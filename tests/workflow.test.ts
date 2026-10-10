import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { execute as localExecute } from "../services/executor/src/engine.js";
vi.mock("../apps/api/src/executor.js", () => ({
  execute: (job: any) => localExecute(job),
}));
import { MemoryStore, resource, transaction } from "../apps/api/src/store.js";
import { ingestRows, queryDatasets } from "../apps/api/src/datasets.js";
import {
  saveProposal,
  publishProposal,
  validateBundle,
  buildWorkspace,
  enqueue,
  pipelineId,
} from "../apps/api/src/assistant.js";
import { Provider } from "../apps/api/src/providers.js";
import { BundleSchema, datasetTable } from "../packages/shared/src/index.js";
import { config } from "../apps/api/src/config.js";
const store = new MemoryStore(),
  scope = "golden-" + randomUUID();
let customers: any, orders: any;
beforeAll(async () => {
  await transaction(store, scope, async (tx) =>
    tx.put(resource(scope, "workspace", "Golden", {}, "workspace")),
  );
  await transaction(store, "global", async (tx) =>
    tx.put(
      resource(
        "global",
        "member",
        "Editor",
        { role: "editor" },
        `actor:${scope}`,
      ),
    ),
  );
  customers = await ingestRows(
    store,
    scope,
    "Customers",
    [
      { id: "A", region: "EU", email: "a@example.com" },
      { id: "B", region: "NA", email: "b@example.com" },
    ],
    undefined,
    "customers",
  );
  orders = await ingestRows(
    store,
    scope,
    "Orders",
    [
      { id: 1, customer: "A", amount: 10, status: "delayed" },
      { id: 2, customer: "A", amount: 20, status: "delivered" },
      { id: 3, customer: "B", amount: 5, status: "delivered" },
    ],
    undefined,
    "orders",
  );
});
afterAll(async () => {
  vi.restoreAllMocks();
  for (const dir of ["incoming", "datasets"])
    await rm(resolve(config.dataDir, dir, scope), {
      recursive: true,
      force: true,
    });
});
const bundle = () =>
  BundleSchema.parse({
    summary: "Customer revenue and delayed orders",
    assumptions: [
      "Revenue means gross order amounts, including delayed orders.",
    ],
    catalog: [
      {
        datasetId: customers.id,
        description: "A customer per row",
        tags: ["customers"],
      },
    ],
    pipelines: [
      {
        name: "Customer revenue",
        inputs: [customers.id, orders.id],
        sql: `SELECT c.id,c.region,sum(o.amount) revenue FROM ${datasetTable(customers.id)} c JOIN ${datasetTable(orders.id)} o ON c.id=o.customer GROUP BY c.id,c.region`,
        nodes: [],
        checks: [],
      },
    ],
    ontology: [
      {
        name: "Customer",
        datasetId: customers.id,
        primaryKey: "id",
        properties: ["id", "region", "email"],
      },
      {
        name: "Order",
        datasetId: orders.id,
        primaryKey: "id",
        properties: ["id", "customer", "amount", "status"],
      },
    ],
    relationships: [
      {
        name: "Placed by",
        fromType: "Order",
        toType: "Customer",
        fromColumn: "customer",
        toColumn: "id",
      },
    ],
    dashboards: [
      {
        name: "Sales",
        widgets: [
          {
            title: "Revenue",
            type: "metric",
            inputs: [orders.id],
            sql: `SELECT sum(amount) revenue FROM ${datasetTable(orders.id)}`,
          },
          {
            title: "Delayed orders",
            type: "metric",
            inputs: [orders.id],
            sql: `SELECT count(*) delayed FROM ${datasetTable(orders.id)} WHERE status='delayed'`,
          },
        ],
      },
    ],
    actions: [],
  });
