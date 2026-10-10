import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Cable, Database, Pause, Play, RefreshCw } from "lucide-react";
import type { Resource } from "../../../../../packages/shared/src";
import { api } from "../../api";
import { useAction, useResources, useWorkspace } from "../../ui";
import {
  Button,
  DataGrid,
  EmptyState,
  KeyValue,
  Page,
  PageHeader,
  Panel,
  Section,
  SkeletonText,
  SourceLogo,
  StatusBadge,
  connectorLabel,
  connectorOf,
  formatDate,
  formatNumber,
  formatRelative,
  toStatus,
} from "../../kit";
import { paths } from "../../paths";

const SCHEDULE_PRESETS = [
  { value: "", label: "Automatic (default for this connector)" },
  { value: "*/5 * * * *", label: "Every 5 minutes" },
  { value: "*/15 * * * *", label: "Every 15 minutes" },
  { value: "0 * * * *", label: "Hourly" },
  { value: "0 */6 * * *", label: "Every 6 hours" },
  { value: "0 0 * * *", label: "Daily at 00:00 UTC" },
  { value: "custom", label: "Custom cron…" },
] as const;

function schedulePreset(schedule: string | null | undefined) {
  if (!schedule) return "";
  return SCHEDULE_PRESETS.some((p) => p.value === schedule) ? schedule : "custom";
}

