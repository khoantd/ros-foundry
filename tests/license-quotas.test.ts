import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../apps/api/src/app.js";
import { MemoryStore, resource, transaction } from "../apps/api/src/store.js";
import { config } from "../apps/api/src/config.js";
import {
  applyLicense,
  assertQuota,
  directorySize,
  getLicense,
  measureUsage,
  recordAiUnits,
  resetLicenseState,
  runHeartbeat,
  usageMonthKey,
} from "../apps/api/src/license.js";
import { AppError } from "../apps/api/src/security.js";

type App = Awaited<ReturnType<typeof createApp>>;

async function seededWorkspace(store: MemoryStore) {
  const scope = "ws-license";
  await transaction(store, "global", async (tx) => {
    tx.put(resource("global", "workspaceRef", "License WS", {}, scope));
    tx.put(
      resource(
        "global",
        "user",
        "Owner",
        { email: "owner@example.com" },
        "user-1",
      ),
    );
    tx.put(
      resource(
        "global",
        "member",
        "Owner",
        { userId: "user-1", role: "owner", workspaceId: scope },
        "user-1:" + scope,
      ),
    );
  });
  await transaction(store, scope, async (tx) => {
    tx.put(
      resource(scope, "workspace", "License WS", { activeGeneration: null }, "workspace"),
    );
  });
  return scope;
}

