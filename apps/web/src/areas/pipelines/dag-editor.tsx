import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  ConnectionMode,
  useReactFlow,
  type Node,
  type Edge,
  type Connection,
  type NodeProps,
  type OnNodesChange,
  applyNodeChanges,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  LayoutGrid,
  Maximize2,
  Minus,
  Network,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import type { Resource } from "../../../../../packages/shared/src";
import type { PipelineNode } from "../../../../../packages/shared/src/pipeline.js";
import { Button, EmptyState, IconButton } from "../../kit";
import { FormatSqlButton } from "./sql-view";
import {
  NODE_CATALOG,
  canAcceptInput,
  createPipelineNode,
  defaultPosition,
  disconnectEdge,
  formatMapping,
  layoutPipeline,
  maxInputsFor,
  nextNodeId,
  nodeTypeHueVar,
  parseCsvList,
  parseMapping,
  positionsFromNodes,
  removeNode,
  resolveConnection,
  updateNode,
  withPositions,
  type FlowPosition,
  type NodeType,
} from "./dag-model";

type DagNodeData = {
  label: string;
  type: NodeType;
  summary: string;
  selected: boolean;
};

const PANEL_FIT_PADDING = {
  top: 0.12,
  left: 0.12,
  bottom: 0.12,
  right: 0.42,
} as const;

function nodeSummary(n: PipelineNode, datasets: Resource[]): string {
  if (n.type === "source") {
    return datasets.find((d) => d.id === n.datasetId)?.name || "Pick dataset";
  }
  if (n.type === "filter") return String(n.config.condition || "");
  if (n.type === "select") {
    const cols = n.config.columns as string[] | undefined;
    return cols?.join(", ") || "";
  }
  if (n.type === "aggregate") {
    const metrics = Object.keys(
      (n.config.metrics as Record<string, string>) || {},
    );
    return metrics.length ? metrics.join(", ") : "metrics";
  }
  if (n.type === "limit") {
    const lim = n.config.limit;
    const off = n.config.offset;
    const parts: string[] = [];
    if (lim != null && lim !== "") parts.push(`LIMIT ${lim}`);
    if (off != null && off !== "") parts.push(`OFFSET ${off}`);
    return parts.join(" ") || "Set limit";
  }
  if (n.type === "sql") return (n.sql || "").slice(0, 40);
  if (n.inputs.length) return `← ${n.inputs.join(", ")}`;
  return "Not connected";
}

function FieldSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function DagFlowNode({ data }: NodeProps<Node<DagNodeData>>) {
  const acceptsInputs = maxInputsFor(data.type) > 0;
  const hue = nodeTypeHueVar(data.type);
  return (
    <div
      className={`pp-dag-node${data.selected ? " is-selected" : ""}`}
      data-type={data.type}
      style={{ borderLeftColor: hue }}
    >
      {acceptsInputs && (
        <Handle
          type="target"
          position={Position.Left}
          className="pp-dag-handle"
          isConnectable
          aria-label={`Connect input to ${data.label}`}
        />
      )}
      <strong>{data.label}</strong>
      <small>{data.summary}</small>
      <Handle
        type="source"
        position={Position.Right}
        className="pp-dag-handle"
        isConnectable
        aria-label={`Connect from ${data.label}`}
      />
    </div>
  );
}

const nodeTypes = { pipeline: DagFlowNode };

