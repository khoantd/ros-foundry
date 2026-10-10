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

Full-identity rename Helix Foundry → **ROS Foundry** (Royal Solution portfolio alignment).

## Done

- Packages: root `ros-foundry`, `@ros-foundry/shared`, `@ros-foundry/sdk`; lockfile refreshed.
- Compose / scripts / health: `ros-foundry`; credential labels `ROS Foundry …`.
- Web brand + CSS: `--rosf-*` tokens, `rosf-*` classes, sidebar lockup `ros`+`foundry`.
- Docs, logos (text SVG), OPERATIONS volume-migration note.
- Company Brain proposed: `04-PRODUCTS/ros-foundry/PRODUCT.md`.
- Stale kit test: `/pipelines` → section `pipelines`.
- `pnpm typecheck` + `pnpm test` green (188 passed).
- GitHub: https://github.com/khoantd/ros-foundry (`origin`); old remote kept as `helix-foundry`.

## In progress

- _(none)_
- **Blockers:** none

## Done (this session)

- Fixed onboarding AI-choice save error (`JSON.parse: unexpected end of data`): `api()` now handles empty/non-JSON proxy bodies; clearer Helix 429 messages; `useSetup` backs off on 429; SetupGate passes error through.
- Resolved Helix Cloud 429s: `.env` pointed at local HelixDB `http://127.0.0.1:6996`; idle onboarding poll slowed to 8s; provider-job included in settling polls.
- Local workspace `09882d97-…` responds without rate limits (~30ms); Cloud workspace id stays on Cloud only.
- Fixed OpenAI HTTP 400 on pipeline generation: `strictSchema` strips `propertyNames` (from `z.record`) and empty enums; provider errors now include OpenAI’s message. Failed review run advanced to `awaiting_review`.
- Fixed Review Catalog Errors from stale `d_pipeline_*` after Prepare/repair: `validateBundle` realigns SQL table refs, expands query inputs from SQL, topo-sorts cross-pipeline deps (`apps/api/src/assistant.ts` + `tests/workflow.test.ts`).
- Pipeline detail shows live build status (queued → running → succeeded/failed) from jobs + live events; Run now disabled while building (`build-status.ts`, `detail.tsx`).

## Next

1. Re-run Prepare → Review on the sample workspace to confirm Catalog Errors are gone.
2. Promote Company Brain product to approved when ready.
3. Optional: rename on-disk folder to `ros-foundry`.
4. Optional: apply `SqlView` chrome to Analyst `.an-sql`.
5. Re-enable Helix Cloud in `.env` only when needed (commented credentials kept).

## Decisions

- Keep HelixDB / `HELIX_*` / helix Compose service (engine, not brand).
- Keep SDK class names `FoundryClient` / `FoundryError`.
- CSS prefix `rosf` (not `rf`) for clarity.
- Existing Docker volumes: keep `COMPOSE_PROJECT_NAME=helix-foundry` or backup → restore.

## Gotchas

- `concurrently -k` kills the whole stack if one child (e.g. executor) dies.
- Compose project rename creates new volumes by default.
- Path-based imports of `packages/shared/src` did not need package-name updates.

## Pointers

| Item | Location |
|------|----------|
| Spec | — |
| Tasks | `tasks/todo.md` |
| Branch | current |
| Key files | `package.json`, `packages/*/package.json`, `compose.yaml`, `apps/web/src/shell/*`, `apps/web/src/kit/kit.css`, `docs/assets/logo-*.svg` |