// Interim source page: status, recent syncs and the datasets it produces.
export function ConnectionDetail({ sourceId }: { sourceId: string }) {
  const { id, role } = useWorkspace(),
    action = useAction();
  const source = useQuery({
    queryKey: [id, "source", sourceId],
    queryFn: () =>
      api<Resource>(`/workspaces/${id}/resources/source/${sourceId}`),
  });
  const jobs = useResources("job", { limit: 500 }),
    datasets = useResources("dataset", { limit: 500 });
  const s = source.data;
  const [preset, setPreset] = useState(() =>
    schedulePreset(s?.data.schedule),
  );
  const [customCron, setCustomCron] = useState(
    () =>
      (s?.data.schedule && schedulePreset(s.data.schedule) === "custom"
        ? s.data.schedule
        : "") || "",
  );
  useEffect(() => {
    if (!s) return;
    setPreset(schedulePreset(s.data.schedule));
    setCustomCron(
      s.data.schedule && schedulePreset(s.data.schedule) === "custom"
        ? s.data.schedule
        : "",
    );
  }, [s?.id, s?.data.schedule, s?.revision]);
  const crumbs = [
    { label: "Data", to: paths.data() },
    { label: "Data", to: paths.data() },
  ];
  if (source.isPending)
    return (
      <Page>
        <SkeletonText lines={4} />
      </Page>
    );
  if (source.error || !s)
    return (
      <Page>
        <PageHeader breadcrumbs={crumbs} title="Connection unavailable" />
        <EmptyState
          icon={Cable}
          title="This connection no longer exists"
          text={source.error?.message}
        />
      </Page>
    );
  const connector = connectorOf(s);
  const runs = ((jobs.data?.items || []) as Resource[])
    .filter((j) => j.data.sourceId === s.id)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const produced = ((datasets.data?.items || []) as Resource[]).filter(
    (d) => d.data.sourceId === s.id,
  );
  const latest = runs[0];
  const canEdit = role !== "viewer";
  const cdc = s.data.sync?.mode === "cdc";
  const paused = !!s.data.paused;
  const dirtySchedule =
    (preset === "custom" ? customCron.trim() : preset) !== (s.data.schedule || "");
  const saveSchedule = () => {
    const schedule =
      preset === "custom" ? customCron.trim() || null : preset || null;
    return action.run(
      () =>
        api(`/workspaces/${id}/sources/${s.id}`, { schedule }, "PATCH"),
      schedule ? "Schedule updated" : "Using automatic refresh",
    );
  };
  return (
    <Page>
      <PageHeader
        breadcrumbs={[...crumbs, { label: s.name }]}
        icon={<SourceLogo source={connector} size={28} />}
        title={s.name}
        subtitle={[s.data.connectionName, connectorLabel(connector)]
          .filter(Boolean)
          .join(" · ")}
        meta={
          <>
            <StatusBadge
              status={
                paused
                  ? "paused"
                  : latest
                    ? toStatus(latest.data.status)
                    : toStatus(s.data.sync?.status)
              }
            />
            {latest && !paused && (
              <span>Last activity {formatRelative(latest.updatedAt)}</span>
            )}
            {paused && <span>Automatic sync paused</span>}
          </>
        }
        actions={
          canEdit && (
            <>
              <Button
                variant="secondary"
                icon={paused ? Play : Pause}
                pending={action.pending}
                onClick={() =>
                  action.run(
                    () =>
                      api(
                        `/workspaces/${id}/sources/${s.id}`,
                        { paused: !paused },
                        "PATCH",
                      ),
                    paused ? "Sync resumed" : "Sync paused",
                  )
                }
              >
                {paused ? "Resume" : "Pause"}
              </Button>
              <Button
                variant="primary"
                icon={RefreshCw}
                pending={action.pending}
                onClick={() =>
                  action.run(
                    () => api(`/workspaces/${id}/sources/${s.id}/sync`, {}),
                    "Sync queued",
                  )
                }
              >
                Sync now
              </Button>
            </>
          )
        }
      />
      <div className="dc-connection-grid">
        <Panel title="Recent syncs" padded={false}>
          <DataGrid
            label="Recent syncs"
            loading={jobs.isPending}
            rows={runs}
            getRowKey={(r) => r.id}
            maxHeight={360}
            emptyText="No syncs yet."
            columns={[
              {
                key: "status",
                label: "Status",
                width: 130,
                render: (r) => (
                  <StatusBadge status={toStatus(r.data.status)} size="sm" />
                ),
                sortValue: (r) => r.data.status,
              },
              { key: "createdAt", label: "Started", type: "timestamp" },
              { key: "updatedAt", label: "Updated", type: "timestamp" },
              {
                key: "message",
                label: "Details",
                width: 240,
                render: (r) =>
                  r.data.error || r.data.progress?.message || r.name,
                sortable: false,
              },
            ]}
          />
        </Panel>
        <Panel title="Details">
          <KeyValue
            items={[
              { label: "Connector", value: connectorLabel(connector) },
              {
                label: "Sync mode",
                value: s.data.sync?.mode,
                hint: s.data.sync?.reason,
              },
              {
                label: "Next refresh",
                value: s.data.nextRun ? formatDate(s.data.nextRun) : null,
              },
              { label: "Created", value: formatDate(s.createdAt) },
            ]}
          />
          {canEdit ? (
            <form
              className="dc-sync-controls"
              onSubmit={(e) => {
                e.preventDefault();
                if (dirtySchedule) void saveSchedule();
              }}
            >
              <label className="rosf-field">
                <span>
                  {cdc ? "Snapshot fallback schedule" : "Refresh schedule"}
                </span>
                <select
                  value={preset}
                  onChange={(e) => setPreset(e.target.value)}
                  disabled={action.pending}
                >
                  {SCHEDULE_PRESETS.map((p) => (
                    <option key={p.value || "auto"} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              {preset === "custom" && (
                <label className="rosf-field">
                  <span>Cron (UTC)</span>
                  <input
                    value={customCron}
                    onChange={(e) => setCustomCron(e.target.value)}
                    placeholder="*/5 * * * *"
                    spellCheck={false}
                    autoComplete="off"
                    disabled={action.pending}
                    required
                  />
                </label>
              )}
              <p className="dc-sync-hint">
                {cdc
                  ? "Live change capture is active. This schedule is only used if the stream falls back to snapshots."
                  : "Times are UTC. Automatic uses the connector default."}
              </p>
              <Button
                type="submit"
                size="sm"
                pending={action.pending}
                disabled={!dirtySchedule || (preset === "custom" && !customCron.trim())}
              >
                Save schedule
              </Button>
            </form>
          ) : (
            <KeyValue
              items={[
                {
                  label: "Schedule",
                  value: s.data.schedule
                    ? `${s.data.schedule} UTC`
                    : "Automatic",
                  mono: !!s.data.schedule,
                },
              ]}
            />
          )}
        </Panel>
      </div>
      <Section
        title="Datasets"
        description="Tables this connection keeps up to date."
      >
        {produced.length ? (
          <ul className="dc-dataset-list">
            {produced.map((d) => (
              <li key={d.id}>
                <Link to={paths.dataset(d.id)}>
                  <Database size={15} aria-hidden />
                  <strong>{d.name}</strong>
                  <span>
                    {formatNumber(d.data.profile?.rows)} rows ·{" "}
                    {d.data.profile?.columns?.length || 0} columns
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            size="sm"
            icon={Database}
            title="No datasets yet"
            text="Datasets appear after the first sync finishes."
          />
        )}
      </Section>
    </Page>
  );
}
