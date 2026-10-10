// Reverse-compile a single SELECT into PipelineNode[]. Refuses (ok:false)
// when any construct cannot be mapped fully — no partial graphs.
import nodeSqlParser from "node-sql-parser";
import {
  datasetAliases,
  datasetTable,
  type Resource,
} from "../../../../../packages/shared/src";
import type { PipelineNode } from "../../../../../packages/shared/src/pipeline.js";
import { tryCompile } from "./dag-model";

export type SqlToNodesResult =
  | { ok: true; nodes: PipelineNode[] }
  | { ok: false; error: string };

type AstNode = Record<string, any>;

const { Parser } = nodeSqlParser as {
  Parser: new () => {
    astify: (sql: string, opt?: object) => unknown;
    exprToSQL: (expr: unknown, opt?: object) => string;
  };
};
const parser = new Parser();
const OPT = { database: "PostgreSQL" as const };

function fail(error: string): SqlToNodesResult {
  return { ok: false, error };
}

function colName(ref: AstNode | string | null | undefined): string | null {
  if (!ref) return null;
  if (typeof ref === "string") return ref;
  if (typeof ref.column === "string") return ref.column;
  if (ref.column?.expr?.value) return String(ref.column.expr.value);
  if (ref.column?.value) return String(ref.column.value);
  if (ref.value) return String(ref.value);
  return null;
}

function exprSql(expr: AstNode | null | undefined): string {
  if (!expr) return "";
  return parser.exprToSQL(expr, OPT);
}

/** Table name/alias on a column_ref (string or { value }). */
function tableName(ref: AstNode | null | undefined): string | null {
  if (!ref?.table) return null;
  if (typeof ref.table === "string") return ref.table.replaceAll('"', "");
  if (ref.table.value != null) return String(ref.table.value).replaceAll('"', "");
  return null;
}

function fromAliases(f: AstNode): string[] {
  const out: string[] = [];
  if (f.as) out.push(String(f.as).replaceAll('"', "").toLowerCase());
  if (f.table != null) {
    out.push(String(f.table).replaceAll('"', "").toLowerCase());
  }
  return [...new Set(out)];
}

/**
 * Rewrite column_ref.table via map. Value `null` strips the qualifier.
 * Mutates a deep clone; does not mutate the input AST.
 */
function rewriteTables(
  expr: AstNode,
  map: Map<string, string | null>,
): AstNode {
  const clone = JSON.parse(JSON.stringify(expr)) as AstNode;
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const n = node as AstNode;
    if (n.type === "column_ref" && n.table) {
      const t = tableName(n);
      if (t && map.has(t.toLowerCase())) {
        const dest = map.get(t.toLowerCase())!;
        if (dest === null) {
          n.table = null;
        } else if (typeof n.table === "object") {
          n.table = { type: "default", value: dest };
        } else {
          n.table = dest;
        }
      }
    }
    for (const v of Object.values(n)) walk(v);
  };
  walk(clone);
  return clone;
}

function exprSqlRewritten(
  expr: AstNode | null | undefined,
  map: Map<string, string | null>,
): string {
  if (!expr) return "";
  return exprSql(rewriteTables(expr, map));
}

function isStar(expr: AstNode): boolean {
  return expr?.type === "star" || expr?.column === "*";
}

function isAgg(expr: AstNode): boolean {
  return expr?.type === "aggr_func";
}

function isColumnRef(expr: AstNode): boolean {
  return expr?.type === "column_ref";
}

function isCast(expr: AstNode): boolean {
  return expr?.type === "cast";
}

function hasWindow(expr: AstNode | null | undefined): boolean {
  if (!expr || typeof expr !== "object") return false;
  if (expr.over) return true;
  return Object.values(expr).some(
    (v) =>
      (v && typeof v === "object" && hasWindow(v as AstNode)) ||
      (Array.isArray(v) && v.some((x) => hasWindow(x))),
  );
}

function buildTableIndex(
  datasets: Resource[],
  inputIds: string[],
): Map<string, string> {
  const allowed = new Set(inputIds);
  const index = new Map<string, string>();
  for (const d of datasets) {
    if (allowed.size && !allowed.has(d.id)) continue;
    const table = datasetTable(d.id);
    index.set(table.toLowerCase(), d.id);
    index.set(d.id.toLowerCase(), d.id);
    for (const alias of datasetAliases(d.name)) {
      index.set(alias.toLowerCase(), d.id);
    }
    index.set(d.name.toLowerCase(), d.id);
  }
  // If inputs empty, allow any known dataset (still must resolve).
  if (!allowed.size) {
    for (const d of datasets) {
      const table = datasetTable(d.id);
      index.set(table.toLowerCase(), d.id);
      for (const alias of datasetAliases(d.name)) {
        index.set(alias.toLowerCase(), d.id);
      }
      index.set(d.name.toLowerCase(), d.id);
    }
  }
  return index;
}

