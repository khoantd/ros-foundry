// Data Connection job handlers (upload, sync), dispatched by the worker in jobs.ts.
import type { Resource } from "../../../packages/shared/src/index.js";
import { jobProgress } from "./setup-jobs.js";
import { prepareSourceSync } from "./source-sync.js";
import { transaction, now, type Store } from "./store.js";
import { importSource } from "./connectors.js";
import { applyDeltaVersion, ingestFile } from "./datasets.js";
import { unseal } from "./security.js";
import {
  canApplyDeltas,
  coalesceOps,
  pruneJournal,
  readJournalOps,
} from "./cdc-journal.js";

export async function runUploadJob(store: Store, scope: string, job: Resource) {
  await jobProgress(store, scope, job.id, {
    message: "Importing and profiling complete file",
  });
  await ingestFile(
    store,
    scope,
    job.name,
    job.data.file,
    undefined,
    job.data.datasetId,
    job.id,
    undefined,
    job.id,
  );
}

async function snapshotImport(
  store: Store,
  scope: string,
  source: Resource,
  job: Resource,
) {
  const imported = await importSource(
    scope,
    source.data.kind,
    unseal(source.data.secret),
    (p) => jobProgress(store, scope, job.id, p),
  );
  return ingestFile(
    store,
    scope,
    source.name,
    imported.file,
    source.id,
    source.data.datasetId || "source_" + source.id,
    job.id,
    imported.schema,
    job.id,
  );
}

export async function runSyncJob(store: Store, scope: string, job: Resource) {
  let source = await store.get(scope, job.data.sourceId);
  if (!source) throw new Error("Source missing");
  source = await prepareSourceSync(store, scope, source);
  const changeCounter = Number(source.data.sync?.changes || 0);
  const applied = Number(source.data.sync?.applied || 0);
  const keys = source.data.sync?.keys as string[] | undefined;
  const datasetId = source.data.datasetId as string | undefined;
  const dataset = datasetId ? await store.get(scope, datasetId) : undefined;
  const baseVersion = dataset?.data.activeVersion as string | undefined;
  const rowCount = Number(dataset?.data.profile?.rows || 0);

  let ds: Resource | undefined;
  let usedDelta = false;
  if (
    source.data.sync?.mode === "cdc" &&
    baseVersion &&
    keys?.length &&
    changeCounter > applied
  ) {
    const ops = await readJournalOps(scope, source.id, applied, changeCounter);
    if (canApplyDeltas(ops, applied, changeCounter, keys, rowCount)) {
      try {
        await jobProgress(store, scope, job.id, {
          message: "Applying row changes",
          records: ops.length,
        });
        const { deletes, upserts } = coalesceOps(ops, keys);
        ds = await applyDeltaVersion(
          store,
          scope,
          source.name,
          baseVersion,
          keys,
          deletes,
          upserts,
          source.id,
          datasetId,
          job.id,
        );
        usedDelta = true;
      } catch {
        await jobProgress(store, scope, job.id, {
          message: "Row patch failed; reading complete snapshot",
        });
        ds = await snapshotImport(store, scope, source, job);
      }
    }
  }
  if (!ds) ds = await snapshotImport(store, scope, source, job);

  await transaction(store, scope, async (tx) => {
    const s = await tx.get(source.id);
    if (s && s.data.secret === source.data.secret)
      tx.update(s, {
        ...s.data,
        datasetId: ds!.id,
        lastSync: now(),
        lastError: null,
        sync: s.data.sync
          ? {
              ...s.data.sync,
              applied: changeCounter,
              ...(usedDelta ? { lastApply: "delta" } : { lastApply: "snapshot" }),
            }
          : undefined,
      });
  });
  if (source.data.sync?.mode === "cdc")
    await pruneJournal(scope, source.id, changeCounter).catch(() => {});
}
