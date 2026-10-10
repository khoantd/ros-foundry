import { ProviderSetup } from "./setup-components";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Copy,
  Download,
  Gauge,
  KeyRound,
  Terminal,
  Users,
} from "lucide-react";
import { useWorkspace, useAction, PageHeader } from "./ui";
import { api, ApiError } from "./api";
import { paths } from "./paths";

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function UsagePanel({ workspaceId }: { workspaceId: string }) {
  const license = useQuery({
    queryKey: [workspaceId, "license"],
    queryFn: () => api(`/workspaces/${workspaceId}/license`),
    retry: false,
  });

  if (license.isPending)
    return (
      <section className="panel settings-panel">
        <p className="pad muted">Loading usage…</p>
      </section>
    );

  if (license.isError)
    return (
      <section className="panel settings-panel">
        <p className="pad muted" role="alert">
          Couldn’t load license usage.
        </p>
      </section>
    );

  const { license: lic, usage, alerts } = license.data;
  const rows: {
    key: string;
    label: string;
    used: string;
    limit: string;
  }[] = [
    {
      key: "seats",
      label: "Seats",
      used: String(usage.seats),
      limit: lic.seats ? String(lic.seats) : "Unlimited",
    },
    {
      key: "sources",
      label: "Sources",
      used: String(usage.sources),
      limit: lic.maxSources ? String(lic.maxSources) : "Unlimited",
    },
    {
      key: "storage",
      label: "Storage",
      used: formatBytes(usage.storageBytes),
      limit: lic.maxStorageBytes
        ? formatBytes(lic.maxStorageBytes)
        : "Unlimited",
    },
    {
      key: "aiUnits",
      label: `AI units (${usage.month})`,
      used: String(usage.aiUnits),
      limit: lic.aiUnitsMonthly ? String(lic.aiUnitsMonthly) : "Unlimited",
    },
  ];

  return (
    <section className="panel settings-panel">
      <div className="panel-title">
        <h3>
          <Gauge size={18} /> Plan usage
        </h3>
        {lic.plan && <span className="muted">{lic.plan}</span>}
      </div>
      {alerts?.length > 0 && (
        <ul className="pad" style={{ listStyle: "none", margin: 0, padding: "0 16px" }}>
          {alerts.map((a: { dimension: string; level: string; message: string }) => (
            <li
              key={a.dimension}
              role="status"
              className={a.level === "exceeded" ? "rosf-quota-exceeded" : "muted"}
              style={{
                padding: "8px 0",
                borderBottom: "1px solid var(--border, var(--rosf-border))",
                color:
                  a.level === "exceeded"
                    ? "var(--danger, #b42318)"
                    : undefined,
              }}
            >
              {a.message}
            </li>
          ))}
        </ul>
      )}
      <ul className="pad" style={{ listStyle: "none", margin: 0, padding: 16 }}>
        {rows.map((r) => (
          <li
            key={r.key}
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              padding: "8px 0",
              borderBottom: "1px solid var(--border, var(--rosf-border))",
            }}
          >
            <span>{r.label}</span>
            <span className="muted">
              {r.used} / {r.limit}
            </span>
          </li>
        ))}
      </ul>
      <p className="pad muted" style={{ paddingTop: 0 }}>
        Limits come from the instance license. Zero means unlimited. A control
        plane heartbeat can refresh them without redeploying.
      </p>
    </section>
  );
}