function resolveTable(
  name: string,
  index: Map<string, string>,
): string | null {
  const raw = name.replaceAll('"', "");
  return index.get(raw.toLowerCase()) || null;
}

function nextId(prefix: string, used: Set<string>): string {
  let n = 1;
  while (used.has(`${prefix}_${n}`)) n += 1;
  const id = `${prefix}_${n}`;
  used.add(id);
  return id;
}

function sourceNode(id: string, datasetId: string): PipelineNode {
  return { id, type: "source", inputs: [], datasetId, config: {} };
}

function cteNameOf(cte: AstNode): string | null {
  const n = cte?.name;
  if (!n) return null;
  if (typeof n === "string") return n.replaceAll('"', "");
  if (n.value != null) return String(n.value).replaceAll('"', "");
  return null;
}

/** Unwrap parser CTE body to a SELECT AST (handles nested .ast / array). */
function cteSelectStmt(cte: AstNode): AstNode | null {
  let stmt: AstNode | null = cte?.stmt ?? null;
  if (!stmt) return null;
  if (stmt.type !== "select" && stmt.ast) {
    stmt = (Array.isArray(stmt.ast) ? stmt.ast[0] : stmt.ast) as AstNode;
  }
  if (Array.isArray(stmt)) stmt = stmt[0] as AstNode;
  if (!stmt || stmt.type !== "select") return null;
  return stmt;
}

/** Table name from FROM item (string or { value }). */
function fromTableName(f: AstNode | null | undefined): string | null {
  if (!f || f.table == null) return null;
  if (typeof f.table === "string") return f.table.replaceAll('"', "");
  if (f.table.value != null) return String(f.table.value).replaceAll('"', "");
  return String(f.table).replaceAll('"', "");
}

/** compilePipeline names CTEs `node_<id>`. */
function nodeIdFromPipelineCte(name: string): string | null {
  if (!/^node_/i.test(name)) return null;
  const id = name.slice(5);
  return id || null;
}

function isStarSelectList(columns: unknown): boolean {
  if (columns === "*") return true;
  if (!Array.isArray(columns)) return false;
  return (
    columns.length === 1 &&
    isStar(columns[0].expr) &&
    !columns[0].as
  );
}

function parseLimitConfig(ast: AstNode): Record<string, number> | null | "bad" {
  const limitVals = Array.isArray(ast.limit?.value) ? ast.limit.value : [];
  if (!limitVals.length) return null;
  const nums = limitVals.map((v: AstNode) => {
    const n = Number(v?.value);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
    return n;
  });
  if (nums.some((n: number | null) => n == null)) return "bad";
  const sep = String(ast.limit?.seperator || "").toLowerCase();
  const config: Record<string, number> = {};
  if (nums.length === 1 && sep === "offset") {
    config.offset = nums[0]!;
  } else if (nums.length === 1) {
    config.limit = nums[0]!;
  } else if (nums.length >= 2) {
    config.limit = nums[0]!;
    config.offset = nums[1]!;
  }
  return config;
}

type FromRef =
  | { kind: "dataset"; datasetId: string }
  | { kind: "node"; nodeId: string };

function resolvePipelineFrom(
  table: string,
  knownCtes: Map<string, string>,
  tableIndex: Map<string, string>,
): FromRef | null {
  const raw = String(table).replaceAll('"', "");
  const cte = knownCtes.get(raw.toLowerCase());
  if (cte) return { kind: "node", nodeId: cte };
  const ds = resolveTable(raw, tableIndex);
  if (ds) return { kind: "dataset", datasetId: ds };
  return null;
}

/**
 * Map one compilePipeline CTE body to a single PipelineNode (forced id).
 * Returns null when the WITH list is not pipeline-shaped (caller refuses WITH).
 */
