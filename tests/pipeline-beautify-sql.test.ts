import { describe, it, expect } from "vitest";
import {
  beautifySql,
  tokenizeSql,
} from "../apps/web/src/areas/pipelines/beautify-sql.js";

describe("beautifySql", () => {
  it("returns empty / whitespace unchanged", () => {
    expect(beautifySql("")).toBe("");
    expect(beautifySql("   ")).toBe("   ");
  });

  it("formats a flat SELECT with major clauses", () => {
    const out = beautifySql(
      `SELECT a, b FROM "orders" WHERE a > 1 GROUP BY a LIMIT 10`,
    );
    expect(out).toBe(
      [
        "SELECT a, b",
        'FROM "orders"',
        "WHERE a > 1",
        "GROUP BY a",
        "LIMIT 10",
      ].join("\n"),
    );
  });

  it("formats WITH CTEs with indented bodies", () => {
    const raw =
      `WITH "node_a" AS (SELECT * FROM "ds"),` +
      `"node_b" AS (SELECT * FROM "node_a" WHERE true)\n` +
      `SELECT * FROM "node_b"`;
    const out = beautifySql(raw);
    expect(out).toContain('WITH\n  "node_a" AS (');
    expect(out).toMatch(/\n\s+SELECT \*/);
    expect(out).toMatch(/\n\s+FROM "ds"/);
    expect(out).toContain('SELECT *\nFROM "node_b"');
  });

  it("is idempotent on already-formatted SQL", () => {
    const once = beautifySql(
      `SELECT * FROM "t" WHERE x = 1 LIMIT 5`,
    );
    expect(beautifySql(once)).toBe(once);
  });

  it("returns original on unbalanced quotes", () => {
    const bad = `SELECT 'oops FROM t`;
    expect(beautifySql(bad)).toBe(bad);
  });

  it("preserves JOIN / ON structure", () => {
    const out = beautifySql(
      `SELECT * FROM a INNER JOIN b ON a.id = b.id WHERE a.x = 1`,
    );
    expect(out).toBe(
      [
        "SELECT *",
        "FROM a",
        "INNER JOIN b",
        "ON a.id = b.id",
        "WHERE a.x = 1",
      ].join("\n"),
    );
  });
});

describe("tokenizeSql", () => {
  it("classifies keywords, strings, numbers, and identifiers", () => {
    const tokens = tokenizeSql(`SELECT 'x', 42, "t"`);
    const kinds = tokens.map((t) => t.kind);
    expect(kinds).toContain("kw");
    expect(kinds).toContain("str");
    expect(kinds).toContain("num");
    expect(kinds).toContain("id");
  });
});
