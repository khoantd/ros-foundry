import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Code2, Play, RotateCcw, Send, Workflow } from "lucide-react";
import {
  datasetAliases,
  type Resource,
} from "../../../../../packages/shared/src";
import type { PipelineNode } from "../../../../../packages/shared/src/pipeline.js";
import { api } from "../../api";
import { paths } from "../../paths";
import { useWorkspace, useResources, useAction } from "../../ui";
import {
  Button,
  ButtonLink,
  DataGrid,
  EmptyState,
  Page,
  PageHeader,
  Panel,
  Skeleton,
  Tabs,
  TabPanel,
  cx,
} from "../../kit";
import { DagEditor } from "./dag-editor";
import {
  applyVisualToSql,
  isBuildingHint,
  isSqlInSyncWithNodes,
  tryCompile,
} from "./dag-model";
import { sqlToNodes } from "./sql-to-nodes";
import { FormatSqlButton, SqlView } from "./sql-view";

function quoteIdent(name: string) {
  return '"' + name.replaceAll('"', '""') + '"';
}

function defaultSql(datasets: Resource[]) {
  if (!datasets.length) return "SELECT 1";
  const alias = datasetAliases(datasets[0].name)[0] || datasets[0].name;
  return `SELECT * FROM ${quoteIdent(alias)} LIMIT 100`;
}

type EditorMode = "visual" | "sql";

