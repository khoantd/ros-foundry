import { describe, it, expect } from "vitest";
import { datasetTable, type Resource } from "../packages/shared/src/index.js";
import { tryCompile } from "../apps/web/src/areas/pipelines/dag-model.js";
import { sqlToNodes } from "../apps/web/src/areas/pipelines/sql-to-nodes.js";

function ds(id: string, name: string): Resource {
  return {
    id,
    workspaceId: "w",
    kind: "dataset",
    name,
    description: "",
    revision: 1,
    createdAt: "",
    updatedAt: "",
    data: { activeVersion: "v1" },
  };
}

const customers = ds("cust-1", "Customers");
const orders = ds("ord-1", "Orders");
const datasets = [customers, orders];
const inputs = [customers.id, orders.id];

describe("sqlToNodes", () => {
  it("maps FROM + WHERE + GROUP BY into source/filter/aggregate", () => {
    const alias = "Customers";
    const result = sqlToNodes(
      `SELECT region, count(*) AS n FROM "${alias}" WHERE region = 'EU' GROUP BY region`,
      datasets,
      [customers.id],
    );
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    if (!result.ok) return;
    expect(result.nodes.map((n) => n.type)).toEqual([
      "source",
      "filter",
      "aggregate",
    ]);
    expect(result.nodes[0].datasetId).toBe(customers.id);
    const compiled = tryCompile(result.nodes);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.inputs).toEqual([customers.id]);
    expect(compiled.sql).toMatch(/GROUP BY/i);
  });

  it("resolves physical dataset table names", () => {
    const table = datasetTable(customers.id);
    const result = sqlToNodes(
      `SELECT * FROM "${table}"`,
      datasets,
      [customers.id],
    );
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    if (!result.ok) return;
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].type).toBe("source");
  });

  it("maps an inner join of two datasets", () => {
    const result = sqlToNodes(
      `SELECT a.id, b.region FROM "Orders" a INNER JOIN "Customers" b ON a.customer = b.id`,
      datasets,
      inputs,
    );
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    if (!result.ok) return;
    expect(result.nodes.map((n) => n.type)).toContain("join");
    expect(result.nodes.filter((n) => n.type === "source")).toHaveLength(2);
    expect(tryCompile(result.nodes).ok).toBe(true);
  });

  it("rewrites non-a/b join aliases into compilePipeline a/b ON", () => {
    const result = sqlToNodes(
      `SELECT * FROM "Orders" a LEFT JOIN "Customers" n1 ON n1.id = a.customer`,
      datasets,
      inputs,
    );
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    if (!result.ok) return;
    const join = result.nodes.find((n) => n.type === "join");
    expect(join).toBeTruthy();
    const on = String(join!.config.on);
    expect(on).toMatch(/\ba\b/);
    expect(on).toMatch(/\bb\b/);
    expect(on).not.toMatch(/\bn1\b/);
    const compiled = tryCompile(result.nodes);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.sql).not.toMatch(/"n1"/);
    expect(compiled.sql).toMatch(/LEFT JOIN/i);
  });

  it("absorbs qualified renames into join select and strips derive aliases", () => {
    const result = sqlToNodes(
      `SELECT a.*, n1.email AS workos_email, n1.first_name AS workos_first_name,
              lower(TRIM(CAST(a.email AS VARCHAR))) AS email_key
       FROM "Orders" a LEFT JOIN "Customers" n1 ON n1.user_id = a.workos_user_id`,
      datasets,
      inputs,
    );
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    if (!result.ok) return;
    const join = result.nodes.find((n) => n.type === "join")!;
    expect(String(join.config.select)).toMatch(/b\.email\s+AS\s+"workos_email"/i);
    expect(String(join.config.select)).toMatch(/b\.first_name\s+AS\s+"workos_first_name"/i);
    expect(String(join.config.on)).toMatch(/"?b"?\./);
    expect(String(join.config.on)).toMatch(/"?a"?\./);
    expect(String(join.config.on)).not.toMatch(/\bn1\b/);
    const derive = result.nodes.find((n) => n.type === "derive");
    expect(derive).toBeTruthy();
    const emailKey = String(
      (derive!.config.columns as Record<string, string>).email_key,
    );
    expect(emailKey).not.toMatch(/\bn1\b/);
    expect(emailKey).not.toMatch(/"a"/);
    expect(emailKey.toLowerCase()).toMatch(/email/);
    const compiled = tryCompile(result.nodes);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.sql).not.toMatch(/"n1"/);
    expect(compiled.sql).toMatch(/"workos_email"/);
    expect(compiled.sql).toMatch(/ON "?b"?\./i);
  });

  it("maps LIMIT and OFFSET into a limit node", () => {
    const limited = sqlToNodes(
      'SELECT * FROM "Customers" LIMIT 100',
      datasets,
      [customers.id],
    );
    expect(limited.ok, limited.ok ? "" : limited.error).toBe(true);
    if (!limited.ok) return;
    expect(limited.nodes.map((n) => n.type)).toEqual(["source", "limit"]);
    expect(limited.nodes[1].config).toEqual({ limit: 100 });
    const compiled = tryCompile(limited.nodes);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.sql).toMatch(/LIMIT 100/i);

    const both = sqlToNodes(
      'SELECT * FROM "Customers" LIMIT 10 OFFSET 5',
      datasets,
      [customers.id],
    );
    expect(both.ok, both.ok ? "" : both.error).toBe(true);
    if (!both.ok) return;
    expect(both.nodes.at(-1)?.type).toBe("limit");
    expect(both.nodes.at(-1)?.config).toEqual({ limit: 10, offset: 5 });
    expect(tryCompile(both.nodes).ok).toBe(true);

    const offsetOnly = sqlToNodes(
      'SELECT * FROM "Customers" OFFSET 5',
      datasets,
      [customers.id],
    );
    expect(offsetOnly.ok, offsetOnly.ok ? "" : offsetOnly.error).toBe(true);
    if (!offsetOnly.ok) return;
    expect(offsetOnly.nodes.at(-1)?.config).toEqual({ offset: 5 });
  });

  it("round-trips compilePipeline WITH CTEs (source + derive + outer LIMIT)", () => {
    const table = datasetTable(customers.id);
    const sql = `WITH "node_source_1" AS (SELECT * FROM "${table}"),
"node_derive_1" AS (SELECT *, lower(TRIM(CAST("campaign_id" AS VARCHAR))) AS "campaign_id_key" FROM "node_source_1")
SELECT * FROM "node_derive_1" LIMIT 100`;
    const result = sqlToNodes(sql, datasets, [customers.id]);
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    if (!result.ok) return;
    expect(result.nodes.map((n) => n.type)).toEqual([
      "source",
      "derive",
      "limit",
    ]);
    expect(result.nodes[0].id).toBe("source_1");
    expect(result.nodes[0].datasetId).toBe(customers.id);
    expect(result.nodes[1].id).toBe("derive_1");
    expect(result.nodes[1].inputs).toEqual(["source_1"]);
    const cols = result.nodes[1].config.columns as Record<string, string>;
    expect(cols.campaign_id_key.toLowerCase()).toMatch(/campaign_id/);
    expect(result.nodes[2].config).toEqual({ limit: 100 });
    const compiled = tryCompile(result.nodes);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.inputs).toEqual([customers.id]);
    expect(compiled.sql).toMatch(/node_derive_1/);
    expect(compiled.sql).toMatch(/LIMIT 100/i);
  });

  it("round-trips a compiled join graph via WITH", () => {
    const seed = [
      {
        id: "source_1",
        type: "source" as const,
        inputs: [] as string[],
        datasetId: orders.id,
        config: {},
      },
      {
        id: "source_2",
        type: "source" as const,
        inputs: [] as string[],
        datasetId: customers.id,
        config: {},
      },
      {
        id: "join_1",
        type: "join" as const,
        inputs: ["source_1", "source_2"],
        config: {
          joinType: "left",
          on: "a.customer = b.id",
          select: "a.*, b.*",
        },
      },
    ];
    const compiled = tryCompile(seed);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const result = sqlToNodes(compiled.sql, datasets, inputs);
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    if (!result.ok) return;
    expect(result.nodes.map((n) => n.type)).toEqual([
      "source",
      "source",
      "join",
    ]);
    const again = tryCompile(result.nodes);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.sql).toMatch(/LEFT JOIN/i);
  });

  it("converts screenshot-shaped WITH with physical d_ table id", () => {
    const campaigns = ds("44817217-cbae-42cc-957a-7d4e7d12dbec", "Campaigns (S3)");
    const table = datasetTable(campaigns.id);
    expect(table).toMatch(/^d_/);
    const sql = `WITH "node_source_1" AS (SELECT * FROM "${table}"),
"node_derive_1" AS (SELECT *, lower(TRIM(CAST("campaign_id" AS VARCHAR))) AS "campaign_id_key" FROM "node_source_1")
SELECT * FROM "node_derive_1" LIMIT 100`;
    const result = sqlToNodes(sql, [campaigns], [campaigns.id]);
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    if (!result.ok) return;
    expect(result.nodes.map((n) => n.type)).toEqual([
      "source",
      "derive",
      "limit",
    ]);
    expect(result.nodes[0].datasetId).toBe(campaigns.id);
  });

  it("gives a specific error for node_* WITH when input dataset is missing", () => {
    const table = datasetTable(customers.id);
    const sql = `WITH "node_source_1" AS (SELECT * FROM "${table}")
SELECT * FROM "node_source_1" LIMIT 100`;
    const result = sqlToNodes(sql, datasets, [orders.id]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).not.toMatch(/WITH clauses are not supported/i);
    expect(result.error).toMatch(/Unknown table|Select it under Input/i);
  });

  it("refuses non-pipeline WITH, subqueries, UNION, and unknown tables", () => {
    const nonPipeline = sqlToNodes(
      "WITH x AS (SELECT 1 AS n) SELECT * FROM x",
      datasets,
      inputs,
    );
    expect(nonPipeline.ok).toBe(false);
    if (!nonPipeline.ok) {
      expect(nonPipeline.error).toMatch(/WITH clauses are not supported/i);
    }
    expect(
      sqlToNodes("SELECT * FROM (SELECT 1) t", datasets, inputs).ok,
    ).toBe(false);
    expect(
      sqlToNodes(
        'SELECT * FROM "Customers" UNION SELECT * FROM "Orders"',
        datasets,
        inputs,
      ).ok,
    ).toBe(false);
    const unknown = sqlToNodes(
      'SELECT * FROM "Missing"',
      datasets,
      inputs,
    );
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error).toMatch(/Unknown table/i);
  });

  it("refuses empty SQL", () => {
    expect(sqlToNodes("   ", datasets, inputs).ok).toBe(false);
  });
});