function TeamPanel({ workspaceId, owner }: { workspaceId: string; owner: boolean }) {
  const action = useAction();
  const qc = useQueryClient();
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const members = useQuery({
    queryKey: [workspaceId, "members"],
    queryFn: () => api(`/workspaces/${workspaceId}/members`),
    retry: false,
  });

  if (members.isPending)
    return (
      <section className="panel settings-panel">
        <p className="pad muted">Loading members…</p>
      </section>
    );

  if (
    members.isError &&
    members.error instanceof ApiError &&
    members.error.status === 404
  )
    return (
      <section className="panel settings-panel">
        <div className="pad">
          <h3>
            <Users size={18} /> Team
          </h3>
          <p className="muted">
            Member invites are available when the instance runs in hosted mode
            (<code>AUTH_MODE=hosted</code>). Local installs use this computer’s
            owner only.
          </p>
        </div>
      </section>
    );

  if (members.isError)
    return (
      <section className="panel settings-panel">
        <p className="pad muted" role="alert">
          Couldn’t load members.
        </p>
      </section>
    );

  const data = members.data;
  return (
    <>
      <section className="panel settings-panel">
        <div className="panel-title">
          <h3>
            <Users size={18} /> Members
          </h3>
          {data.seats?.limit != null && (
            <span className="muted">
              {data.seats.used} / {data.seats.limit} seats
            </span>
          )}
        </div>
        <ul className="pad" style={{ listStyle: "none", margin: 0, padding: 16 }}>
          {data.items.map((m: any) => (
            <li
              key={m.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                padding: "8px 0",
                borderBottom: "1px solid var(--border, var(--rosf-border))",
              }}
            >
              <span>
                <strong>{m.name}</strong>
                {m.email && (
                  <span className="muted"> · {m.email}</span>
                )}
              </span>
              <span className="muted">{m.role}</span>
            </li>
          ))}
          {data.invitations?.map((i: any) => (
            <li
              key={i.id}
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                padding: "8px 0",
                borderBottom: "1px solid var(--border, var(--rosf-border))",
              }}
            >
              <span>
                <strong>{i.email}</strong>
                <span className="muted"> · pending invite</span>
              </span>
              <span className="muted">{i.role}</span>
            </li>
          ))}
        </ul>
      </section>
      {owner && (
        <section className="panel settings-panel">
          <div className="pad">
            <h3>Invite teammate</h3>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                action.run(async () => {
                  const r = await api(
                    `/workspaces/${workspaceId}/invitations`,
                    {
                      email: f.get("email"),
                      role: f.get("role") || "editor",
                    },
                  );
                  setInviteToken(r.token);
                  setInviteUrl(
                    location.origin + paths.invite(r.token),
                  );
                  await qc.invalidateQueries({
                    queryKey: [workspaceId, "members"],
                  });
                  (e.target as HTMLFormElement).reset();
                });
              }}
            >
              <label>
                Email
                <input name="email" type="email" required />
              </label>
              <label>
                Role
                <select name="role" defaultValue="editor">
                  <option value="editor">Editor</option>
                  <option value="viewer">Viewer</option>
                </select>
              </label>
              <button className="button" type="submit">
                Create invite
              </button>
            </form>
            {inviteUrl && inviteToken && (
              <div className="copy-box" style={{ marginTop: 12 }}>
                <p className="muted">
                  Share this link once. It expires in 7 days.
                </p>
                <div className="rosf-invite-token">
                  <code>{inviteUrl}</code>
                  <button
                    type="button"
                    className="button small"
                    onClick={() => navigator.clipboard.writeText(inviteUrl)}
                  >
                    <Copy size={14} />
                  </button>
                </div>
              </div>
            )}
          </div>
        </section>
      )}
    </>
  );
}

export default function SettingsPage() {
  const { id, role } = useWorkspace(),
    action = useAction(),
    [tab, setTab] = useState(
      new URLSearchParams(location.search).get("tab") || "models",
    ),
    [apiToken, setApiToken] = useState("");
  const owner = role === "owner";
  return (
    <>
      <PageHeader title="Workspace settings" description="" />
      <div className="tabs standalone">
        {[
          ["models", "AI & models"],
          ["team", "Team"],
          ["usage", "Usage"],
          ["developer", "Developer tools"],
        ].map(([value, label]) => (
          <button
            key={value}
            type="button"
            className={tab === value ? "active" : ""}
            onClick={() => setTab(value)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "models" ? (
        <section className="reading-width">
          <ProviderSetup />
        </section>
      ) : tab === "team" ? (
        <TeamPanel workspaceId={id} owner={owner} />
      ) : tab === "usage" ? (
        <UsagePanel workspaceId={id} />
      ) : (
        <>
          <section className="panel settings-panel">
            <div className="panel-title">
              <h3>
                <Terminal size={18} /> Developer access
              </h3>
              <a href="/api/docs" target="_blank">
                Open API docs ↗
              </a>
            </div>
            <form
              className="pad"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                action.run(async () => {
                  const r = await api(`/workspaces/${id}/tokens`, {
                    name: f.get("name"),
                    readOnly: f.get("readOnly") === "on",
                  });
                  setApiToken(r.token);
                });
              }}
            >
              <label>
                Token name
                <input
                  name="name"
                  required
                  placeholder="Local development"
                  disabled={!owner}
                />
              </label>
              <label className="checkbox">
                <input
                  name="readOnly"
                  type="checkbox"
                  defaultChecked
                  disabled={!owner}
                />{" "}
                Read-only access
              </label>
              <button className="button" disabled={!owner}>
                <KeyRound size={15} /> Create API token
              </button>
              {apiToken && (
                <div className="copy-box">
                  <code>{apiToken}</code>
                  <button
                    type="button"
                    className="button small"
                    onClick={() => navigator.clipboard.writeText(apiToken)}
                  >
                    <Copy size={14} />
                  </button>
                </div>
              )}
              <p className="muted">
                Tokens are scoped to this workspace. Copy once and store
                securely.
              </p>
              <pre className="sql-block">{`import { FoundryClient } from '@ros-foundry/sdk';\n\nconst foundry = new FoundryClient({\n  baseUrl: '${location.origin}',\n  workspaceId: '${id}',\n  token: process.env.ROS_FOUNDRY_TOKEN,\n});\n\nconst datasets = await foundry.list('dataset');`}</pre>
            </form>
          </section>
          <section className="panel settings-panel">
            <div className="pad">
              <h3>Portable definitions</h3>
              <p className="muted">
                Export published definitions without credentials. Imports become
                validated proposals.
              </p>
              <a
                className="button"
                href={`/api/v1/workspaces/${id}/definitions/export`}
                download="foundry-definitions.json"
              >
                <Download size={15} /> Export definitions
              </a>
            </div>
          </section>
        </>
      )}
    </>
  );
}
