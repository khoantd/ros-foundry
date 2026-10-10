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

## Next

1. Promote Company Brain product to approved when ready.
2. Optional: rename on-disk folder to `ros-foundry`.
3. Optional: apply `SqlView` chrome to Analyst `.an-sql`.

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