export function PipelineEditor({ mode }: { mode: "new" | "edit" }) {
  const { pipelineId = "" } = useParams();
  const { id, role } = useWorkspace();
  const navigate = useNavigate();
  const action = useAction();
  const datasets = useResources("dataset");
  const existing = useQuery({
    queryKey: [id, "pipeline", pipelineId],
    queryFn: () =>
      api<Resource>(`/workspaces/${id}/resources/pipeline/${pipelineId}`),
    enabled: mode === "edit" && !!pipelineId,
  });

  const available = useMemo(
    () =>
      ((datasets.data?.items || []) as Resource[]).filter(
        (d) => d.data.activeVersion,
      ),
    [datasets.data],
  );

  const seed = existing.data;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [inputs, setInputs] = useState<string[]>([]);
  const [sql, setSql] = useState("");
  const [nodes, setNodes] = useState<PipelineNode[]>([]);
  const [layoutKey, setLayoutKey] = useState(0);
  const [sqlDirty, setSqlDirty] = useState(false);
  const [editorMode, setEditorMode] = useState<EditorMode>("visual");
  const [preview, setPreview] = useState<{
    rows: Record<string, unknown>[];
    profile?: { columns: { name: string; type: string }[] };
  } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(mode === "new");

  useEffect(() => {
    if (mode !== "edit" || !existing.data || hydrated) return;
    const p = existing.data;
    const savedSql = (p.data.sql as string) || "";
    const savedInputs = [...((p.data.inputs as string[]) || [])];
    const savedNodes = (p.data.nodes as PipelineNode[]) || [];
    setName(p.name);
    setDescription(p.description || "");
    setInputs(savedInputs);
    setSql(savedSql);
    setNodes(savedNodes);
    setSqlDirty(
      savedNodes.length > 0 && !isSqlInSyncWithNodes(savedNodes, savedSql),
    );
    setEditorMode(savedNodes.length ? "visual" : "sql");
    setHydrated(true);
  }, [mode, existing.data, hydrated]);

  // Always compute compile status from nodes (needed for dirty banner reset + SQL sync).
  const compiled = useMemo(() => tryCompile(nodes), [nodes]);

  if (role === "viewer") {
    return (
      <Page>
        <EmptyState
          title="View only"
          text="You need edit access to create or change pipelines."
          action={<ButtonLink to={paths.pipelines()}>Back</ButtonLink>}
        />
      </Page>
    );
  }

  if (mode === "edit" && (existing.error || (!existing.isPending && !existing.data))) {
    return (
      <Page>
        <EmptyState
          title="Pipeline not found"
          text="It may have been replaced by a newer publication."
          action={<ButtonLink to={paths.pipelines()}>Back</ButtonLink>}
        />
      </Page>
    );
  }

  if (mode === "edit" && (existing.isPending || !hydrated)) {
    return (
      <Page>
        <Skeleton height={240} />
      </Page>
    );
  }

  const selected = available.filter((d) => inputs.includes(d.id));

  const syncSqlFromGraph = (): boolean => {
    const next = applyVisualToSql(nodes, false, { sql, inputs });
    if (!next.applied) {
      setPreviewError(next.error || "Build a valid graph first.");
      return false;
    }
    setSql(next.sql);
    setInputs(next.inputs);
    setSqlDirty(false);
    setPreviewError(null);
    return true;
  };

  const onNodesChange = (next: PipelineNode[]) => {
    setNodes(next);
    setPreview(null);
    setPreviewError(null);
    if (!sqlDirty) {
      const synced = applyVisualToSql(next, false, { sql, inputs });
      if (synced.applied) {
        setSql(synced.sql);
        setInputs(synced.inputs);
      }
    }
  };

  const markSqlDirty = () => {
    setSqlDirty(true);
    setPreview(null);
    setPreviewError(null);
  };

  const toggle = (datasetId: string) => {
    setInputs((prev) => {
      const next = prev.includes(datasetId)
        ? prev.filter((x) => x !== datasetId)
        : [...prev, datasetId];
      if (!sql.trim() && next.length) {
        const ds = available.find((d) => d.id === next[0]);
        if (ds) setSql(defaultSql([ds]));
      }
      return next;
    });
    markSqlDirty();
  };

  const convertSqlToVisual = (): boolean => {
    const result = sqlToNodes(sql, available, inputs);
    if (!result.ok) {
      setPreviewError(result.error);
      return false;
    }
    setNodes(result.nodes);
    setLayoutKey((k) => k + 1);
    setSqlDirty(false);
    const compiledNow = tryCompile(result.nodes);
    if (compiledNow.ok) {
      setSql(compiledNow.sql);
      setInputs(compiledNow.inputs);
    }
    setPreviewError(null);
    setPreview(null);
    return true;
  };

  const switchMode = (nextMode: EditorMode) => {
    if (nextMode === "sql" && !sqlDirty) {
      const synced = applyVisualToSql(nodes, false, { sql, inputs });
      if (synced.applied) {
        setSql(synced.sql);
        setInputs(synced.inputs);
        setPreviewError(null);
      }
      // Incomplete graphs stay on the visual hint; do not promote to a danger alert.
    }
    if (nextMode === "visual") {
      // Keep an existing graph when SQL is dirty — convert only via the button.
      // Auto-convert only when there is SQL and no graph yet.
      if (sql.trim() && !nodes.length) {
        if (!convertSqlToVisual()) return; // stay on SQL with error
      }
    }
    setEditorMode(nextMode);
    setPreview(null);
  };

  const effectiveInputs =
    editorMode === "visual" && compiled.ok ? compiled.inputs : inputs;
  const effectiveSql =
    editorMode === "visual" && compiled.ok ? compiled.sql : sql;

  const runPreview = async () => {
    setPreviewError(null);
    setPreview(null);
    if (editorMode === "visual") {
      if (!compiled.ok) {
        setPreviewError(compiled.error || "Build a valid graph first.");
        return;
      }
    } else if (!inputs.length || !sql.trim()) {
      setPreviewError("Choose at least one dataset and enter SQL.");
      return;
    }
    try {
      const result = await api<{
        rows: Record<string, unknown>[];
        profile?: { columns: { name: string; type: string }[] };
      }>(`/workspaces/${id}/query`, {
        inputs: effectiveInputs,
        sql: effectiveSql,
      });
      setPreview({ rows: result.rows || [], profile: result.profile });
    } catch (e) {
      setPreviewError((e as Error).message);
    }
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setPreviewError("Name is required.");
      return;
    }

    let draftInputs = inputs;
    let draftSql = sql;
    let draftNodes: PipelineNode[] = [];

    if (editorMode === "visual") {
      if (!compiled.ok) {
        setPreviewError(compiled.error || "Build a valid graph first.");
        return;
      }
      draftInputs = compiled.inputs;
      draftSql = compiled.sql;
      draftNodes = nodes;
      setSql(compiled.sql);
      setInputs(compiled.inputs);
      setSqlDirty(false);
    } else if (!inputs.length || !sql.trim()) {
      setPreviewError("Name, inputs and SQL are required.");
      return;
    } else if (nodes.length && !compiled.ok && !sqlDirty) {
      setPreviewError(
        "The visual graph is incomplete or invalid. Fix it on the Visual tab, or edit SQL (Send will then publish SQL without nodes).",
      );
      return;
    } else if (sqlDirty) {
      // SQL wins — omit nodes so the API does not overwrite via compilePipeline.
      draftNodes = [];
    } else if (nodes.length && compiled.ok) {
      draftNodes = nodes;
      draftInputs = compiled.inputs;
      draftSql = compiled.sql;
    }

    const proposal = await action.run(
      () =>
        api(`/workspaces/${id}/pipelines/draft`, {
          name: name.trim(),
          description: description.trim(),
          inputs: draftInputs,
          sql: draftSql,
          nodes: draftNodes,
          checks: [],
        }),
      "Pipeline ready for review",
    );
    if (proposal?.id) navigate(paths.proposals(proposal.id));
  };

  const canEdit = available.length > 0;

  return (
    <Page width="wide">
      <PageHeader
        title={mode === "new" ? "New pipeline" : "Edit pipeline"}
        subtitle="Build a transform graph or write SELECT SQL. Preview it, then send a tested proposal for review."
        breadcrumbs={[
          { label: "Pipelines", to: paths.pipelines() },
          {
            label: mode === "new" ? "New" : seed?.name || "Edit",
          },
        ]}
        actions={
          canEdit ? (
            <div className="pp-actions" style={{ marginBottom: 0 }}>
              <Button
                type="button"
                form="pp-editor-form"
                icon={Play}
                onClick={() => void runPreview()}
              >
                Preview
              </Button>
              <Button
                type="submit"
                form="pp-editor-form"
                variant="primary"
                icon={Send}
                pending={action.pending}
              >
                Send for review
              </Button>
            </div>
          ) : undefined
        }
      />

      {!canEdit && !datasets.isPending ? (
        <EmptyState
          title="Connect data first"
          text="Pipelines read from dataset snapshots. Add a connection or sample data, then come back."
          action={<ButtonLink to={paths.connections(true)}>Add data</ButtonLink>}
        />
      ) : (
        <form
          id="pp-editor-form"
          className="pp-form pp-form-wide"
          onSubmit={onSubmit}
        >
          <label className="rosf-field">
            <span>Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={120}
              autoComplete="off"
            />
          </label>
          <label className="rosf-field">
            <span>Description</span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              autoComplete="off"
            />
          </label>

          <Tabs
            label="Editor mode"
            items={[
              { id: "visual", label: "Visual", icon: Workflow },
              { id: "sql", label: "SQL", icon: Code2 },
            ]}
            value={editorMode}
            onChange={(tabId) => switchMode(tabId as EditorMode)}
          />

          <TabPanel id="visual" value={editorMode} idPrefix="tab">
            {sqlDirty && (
              <div className="pp-sync-banner" role="status">
                <p>
                  SQL was edited; the graph may not match. Preview and submit
                  from Visual use the graph. Submit from SQL uses your edited
                  SQL and drops the graph from the draft.
                </p>
                <Button
                  type="button"
                  size="sm"
                  icon={RotateCcw}
                  disabled={!compiled.ok}
                  title={
                    compiled.ok
                      ? "Replace SQL tab with compiled graph SQL"
                      : compiled.error
                  }
                  onClick={() => {
                    syncSqlFromGraph();
                  }}
                >
                  Reset SQL from graph
                </Button>
              </div>
            )}
            <DagEditor
              nodes={nodes}
              datasets={available}
              onChange={onNodesChange}
              layoutKey={layoutKey}
            />
            {!compiled.ok && nodes.length > 0 && (
              <p
                role="status"
                className={
                  isBuildingHint(compiled.error) ? "pp-hint" : "pp-error"
                }
              >
                {compiled.error}
              </p>
            )}
            {compiled.ok && (
              <Panel title="Compiled SQL" className="pp-preview">
                <SqlView
                  sql={compiled.sql}
                  hint="Compiled from the visual graph"
                />
              </Panel>
            )}
          </TabPanel>

          <TabPanel id="sql" value={editorMode} idPrefix="tab">
            {sqlDirty && (
              <div className="pp-sync-banner" role="status">
                <p>
                  You edited SQL away from the visual graph. Send for review
                  will publish this SQL without nodes.
                </p>
                <Button
                  type="button"
                  size="sm"
                  icon={RotateCcw}
                  disabled={!compiled.ok}
                  title={
                    compiled.ok
                      ? "Replace SQL with compiled graph SQL"
                      : compiled.error || "Build a valid graph first"
                  }
                  onClick={() => {
                    syncSqlFromGraph();
                  }}
                >
                  Reset SQL from graph
                </Button>
              </div>
            )}
            <fieldset className="pp-dataset-picker">
              <legend>
                Input datasets
                {selected.length > 0 && (
                  <span className="pp-dataset-count">
                    {selected.length} selected
                  </span>
                )}
              </legend>
              <div
                className="pp-datasets"
                role="group"
                aria-label="Input datasets"
              >
                {datasets.isPending ? (
                  <Skeleton height={80} />
                ) : (
                  available.map((d) => {
                    const alias = datasetAliases(d.name)[0] || d.name;
                    const checked = inputs.includes(d.id);
                    return (
                      <label
                        key={d.id}
                        className={cx("pp-dataset", checked && "is-checked")}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggle(d.id)}
                        />
                        <span className="pp-dataset-meta">
                          <strong>{d.name}</strong>
                          <small>{quoteIdent(alias)}</small>
                        </span>
                      </label>
                    );
                  })
                )}
              </div>
            </fieldset>

            <div className="rosf-field">
              <div className="pp-sql-field-head">
                <label htmlFor="pp-sql-input">SQL</label>
                <FormatSqlButton
                  value={sql}
                  onFormat={(next) => {
                    setSql(next);
                    markSqlDirty();
                  }}
                />
              </div>
              <textarea
                id="pp-sql-input"
                className="pp-sql"
                value={sql}
                onChange={(e) => {
                  setSql(e.target.value);
                  markSqlDirty();
                }}
                required={editorMode === "sql"}
                spellCheck={false}
                aria-describedby="pp-sql-hint"
              />
              <small id="pp-sql-hint">
                Single SELECT with FROM / JOIN / WHERE / GROUP BY / LIMIT can
                convert to Visual. Compiled pipeline WITH (node_* CTEs) also
                round-trips. Other WITH, subqueries, UNION, ORDER BY, and window
                functions are refused.
              </small>
            </div>

            <div className="pp-actions" style={{ marginBottom: 0 }}>
              <Button
                type="button"
                icon={Workflow}
                onClick={() => {
                  if (convertSqlToVisual()) setEditorMode("visual");
                }}
              >
                Convert to visual
              </Button>
            </div>
          </TabPanel>

          {previewError && (
            <p role="alert" className="pp-error">
              {previewError}
            </p>
          )}

          <div className="pp-actions pp-actions-sticky">
            <Button
              type="button"
              icon={Play}
              onClick={() => void runPreview()}
            >
              Preview
            </Button>
            <Button
              type="submit"
              variant="primary"
              icon={Send}
              pending={action.pending}
            >
              Send for review
            </Button>
            <ButtonLink to={paths.pipelines()}>Cancel</ButtonLink>
          </div>

          {preview && (
            <Panel title="Preview" className="pp-preview">
              {preview.rows.length === 0 ? (
                <p>Query returned no rows.</p>
              ) : (
                <DataGrid
                  label="Pipeline preview"
                  rows={preview.rows}
                  columns={(
                    preview.profile?.columns ||
                    Object.keys(preview.rows[0] || {}).map((name) => ({
                      name,
                      type: "VARCHAR",
                    }))
                  ).map((c) => ({ key: c.name, type: c.type }))}
                />
              )}
            </Panel>
          )}

          {mode === "edit" && (
            <p className="pp-aliases">
              Saving creates a new proposal. After you publish it, this pipeline
              is replaced. <Link to={paths.proposals()}>Open proposals</Link>
            </p>
          )}
        </form>
      )}
    </Page>
  );
}