function Inspector({
  node,
  datasets,
  onChange,
  onDelete,
  onClose,
}: {
  node: PipelineNode;
  datasets: Resource[];
  onChange: (patch: Partial<PipelineNode>) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const cfg = node.config as Record<string, unknown>;
  const setCfg = (patch: Record<string, unknown>) =>
    onChange({ config: { ...cfg, ...patch } });
  const label =
    NODE_CATALOG.find((c) => c.type === node.type)?.label || node.type;
  const hue = nodeTypeHueVar(node.type);

  return (
    <aside className="pp-dag-panel" aria-label="Node settings">
      <header>
        <span
          className="pp-dag-dot"
          style={{ background: hue }}
          aria-hidden
        />
        <div>
          <h2>{label}</h2>
          <p className="pp-dag-id">
            <code>{node.id}</code>
          </p>
        </div>
        <div className="pp-dag-panel-actions">
          <IconButton
            icon={Trash2}
            label="Delete node"
            size="sm"
            onClick={onDelete}
          />
          <IconButton icon={X} label="Close" size="sm" onClick={onClose} />
        </div>
      </header>

      {node.type === "source" && (
        <FieldSection title="Dataset">
          <label className="rosf-field">
            <span className="rosf-sr-only">Dataset</span>
            <select
              value={node.datasetId || ""}
              onChange={(e) =>
                onChange({ datasetId: e.target.value || undefined })
              }
            >
              <option value="">Select…</option>
              {datasets.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
        </FieldSection>
      )}

      {node.type === "filter" && (
        <FieldSection title="Condition">
          <label className="rosf-field">
            <span className="rosf-sr-only">Condition</span>
            <input
              value={String(cfg.condition || "")}
              onChange={(e) => setCfg({ condition: e.target.value })}
              spellCheck={false}
            />
          </label>
        </FieldSection>
      )}

      {node.type === "select" && (
        <FieldSection title="Columns">
          <label className="rosf-field">
            <span className="rosf-sr-only">Columns (comma-separated)</span>
            <input
              value={((cfg.columns as string[]) || []).join(", ")}
              onChange={(e) =>
                setCfg({ columns: parseCsvList(e.target.value) })
              }
              placeholder="comma-separated"
              spellCheck={false}
            />
          </label>
        </FieldSection>
      )}

      {node.type === "rename" && (
        <FieldSection title="Mapping">
          <label className="rosf-field">
            <span className="rosf-sr-only">Mapping (old:new, …)</span>
            <input
              value={formatMapping(cfg.mapping as Record<string, string>)}
              onChange={(e) =>
                setCfg({ mapping: parseMapping(e.target.value) })
              }
              placeholder="old:new, …"
              spellCheck={false}
            />
          </label>
        </FieldSection>
      )}

      {(node.type === "cast" || node.type === "derive") && (
        <FieldSection title="Columns">
          <label className="rosf-field">
            <span className="rosf-sr-only">
              {node.type === "cast"
                ? "Columns (name:TYPE, …)"
                : "Columns (name:expr, …)"}
            </span>
            <input
              value={formatMapping(cfg.columns as Record<string, string>)}
              onChange={(e) =>
                setCfg({ columns: parseMapping(e.target.value) })
              }
              placeholder={
                node.type === "cast" ? "name:TYPE, …" : "name:expr, …"
              }
              spellCheck={false}
            />
          </label>
        </FieldSection>
      )}

      {node.type === "deduplicate" && (
        <FieldSection title="Keys">
          <label className="rosf-field">
            <span className="rosf-sr-only">
              Keys (comma-separated, empty = DISTINCT *)
            </span>
            <input
              value={((cfg.keys as string[]) || []).join(", ")}
              onChange={(e) => setCfg({ keys: parseCsvList(e.target.value) })}
              placeholder="empty = DISTINCT *"
              spellCheck={false}
            />
          </label>
        </FieldSection>
      )}

      {node.type === "join" && (
        <>
          <FieldSection title="Join">
            <label className="rosf-field">
              <span>Type</span>
              <select
                value={String(cfg.joinType || "inner")}
                onChange={(e) => setCfg({ joinType: e.target.value })}
              >
                <option value="inner">Inner</option>
                <option value="left">Left</option>
              </select>
            </label>
            <label className="rosf-field">
              <span>ON</span>
              <input
                value={String(cfg.on || "")}
                onChange={(e) => setCfg({ on: e.target.value })}
                spellCheck={false}
              />
            </label>
            <label className="rosf-field">
              <span>SELECT</span>
              <input
                value={String(cfg.select || "a.*, b.*")}
                onChange={(e) => setCfg({ select: e.target.value })}
                spellCheck={false}
              />
            </label>
          </FieldSection>
          <p className="pp-aliases">
            Connect left then right input. Aliases are <code>a</code> and{" "}
            <code>b</code>.
          </p>
        </>
      )}

      {node.type === "aggregate" && (
        <FieldSection title="Aggregate">
          <label className="rosf-field">
            <span>Group by</span>
            <input
              value={((cfg.groupBy as string[]) || []).join(", ")}
              onChange={(e) =>
                setCfg({ groupBy: parseCsvList(e.target.value) })
              }
              placeholder="comma-separated"
              spellCheck={false}
            />
          </label>
          <label className="rosf-field">
            <span>Metrics</span>
            <input
              value={formatMapping(cfg.metrics as Record<string, string>)}
              onChange={(e) =>
                setCfg({ metrics: parseMapping(e.target.value) })
              }
              placeholder="name:expr, …"
              spellCheck={false}
            />
          </label>
        </FieldSection>
      )}

      {node.type === "limit" && (
        <FieldSection title="Rows">
          <label className="rosf-field">
            <span>LIMIT</span>
            <input
              type="number"
              min={0}
              step={1}
              value={cfg.limit == null ? "" : String(cfg.limit)}
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === "") {
                  setCfg({ limit: null });
                  return;
                }
                const n = Number(raw);
                if (Number.isFinite(n) && n >= 0) setCfg({ limit: Math.floor(n) });
              }}
            />
          </label>
          <label className="rosf-field">
            <span>OFFSET (optional)</span>
            <input
              type="number"
              min={0}
              step={1}
              value={cfg.offset == null ? "" : String(cfg.offset)}
              onChange={(e) => {
                const raw = e.target.value;
                if (raw === "") {
                  setCfg({ offset: null });
                  return;
                }
                const n = Number(raw);
                if (Number.isFinite(n) && n >= 0) {
                  setCfg({ offset: Math.floor(n) });
                }
              }}
            />
          </label>
        </FieldSection>
      )}

      {node.type === "sql" && (
        <FieldSection title="SQL">
          <div className="pp-sql-field-head pp-sql-field-head--end">
            <FormatSqlButton
              value={node.sql || ""}
              onFormat={(next) => onChange({ sql: next })}
            />
          </div>
          <label className="rosf-field">
            <span className="rosf-sr-only">SQL</span>
            <textarea
              className="pp-sql"
              value={node.sql || ""}
              onChange={(e) => onChange({ sql: e.target.value })}
              spellCheck={false}
            />
          </label>
        </FieldSection>
      )}

      {node.type !== "source" && node.type !== "sql" && (
        <section>
          <h3>Inputs</h3>
          <p className="pp-aliases">
            {node.inputs.length ? node.inputs.join(" → ") : "none yet"}
          </p>
        </section>
      )}
    </aside>
  );
}