function cteBodyToNode(
  id: string,
  stmt: AstNode,
  knownCtes: Map<string, string>,
  tableIndex: Map<string, string>,
): SqlToNodesResult | { ok: true; node: PipelineNode } {
  if (!stmt || stmt.type !== "select") {
    return fail("Pipeline CTE must be a SELECT");
  }
  if (stmt.with) {
    return fail("Nested WITH inside pipeline CTEs is not supported");
  }
  if (stmt.having) return fail("HAVING is not supported in Visual conversion");
  if (stmt.orderby) return fail("ORDER BY is not supported in Visual conversion");
  if (stmt.window) {
    return fail("WINDOW clauses are not supported in Visual conversion");
  }
  if (stmt.set_op || stmt._next) {
    return fail("UNION / set operations are not supported in Visual conversion");
  }

  const from = stmt.from;
  if (!Array.isArray(from) || !from.length) {
    return fail("SELECT must include a FROM clause");
  }
  for (const f of from) {
    if (f.expr || f.table == null) {
      return fail("Subqueries in FROM are not supported in Visual conversion");
    }
  }

  const columns = stmt.columns;
  if (columns !== "*" && !Array.isArray(columns)) {
    return fail("Unsupported SELECT list");
  }
  if (Array.isArray(columns)) {
    for (const col of columns) {
      if (hasWindow(col.expr)) {
        return fail("Window functions are not supported in Visual conversion");
      }
    }
  }

  const limitCfg = parseLimitConfig(stmt);
  if (limitCfg === "bad") {
    return fail("LIMIT / OFFSET must be non-negative integers");
  }

  const distinct =
    stmt.distinct?.type &&
    String(stmt.distinct.type).toLowerCase() === "distinct";
  const star = isStarSelectList(columns);

  // Join CTE: FROM node_a a JOIN node_b b ON ...
  if (from.length > 1) {
    if (from.length !== 2 || !from[1].join) {
      return fail("Only a binary JOIN is supported in pipeline CTEs");
    }
    const joinType = String(from[1].join).toUpperCase();
    if (!joinType.includes("INNER") && !joinType.includes("LEFT")) {
      return fail(`Join type "${from[1].join}" is not supported in Visual conversion`);
    }
    if (!from[1].on) return fail("JOIN requires an ON condition");
    if (stmt.where || distinct || limitCfg || stmt.groupby?.columns?.length) {
      return fail("JOIN CTEs cannot also include WHERE / DISTINCT / LIMIT / GROUP BY");
    }
    const leftName = fromTableName(from[0]);
    const rightName = fromTableName(from[1]);
    const left = leftName
      ? resolvePipelineFrom(leftName, knownCtes, tableIndex)
      : null;
    const right = rightName
      ? resolvePipelineFrom(rightName, knownCtes, tableIndex)
      : null;
    if (!left || left.kind !== "node") {
      return fail(`Unknown join input "${leftName || from[0].table}"`);
    }
    if (!right || right.kind !== "node") {
      return fail(`Unknown join input "${rightName || from[1].table}"`);
    }
    const leftAliases = fromAliases(from[0]);
    const rightAliases = fromAliases(from[1]);
    const onMap = new Map<string, string | null>();
    for (const a of leftAliases) onMap.set(a, "a");
    for (const a of rightAliases) onMap.set(a, "b");
    // Default aliases a/b from compilePipeline.
    onMap.set("a", "a");
    onMap.set("b", "b");

    let select = "a.*, b.*";
    if (Array.isArray(columns) && !star) {
      const parts: string[] = [];
      for (const col of columns) {
        if (isStar(col.expr)) {
          const t = tableName(col.expr);
          if (!t || t.toLowerCase() === "a") parts.push("a.*");
          else if (t.toLowerCase() === "b") parts.push("b.*");
          else parts.push("a.*", "b.*");
          continue;
        }
        if (isColumnRef(col.expr)) {
          const name = colName(col.expr);
          const t = tableName(col.expr);
          if (!name || !t) return fail("Unsupported JOIN SELECT column");
          const side = t.toLowerCase() === "b" ? "b" : "a";
          parts.push(
            col.as && String(col.as) !== name
              ? `${side}.${name} AS "${String(col.as).replaceAll('"', '""')}"`
              : `${side}.${name}`,
          );
          continue;
        }
        return fail("Unsupported expression in JOIN SELECT list");
      }
      if (parts.length) select = parts.join(", ");
    }

    return {
      ok: true,
      node: {
        id,
        type: "join",
        inputs: [left.nodeId, right.nodeId],
        config: {
          joinType: joinType.includes("LEFT") ? "left" : "inner",
          on: exprSqlRewritten(from[1].on, onMap),
          select,
        },
      },
    };
  }

  const fromName = fromTableName(from[0]);
  if (!fromName) {
    return fail("SELECT must include a FROM table");
  }
  const ref = resolvePipelineFrom(fromName, knownCtes, tableIndex);
  if (!ref) {
    return fail(
      `Unknown table "${fromName}". Select it under Input datasets first.`,
    );
  }

  // Source CTE
  if (ref.kind === "dataset") {
    if (!star || stmt.where || distinct || limitCfg || stmt.groupby?.columns?.length) {
      return fail("Source CTEs must be SELECT * FROM <dataset>");
    }
    return { ok: true, node: sourceNode(id, ref.datasetId) };
  }

  const inputId = ref.nodeId;

  // Limit-only CTE
  if (limitCfg && star && !stmt.where && !distinct && !stmt.groupby?.columns?.length) {
    if (Array.isArray(columns) && columns.some((c) => !isStar(c.expr) && !isColumnRef(c.expr))) {
      return fail("LIMIT CTEs must be SELECT * FROM <node>");
    }
    return {
      ok: true,
      node: { id, type: "limit", inputs: [inputId], config: limitCfg },
    };
  }
  if (limitCfg) {
    return fail("LIMIT inside a transform CTE is not supported; put LIMIT on the outer SELECT");
  }

  // Filter
  if (stmt.where && star && !distinct && !stmt.groupby?.columns?.length) {
    if (hasWindow(stmt.where)) {
      return fail("Window functions are not supported in Visual conversion");
    }
    return {
      ok: true,
      node: {
        id,
        type: "filter",
        inputs: [inputId],
        config: { condition: exprSql(stmt.where) },
      },
    };
  }

  // Aggregate
  const groupCols: string[] = [];
  if (stmt.groupby?.columns?.length) {
    for (const g of stmt.groupby.columns) {
      const name = colName(g);
      if (!name) return fail("Unsupported GROUP BY expression");
      groupCols.push(name);
    }
  }
  if (groupCols.length || (Array.isArray(columns) && columns.some((c) => isAgg(c.expr)))) {
    if (!Array.isArray(columns) || star) {
      return fail("Aggregate queries need an explicit SELECT list");
    }
    if (stmt.where || distinct) {
      return fail("Combine WHERE/DISTINCT with aggregate in separate CTEs");
    }
    const metrics: Record<string, string> = {};
    for (const col of columns) {
      if (isAgg(col.expr)) {
        const alias = col.as ? String(col.as) : null;
        if (!alias) return fail("Aggregate expressions need an AS alias");
        metrics[alias] = exprSql(col.expr);
      } else if (isColumnRef(col.expr)) {
        const name = colName(col.expr);
        if (!name || !groupCols.includes(name)) {
          return fail("Non-aggregate SELECT columns must appear in GROUP BY");
        }
      } else {
        return fail("Unsupported expression in aggregate SELECT list");
      }
    }
    if (!Object.keys(metrics).length) {
      return fail("GROUP BY requires at least one aggregate metric");
    }
    return {
      ok: true,
      node: {
        id,
        type: "aggregate",
        inputs: [inputId],
        config: { groupBy: groupCols, metrics },
      },
    };
  }

  // Deduplicate
  if (distinct && star && !stmt.where) {
    return {
      ok: true,
      node: {
        id,
        type: "deduplicate",
        inputs: [inputId],
        config: { keys: [] },
      },
    };
  }

  // Derive: SELECT *, expr AS alias, ...
  if (Array.isArray(columns) && columns.some((c) => isStar(c.expr))) {
    const derived: Record<string, string> = {};
    let sawStar = false;
    for (const col of columns) {
      if (isStar(col.expr) && !col.as) {
        sawStar = true;
        continue;
      }
      if (!col.as) return fail("Derived expressions need an AS alias");
      if (isColumnRef(col.expr) || isCast(col.expr)) {
        // rename/cast mixed into derive list — treat as derive expr
      }
      derived[String(col.as)] = exprSql(col.expr);
    }
    if (sawStar && Object.keys(derived).length) {
      return {
        ok: true,
        node: {
          id,
          type: "derive",
          inputs: [inputId],
          config: { columns: derived },
        },
      };
    }
  }

  // Select / rename / cast (no star)
  if (Array.isArray(columns) && !star) {
    const onlyCols = columns.every((c) => isColumnRef(c.expr));
    const hasRename = columns.some(
      (c) => isColumnRef(c.expr) && c.as && String(c.as) !== colName(c.expr),
    );
    const hasCast = columns.some((c) => isCast(c.expr));
    const onlyCastOrCol = columns.every(
      (c) => isCast(c.expr) || isColumnRef(c.expr),
    );

    if (hasCast && onlyCastOrCol && !hasRename) {
      const castCols: Record<string, string> = {};
      for (const col of columns) {
        if (!isCast(col.expr)) continue;
        const target = col.expr.target?.[0]?.dataType || col.expr.as;
        const inner = colName(col.expr.expr);
        if (!inner || !target) return fail("Unsupported CAST expression");
        const outName = col.as ? String(col.as) : inner;
        if (outName !== inner) {
          return fail("CAST with rename is not supported; cast in place only");
        }
        castCols[inner] = String(target);
      }
      return {
        ok: true,
        node: {
          id,
          type: "cast",
          inputs: [inputId],
          config: { columns: castCols },
        },
      };
    }

    if (onlyCols && hasRename) {
      const mapping: Record<string, string> = {};
      for (const col of columns) {
        const name = colName(col.expr);
        if (!name) return fail("Unsupported column reference");
        if (col.as && String(col.as) !== name) mapping[name] = String(col.as);
      }
      // compilePipeline rename is SELECT * RENAME — may not round-trip as column list.
      // Prefer rename node when every column is a rename mapping entry only is wrong;
      // use select+rename is multi-node. Single CTE → rename if we only have mappings
      // from a * style... For column list with renames, use type sql fallback message:
      return {
        ok: true,
        node: {
          id,
          type: "rename",
          inputs: [inputId],
          config: { mapping },
        },
      };
    }

    if (onlyCols) {
      const names = columns.map((c) => colName(c.expr));
      if (names.some((n) => !n)) return fail("Unsupported column reference");
      return {
        ok: true,
        node: {
          id,
          type: "select",
          inputs: [inputId],
          config: { columns: names as string[] },
        },
      };
    }
  }

  // Passthrough SELECT * (identity) — refuse; should not appear as a CTE
  if (star && !stmt.where && !distinct) {
    return fail(`Could not map pipeline CTE "${id}" to a visual node`);
  }

  return fail(`Could not map pipeline CTE "${id}" to a visual node`);
}