describe("license quotas", () => {
  const apps: App[] = [];
  let tempDir: string | undefined;

  afterEach(async () => {
    while (apps.length) await apps.pop()!.close();
    resetLicenseState();
    config.authMode = "local";
    config.licenseSeats = 0;
    config.licenseMaxSources = 0;
    config.licenseMaxStorageBytes = 0;
    config.licenseAiUnitsMonthly = 0;
    config.controlPlaneUrl = "";
    config.licenseInstanceId = "";
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it("loads license limits from options and reports usage", async () => {
    const store = new MemoryStore();
    const scope = await seededWorkspace(store);
    await transaction(store, scope, async (tx) => {
      tx.put(resource(scope, "source", "A", { kind: "postgres" }, "src-a"));
      tx.put(resource(scope, "source", "B", { kind: "mysql" }, "src-b"));
    });
    applyLicense({
      seats: 5,
      maxSources: 10,
      maxStorageBytes: 1024,
      aiUnitsMonthly: 100,
      features: ["pipelines"],
      plan: "starter",
    });
    const usage = await measureUsage(store, scope, () => 128);
    expect(usage).toMatchObject({
      seats: 1,
      sources: 2,
      storageBytes: 128,
      aiUnits: 0,
    });
    expect(getLicense()).toMatchObject({
      plan: "starter",
      maxSources: 10,
      seats: 5,
    });
  });

  it("throws QUOTA_EXCEEDED when source or seat limits are hit", () => {
    applyLicense({
      seats: 2,
      maxSources: 2,
      maxStorageBytes: 0,
      aiUnitsMonthly: 0,
      features: [],
    });
    expect(() =>
      assertQuota("sources", { seats: 1, sources: 2, storageBytes: 0, aiUnits: 0 }),
    ).toThrow(AppError);
    try {
      assertQuota("sources", { seats: 1, sources: 2, storageBytes: 0, aiUnits: 0 });
    } catch (e: any) {
      expect(e.statusCode).toBe(403);
      expect(e.code).toBe("QUOTA_EXCEEDED");
    }
    expect(() =>
      assertQuota("seats", { seats: 2, sources: 0, storageBytes: 0, aiUnits: 0 }),
    ).toThrow(/Seat limit/);
  });

  it("meters AI units per month and blocks when exhausted", async () => {
    const store = new MemoryStore();
    applyLicense({
      seats: 0,
      maxSources: 0,
      maxStorageBytes: 0,
      aiUnitsMonthly: 2,
      features: [],
    });
    await recordAiUnits(store, 1);
    await recordAiUnits(store, 1);
    const usage = await measureUsage(store, "ws", () => 0);
    expect(usage.aiUnits).toBe(2);
    expect(usage.month).toBe(usageMonthKey());
    expect(() =>
      assertQuota("aiUnits", usage, 1),
    ).toThrow(/AI unit/);
  });

  it("measures DATA_DIR size for storage quota", () => {
    tempDir = join(tmpdir(), "foundry-license-" + Date.now());
    mkdirSync(join(tempDir, "datasets"), { recursive: true });
    writeFileSync(join(tempDir, "datasets", "a.bin"), Buffer.alloc(50));
    writeFileSync(join(tempDir, "datasets", "b.bin"), Buffer.alloc(30));
    expect(directorySize(tempDir)).toBe(80);
    applyLicense({
      seats: 0,
      maxSources: 0,
      maxStorageBytes: 80,
      aiUnitsMonthly: 0,
      features: [],
    });
    expect(() =>
      assertQuota(
        "storage",
        { seats: 0, sources: 0, storageBytes: 80, aiUnits: 0 },
        1,
      ),
    ).toThrow(/Storage/);
  });

  it("exposes GET /api/v1/license with usage and alerts", async () => {
    const store = new MemoryStore();
    const app = await createApp(store, {
      license: {
        seats: 3,
        maxSources: 2,
        maxStorageBytes: 1000,
        aiUnitsMonthly: 50,
        plan: "team",
        features: [],
      },
    });
    apps.push(app);
    await app.ready();
    const scope = (
      await app.inject({ method: "GET", url: "/api/v1/me" })
    ).json().workspaces[0].id;
    await transaction(store, scope, async (tx) => {
      tx.put(resource(scope, "source", "One", { kind: "postgres" }));
      tx.put(resource(scope, "source", "Two", { kind: "mysql" }));
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/workspaces/${scope}/license`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.license).toMatchObject({
      plan: "team",
      maxSources: 2,
      seats: 3,
    });
    expect(body.usage.sources).toBe(2);
    expect(body.alerts.some((a: any) => a.dimension === "sources")).toBe(true);
  });

  it("rejects adding a source when maxSources is reached", async () => {
    const store = new MemoryStore();
    const app = await createApp(store, {
      license: { maxSources: 1, seats: 0, maxStorageBytes: 0, aiUnitsMonthly: 0, features: [] },
    });
    apps.push(app);
    await app.ready();
    const scope = (
      await app.inject({ method: "GET", url: "/api/v1/me" })
    ).json().workspaces[0].id;
    await transaction(store, scope, async (tx) => {
      tx.put(resource(scope, "source", "Only", { kind: "postgres" }));
    });
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/workspaces/${scope}/sources`,
      payload: {
        name: "Blocked",
        kind: "postgres",
        config: { url: "postgresql://user:pass@127.0.0.1:5432/db" },
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("QUOTA_EXCEEDED");
  });

  it("heartbeat posts usage and applies a refreshed license", async () => {
    const store = new MemoryStore();
    await seededWorkspace(store);
    applyLicense({
      seats: 3,
      maxSources: 5,
      maxStorageBytes: 0,
      aiUnitsMonthly: 10,
      features: [],
      plan: "starter",
    });
    let received: any;
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received = JSON.parse(body);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            license: {
              seats: 10,
              maxSources: 25,
              maxStorageBytes: 0,
              aiUnitsMonthly: 100,
              features: ["sso"],
              plan: "team",
            },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    config.controlPlaneUrl = `http://127.0.0.1:${port}`;
    config.licenseInstanceId = "tenant-demo";
    const result = await runHeartbeat(store, () => 42);
    expect(result.ok).toBe(true);
    expect(received).toMatchObject({
      instanceId: "tenant-demo",
      usage: expect.objectContaining({ sources: 0, storageBytes: 42 }),
    });
    expect(getLicense()).toMatchObject({ plan: "team", seats: 10, maxSources: 25 });
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it("heartbeat is a no-op when control plane URL is unset", async () => {
    const store = new MemoryStore();
    config.controlPlaneUrl = "";
    const spy = vi.spyOn(globalThis, "fetch");
    const result = await runHeartbeat(store, () => 0);
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
