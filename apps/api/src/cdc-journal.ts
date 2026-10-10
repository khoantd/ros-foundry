import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { config } from "./config.js";

export const MAX_DELTA_OPS = 50_000;
export const MAX_DELTA_RATIO = 0.1;

export type CdcOpKind = "insert" | "update" | "delete" | "truncate" | "ddl";

export type CdcOp = {
  change: number;
  op: CdcOpKind;
  keys?: Record<string, unknown>;
  row?: Record<string, unknown>;
};

const safePart = (s: string) => /^[a-zA-Z0-9_-]{1,100}$/.test(s);

export function journalDir(scope: string, sourceId: string, root = config.dataDir) {
  if (!safePart(scope) || !safePart(sourceId))
    throw new Error("Invalid CDC journal identity");
  return resolve(root, "cdc", scope, sourceId);
}

const journalPath = (scope: string, sourceId: string, root = config.dataDir) =>
  resolve(journalDir(scope, sourceId, root), "ops.jsonl");

const serialize = (value: unknown) =>
  JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));

export function keyFields(
  row: Record<string, unknown> | null | undefined,
  keys: string[],
): Record<string, unknown> | undefined {
  if (!row || !keys.length) return undefined;
  return Object.fromEntries(keys.map((k) => [k, row[k]]));
}

export async function appendJournalOps(
  scope: string,
  sourceId: string,
  change: number,
  ops: Omit<CdcOp, "change">[],
  root = config.dataDir,
) {
  if (!ops.length) return;
  const dir = journalDir(scope, sourceId, root);
  await mkdir(dir, { recursive: true });
  const lines =
    ops.map((op) => serialize({ ...op, change })).join("\n") + "\n";
  const path = journalPath(scope, sourceId, root);
  const handle = await open(path, "a");
  try {
    await handle.write(lines);
  } finally {
    await handle.close();
  }
}

export async function readJournalOps(
  scope: string,
  sourceId: string,
  fromChange: number,
  throughChange: number,
  root = config.dataDir,
): Promise<CdcOp[]> {
  const path = journalPath(scope, sourceId, root);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
  const ops: CdcOp[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const op = JSON.parse(line) as CdcOp;
    if (op.change > fromChange && op.change <= throughChange) ops.push(op);
  }
  return ops;
}

export async function pruneJournal(
  scope: string,
  sourceId: string,
  throughChange: number,
  root = config.dataDir,
) {
  const path = journalPath(scope, sourceId, root);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return;
    throw e;
  }
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const op = JSON.parse(line) as CdcOp;
    if (op.change > throughChange) kept.push(serialize(op));
  }
  const tmp = path + ".tmp";
  await writeFile(tmp, kept.length ? kept.join("\n") + "\n" : "");
  await rename(tmp, path);
}

export function coalesceOps(ops: CdcOp[], keys: string[]) {
  type State =
    | { kind: "upsert"; row: Record<string, unknown> }
    | { kind: "delete"; keys: Record<string, unknown> };
  const order: string[] = [];
  const state = new Map<string, State>();
  const idOf = (k: Record<string, unknown>) =>
    JSON.stringify(keys.map((c) => k[c]));

  for (const op of ops) {
    if (op.op === "truncate" || op.op === "ddl")
      throw new Error("CDC op requires full snapshot");
    if (op.op === "insert") {
      if (!op.row) throw new Error("insert missing row");
      const k = keyFields(op.row, keys);
      if (!k) throw new Error("insert missing keys");
      const id = idOf(k);
      if (!state.has(id)) order.push(id);
      state.set(id, { kind: "upsert", row: op.row });
    } else if (op.op === "update") {
      if (!op.row) throw new Error("update missing row");
      const next = keyFields(op.row, keys);
      if (!next) throw new Error("update missing keys");
      if (op.keys && idOf(op.keys) !== idOf(next)) {
        const oldId = idOf(op.keys);
        if (!state.has(oldId)) order.push(oldId);
        state.set(oldId, { kind: "delete", keys: op.keys });
      }
      const id = idOf(next);
      if (!state.has(id)) order.push(id);
      state.set(id, { kind: "upsert", row: op.row });
    } else if (op.op === "delete") {
      if (!op.keys) throw new Error("delete missing keys");
      const id = idOf(op.keys);
      if (!state.has(id)) order.push(id);
      state.set(id, { kind: "delete", keys: op.keys });
    }
  }

  const deletes: Record<string, unknown>[] = [];
  const upserts: Record<string, unknown>[] = [];
  for (const id of order) {
    const s = state.get(id)!;
    if (s.kind === "delete") deletes.push(s.keys);
    else upserts.push(s.row);
  }
  return { deletes, upserts };
}

export function canApplyDeltas(
  ops: CdcOp[],
  applied: number,
  changeCounter: number,
  keys: string[] | undefined,
  rowCount?: number,
) {
  if (!keys?.length) return false;
  if (changeCounter <= applied) return false;
  if (!ops.length) return false;
  if (ops.some((o) => o.op === "truncate" || o.op === "ddl")) return false;
  if (ops.length > MAX_DELTA_OPS) return false;
  if (rowCount && ops.length >= Math.max(1, Math.floor(rowCount * MAX_DELTA_RATIO)))
    return false;
  const seen = new Set(ops.map((o) => o.change));
  for (let c = applied + 1; c <= changeCounter; c++)
    if (!seen.has(c)) return false;
  return true;
}