/**
 * Reverse compilePipeline SQL: WITH "node_*" AS (...) SELECT * FROM "node_leaf" [LIMIT].
 * Returns null only when WITH is not pipeline-shaped (caller shows the generic WITH error).
 * Once any CTE matches node_*, failures are specific SqlToNodesResult errors — never null.
 */
function convertPipelineWith(
  ast: AstNode,
  datasets: Resource[],
  inputIds: string[],
): SqlToNodesResult | null {
  const withList = Array.isArray(ast.with) ? ast.with : null;
  if (!withList?.length) return null;

  const names = withList.map((cte) => cteNameOf(cte));
  if (names.some((n) => !n)) return null;
  const ids = names.map((n) => nodeIdFromPipelineCte(n!));
  const pipelineCount = ids.filter(Boolean).length;
  if (pipelineCount === 0) return null;
  if (pipelineCount < withList.length) {
    return fail(
      "Mixed pipeline and non-pipeline WITH CTEs cannot convert to Visual",
    );
  }

  const cteMeta: { name: string; id: string; stmt: AstNode }[] = [];
  for (let i = 0; i < withList.length; i++) {
    const stmt = cteSelectStmt(withList[i]);
    if (!stmt) {
      return fail(`Pipeline CTE "${names[i]}" must be a SELECT`);
    }
    cteMeta.push({ name: names[i]!, id: ids[i]!, stmt });
  }

  // Outer must be SELECT * FROM node_leaf [LIMIT/OFFSET] with no other clauses.
  if (ast.having || ast.orderby || ast.window || ast.set_op || ast._next) {
    return fail(
      "Compiled pipeline SQL must end with SELECT * FROM the output node",
    );
  }
  if (ast.where || ast.groupby?.columns?.length) {
    return fail(
      "Compiled pipeline SQL must end with SELECT * FROM the output node",
    );
  }
  const outerFrom = ast.from;
  if (!Array.isArray(outerFrom) || outerFrom.length !== 1 || outerFrom[0].join) {
    return fail(
      "Compiled pipeline SQL must end with SELECT * FROM the output node",
    );
  }
  if (!isStarSelectList(ast.columns)) {
    return fail(
      "Compiled pipeline SQL must end with SELECT * FROM the output node",
    );
  }
  const leafCte = fromTableName(outerFrom[0]);
  const leafId = leafCte ? nodeIdFromPipelineCte(leafCte) : null;
  if (!leafId || !cteMeta.some((c) => c.id === leafId)) {
    return fail(
      "Compiled pipeline SQL must SELECT * FROM the final node_* CTE",
    );
  }

  const outerLimit = parseLimitConfig(ast);
  if (outerLimit === "bad") {
    return fail("LIMIT / OFFSET must be non-negative integers");
  }

  const tableIndex = buildTableIndex(datasets, inputIds);
  const knownCtes = new Map<string, string>();
  const usedIds = new Set<string>();
  const nodes: PipelineNode[] = [];

  for (const cte of cteMeta) {
    if (usedIds.has(cte.id)) {
      return fail(`Duplicate pipeline node id "${cte.id}"`);
    }
    const mapped = cteBodyToNode(cte.id, cte.stmt, knownCtes, tableIndex);
    if (!("node" in mapped)) return mapped;
    usedIds.add(cte.id);
    nodes.push(mapped.node);
    knownCtes.set(cte.name.toLowerCase(), cte.id);
    knownCtes.set(`node_${cte.id}`.toLowerCase(), cte.id);
  }

  let currentId = leafId;
  if (outerLimit) {
    const limitId = nextId("limit", usedIds);
    nodes.push({
      id: limitId,
      type: "limit",
      inputs: [currentId],
      config: outerLimit,
    });
    currentId = limitId;
  }
  void currentId;

  const compiled = tryCompile(nodes);
  if (!compiled.ok) {
    return fail("Converted graph is invalid: " + compiled.error);
  }
  return { ok: true, nodes };
}

