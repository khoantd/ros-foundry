# Tasks

> Actionable checklist for the current feature or sprint. Sync with `.agent/SESSION.md` on `/handoff`.

## Current sprint — Single-tenant SaaS Phase 2 (license + quotas)

- [x] License document (env / in-memory refresh): seats, sources, storage, AI units, features
- [x] Usage metering: members/invites, sources, `DATA_DIR` size, monthly AI units
- [x] Hard enforce with `403` + `code: QUOTA_EXCEEDED` (sources, seats, storage, AI)
- [x] Heartbeat stub (`CONTROL_PLANE_URL`) + server interval
- [x] `GET /workspaces/:w/license` + Settings → Usage
- [x] Tests: `tests/license-quotas.test.ts`
- [x] Docs: API + GUIDE + `.env.example`

## Done — Phase 1 (hosted auth)

- [x] `AUTH_MODE` + `LICENSE_SEATS` in config / `.env.example`
- [x] Hosted auth API: bootstrap, login, logout, status, invites, members
- [x] No `localIdentity` fallback when `AUTH_MODE=hosted`
- [x] Tests: `tests/auth-hosted.test.ts` (+ existing local 404 expectations)
- [x] Web: login / register / invite + 401 gate
- [x] Settings → Team tab (members + invite link)

## Backlog — SaaS later phases

- [ ] Phase 3: control plane + Stripe + per-tenant provisioner
- [ ] Phase 4: marketing site + signup funnel
- [ ] Phase 5: backups, suspend/delete, observability, security review
- [ ] Promote Company Brain `ros-foundry` product notes for hosted SaaS
- [ ] Optional: rename on-disk folder
- [ ] Optional: `SqlView` chrome on Analyst `.an-sql`