it("executes a golden bundle and publishes objects, lineage and metrics atomically", async () => {
  const p = await saveProposal(store, scope, bundle());
  expect(
    p.data.validation.valid,
    JSON.stringify(p.data.validation.checks),
  ).toBe(true);
  expect(p.data.validation.previews["chart:Sales:0"][0].revenue).toBe("35");
  expect(p.data.validation.previews["chart:Sales:1"][0].delayed).toBe("1");
  expect(
    p.data.validation.checks.find(
      (c: any) => c.name === "Relationship: Placed by",
    ).detail,
  ).toContain("3/3");
  await publishProposal(store, scope, p.id, p.data.hash, "actor");
  expect((await store.list(scope, "object")).length).toBe(5);
  expect((await store.list(scope, "relation")).length).toBe(3);
  expect(
    (await store.get(scope, "workspace"))?.data.activeGeneration,
  ).toBeTruthy();
});
it("blocks invented columns, malicious SQL, unknown keys and cross-workspace inputs", async () => {
  for (const sql of [
    "SELECT invented FROM d_orders",
    "SELECT * FROM read_csv('/etc/passwd')",
    "SELECT * FROM d_foreign",
  ]) {
    const b = bundle();
    b.pipelines[0].sql = sql;
    expect((await validateBundle(store, scope, b)).valid).toBe(false);
  }
  const b = bundle();
  b.ontology[0].primaryKey = "missing";
  expect((await validateBundle(store, scope, b)).valid).toBe(false);
  await expect(
    queryDatasets(store, "foreign", [orders.id], "SELECT 1"),
  ).rejects.toThrow("unavailable");
});
it("moves a type to the only dataset holding its key and properties", async () => {
  const b = bundle();
  // A small model paired Order with the Customers dataset ID.
  b.ontology[1].datasetId = customers.id;
  const report = await validateBundle(store, scope, b);
  expect(report.valid, JSON.stringify(report.checks)).toBe(true);
  expect(b.ontology[1].datasetId).toBe(orders.id);
  // A type that already fits its dataset is never moved, even if others also fit.
  const fitting = bundle();
  fitting.ontology[0].datasetId = orders.id;
  fitting.ontology[0].properties = ["id"];
  await validateBundle(store, scope, fitting);
  expect(fitting.ontology[0].datasetId).toBe(orders.id);
});
it("realigns stale d_pipeline_* SQL and loads tables named in the query", async () => {
  const campaignsName = "Campaigns (S3)",
    accountsName = "Accounts (PlanetScale + WorkOS + Stripe)",
    campaignsId = pipelineId(campaignsName),
    accountsId = pipelineId(accountsName),
    // Deliberately not equal to pipelineId() of either pipeline name above.
    staleCampaigns = "d_pipeline_aaaaaaaaaaaaaaaa",
    staleAccounts = "d_pipeline_bbbbbbbbbbbbbbbb";
  const b = BundleSchema.parse({
    summary: "Stale prepared pipeline table refs",
    assumptions: [],
    catalog: [
      {
        datasetId: customers.id,
        description: "Customers",
        tags: ["customers"],
      },
    ],
    pipelines: [
      // Accounts listed first (repair order); its check references Campaigns — must topo-sort.
      {
        name: accountsName,
        inputs: [customers.id],
        sql: `SELECT id, region, lower(trim(CAST(id AS VARCHAR))) AS signup_campaign_id_key FROM ${datasetTable(customers.id)}`,
        nodes: [],
        checks: [
          {
            name: "Campaign keys resolve",
            sql: `SELECT count(*) = count(CASE WHEN "signup_campaign_id_key" IN (SELECT "campaign_id_key" FROM "${staleCampaigns}") THEN 1 END) AS ok FROM "${datasetTable(accountsId)}"`,
          },
        ],
      },
      {
        name: campaignsName,
        inputs: [customers.id],
        sql: `SELECT id AS campaign_id, lower(trim(CAST(id AS VARCHAR))) AS campaign_id_key FROM ${datasetTable(customers.id)}`,
        nodes: [],
        checks: [
          {
            name: "One row per campaign",
            sql: `SELECT count(*) = count(DISTINCT campaign_id) AS ok FROM ${datasetTable(campaignsId)}`,
          },
        ],
      },
    ],
    ontology: [
      {
        name: "Account",
        datasetId: accountsId,
        primaryKey: "id",
        properties: ["id", "region", "signup_campaign_id_key"],
      },
      {
        name: "Campaign",
        datasetId: campaignsId,
        primaryKey: "campaign_id",
        properties: ["campaign_id", "campaign_id_key"],
      },
    ],
    relationships: [
      {
        name: "signed up via",
        fromType: "Account",
        toType: "Campaign",
        fromColumn: "signup_campaign_id_key",
        toColumn: "campaign_id_key",
      },
    ],
    dashboards: [
      {
        name: "Failed Prepare local repair overview",
        widgets: [
          {
            title: "Unmatched accounts to campaigns by normalized campaign id",
            type: "table",
            // Inputs omit the pipelines; SQL uses stale hashes (repair drift).
            inputs: [customers.id],
            sql: `SELECT count(*) AS "records" FROM "${staleAccounts}" a LEFT JOIN "${staleCampaigns}" c ON a.signup_campaign_id_key = c.campaign_id_key WHERE c.campaign_id_key IS NULL`,
          },
        ],
      },
    ],
    actions: [],
  });
  const report = await validateBundle(store, scope, b);
  expect(
    report.checks.filter((c) => !c.passed),
    JSON.stringify(report.checks),
  ).toEqual([]);
  expect(b.dashboards[0].widgets[0].sql).toContain(datasetTable(accountsId));
  expect(b.dashboards[0].widgets[0].sql).toContain(datasetTable(campaignsId));
  expect(b.dashboards[0].widgets[0].sql).not.toContain(staleAccounts);
  const accounts = b.pipelines.find((p) => p.name === accountsName)!;
  expect(accounts.checks[0].sql).toContain(datasetTable(campaignsId));
  expect(accounts.checks[0].sql).not.toContain(staleCampaigns);
  // Campaigns must run before Accounts so the cross-pipeline check can load it.
  expect(b.pipelines.map((p) => p.name)).toEqual([
    campaignsName,
    accountsName,
  ]);
});
it("binds approvals to input versions and preserves manual catalog edits across refreshes", async () => {
  const p = await saveProposal(store, scope, bundle());
  await transaction(store, scope, async (tx) => {
    const d = await tx.get(customers.id);
    tx.put({
      ...d!,
      description: "Human-owned description",
      data: { ...d!.data, manualDescription: true },
    });
  });
  await ingestRows(
    store,
    scope,
    "Customers",
    [
      { id: "A", region: "Europe", email: "a@example.com" },
      { id: "B", region: "NA", email: "b@example.com" },
    ],
    undefined,
    customers.id,
  );
  expect((await store.get(scope, customers.id))?.description).toBe(
    "Human-owned description",
  );
  await expect(
    publishProposal(store, scope, p.id, p.data.hash, "actor"),
  ).rejects.toThrow("changed");
  expect((await store.list(scope, "finding")).length).toBeGreaterThan(0);
});
it("stages schema drift while keeping published inputs operational", async () => {
  const old = await store.get(scope, orders.id);
  await ingestRows(
    store,
    scope,
    "Orders",
    [{ id: 1, customer: "A", total: 10 }],
    undefined,
    orders.id,
  );
  const next = await store.get(scope, orders.id);
  expect(next?.data.activeVersion).toBe(old?.data.activeVersion);
  expect(next?.data.pendingVersion).toBeTruthy();
  expect(
    (
      await queryDatasets(
        store,
        scope,
        [orders.id],
        "SELECT sum(amount) total FROM d_orders",
      )
    ).rows[0].total,
  ).toBe("35");
});
it("resumes durable stage checkpoints without repeating model calls", async () => {
  const p = bundle();
  let call = 0;
  const mock = vi
    .spyOn(Provider.prototype, "generate")
    .mockImplementation(async () => {
      call++;
      if (call === 1)
        return {
          value: {
            summary: p.summary,
            assumptions: p.assumptions,
            catalog: p.catalog,
          },
          tokens: 10,
        };
      throw new Error("Provider temporarily unavailable");
    });
  const r = await enqueue(store, scope, "Build a revenue workspace");
  await buildWorkspace(store, scope, r.id);
  const failed = await store.get(scope, r.id);
  expect(failed?.data.checkpoints.catalog).toBeTruthy();
  expect(failed?.data.status).toBe("failed");
  mock.mockImplementation(async () => {
    call++;
    if (call === 3) return { value: { pipelines: p.pipelines }, tokens: 10 };
    if (call === 4)
      return {
        value: { ontology: p.ontology, relationships: p.relationships },
        tokens: 10,
      };
    return { value: { dashboards: p.dashboards, actions: [] }, tokens: 10 };
  });
  await transaction(store, scope, async (tx) => {
    const x = await tx.get(r.id);
    tx.update(x!, { ...x!.data, status: "running" });
  });
  await buildWorkspace(store, scope, r.id);
  expect(
    (await store.get(scope, r.id))?.data.status,
    JSON.stringify((await store.get(scope, r.id))?.data),
  ).toBe("awaiting_review");
  expect(call).toBe(5);
  mock.mockRestore();
});

