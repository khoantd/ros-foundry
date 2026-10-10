import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createApp } from "../apps/api/src/app.js";
import { MemoryStore, resource, transaction } from "../apps/api/src/store.js";
import { seal } from "../apps/api/src/security.js";
import { sourceSyncDefaults } from "../apps/api/src/source-sync.js";

describe("source schedule and pause controls", () => {
  const store = new MemoryStore();
  let app: Awaited<ReturnType<typeof createApp>>,
    scope: string,
    sourceId: string;

  beforeAll(async () => {
    app = await createApp(store);
    await app.ready();
    const me = await app.inject({ method: "GET", url: "/api/v1/me" });
    scope = me.json().workspaces[0].id;
    sourceId = "sched-source";
    await transaction(store, scope, async (tx) => {
      tx.put(
        resource(
          scope,
          "source",
          "REST feed",
          {
            kind: "rest",
            secret: seal({ url: "http://127.0.0.1/items" }),
            ...sourceSyncDefaults("rest", null),
          },
          sourceId,
        ),
      );
    });
  });
  afterAll(() => app.close());

  const patch = (body: unknown) =>
    app.inject({
      method: "PATCH",
      url: `/api/v1/workspaces/${scope}/sources/${sourceId}`,
      payload: body as any,
    });

  it("updates schedule, pauses automatic refresh, and rejects bad cron", async () => {
    const updated = await patch({ schedule: "0 * * * *" });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().data.schedule).toBe("0 * * * *");
    expect(updated.json().data.nextRun).toBeGreaterThan(Date.now());
    expect(updated.json().data.secret).toBeUndefined();

    const paused = await patch({ paused: true });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().data.paused).toBe(true);
    expect(paused.json().data.schedule).toBe("0 * * * *");

    const cleared = await patch({ schedule: null, paused: false });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().data.schedule).toBeNull();
    expect(cleared.json().data.paused).toBe(false);

    expect((await patch({ schedule: "not a cron" })).statusCode).toBe(400);
    expect((await patch({})).statusCode).toBe(400);
    expect(
      (
        await app.inject({
          method: "PATCH",
          url: `/api/v1/workspaces/${scope}/sources/missing`,
          payload: { paused: true },
        })
      ).statusCode,
    ).toBe(404);
  });
});