function DagZoom({
  panelOpen,
  fitToken,
  nodeCount,
}: {
  panelOpen: boolean;
  fitToken: number;
  nodeCount: number;
}) {
  const { zoomIn, zoomOut, fitView } = useReactFlow();

  const runFit = useCallback(() => {
    if (!nodeCount) return;
    fitView({
      padding: panelOpen ? PANEL_FIT_PADDING : 0.2,
      duration: 200,
    });
  }, [fitView, nodeCount, panelOpen]);

  useEffect(() => {
    if (!nodeCount) return;
    const id = requestAnimationFrame(runFit);
    return () => cancelAnimationFrame(id);
  }, [fitToken, runFit, nodeCount]);

  return (
    <div className="pp-dag-zoom">
      <IconButton
        label="Zoom in"
        icon={Plus}
        size="sm"
        variant="secondary"
        onClick={() => zoomIn({ duration: 200 })}
      />
      <IconButton
        label="Zoom out"
        icon={Minus}
        size="sm"
        variant="secondary"
        onClick={() => zoomOut({ duration: 200 })}
      />
      <IconButton
        label="Fit to screen"
        icon={Maximize2}
        size="sm"
        variant="secondary"
        onClick={runFit}
      />
    </div>
  );
}

function DagCanvasInner({
  nodes,
  datasets,
  positions,
  selectedId,
  fitToken,
  onNodesChange,
  onPositionsChange,
  onPositionsCommit,
  onSelect,
}: {
  nodes: PipelineNode[];
  datasets: Resource[];
  positions: Record<string, FlowPosition>;
  selectedId: string | null;
  fitToken: number;
  onNodesChange: (next: PipelineNode[]) => void;
  onPositionsChange: (next: Record<string, FlowPosition>) => void;
  /** Persist final positions onto the pipeline node model (drag end). */
  onPositionsCommit: (next: Record<string, FlowPosition>) => void;
  onSelect: (id: string | null) => void;
}) {
  const panelOpen = !!selectedId;

  const flowNodes: Node<DagNodeData>[] = useMemo(
    () =>
      nodes.map((n, i) => ({
        id: n.id,
        type: "pipeline",
        position: defaultPosition(i, positions, n.id),
        data: {
          label:
            NODE_CATALOG.find((c) => c.type === n.type)?.label || n.type,
          type: n.type,
          summary: nodeSummary(n, datasets),
          selected: n.id === selectedId,
        },
        selected: n.id === selectedId,
      })),
    [nodes, positions, datasets, selectedId],
  );

  const flowEdges: Edge[] = useMemo(() => {
    const edges: Edge[] = [];
    for (const n of nodes) {
      n.inputs.forEach((src, i) => {
        edges.push({
          id: `${src}->${n.id}:${i}`,
          source: src,
          target: n.id,
          type: "smoothstep",
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
        });
      });
    }
    return edges;
  }, [nodes]);

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target) return;
      const next = resolveConnection(nodes, c.source, c.target);
      if (next !== nodes) onNodesChange(next);
    },
    [nodes, onNodesChange],
  );

  const isValidConnection = useCallback(
    (c: Connection | Edge) => {
      if (!c.source || !c.target || c.source === c.target) return false;
      return (
        canAcceptInput(nodes, c.target, c.source) ||
        canAcceptInput(nodes, c.source, c.target)
      );
    },
    [nodes],
  );

  const onEdgesDelete = useCallback(
    (deleted: Edge[]) => {
      let next = nodes;
      for (const e of deleted) next = disconnectEdge(next, e.source, e.target);
      onNodesChange(next);
    },
    [nodes, onNodesChange],
  );

  const onNodesDelete = useCallback(
    (deleted: Node<DagNodeData>[]) => {
      let next = nodes;
      for (const n of deleted) next = removeNode(next, n.id);
      onNodesChange(next);
      onSelect(null);
    },
    [nodes, onNodesChange, onSelect],
  );

  const handleNodesChange: OnNodesChange<Node<DagNodeData>> = useCallback(
    (changes) => {
      const applied = applyNodeChanges(changes, flowNodes);
      const nextPos = { ...positions };
      let posChanged = false;
      for (const n of applied) {
        const prev = positions[n.id];
        if (!prev || prev.x !== n.position.x || prev.y !== n.position.y) {
          nextPos[n.id] = { x: n.position.x, y: n.position.y };
          posChanged = true;
        }
      }
      if (posChanged) onPositionsChange(nextPos);
      for (const ch of changes) {
        if (ch.type === "select") {
          onSelect(ch.selected ? ch.id : null);
        }
      }
    },
    [flowNodes, positions, onPositionsChange, onSelect],
  );

  const commitDragPositions = useCallback(
    (_: unknown, __: unknown, dragNodes: Node<DagNodeData>[]) => {
      const nextPos = { ...positions };
      for (const n of dragNodes) {
        nextPos[n.id] = { x: n.position.x, y: n.position.y };
      }
      onPositionsChange(nextPos);
      onPositionsCommit(nextPos);
    },
    [positions, onPositionsChange, onPositionsCommit],
  );

  return (
    <ReactFlow
      nodes={flowNodes}
      edges={flowEdges}
      nodeTypes={nodeTypes}
      onConnect={onConnect}
      isValidConnection={isValidConnection}
      onEdgesDelete={onEdgesDelete}
      onNodesDelete={onNodesDelete}
      onNodesChange={handleNodesChange}
      onNodeDragStop={commitDragPositions}
      onPaneClick={() => onSelect(null)}
      nodesConnectable
      elementsSelectable
      connectionMode={ConnectionMode.Loose}
      connectionRadius={28}
      defaultEdgeOptions={{
        type: "smoothstep",
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      }}
      fitView
      fitViewOptions={{
        padding: panelOpen ? PANEL_FIT_PADDING : 0.2,
      }}
      deleteKeyCode={["Backspace", "Delete"]}
      proOptions={{ hideAttribution: true }}
      style={{ width: "100%", height: "100%" } satisfies CSSProperties}
    >
      <Background gap={16} size={1} />
      <DagZoom
        panelOpen={panelOpen}
        fitToken={fitToken}
        nodeCount={nodes.length}
      />
      <MiniMap
        className="pp-dag-minimap"
        pannable
        zoomable
        ariaLabel="Pipeline overview"
        nodeStrokeWidth={2}
        nodeClassName={(n) =>
          `pp-minimap-node pp-minimap-${(n.data as DagNodeData)?.type || "default"}`
        }
      />
    </ReactFlow>
  );
}

