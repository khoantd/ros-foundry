import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendJournalOps,
  canApplyDeltas,
  coalesceOps,
  pruneJournal,
  readJournalOps,
  MAX_DELTA_OPS,
} from "../apps/api/src/cdc-journal.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "foundry-cdc-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe("CDC journal", () => {
  it("appends, reads by change watermark, and prunes applied ops", async () => {
    await appendJournalOps(
      "ws",
      "source",
      1,
      [
        { op: "insert", row: { id: 1, label: "a" }, keys: { id: 1 } },
        { op: "update", row: { id: 1, label: "b" }, keys: { id: 1 } },
      ],
      root,
    );
    await appendJournalOps(
      "ws",
      "source",
      2,
      [{ op: "delete", keys: { id: 2 } }],
      root,
    );
    expect(await readJournalOps("ws", "source", 0, 2, root)).toHaveLength(3);
    expect(await readJournalOps("ws", "source", 1, 2, root)).toEqual([
      { change: 2, op: "delete", keys: { id: 2 } },
    ]);
    await pruneJournal("ws", "source", 1, root);
    expect(await readJournalOps("ws", "source", 0, 2, root)).toEqual([
      { change: 2, op: "delete", keys: { id: 2 } },
    ]);
  });

  it("coalesces insert/update/delete by primary key", () => {
    const { deletes, upserts } = coalesceOps(
      [
        {
          change: 1,
          op: "insert",
          row: { id: 1, label: "a" },
          keys: { id: 1 },
        },
        {
          change: 1,
          op: "update",
          row: { id: 1, label: "b" },
          keys: { id: 1 },
        },
        { change: 1, op: "insert", row: { id: 2, label: "c" }, keys: { id: 2 } },
        { change: 1, op: "delete", keys: { id: 2 } },
        { change: 1, op: "delete", keys: { id: 3 } },
      ],
      ["id"],
    );
    expect(upserts).toEqual([{ id: 1, label: "b" }]);
    expect(deletes).toEqual([{ id: 2 }, { id: 3 }]);
  });

  it("requires contiguous change coverage and rejects truncate or overflow", () => {
    const keys = ["id"];
    const ops = [
      { change: 2, op: "insert" as const, row: { id: 1 }, keys: { id: 1 } },
    ];
    expect(canApplyDeltas(ops, 1, 2, keys)).toBe(true);
    expect(canApplyDeltas(ops, 0, 2, keys)).toBe(false); // missing change 1
    expect(
      canApplyDeltas([{ change: 1, op: "truncate" }], 0, 1, keys),
    ).toBe(false);
    expect(
      canApplyDeltas(
        Array.from({ length: MAX_DELTA_OPS + 1 }, (_, i) => ({
          change: 1,
          op: "insert" as const,
          row: { id: i },
          keys: { id: i },
        })),
        0,
        1,
        keys,
      ),
    ).toBe(false);
    expect(
      canApplyDeltas(
        [
          { change: 1, op: "insert", row: { id: 1 }, keys: { id: 1 } },
          { change: 1, op: "insert", row: { id: 2 }, keys: { id: 2 } },
        ],
        0,
        1,
        keys,
        10,
      ),
    ).toBe(false); // 2 >= 10% of 10
  });
});