/**
 * Convert a single SELECT into pipeline nodes.
 * datasets: available datasets; inputIds: currently selected inputs (preferred).
 */
export function sqlToNodes(
  sql: string,
  datasets: Resource[],
  inputIds: string[] = [],
): SqlToNodesResult {
  const trimmed = sql.trim().replace(/;+\s*$/, "");
  if (!trimmed) return fail("SQL is empty");
  if (/;\s*\S/.test(trimmed)) return fail("Multiple SQL statements are not supported");

  let ast: AstNode;
  try {
    const parsed = parser.astify(trimmed, OPT);
    ast = (Array.isArray(parsed) ? parsed[0] : parsed) as AstNode;
  } catch (e) {
    return fail("Could not parse SQL: " + (e as Error).message);
  }

  if (!ast || ast.type !== "select") {
    return fail("Only a single SELECT statement can be converted to Visual");
  }
  if (ast.with || (Array.isArray(ast.with) && ast.with.length)) {
    const pipeline = convertPipelineWith(ast, datasets, inputIds);
    if (pipeline) return pipeline;
    return fail("WITH clauses are not supported in Visual conversion");
  }
  if (ast.having) return fail("HAVING is not supported in Visual conversion");
  if (ast.orderby) return fail("ORDER BY is not supported in Visual conversion");
  if (ast.window) return fail("WINDOW clauses are not supported in Visual conversion");
  if (ast.set_op || ast._next) {
    return fail("UNION / set operations are not supported in Visual conversion");
  }
  if (ast.distinct?.type && String(ast.distinct.type).toLowerCase() === "distinct") {
    // handled later as deduplicate when select is *
  }

  const from = ast.from;
  if (!Array.isArray(from) || !from.length) {
    return fail("SELECT must include a FROM clause");
  }

  for (const f of from) {
    if (f.expr || f.table == null) {
      return fail("Subqueries in FROM are not supported in Visual conversion");
    }
  }

  const columns = ast.columns;
  if (columns !== "*" && !Array.isArray(columns)) {
    return fail("Unsupported SELECT list");
  }
  if (Array.isArray(columns)) {
    for (const col of columns) {
      if (hasWindow(col.expr)) {
        return fail("Window functions are not supported in Visual conversion");
      }
    }
  }

  const tableIndex = buildTableIndex(datasets, inputIds);
  const usedIds = new Set<string>();
  const nodes: PipelineNode[] = [];

  // Build sources + joins from FROM list.
  const from0 = from[0];
  const firstDs = resolveTable(String(from0.table), tableIndex);
  if (!firstDs) {
    return fail(
      `Unknown table "${from0.table}". Select it under Input datasets first.`,
    );
  }
  const firstSourceId = nextId("source", usedIds);
  nodes.push(sourceNode(firstSourceId, firstDs));
  let currentId = firstSourceId;

  /** Aliases currently on the left (accumulated) side of the next join. */
  const leftAliases = new Set<string>(fromAliases(from0));
  /** Every FROM alias/table name seen (for post-join strip maps). */
  const allAliases = new Set<string>(leftAliases);
  let lastRightAliases = new Set<string>();
  let lastJoinId: string | null = null;

  for (let i = 1; i < from.length; i++) {
    const f = from[i];
    if (!f.join) {
      return fail("Multiple FROM tables without JOIN are not supported");
    }
    const joinType = String(f.join).toUpperCase();
    if (!joinType.includes("INNER") && !joinType.includes("LEFT")) {
      return fail(`Join type "${f.join}" is not supported in Visual conversion`);
    }
    const rightDs = resolveTable(String(f.table), tableIndex);
    if (!rightDs) {
      return fail(
        `Unknown table "${f.table}". Select it under Input datasets first.`,
      );
    }
    if (!f.on) return fail("JOIN requires an ON condition");
    const rightAliases = fromAliases(f);
    const onMap = new Map<string, string | null>();
    for (const a of leftAliases) onMap.set(a, "a");
    for (const a of rightAliases) onMap.set(a, "b");
    const rightId = nextId("source", usedIds);
    nodes.push(sourceNode(rightId, rightDs));
    const joinId = nextId("join", usedIds);
    nodes.push({
      id: joinId,
      type: "join",
      inputs: [currentId, rightId],
      config: {
        joinType: joinType.includes("LEFT") ? "left" : "inner",
        on: exprSqlRewritten(f.on, onMap),
        select: "a.*, b.*",
      },
    });
    currentId = joinId;
    lastJoinId = joinId;
    lastRightAliases = new Set(rightAliases);
    for (const a of rightAliases) {
      allAliases.add(a);
      leftAliases.add(a);
    }
  }

  /** compilePipeline join aliases: last right → b, everything else → a. */
  const sideMap = new Map<string, "a" | "b">();
  for (const a of allAliases) {
    sideMap.set(a, lastRightAliases.has(a) ? "b" : "a");
  }
  /** Downstream CTEs have no table aliases — strip all FROM qualifiers. */
  const stripMap = new Map<string, string | null>();
  for (const a of allAliases) stripMap.set(a, null);

  if (ast.where) {
    if (hasWindow(ast.where)) {
      return fail("Window functions are not supported in Visual conversion");
    }
    const filterId = nextId("filter", usedIds);
    nodes.push({
      id: filterId,
      type: "filter",
      inputs: [currentId],
      config: { condition: exprSqlRewritten(ast.where, stripMap) },
    });
    currentId = filterId;
  }

  const distinct =
    ast.distinct?.type &&
    String(ast.distinct.type).toLowerCase() === "distinct";

  const groupCols: string[] = [];
  if (ast.groupby?.columns?.length) {
    for (const g of ast.groupby.columns) {
      const name = colName(g);
      if (!name) return fail("Unsupported GROUP BY expression");
      groupCols.push(name);
    }
  }

  const isStarSelect =
    columns === "*" ||
    (Array.isArray(columns) &&
      columns.length === 1 &&
      isStar(columns[0].expr) &&
      !columns[0].as);

  if (groupCols.length || (Array.isArray(columns) && columns.some((c) => isAgg(c.expr)))) {
    if (!Array.isArray(columns) || isStarSelect) {
      return fail("Aggregate queries need an explicit SELECT list");
    }
    const metrics: Record<string, string> = {};
    for (const col of columns) {
      if (isAgg(col.expr)) {
        if (col.expr.over) {
          return fail("Window functions are not supported in Visual conversion");
        }
        const alias = col.as ? String(col.as) : null;
        if (!alias) return fail("Aggregate expressions need an AS alias");
        metrics[alias] = exprSqlRewritten(col.expr, stripMap);
      } else if (isColumnRef(col.expr)) {
        const name = colName(col.expr);
        if (!name || !groupCols.includes(name)) {
          return fail(
            "Non-aggregate SELECT columns must appear in GROUP BY",
          );
        }
        if (col.as && String(col.as) !== name) {
          return fail("Renaming GROUP BY columns is not supported in Visual conversion");
        }
      } else {
        return fail("Unsupported expression in aggregate SELECT list");
      }
    }
    if (!Object.keys(metrics).length) {
      return fail("GROUP BY requires at least one aggregate metric");
    }
    const aggId = nextId("aggregate", usedIds);
    nodes.push({
      id: aggId,
      type: "aggregate",
      inputs: [currentId],
      config: { groupBy: groupCols, metrics },
    });
    currentId = aggId;
  } else if (!isStarSelect && Array.isArray(columns)) {
    const onlyCols = columns.every((c) => isColumnRef(c.expr));
    const hasRename = columns.some(
      (c) => isColumnRef(c.expr) && c.as && String(c.as) !== colName(c.expr),
    );
    const hasCast = columns.some((c) => isCast(c.expr));
    const hasDerive = columns.some(
      (c) => !isColumnRef(c.expr) && !isCast(c.expr) && !isStar(c.expr),
    );
    const onlyCastOrCol = columns.every(
      (c) => isCast(c.expr) || isColumnRef(c.expr),
    );

    if (hasDerive || (lastJoinId && hasRename && !hasCast)) {
      const derived: Record<string, string> = {};
      const joinSelectParts: string[] = [];
      let leftStar = false;
      let rightStar = false;
      let bareCount = 0;
      /** col name → side seen in post-join stripped exprs (ambiguity check). */
      const strippedSides = new Map<string, Set<string>>();

      const noteStripped = (expr: AstNode) => {
        const walk = (node: unknown): void => {
          if (!node || typeof node !== "object") return;
          if (Array.isArray(node)) {
            node.forEach(walk);
            return;
          }
          const n = node as AstNode;
          if (n.type === "column_ref") {
            const name = colName(n);
            const t = tableName(n);
            if (name && t && sideMap.has(t.toLowerCase())) {
              const side = sideMap.get(t.toLowerCase())!;
              const set = strippedSides.get(name) || new Set();
              set.add(side);
              strippedSides.set(name, set);
            }
          }
          for (const v of Object.values(n)) walk(v);
        };
        walk(expr);
      };

      for (const col of columns) {
        if (isStar(col.expr)) {
          bareCount += 1;
          const t = tableName(col.expr);
          if (!t) {
            leftStar = true;
            rightStar = true;
          } else if (sideMap.get(t.toLowerCase()) === "b") {
            rightStar = true;
          } else {
            leftStar = true;
          }
          continue;
        }
        if (
          lastJoinId &&
          isColumnRef(col.expr) &&
          col.as &&
          String(col.as) !== colName(col.expr)
        ) {
          const name = colName(col.expr);
          const t = tableName(col.expr);
          if (!name || !t || !sideMap.has(t.toLowerCase())) {
            return fail("Unsupported qualified column rename in JOIN SELECT");
          }
          const side = sideMap.get(t.toLowerCase())!;
          joinSelectParts.push(
            `${side}.${name} AS "${String(col.as).replaceAll('"', '""')}"`,
          );
          continue;
        }
        if (isColumnRef(col.expr) && !col.as) {
          bareCount += 1;
          continue;
        }
        if (!col.as) return fail("Derived expressions need an AS alias");
        noteStripped(col.expr);
        derived[String(col.as)] = exprSqlRewritten(col.expr, stripMap);
      }

      for (const [name, sides] of strippedSides) {
        if (sides.size > 1) {
          return fail(
            `Column "${name}" is referenced from both join sides; give each an AS alias in the JOIN SELECT list`,
          );
        }
      }

      if (lastJoinId && joinSelectParts.length) {
        const joinNode = nodes.find((n) => n.id === lastJoinId);
        if (joinNode) {
          const selectParts: string[] = [];
          if (leftStar || bareCount > 0) selectParts.push("a.*");
          if (rightStar) selectParts.push("b.*");
          if (!selectParts.length) selectParts.push("a.*");
          selectParts.push(...joinSelectParts);
          joinNode.config.select = selectParts.join(", ");
        }
      }

      if (!Object.keys(derived).length && !joinSelectParts.length) {
        return fail("Could not map SELECT expressions");
      }
      if (bareCount === 0 && !joinSelectParts.length) {
        return fail(
          "SELECT lists that only contain expressions (no bare columns) are not supported",
        );
      }
      if (Object.keys(derived).length) {
        const deriveId = nextId("derive", usedIds);
        nodes.push({
          id: deriveId,
          type: "derive",
          inputs: [currentId],
          config: { columns: derived },
        });
        currentId = deriveId;
      }
    } else if (hasCast && onlyCastOrCol) {
      const castCols: Record<string, string> = {};
      for (const col of columns) {
        if (!isCast(col.expr)) continue;
        const target = col.expr.target?.[0]?.dataType || col.expr.as;
        const inner = colName(col.expr.expr);
        if (!inner || !target) return fail("Unsupported CAST expression");
        const outName = col.as ? String(col.as) : inner;
        if (outName !== inner) {
          return fail("CAST with rename is not supported; cast in place only");
        }
        castCols[inner] = String(target);
      }
      if (!Object.keys(castCols).length) {
        return fail("No CAST columns found");
      }
      const castId = nextId("cast", usedIds);
      nodes.push({
        id: castId,
        type: "cast",
        inputs: [currentId],
        config: { columns: castCols },
      });
      currentId = castId;
    } else if (onlyCols && hasRename) {
      const mapping: Record<string, string> = {};
      const sourceCols: string[] = [];
      for (const col of columns) {
        const name = colName(col.expr);
        if (!name) return fail("Unsupported column reference");
        sourceCols.push(name);
        if (col.as && String(col.as) !== name) mapping[name] = String(col.as);
      }
      const selectId = nextId("select", usedIds);
      nodes.push({
        id: selectId,
        type: "select",
        inputs: [currentId],
        config: { columns: sourceCols },
      });
      currentId = selectId;
      const renameId = nextId("rename", usedIds);
      nodes.push({
        id: renameId,
        type: "rename",
        inputs: [currentId],
        config: { mapping },
      });
      currentId = renameId;
    } else if (onlyCols) {
      const names = columns.map((c) => colName(c.expr));
      if (names.some((n) => !n)) return fail("Unsupported column reference");
      const selectId = nextId("select", usedIds);
      nodes.push({
        id: selectId,
        type: "select",
        inputs: [currentId],
        config: { columns: names as string[] },
      });
      currentId = selectId;
    } else {
      return fail("Unsupported SELECT list for Visual conversion");
    }
  }

  if (distinct) {
    if (!isStarSelect && !(Array.isArray(columns) && columns.every((c) => isColumnRef(c.expr)))) {
      return fail("DISTINCT is only supported with simple column lists or SELECT *");
    }
    const dedupId = nextId("dedup", usedIds);
    const keys =
      isStarSelect || columns === "*"
        ? []
        : (columns as AstNode[]).map((c) => colName(c.expr)!);
    nodes.push({
      id: dedupId,
      type: "deduplicate",
      inputs: [currentId],
      config: { keys },
    });
    currentId = dedupId;
  }

  const limitCfg = parseLimitConfig(ast);
  if (limitCfg === "bad") {
    return fail("LIMIT / OFFSET must be non-negative integers");
  }
  if (limitCfg) {
    const limitId = nextId("limit", usedIds);
    nodes.push({
      id: limitId,
      type: "limit",
      inputs: [currentId],
      config: limitCfg,
    });
    currentId = limitId;
  }

  void currentId;

  const compiled = tryCompile(nodes);
  if (!compiled.ok) {
    return fail("Converted graph is invalid: " + compiled.error);
  }

  return { ok: true, nodes };
}