export function DagEditor({
  nodes,
  datasets,
  onChange,
  layoutKey = 0,
}: {
  nodes: PipelineNode[];
  datasets: Resource[];
  onChange: (nodes: PipelineNode[]) => void;
  /** Bump to force a full layered re-layout (e.g. after Convert to visual). */
  layoutKey?: number;
}) {
  const [positions, setPositions] = useState<Record<string, FlowPosition>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fitToken, setFitToken] = useState(0);
  const prevIdsRef = useRef<Set<string>>(new Set());
  const prevLayoutKeyRef = useRef(layoutKey);
  const positionsRef = useRef(positions);
  positionsRef.current = positions;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const selected = nodes.find((n) => n.id === selectedId) || null;

  useEffect(() => {
    if (selectedId && !nodes.some((n) => n.id === selectedId)) {
      setSelectedId(null);
    }
  }, [nodes, selectedId]);

  useEffect(() => {
    const ids = new Set(nodes.map((n) => n.id));
    const prev = prevIdsRef.current;
    const overlap = [...ids].some((id) => prev.has(id));
    const forceLayout = layoutKey !== prevLayoutKeyRef.current;
    prevLayoutKeyRef.current = layoutKey;
    const saved = positionsFromNodes(nodes);
    const live = positionsRef.current;

    let nextPos: Record<string, FlowPosition> = {};
    let persist = false;

    if (forceLayout && nodes.length) {
      nextPos = layoutPipeline(nodes);
      persist = true;
    } else {
      const kept: Record<string, FlowPosition> = {};
      for (const n of nodes) {
        if (live[n.id]) kept[n.id] = live[n.id];
        else if (saved[n.id]) kept[n.id] = saved[n.id];
      }
      const known = Object.keys(kept).length;
      if (!nodes.length) nextPos = {};
      else if (known === 0) {
        nextPos = layoutPipeline(nodes);
        persist = true;
      } else if (known < nodes.length) {
        const laid = layoutPipeline(nodes);
        for (const n of nodes) {
          if (!kept[n.id]) kept[n.id] = laid[n.id];
        }
        nextPos = kept;
        persist = true;
      } else nextPos = kept;
    }

    setPositions(nextPos);
    if (persist) {
      const updated = withPositions(nodes, nextPos);
      if (updated !== nodes) onChangeRef.current(updated);
    }

    if (nodes.length && (forceLayout || prev.size === 0 || !overlap)) {
      setFitToken((t) => t + 1);
    }
    prevIdsRef.current = ids;
  }, [nodes, layoutKey]);

  const addNode = (type: NodeType) => {
    const id = nextNodeId(nodes, type);
    const datasetId =
      type === "source" && datasets[0] ? datasets[0].id : undefined;
    const node = createPipelineNode(type, id, datasetId);
    const next = [...nodes, node];
    const laid = layoutPipeline(next);
    setPositions(laid);
    setFitToken((t) => t + 1);
    onChange(withPositions(next, laid));
    setSelectedId(id);
  };

  const runAutoLayout = () => {
    if (!nodes.length) return;
    const laid = layoutPipeline(nodes);
    setPositions(laid);
    setFitToken((t) => t + 1);
    onChange(withPositions(nodes, laid));
  };

  const commitPositions = useCallback(
    (next: Record<string, FlowPosition>) => {
      const updated = withPositions(nodes, next);
      if (updated !== nodes) onChange(updated);
    },
    [nodes, onChange],
  );

  return (
    <div className="pp-dag">
      <div className="pp-dag-bar">
        <ul className="pp-dag-legend" aria-label="Add nodes">
          {NODE_CATALOG.map((item) => (
            <li key={item.type}>
              <button
                type="button"
                className="pp-dag-type"
                title={item.hint}
                onClick={() => addNode(item.type)}
              >
                <span
                  className="pp-dag-dot"
                  style={{ background: nodeTypeHueVar(item.type) }}
                  aria-hidden
                />
                {item.label}
              </button>
            </li>
          ))}
        </ul>
        <Button
          type="button"
          size="sm"
          icon={LayoutGrid}
          title="Arrange nodes by dependency"
          disabled={!nodes.length}
          onClick={runAutoLayout}
        >
          Auto layout
        </Button>
      </div>

      <div className="pp-dag-stage">
        <div
          className="pp-dag-canvas"
          role="application"
          aria-label="Pipeline graph"
        >
          <ReactFlowProvider>
            <DagCanvasInner
              nodes={nodes}
              datasets={datasets}
              positions={positions}
              selectedId={selectedId}
              fitToken={fitToken}
              onNodesChange={onChange}
              onPositionsChange={setPositions}
              onPositionsCommit={commitPositions}
              onSelect={setSelectedId}
            />
          </ReactFlowProvider>
        </div>

        {!nodes.length && (
          <div className="pp-dag-empty">
            <EmptyState
              icon={Network}
              size="sm"
              title="Build a pipeline graph"
              text="Add a Source, then drag from a node’s right handle to another node’s left handle. The graph must end in one output node."
              action={
                <Button
                  type="button"
                  size="sm"
                  icon={Plus}
                  onClick={() => addNode("source")}
                >
                  Add Source
                </Button>
              }
            />
          </div>
        )}

        {selected && (
          <Inspector
            node={selected}
            datasets={datasets}
            onChange={(patch) =>
              onChange(updateNode(nodes, selected.id, patch))
            }
            onDelete={() => {
              onChange(removeNode(nodes, selected.id));
              setSelectedId(null);
            }}
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>
    </div>
  );
}
