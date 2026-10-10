import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Pencil, Play, Workflow } from "lucide-react";
import { api, relative } from "../../api";
import { paths } from "../../paths";
import { useWorkspace, useAction, useResources } from "../../ui";
import { useLiveActivity } from "../../shell/live";
import {
  Button,
  ButtonLink,
  EmptyState,
  KeyValue,
  Page,
  PageHeader,
  Panel,
  Skeleton,
  StatusBadge,
  formatRelative,
  toStatus,
} from "../../kit";
import type { Resource } from "../../../../../packages/shared/src";
import { SqlView } from "./sql-view";
import {
  isBuildActive,
  latestPipelineBuild,
  mergeBuildJobs,
} from "./build-status";

export function PipelineDetail() {
  const { pipelineId = "" } = useParams();
  const { id, role } = useWorkspace();
  const action = useAction();
  const live = useLiveActivity();
  const datasets = useResources("dataset");
  const jobs = useResources("job", { limit: 500 });
  const detail = useQuery({
    queryKey: [id, "pipeline", pipelineId],
    queryFn: () =>
      api<Resource>(`/workspaces/${id}/resources/pipeline/${pipelineId}`),
    enabled: !!pipelineId,
  });

  const latestBuild = useMemo(() => {
    if (!pipelineId) return null;
    const stored = (jobs.data?.items || []) as Resource[];
    return latestPipelineBuild(
      mergeBuildJobs(stored, live.jobs),
      pipelineId,
    );
  }, [jobs.data?.items, live.jobs, pipelineId]);
  const building = isBuildActive(latestBuild);

  if (detail.isPending) {
    return (
      <Page>
        <Skeleton height={200} />
      </Page>
    );
  }
  if (detail.error || !detail.data) {
    return (
      <Page>
        <EmptyState
          icon={Workflow}
          title="Pipeline not found"
          text="It may have been replaced by a newer publication."
          action={<ButtonLink to={paths.pipelines()}>Back to pipelines</ButtonLink>}
        />
      </Page>
    );
  }

  const p = detail.data;
  const inputIds: string[] = p.data.inputs || [];
  const byId = new Map(
    ((datasets.data?.items || []) as Resource[]).map((d) => [d.id, d]),
  );
  const output = ((datasets.data?.items || []) as Resource[]).find(
    (d) => d.id === p.data.outputDatasetId,
  );
  const buildStatus = latestBuild
    ? toStatus(String(latestBuild.data.status))
    : null;
  const buildError =
    latestBuild?.data.status === "failed" && latestBuild.data.error
      ? String(latestBuild.data.error)
      : null;

  return (
    <Page>
      <PageHeader
        title={p.name}
        subtitle={p.description || "Published pipeline"}
        breadcrumbs={[
          { label: "Pipelines", to: paths.pipelines() },
          { label: p.name },
        ]}
        icon={<Workflow size={20} aria-hidden />}
        meta={
          <ul className="pp-meta">
            {buildStatus && (
              <li className="pp-build-meta" aria-live="polite">
                <StatusBadge status={buildStatus} size="sm" />
                <span>
                  {building
                    ? buildStatus === "queued"
                      ? "Build queued"
                      : "Building…"
                    : buildStatus === "failed"
                      ? "Last build failed"
                      : "Last build"}{" "}
                  {formatRelative(latestBuild!.updatedAt)}
                </span>
              </li>
            )}
            <li>Updated {relative(p.updatedAt)}</li>
            {output && (
              <li>
                Output:{" "}
                <Link to={paths.dataset(output.id)}>{output.name}</Link>
              </li>
            )}
          </ul>
        }
        actions={
          role !== "viewer" && (
            <div className="pp-actions" style={{ margin: 0 }}>
              <Button
                icon={Play}
                pending={action.pending || building}
                disabled={building}
                onClick={() =>
                  void action.run(
                    () =>
                      api(`/workspaces/${id}/pipelines/${p.id}/run`, {}),
                    "Pipeline build queued",
                  )
                }
              >
                {building ? "Building…" : "Run now"}
              </Button>
              <ButtonLink icon={Pencil} to={paths.pipelineEdit(p.id)}>
                Edit
              </ButtonLink>
            </div>
          )
        }
      />

      {buildError && (
        <p className="pp-error" role="alert">
          {buildError}
        </p>
      )}

      <Panel title="Inputs">
        {inputIds.length === 0 ? (
          <p className="pp-aliases">No inputs declared.</p>
        ) : (
          <KeyValue
            items={inputIds.map((inputId) => {
              const ds = byId.get(inputId);
              return {
                label: ds?.name || inputId,
                value: ds ? (
                  <Link to={paths.dataset(ds.id)}>Open dataset</Link>
                ) : (
                  "Unavailable"
                ),
              };
            })}
          />
        )}
      </Panel>

      {Array.isArray(p.data.nodes) && p.data.nodes.length > 0 && (
        <Panel title="Graph">
          <p className="pp-aliases">
            Built from {p.data.nodes.length} visual node
            {p.data.nodes.length === 1 ? "" : "s"}. Edit to reopen the DAG
            editor.
          </p>
        </Panel>
      )}

      <Panel title="SQL" className="pp-preview">
        <SqlView sql={String(p.data.sql || "")} />
      </Panel>
    </Page>
  );
}