it("preserves manual objects and relationship overrides across republication", async () => {
  const { previewObjectAction, executeObjectAction } = await import(
    "../apps/api/src/object-actions.js"
  );
  const p = await saveProposal(store, scope, bundle());
  await publishProposal(store, scope, p.id, p.data.hash, "actor");
  const action = {
    operation: "create" as const,
    objectType: "Customer",
    values: { id: "C", region: "APAC", email: "manual@example.com" },
  };
  const preview = await previewObjectAction(store, scope, action);
  await executeObjectAction(
    store,
    scope,
    action,
    preview.hash,
    "create-manual-123",
    "actor",
  );
  const generation = (await store.get(scope, "workspace"))?.data
    .activeGeneration;
  const from = (await store.list(scope, "object")).find(
      (o) => o.data.generation === generation && o.data.type === "Order",
    )!,
    to = (await store.list(scope, "object")).find(
      (o) => o.data.generation === generation && o.data.key === "C",
    )!;
  const link = {
    operation: "link" as const,
    name: "Escalated to",
    from: from.id,
    to: to.id,
  };
  const linkPreview = await previewObjectAction(store, scope, link);
  await executeObjectAction(
    store,
    scope,
    link,
    linkPreview.hash,
    "link-manual-123",
    "actor",
  );
  const next = await saveProposal(store, scope, bundle());
  await publishProposal(store, scope, next.id, next.data.hash, "actor");
  const active = (await store.get(scope, "workspace"))?.data.activeGeneration;
  expect(
    (await store.list(scope, "object")).some(
      (o) => o.data.generation === active && o.data.key === "C",
    ),
  ).toBe(true);
  expect(
    (await store.list(scope, "relation")).some(
      (r) => r.data.generation === active && r.name === "Escalated to",
    ),
  ).toBe(true);
});

