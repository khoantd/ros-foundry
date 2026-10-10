# Operating ROS Foundry

## Installation profiles

`./scripts/setup.sh --compose` starts the local-model profile and downloads the tested Qwen3 4B model. The app is available on `http://localhost:3001`. On Apple Silicon, native Ollama can use Metal: run the data services without `--profile local` and set `MODEL_ENDPOINT=http://host.docker.internal:11434` in `.env`.

Keep `.env`, data volumes, and backups private. The application encrypts connector/provider credentials using `ENCRYPTION_KEY`; losing that key makes those credentials unrecoverable. Do not rotate it by simply replacing the environment value. ROS Foundry has no sign-in, so do not admit other devices. The API refuses a non-loopback `HOST` unless `ALLOW_NETWORK_ACCESS=true`, which Compose sets because it publishes the app on `127.0.0.1` only. Do not expose it to a network through a reverse proxy, tunnel, or port forward. Internal HelixDB, Ollama, and executor ports are not published by Compose.

## Diagnostics and schema migration

`pnpm doctor` checks the database, executor, model endpoint, and local secrets. `/api/health` is a process health check. Startup applies the indexed version-1 metadata schema idempotently; `node --import tsx scripts/migrate.ts` applies it explicitly. Startup rejects database schema versions newer than the application.

Jobs claim leases and periodically renew them. A worker restart reclaims expired leases. AI stages save definitions and usage after each completed stage; a failed/canceled run can be resumed through Activity or the API. Input changes invalidate cached stages. Failed connector/pipeline jobs retry three times with bounded backoff. A stopped worker does not stop published dashboard queries.

## Backup, restore, and upgrades

Database synchronization prefers native CDC. PostgreSQL needs logical WAL, a replication-capable login, a primary key/usable replica identity, table publication permission, and available replication slots. Foundry creates a publication and slot scoped to each selected table. MySQL needs row-format binary logging, SELECT access, and replication client/slave privileges. Read-only logins still import through the scheduled fallback. Foundry never changes server-wide database configuration or writes business records back to sources.

The capture service runs independently of inference, saves its dirty counter and log position atomically in HelixDB, journals row ops under the data directory, and acknowledges PostgreSQL only after that durable write. One queued sync job coalesces multiple commits; its starting counter prevents concurrent changes from being marked applied accidentally. When the journal covers every change since the last apply with only insert/update/delete ops under the size bounds, the executor patches the active parquet by primary key into a new immutable version. Otherwise it materialises a full snapshot (including reconnects, truncations, DDL, and overflow). Existing complete snapshots stay available during imports. Schema changes still need review. Transient stream failures retry from saved positions, then fall back to scheduled refreshes. The two-million-row import and executor memory limits still apply to full snapshots.

Monitor source-side WAL/binlog disk retention. Configure PostgreSQL's `max_slot_wal_keep_size` and a suitable MySQL binlog expiration policy for the installation; the application does not alter either server setting. Stop capture before manually removing Foundry-owned slots/publications. Keep their names from the source's sync metadata when decommissioning a source or changing its endpoint. Do not drop other applications' replication resources.

1. Run `./scripts/backup.sh PATH`. It stops writers and HelixDB, archives the data volumes, saves the encryption configuration, then restarts services.
2. Copy the backup to private off-host storage.
3. For a replacement installation, use `./scripts/restore.sh PATH --replace`. This replaces that installation's data volumes and `.env`.
4. Set `COMPOSE_PROJECT_NAME` when using a nondefault project name; use the same name throughout backup and restore. After the rename from `helix-foundry` to `ros-foundry`, existing Docker volumes stay under the old project name — either keep `COMPOSE_PROJECT_NAME=helix-foundry` or backup then restore into the new project.
5. Before upgrades, retain the old application commit, lockfile, image, and backup. Rebuild and run diagnostics, sample ingestion, a saved query, and proposal validation before using the installation again. Revert the application plus matching data backup if an upgrade fails.

Model weights are reproducible and excluded from application backups. Parquet versions and staged artifacts are immutable; unsuccessful previews can consume disk. There is no automatic artifact garbage collector in this MVP. Remove unreferenced files only during offline maintenance, after checking proposal/run previews and version records.

## Deployment limits

Two DuckDB jobs execute concurrently with a 512 MB per-process memory setting and a 120-second timeout. The executor container has a 2 GB memory cap and an internal-only network. One worker performs one inference job at a time. Use one worker replica in this single-server release.

The supported runtime is Node.js 24. There are no accounts: each installation serves one person on their own computer, who owns every workspace. API tokens are workspace scoped, optionally read-only, and revocable. See `VALIDATION.md` for benchmark scope and unverified deployment combinations.
