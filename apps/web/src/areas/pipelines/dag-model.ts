// Pure helpers for the visual DAG editor: node catalog, defaults, and
// PipelineNode graph ↔ React Flow conversion (no React imports).
import {
  compilePipeline,
  type PipelineNode,
} from "../../../../../packages/shared/src/pipeline.js";

export type NodeType = PipelineNode["type"];

export const NODE_CATALOG: {
  type: NodeType;
  label: string;
  hint: string;
}[] = [
  { type: "source", label: "Source", hint: "Read a dataset" },
  { type: "select", label: "Select", hint: "Keep columns" },
  { type: "filter", label: "Filter", hint: "WHERE condition" },
  { type: "rename", label: "Rename", hint: "Rename columns" },
  { type: "cast", label: "Cast", hint: "Change types" },
  { type: "derive", label: "Derive", hint: "Add expressions" },
  { type: "deduplicate", label: "Deduplicate", hint: "Drop duplicate rows" },
  { type: "join", label: "Join", hint: "Combine two inputs" },
  { type: "aggregate", label: "Aggregate", hint: "Group and measure" },
  { type: "limit", label: "Limit", hint: "Cap rows (LIMIT / OFFSET)" },
  { type: "sql", label: "SQL", hint: "Custom SELECT CTE" },
];

/** CSS custom property for legend dots, node accents, and MiniMap fills. */
export function nodeTypeHueVar(type: NodeType): string {
  return `var(--pp-node-${type})`;
}

export function defaultConfig(type: NodeType): Record<string, unknown> {
  switch (type) {
    case "select":
      return { columns: ["*"] };
    case "rename":
      return { mapping: {} };
    case "cast":
      return { columns: {} };
    case "filter":
      return { condition: "true" };
    case "derive":
      return { columns: {} };
    case "deduplicate":
      return { keys: [] };
    case "join":
      return { on: "a.id = b.id", joinType: "inner", select: "a.*, b.*" };
    case "aggregate":
      return { groupBy: [], metrics: { n: "count(*)" } };
    case "limit":
      return { limit: 100 };
    default:
      return {};
  }
}

export function createPipelineNode(
  type: NodeType,
  id: string,
  datasetId?: string,
): PipelineNode {
  return {
    id,
    type,
    inputs: [],
    config: defaultConfig(type),
    ...(type === "source" && datasetId ? { datasetId } : {}),
    ...(type === "sql" ? { sql: "SELECT 1" } : {}),
  };
}

export function nextNodeId(nodes: PipelineNode[], type: NodeType): string {
  const base = type === "deduplicate" ? "dedup" : type;
  let n = 1;
  const used = new Set(nodes.map((x) => x.id));
  while (used.has(`${base}_${n}`)) n += 1;
  return `${base}_${n}`;
}

export type FlowPosition = { x: number; y: number };

const LAYOUT_ORIGIN_X = 48;
const LAYOUT_ORIGIN_Y = 48;
const LAYOUT_COL_GAP = 240;
const LAYOUT_ROW_GAP = 130;

export function defaultPosition(
  index: number,
  positions: Record<string, FlowPosition>,
  id: string,
): FlowPosition {
  if (positions[id]) return positions[id];
  const col = index % 4;
  const row = Math.floor(index / 4);
  return {
    x: LAYOUT_ORIGIN_X + col * LAYOUT_COL_GAP,
    y: LAYOUT_ORIGIN_Y + row * LAYOUT_ROW_GAP,
  };
}

/** Copy canvas positions onto nodes for durable draft/publish storage. */
export function withPositions(
  nodes: PipelineNode[],
  positions: Record<string, FlowPosition>,
): PipelineNode[] {
  let changed = false;
  const next = nodes.map((n) => {
    const p = positions[n.id];
    if (!p) return n;
    if (n.position?.x === p.x && n.position?.y === p.y) return n;
    changed = true;
    return { ...n, position: { x: p.x, y: p.y } };
  });
  return changed ? next : nodes;
}

