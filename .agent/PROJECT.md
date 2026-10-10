# Project structure map

> Persistent overview for AI agents. Generated on first run by `/understand` (see `.cursor/commands/understand-project.md`). Update when architecture changes significantly.

## Meta

| Field | Value |
|-------|-------|
| **Updated** | 2026-10-10 |
| **Tool** | cursor |

## Stack

- **Language:** TypeScript (Node ≥24, ESM), React 19
- **Package manager:** pnpm 10.7 (workspace: `packages/*`)
- **API:** Fastify 5 (`apps/api`) — loopback-only by default; `AUTH_MODE=hosted` enables accounts/invites
- **Web:** Vite 7 + React Router 7 + TanStack Query + Tailwind 4 (`apps/web`)
- **Query engine:** DuckDB via isolated executor (`services/executor`)
- **Graph / metadata:** HelixDB (`@helix-db/helix-db` 3.2)
- **Local AI:** Ollama (`qwen3:4b` default); optional Claude / OpenAI
- **Validation:** Zod 4
- **Tests:** Vitest + Playwright
- **Deploy:** Docker Compose (`compose.yaml`, `Dockerfile`); local-first on `127.0.0.1`

## Layout

| Path | Purpose |
|------|---------|
| `apps/api/` | Fastify API, worker jobs, connectors, onboarding, AI/providers |
| `apps/web/` | React SPA (Home, Ontology, Data, Analyst, Setup, Settings) |
| `services/executor/` | Isolated DuckDB SELECT runner (no credentials / no internet) |
| `packages/shared/` | Shared types/contracts for API ↔ web ↔ SDK |
| `packages/sdk/` | TypeScript client (`FoundryClient`) for workspace-scoped API tokens |
| `scripts/` | `setup.sh`, backup/restore, doctor, migrate, benchmark |
| `tests/` | Vitest suites + Playwright browser tests |
| `docs/` | GUIDE, API, OPERATIONS, HOSTING, VALIDATION, onboarding |
| `tasks/` | Agent task checklist (`todo.md`) |
| `.agent/` | Session handoff + this structure map |
| `.cursor/` / `.claude/` / `.kiro/` / `.agents/` | Multi-tool agent hubs (sync via class-ai-agent tooling) |

## Entry points

- **API bootstrap:** `apps/api/src/server.ts` → `createApp` (`app.ts`) + optional inline `startWorker` (`jobs.ts`)
- **Standalone worker:** `apps/api/src/worker.ts` (Compose); inline in API during `pnpm dev`
- **Executor:** `services/executor/src/server.ts` (`GET /health`, `POST /execute`)
- **Web:** `apps/web/src/main.tsx` — routes under `WorkspaceRoutes` (Home `/`, Data, Ontology, Analyst, proposals, settings, onboarding gate)
- **API route modules:** `apps/api/src/routes/{data,ontology,analyst,pipelines,workspace}.ts` plus onboarding/hosting
- **Compose / prod:** `./scripts/setup.sh --compose` → app on `PUBLIC_PORT` (default 3001)

## Key files

- `apps/api/src/app.ts` — Fastify app, security (loopback Host/Origin), route registration
- `apps/api/src/store.ts` — HelixDB-backed metadata store
- `apps/api/src/connectors.ts` / `source-sync.ts` / `discovery.ts` — data sources & CDC
- `apps/api/src/onboarding.ts` / `sample-data.ts` — guided setup & Loopwell sample
- `apps/api/src/providers.ts` / `assistant.ts` — AI providers & analyst
- `apps/api/src/security.ts` — encryption, AppError, redaction
- `services/executor/src/engine.ts` / `runner.ts` — DuckDB isolation
- `packages/sdk/src/index.ts` — SDK surface
- `packages/shared/src/` — domain contracts (workspace, ontology, data, analyst, pipelines)
- `compose.yaml`, `Dockerfile` — runtime stack
- `.env.example` — env template (secrets via `scripts/setup.sh`)
- `.github/workflows/ci.yml` — typecheck, test, build on Node 24
- `docs/GUIDE.md`, `docs/API.md`, `AGENTS.md` — product + agent runbooks

## Commands

| Action | Command |
|--------|---------|
| Install | `pnpm install` |
| Setup env | `./scripts/setup.sh` (Compose: `./scripts/setup.sh --compose`) |
| Dev | `pnpm dev` (API 3001, executor 3002, web 5173) |
| Typecheck | `pnpm typecheck` |
| Test | `pnpm test` (`pnpm test:browser` for Playwright) |
| Build | `pnpm build` |
| Doctor | `pnpm doctor` |
| Migrate | `pnpm migrate` |
| Health (Compose) | `curl -fsS http://localhost:3001/api/health` |

## Code intelligence

| Item | Status |
|------|--------|
| CodeGraph index | Present — 237 files, ~5.1k nodes, ~16k edges |
| Workspace root | `/Volumes/Data/Software Development/TypeScript/ros-foundry` |
| OntoSight | `npx royalsolution-ontosight@0.2.1 "/Volumes/Data/Software Development/TypeScript/ros-foundry"` |

## Notes

- Local-first default: no accounts; anyone who can reach the app is owner. Never expose beyond loopback unless `AUTH_MODE=hosted` and a private network for Helix/executor.
- Change `PUBLIC_PORT` and `PUBLIC_ORIGIN` together or browser saves fail with `403 Origin is not allowed`.
- Data path: connectors → Parquet snapshots → DuckDB executor; ontology/jobs/tokens live in HelixDB.
- UI areas: Home (metrics), Ontology (explorer), Data (sources), Analyst (Q&A + proposals), Settings (AI + API tokens).
- `tasks/todo.md` and `.agent/SESSION.md` are still templates (no active feature sprint).
