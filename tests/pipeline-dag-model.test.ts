import { describe, it, expect } from "vitest";
import { PipelineNodeSchema } from "../packages/shared/src/pipelines.js";
import {
  applyVisualToSql,
  connectNodes,
  createPipelineNode,
  disconnectEdge,
  friendlyCompileError,
  isBuildingHint,
  isSqlInSyncWithNodes,
  layoutPipeline,
  nextNodeId,
  parseCsvList,
  parseMapping,
  positionsFromNodes,
  removeNode,
  resolveConnection,
  tryCompile,
  withPositions,
} from "../apps/web/src/areas/pipelines/dag-model.js";

describe("pipeline DAG model", () => {
  it("creates unique ids and default configs", () => {
    const a = createPipelineNode("filter", "filter_1");
    expect(a.config.condition).toBe("true");
    expect(nextNodeId([a], "filter")).toBe("filter_2");
  });

  it("persists and restores canvas positions on nodes", () => {
    const nodes = [
      createPipelineNode("source", "src", "ds1"),
      createPipelineNode("filter", "f1"),
    ];
    const placed = withPositions(nodes, {
      src: { x: 10, y: 20 },
      f1: { x: 240, y: 20 },
    });
    expect(placed[0].position).toEqual({ x: 10, y: 20 });
    expect(positionsFromNodes(placed)).toEqual({
      src: { x: 10, y: 20 },
      f1: { x: 240, y: 20 },
    });
    expect(withPositions(placed, positionsFromNodes(placed))).toBe(placed);
    expect(
      PipelineNodeSchema.parse({
        ...placed[0],
        position: { x: 1, y: 2 },
      }).position,
    ).toEqual({ x: 1, y: 2 });
    expect(tryCompile(placed).ok).toBe(false); // filter not connected
    const linked = connectNodes(placed, "src", "f1");
    expect(tryCompile(linked).ok).toBe(true);
    expect(linked.find((n) => n.id === "src")?.position).toEqual({
      x: 10,
      y: 20,
    });
  });

  it("connects linear and join inputs", () => {
    const nodes = [
      createPipelineNode("source", "src", "ds1"),
      createPipelineNode("filter", "f1"),
      createPipelineNode("source", "src2", "ds2"),
      createPipelineNode("join", "j1"),
    ];
    const linked = connectNodes(nodes, "src", "f1");
    expect(linked.find((n) => n.id === "f1")?.inputs).toEqual(["src"]);
    // Single-input nodes replace the prior input.
    const replaced = connectNodes(linked, "src2", "f1");
    expect(replaced.find((n) => n.id === "f1")?.inputs).toEqual(["src2"]);
    const joined = connectNodes(
      connectNodes(nodes, "src", "j1"),
      "src2",
      "j1",
    );
    expect(joined.find((n) => n.id === "j1")?.inputs).toEqual(["src", "src2"]);
  });

  it("resolves reverse drag direction onto a valid target", () => {
    const nodes = [
      createPipelineNode("source", "src", "ds1"),
      createPipelineNode("select", "select_1"),
    ];
    // User dragged Select → Source; still wires Source → Select.
    const next = resolveConnection(nodes, "select_1", "src");
    expect(next.find((n) => n.id === "select_1")?.inputs).toEqual(["src"]);
    expect(next.find((n) => n.id === "src")?.inputs).toEqual([]);
  });

  it("disconnects and removes nodes with dangling cleanup", () => {
    let nodes = [
      createPipelineNode("source", "src", "ds1"),
      { ...createPipelineNode("filter", "f1"), inputs: ["src"] },
    ];
    nodes = disconnectEdge(nodes, "src", "f1");
    expect(nodes.find((n) => n.id === "f1")?.inputs).toEqual([]);
    nodes = [
      createPipelineNode("source", "src", "ds1"),
      { ...createPipelineNode("filter", "f1"), inputs: ["src"] },
    ];
    nodes = removeNode(nodes, "src");
    expect(nodes).toHaveLength(1);
    expect(nodes[0].inputs).toEqual([]);
  });

  it("parses inspector text helpers", () => {
    expect(parseCsvList(" a, b , ,c ")).toEqual(["a", "b", "c"]);
    expect(parseMapping("amount:gross, id:pk")).toEqual({
      amount: "gross",
      id: "pk",
    });
  });

  it("compiles a valid graph and syncs SQL when clean", () => {
    const nodes = [
      createPipelineNode("source", "src", "ds1"),
      {
        ...createPipelineNode("aggregate", "agg"),
        inputs: ["src"],
        config: { groupBy: ["region"], metrics: { n: "count(*)" } },
      },
    ];
    const compiled = tryCompile(nodes);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.inputs).toEqual(["ds1"]);
    expect(compiled.sql).toMatch(/WITH/i);

    const applied = applyVisualToSql(nodes, false, {
      sql: "SELECT 1",
      inputs: [],
    });
    expect(applied.applied).toBe(true);
    expect(applied.sql).toBe(compiled.sql);
    expect(applied.inputs).toEqual(["ds1"]);
  });

  it("does not overwrite SQL when dirty", () => {
    const nodes = [
      createPipelineNode("source", "src", "ds1"),
      {
        ...createPipelineNode("filter", "f1"),
        inputs: ["src"],
        config: { condition: "true" },
      },
    ];
    const kept = applyVisualToSql(nodes, true, {
      sql: "SELECT custom",
      inputs: ["other"],
    });
    expect(kept.applied).toBe(false);
    expect(kept.sql).toBe("SELECT custom");
    expect(kept.inputs).toEqual(["other"]);
  });

  it("detects hydrate sync between nodes and saved SQL", () => {
    const nodes = [
      createPipelineNode("source", "src", "ds1"),
      {
        ...createPipelineNode("filter", "f1"),
        inputs: ["src"],
        config: { condition: "true" },
      },
    ];
    const compiled = tryCompile(nodes);
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(isSqlInSyncWithNodes(nodes, compiled.sql)).toBe(true);
    expect(isSqlInSyncWithNodes(nodes, "SELECT 1")).toBe(false);
    expect(isSqlInSyncWithNodes([], "SELECT 1")).toBe(true);
  });

  it("auto-layouts join graphs with stacked sources", () => {
    const nodes = [
      createPipelineNode("source", "source_1", "ds1"),
      createPipelineNode("source", "source_2", "ds2"),
      {
        ...createPipelineNode("join", "join_1"),
        inputs: ["source_1", "source_2"],
      },
      {
        ...createPipelineNode("derive", "derive_1"),
        inputs: ["join_1"],
        config: { columns: { n: "1" } },
      },
    ];
    const pos = layoutPipeline(nodes);
    expect(pos.source_1.x).toBe(pos.source_2.x);
    expect(pos.source_1.y).not.toBe(pos.source_2.y);
    expect(pos.join_1.x).toBeGreaterThan(pos.source_1.x);
    expect(pos.derive_1.x).toBeGreaterThan(pos.join_1.x);
  });

  it("uses friendly labels and building-hint tone for incomplete graphs", () => {
    const nodes = [
      createPipelineNode("source", "src", "ds1"),
      createPipelineNode("select", "select_1"),
    ];
    const compiled = tryCompile(nodes);
    expect(compiled.ok).toBe(false);
    if (compiled.ok) return;
    expect(compiled.error).toBe("Connect an input to Select");
    expect(compiled.error).not.toContain("select_1");
    expect(isBuildingHint(compiled.error)).toBe(true);
    expect(
      friendlyCompileError(nodes, "Connect an input to select_1"),
    ).toBe("Connect an input to Select");
    expect(isBuildingHint("Pipeline has a cycle")).toBe(false);
  });
});