export function positionsFromNodes(
  nodes: PipelineNode[],
): Record<string, FlowPosition> {
  const out: Record<string, FlowPosition> = {};
  for (const n of nodes) {
    if (n.position) out[n.id] = { x: n.position.x, y: n.position.y };
  }
  return out;
}

/**
 * Layered left-to-right layout by dependency rank so joins fan in from
 * stacked sources instead of sitting in a flat index row.
 */
export function layoutPipeline(
  nodes: PipelineNode[],
): Record<string, FlowPosition> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ranks = new Map<string, number>();

  const rankOf = (id: string, stack: Set<string>): number => {
    if (ranks.has(id)) return ranks.get(id)!;
    if (stack.has(id)) return 0;
    const n = byId.get(id);
    if (!n || !n.inputs.length) {
      ranks.set(id, 0);
      return 0;
    }
    stack.add(id);
    let max = 0;
    for (const input of n.inputs) {
      if (byId.has(input)) max = Math.max(max, rankOf(input, stack));
    }
    stack.delete(id);
    const r = max + 1;
    ranks.set(id, r);
    return r;
  };

  for (const n of nodes) rankOf(n.id, new Set());

  const columns = new Map<number, string[]>();
  for (const n of nodes) {
    const r = ranks.get(n.id) ?? 0;
    const col = columns.get(r) || [];
    col.push(n.id);
    columns.set(r, col);
  }
  for (const ids of columns.values()) ids.sort((a, b) => a.localeCompare(b));

  let maxColHeight = 0;
  for (const ids of columns.values()) {
    maxColHeight = Math.max(
      maxColHeight,
      ids.length * LAYOUT_ROW_GAP - (ids.length ? LAYOUT_ROW_GAP : 0),
    );
  }

  const out: Record<string, FlowPosition> = {};
  for (const [rank, ids] of columns) {
    const colHeight =
      ids.length * LAYOUT_ROW_GAP - (ids.length ? LAYOUT_ROW_GAP : 0);
    const y0 = LAYOUT_ORIGIN_Y + Math.max(0, (maxColHeight - colHeight) / 2);
    ids.forEach((id, i) => {
      out[id] = {
        x: LAYOUT_ORIGIN_X + rank * LAYOUT_COL_GAP,
        y: y0 + i * LAYOUT_ROW_GAP,
      };
    });
  }
  return out;
}

export function maxInputsFor(type: NodeType): number {
  if (type === "source") return 0;
  if (type === "join") return 2;
  return 1;
}

export function canAcceptInput(
  nodes: PipelineNode[],
  targetId: string,
  sourceId: string,
): boolean {
  if (sourceId === targetId) return false;
  const target = nodes.find((n) => n.id === targetId);
  const source = nodes.find((n) => n.id === sourceId);
  if (!target || !source) return false;
  if (target.inputs.includes(sourceId)) return false;
  const max = maxInputsFor(target.type);
  if (max === 0) return false;
  // Single-input nodes replace the prior edge; joins fill up to two.
  if (max === 1) return true;
  return target.inputs.length < max;
}

/** Connect source → target (appends to target.inputs unless already linked). */
export function connectNodes(
  nodes: PipelineNode[],
  sourceId: string,
  targetId: string,
): PipelineNode[] {
  if (!canAcceptInput(nodes, targetId, sourceId)) return nodes;
  return nodes.map((n) => {
    if (n.id !== targetId) return n;
    const maxInputs = maxInputsFor(n.type);
    const inputs =
      maxInputs === 1 ? [sourceId] : [...n.inputs, sourceId].slice(0, 2);
    return { ...n, inputs };
  });
}

/**
 * Resolve a React Flow connection. Accepts either drag direction so users can
 * start from either handle; prefers the orientation that the graph can accept.
 */
export function resolveConnection(
  nodes: PipelineNode[],
  a: string,
  b: string,
): PipelineNode[] {
  if (canAcceptInput(nodes, b, a)) return connectNodes(nodes, a, b);
  if (canAcceptInput(nodes, a, b)) return connectNodes(nodes, b, a);
  return nodes;
}

