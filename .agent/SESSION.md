# Agent session

> Cross-tool handoff state for Cursor, Claude Code, and Kiro. Update at session end (`/handoff`) or phase changes; read at session start (`/resume`).

## Meta

| Field | Value |
|-------|-------|
| **Updated** | 2026-10-10 |
| **Phase** | build |
| **Tool** | cursor |
| **Persona** | _(optional)_ |

## Goal

Single-tenant commercial SaaS MVP — Phase 2 license quotas + heartbeat (local-first default unchanged).

## Done

- ROS Foundry rename (packages, compose, brand, docs, GitHub origin).
- Pipeline live build status; catalog repair; OpenAI schema strip; Helix 429 / empty JSON fixes.

## Done (this session)

- Phase 1 hosted auth (prior): `AUTH_MODE`, invites, Settings → Team, `tests/auth-hosted.test.ts`.
- Phase 2 license + quotas + heartbeat stub:
  - [`apps/api/src/license.ts`](apps/api/src/license.ts): license doc, usage meter, `QUOTA_EXCEEDED`, heartbeat
  - Config / `.env.example`: `LICENSE_MAX_*`, `LICENSE_AI_UNITS_MONTHLY`, `CONTROL_PLANE_URL`, `LICENSE_INSTANCE_ID`, `LICENSE_HEARTBEAT_MS`
  - Enforce: source create (data + onboarding), storage (upload/ingest), AI units (`Provider.generate`), seats (auth via license)
  - `GET /api/v1/workspaces/:w/license` → `{ license, usage, alerts }`
  - Web: Settings → Usage
  - Tests: [`tests/license-quotas.test.ts`](tests/license-quotas.test.ts)
  - Docs: `docs/API.md`, `docs/GUIDE.md`
- Fix: local→hosted bootstrap blocked by passwordless `local-user` owner (`hostedOwner` check; claim + transfer workspaces; register route UX).

## In progress

- _(none)_
- **Blockers:** none

## Next

1. Dogfood: local AI is up (`brew services start ollama`, `qwen3:4b` pulled); provider set to local after Prepare local fix.
2. Phase 3: control plane + Stripe + per-tenant provisioner (real heartbeat consumer).
3. Phase 4–5: marketing funnel + ops (backups, suspend).

## Decisions

- Tenancy: single-tenant hosted (one stack per customer), not shared multi-tenant data plane.
- Auth: email/password + invites in-app (scrypt); no Clerk/Auth0 for MVP.
- Local mode remains default; auth routes 404 when not hosted.
- Quotas: 0 = unlimited; AI unit = one successful `Provider.generate` call per calendar month (UTC).
- Heartbeat: stub until Phase 3 — no-op without `CONTROL_PLANE_URL`; when set, POST usage and apply returned license.

## Gotchas

- Prepare local needs Ollama on `OLLAMA_URL` (default `:11434`). Without it the job fails as “Local AI is unavailable”; home shows finding `Failed Prepare local`.
- `concurrently -k` kills the whole stack if one child dies.
- Seat check: pending invites count toward seats; accept does not double-count.
- `tx.update(r, data)` replaces `data` entirely — always spread `r.data`.
- Source quota is checked before discovery/connect so tests can block without a live DB.
- `createApp` applies license options into module state; tests must `resetLicenseState()` / restore config in `afterEach`.

## Pointers

| Item | Location |
|------|----------|
| Spec / plan | `/Users/macbook/.cursor/plans/saas_single-tenant_mvp_415804c7.plan.md` |
| Tasks | `tasks/todo.md` |
| Branch | current |
| Key files | `apps/api/src/license.ts`, `apps/api/src/auth.ts`, `apps/api/src/providers.ts`, `apps/web/src/settings.tsx`, `tests/license-quotas.test.ts` |
