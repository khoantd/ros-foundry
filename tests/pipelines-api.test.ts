import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { execute as localExecute } from "../services/executor/src/engine.js";
vi.mock("../apps/api/src/executor.js", () => ({
  execute: (job: any) => localExecute(job),
}));
import { createApp } from "../apps/api/src/app.js";
import { MemoryStore, resource, transaction } from "../apps/api/src/store.js";
import { ingestRows } from "../apps/api/src/datasets.js";
import { config } from "../apps/api/src/config.js";
import { datasetTable } from "../packages/shared/src/index.js";

const store = new MemoryStore();
let app: Awaited<ReturnType<typeof createApp>>,
  scope: string,
  customers: Awaited<ReturnType<typeof ingestRows>>;

beforeAll(async () => {
  app = await createApp(store);
  await app.ready();
  const me = await app.inject({ method: "GET", url: "/api/v1/me" });
  scope = me.json().workspaces[0].id;
  customers = await ingestRows(
    store,
    scope,
    "Customers",
    [
      { id: "A", region: "EU" },
      { id: "B", region: "NA" },
    ],
    undefined,
    "customers-" + randomUUID().slice(0, 8),
  );
});

afterAll(async () => {
  await app.close();
  vi.restoreAllMocks();
  for (const dir of ["incoming", "datasets"])
    await rm(resolve(config.dataDir, dir, scope), {
      recursive: true,
      force: true,
    });
});

const request = (method: any, path: string, payload?: unknown) =>
  app.inject({
    method,
    url: "/api/v1/workspaces/" + scope + path,
    payload: payload as any,
  });

describe("pipelines API", () => {
  it("rejects an invalid draft body", async () => {
    const r = await request("POST", "/pipelines/draft", { name: "" });
    expect(r.statusCode).toBe(400);
  });

  it("returns 404 when running a missing pipeline", async () => {
    const r = await request("POST", "/pipelines/missing-pipeline/run", {});
    expect(r.statusCode).toBe(404);
    expect(r.json().error).toBe("Pipeline unavailable");
  });

  it("drafts a SQL pipeline as a reviewable proposal and runs a published one", async () => {
    const table = datasetTable(customers.id);
    const definition = {
      name: "Customers by region",
      description: "Count customers per region",
      inputs: [customers.id],
      sql: `SELECT region, count(*) AS n FROM ${table} GROUP BY region`,
      nodes: [],
      checks: [],
    };
    const draft = await request("POST", "/pipelines/draft", definition);
    expect(draft.statusCode, draft.body).toBe(200);
    const proposal = draft.json();
    expect(proposal.kind).toBe("proposal");
    expect(proposal.data.bundle.pipelines.map((p: any) => p.name)).toContain(
      definition.name,
    );
    expect(proposal.data.validation.valid, JSON.stringify(proposal.data.validation)).toBe(
      true,
    );
    expect(proposal.data.status).toBe("ready");

    // Publish so a live pipeline resource exists for /run.
    const published = await request("POST", `/proposals/${proposal.id}/publish`, {
      hash: proposal.data.hash,
    });
    expect(published.statusCode, published.body).toBe(200);

    const listed = await request("GET", "/resources/pipeline");
    expect(listed.statusCode).toBe(200);
    const pipe = listed
      .json()
      .items.find((p: any) => p.name === definition.name);
    expect(pipe).toBeTruthy();
    expect(pipe.data.sql).toContain("GROUP BY");

    const run = await request("POST", `/pipelines/${pipe.id}/run`, {});
    expect(run.statusCode, run.body).toBe(200);
    expect(run.json()).toMatchObject({
      kind: "job",
      data: { type: "pipeline", pipelineId: pipe.id, status: "queued" },
    });
  });

  it("drafts a node DAG pipeline by compiling nodes into SQL", async () => {
    const nodes = [
      {
        id: "src",
        type: "source",
        datasetId: customers.id,
        inputs: [],
        config: {},
      },
      {
        id: "agg",
        type: "aggregate",
        inputs: ["src"],
        config: {
          groupBy: ["region"],
          metrics: { n: "count(*)" },
        },
      },
    ];
    const draft = await request("POST", "/pipelines/draft", {
      name: "Customers DAG",
      description: "Visual aggregate",
      // Placeholders overwritten by compilePipeline when nodes are present.
      inputs: [customers.id],
      sql: "SELECT 1",
      nodes,
      checks: [],
    });
    expect(draft.statusCode, draft.body).toBe(200);
    const proposal = draft.json();
    expect(proposal.kind).toBe("proposal");
    expect(proposal.data.validation.valid, JSON.stringify(proposal.data.validation)).toBe(
      true,
    );
    const saved = proposal.data.bundle.pipelines.find(
      (p: any) => p.name === "Customers DAG",
    );
    expect(saved).toBeTruthy();
    expect(saved.nodes).toHaveLength(2);
    expect(saved.inputs).toEqual([customers.id]);
    expect(saved.sql).toMatch(/WITH/i);
    expect(saved.sql).toMatch(/GROUP BY/i);
    expect(saved.sql).not.toBe("SELECT 1");
  });
});