export function disconnectEdge(
  nodes: PipelineNode[],
  sourceId: string,
  targetId: string,
): PipelineNode[] {
  return nodes.map((n) =>
    n.id === targetId
      ? { ...n, inputs: n.inputs.filter((id) => id !== sourceId) }
      : n,
  );
}

export function updateNode(
  nodes: PipelineNode[],
  id: string,
  patch: Partial<PipelineNode>,
): PipelineNode[] {
  return nodes.map((n) => (n.id === id ? { ...n, ...patch } : n));
}

export function removeNode(nodes: PipelineNode[], id: string): PipelineNode[] {
  return nodes
    .filter((n) => n.id !== id)
    .map((n) => ({ ...n, inputs: n.inputs.filter((x) => x !== id) }));
}

export function parseCsvList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseMapping(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const i = trimmed.indexOf(":");
    if (i <= 0) continue;
    const key = trimmed.slice(0, i).trim();
    const val = trimmed.slice(i + 1).trim();
    if (key && val) out[key] = val;
  }
  return out;
}

export function formatMapping(map: Record<string, string> | undefined): string {
  return Object.entries(map || {})
    .map(([k, v]) => `${k}:${v}`)
    .join(", ");
}

export type CompileResult =
  | { ok: true; sql: string; inputs: string[] }
  | { ok: false; error: string };

export function nodeDisplayLabel(
  nodes: PipelineNode[],
  id: string,
): string {
  const node = nodes.find((n) => n.id === id);
  if (!node) return id;
  const typeLabel =
    NODE_CATALOG.find((c) => c.type === node.type)?.label || node.type;
  const sameType = nodes.filter((n) => n.type === node.type);
  return sameType.length > 1 ? `${typeLabel} (${id})` : typeLabel;
}

/** Rewrite compile errors that embed node ids into human labels. */
export function friendlyCompileError(
  nodes: PipelineNode[],
  message: string,
): string {
  let out = message;
  const ids = [...new Set(nodes.map((n) => n.id))].sort(
    (a, b) => b.length - a.length,
  );
  for (const id of ids) {
    if (!out.includes(id)) continue;
    out = out.split(id).join(nodeDisplayLabel(nodes, id));
  }
  return out;
}

/** Incomplete graph while authoring — show as a hint, not a hard error. */
export function isBuildingHint(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("add at least one node") ||
    m.includes("connect an input") ||
    m.includes("select a source dataset") ||
    m.includes("join needs two inputs") ||
    m.includes("connect every branch") ||
    m.includes("one output node")
  );
}

export function tryCompile(nodes: PipelineNode[]): CompileResult {
  if (!nodes.length) return { ok: false, error: "Add at least one node" };
  try {
    const result = compilePipeline(nodes);
    return { ok: true, sql: result.sql, inputs: result.inputs };
  } catch (e) {
    return {
      ok: false,
      error: friendlyCompileError(nodes, (e as Error).message),
    };
  }
}

/** When clean, push compiled sql/inputs from the graph into the SQL tab. */
export function applyVisualToSql(
  nodes: PipelineNode[],
  sqlDirty: boolean,
  current: { sql: string; inputs: string[] },
): { sql: string; inputs: string[]; applied: boolean; error?: string } {
  if (sqlDirty) {
    return { ...current, applied: false };
  }
  const compiled = tryCompile(nodes);
  if (!compiled.ok) {
    return { ...current, applied: false, error: compiled.error };
  }
  return {
    sql: compiled.sql,
    inputs: compiled.inputs,
    applied: true,
  };
}

/** True when saved SQL already matches a successful compile of saved nodes. */
export function isSqlInSyncWithNodes(
  nodes: PipelineNode[],
  sql: string,
): boolean {
  if (!nodes.length) return true;
  const compiled = tryCompile(nodes);
  return compiled.ok && compiled.sql === sql;
}