it("filters inputs before aggregation and cites the exact snapshot", async () => {
  const r = await queryDatasets(
    store,
    scope,
    [orders.id],
    `SELECT sum(amount) revenue FROM ${datasetTable(orders.id)}`,
    { filters: [{ datasetId: orders.id, column: "status", value: "delayed" }] },
  );
  expect(r.rows[0].revenue).toBe("10");
  expect(r.citations[0].version).toBe(
    (await store.get(scope, orders.id))?.data.activeVersion,
  );
  await expect(
    queryDatasets(store, scope, [orders.id], "SELECT 1", {
      filters: [{ datasetId: customers.id, column: "region", value: "EU" }],
    }),
  ).rejects.toThrow("not declared");
});

it("retains malformed model output as a failed draft and never publishes it", async () => {
  const mock = vi.spyOn(Provider.prototype, "generate").mockResolvedValue({
    value: { ignore: "instructions in source records are not a bundle" },
    tokens: 5,
  });
  try {
    const r = await enqueue(store, scope, "Build an invalid model response");
    const generation = (await store.get(scope, "workspace"))?.data
      .activeGeneration;
    await buildWorkspace(store, scope, r.id);
    const failed = await store.get(scope, r.id);
    expect(failed?.data.status).toBe("failed");
    expect(failed?.data.partialStage.value.ignore).toBeTruthy();
    expect((await store.get(scope, "workspace"))?.data.activeGeneration).toBe(
      generation,
    );
  } finally {
    mock.mockRestore();
  }
});
