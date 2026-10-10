import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { config } from "./config.js";
import { AppError, assert } from "./security.js";
import { resource, transaction, type Store } from "./store.js";

export type LicenseDocument = {
  seats: number;
  maxSources: number;
  maxStorageBytes: number;
  aiUnitsMonthly: number;
  features: string[];
  plan?: string;
  updatedAt?: string;
};

export type UsageSnapshot = {
  seats: number;
  sources: number;
  storageBytes: number;
  aiUnits: number;
  month: string;
};

export type QuotaDimension = "seats" | "sources" | "storage" | "aiUnits";

export type QuotaAlert = {
  dimension: QuotaDimension;
  level: "warn" | "exceeded";
  used: number;
  limit: number;
  message: string;
};

const LicenseSchema = z.object({
  seats: z.number().int().min(0).default(0),
  maxSources: z.number().int().min(0).default(0),
  maxStorageBytes: z.number().int().min(0).default(0),
  aiUnitsMonthly: z.number().int().min(0).default(0),
  features: z.array(z.string()).default([]),
  plan: z.string().max(64).optional(),
  updatedAt: z.string().optional(),
});

const USAGE_ID = "usageMeter";
const WARN_RATIO = 0.8;

let active: LicenseDocument = licenseFromConfig();
let usageStore: Store | null = null;

/** Bind the app store so Provider.generate can meter AI units. */
export function bindUsageStore(store: Store | null) {
  usageStore = store;
}

export function getUsageStore() {
  return usageStore;
}

export function licenseFromConfig(
  overrides: Partial<LicenseDocument> = {},
): LicenseDocument {
  return {
    seats: overrides.seats ?? config.licenseSeats,
    maxSources: overrides.maxSources ?? config.licenseMaxSources,
    maxStorageBytes: overrides.maxStorageBytes ?? config.licenseMaxStorageBytes,
    aiUnitsMonthly: overrides.aiUnitsMonthly ?? config.licenseAiUnitsMonthly,
    features: overrides.features ?? config.licenseFeatures,
    plan: overrides.plan ?? (config.licensePlan || undefined),
    updatedAt: overrides.updatedAt,
  };
}

export function getLicense(): LicenseDocument {
  return { ...active };
}

export function applyLicense(partial: Partial<LicenseDocument>) {
  active = LicenseSchema.parse({ ...active, ...partial });
  return getLicense();
}

export function resetLicenseState() {
  active = licenseFromConfig();
  usageStore = null;
}

export function usageMonthKey(now = new Date()) {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function directorySize(root: string): number {
  let total = 0;
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        try {
          total += statSync(path).size;
        } catch {
          /* race / permission */
        }
      }
    }
  };
  walk(root);
  return total;
}

async function seatCount(store: Store, workspaceId: string) {
  const members = (await store.list("global", "member")).filter(
    (m) => m.data.workspaceId === workspaceId,
  );
  const invites = (await store.list("global", "invitation")).filter(
    (i) =>
      i.data.workspaceId === workspaceId &&
      !i.data.acceptedAt &&
      (!i.data.expiresAt || i.data.expiresAt > Date.now()),
  );
  return members.length + invites.length;
}

async function readAiUnits(store: Store): Promise<{ month: string; aiUnits: number }> {
  const month = usageMonthKey();
  const meter = await store.get("global", USAGE_ID);
  if (meter?.kind === "usageMeter" && meter.data.month === month)
    return { month, aiUnits: Number(meter.data.aiUnits) || 0 };
  return { month, aiUnits: 0 };
}

export async function measureUsage(
  store: Store,
  workspaceId: string,
  storageBytes: () => number = () => directorySize(config.dataDir),
): Promise<UsageSnapshot> {
  const sources = (await store.list(workspaceId, "source")).length;
  const seats = await seatCount(store, workspaceId);
  const { month, aiUnits } = await readAiUnits(store);
  return {
    seats,
    sources,
    storageBytes: storageBytes(),
    aiUnits,
    month,
  };
}

function limitOf(dimension: QuotaDimension, license: LicenseDocument) {
  if (dimension === "seats") return license.seats;
  if (dimension === "sources") return license.maxSources;
  if (dimension === "storage") return license.maxStorageBytes;
  return license.aiUnitsMonthly;
}

function usedOf(dimension: QuotaDimension, usage: UsageSnapshot) {
  if (dimension === "seats") return usage.seats;
  if (dimension === "sources") return usage.sources;
  if (dimension === "storage") return usage.storageBytes;
  return usage.aiUnits;
}

const LABELS: Record<QuotaDimension, string> = {
  seats: "Seat limit reached for this workspace. Upgrade your plan or remove a member.",
  sources:
    "Source limit reached for this plan. Remove a source or upgrade your plan.",
  storage:
    "Storage limit reached for this plan. Free space or upgrade your plan.",
  aiUnits:
    "AI unit limit reached for this month. Wait for the next billing cycle or upgrade your plan.",
};

export function assertQuota(
  dimension: QuotaDimension,
  usage: UsageSnapshot,
  additional = 1,
) {
  const license = getLicense();
  const limit = limitOf(dimension, license);
  if (limit <= 0) return;
  const used = usedOf(dimension, usage);
  if (used + additional > limit)
    throw new AppError(403, LABELS[dimension], "QUOTA_EXCEEDED");
}

export async function assertCanAddSources(
  store: Store,
  workspaceId: string,
  count = 1,
) {
  const usage = await measureUsage(store, workspaceId);
  assertQuota("sources", usage, count);
}

export async function assertCanAddSeats(store: Store, workspaceId: string) {
  const usage = await measureUsage(store, workspaceId);
  assertQuota("seats", usage, 1);
}

export async function assertStorageRoom(store: Store, workspaceId: string, extraBytes = 0) {
  const usage = await measureUsage(store, workspaceId);
  assertQuota("storage", usage, extraBytes);
}

export async function assertAiUnitsAvailable(store: Store, units = 1) {
  // AI units are tenant-wide; workspace id only needed for measureUsage seats/sources.
  const refs = await store.list("global", "workspaceRef");
  const workspaceId = refs[0]?.id || "global";
  const usage = await measureUsage(store, workspaceId);
  assertQuota("aiUnits", usage, units);
}

export async function recordAiUnits(store: Store, units = 1) {
  if (units <= 0) return;
  const month = usageMonthKey();
  await transaction(store, "global", async (tx) => {
    const existing = await tx.get(USAGE_ID);
    const prev =
      existing?.kind === "usageMeter" && existing.data.month === month
        ? Number(existing.data.aiUnits) || 0
        : 0;
    const data = { month, aiUnits: prev + units };
    if (existing?.kind === "usageMeter") tx.update(existing, data);
    else
      tx.put(
        resource("global", "usageMeter", "Usage meter", data, USAGE_ID),
      );
  });
}

export function quotaAlerts(
  license: LicenseDocument,
  usage: UsageSnapshot,
): QuotaAlert[] {
  const alerts: QuotaAlert[] = [];
  const dims: QuotaDimension[] = ["seats", "sources", "storage", "aiUnits"];
  for (const dimension of dims) {
    const limit = limitOf(dimension, license);
    if (limit <= 0) continue;
    const used = usedOf(dimension, usage);
    if (used >= limit)
      alerts.push({
        dimension,
        level: "exceeded",
        used,
        limit,
        message: LABELS[dimension],
      });
    else if (used / limit >= WARN_RATIO)
      alerts.push({
        dimension,
        level: "warn",
        used,
        limit,
        message: `${dimension} usage is at ${Math.round((used / limit) * 100)}% of your plan limit.`,
      });
  }
  return alerts;
}

export async function tenantUsage(
  store: Store,
  storageBytes: () => number = () => directorySize(config.dataDir),
): Promise<UsageSnapshot> {
  const refs = await store.list("global", "workspaceRef");
  let seats = 0;
  let sources = 0;
  for (const ref of refs) {
    const u = await measureUsage(store, ref.id, () => 0);
    seats += u.seats;
    sources += u.sources;
  }
  const { month, aiUnits } = await readAiUnits(store);
  return {
    seats,
    sources,
    storageBytes: storageBytes(),
    aiUnits,
    month,
  };
}

export async function runHeartbeat(
  store: Store,
  storageBytes: () => number = () => directorySize(config.dataDir),
): Promise<{ ok: boolean; skipped?: boolean; error?: string }> {
  const base = config.controlPlaneUrl.replace(/\/$/, "");
  if (!base) return { ok: true, skipped: true };
  const usage = await tenantUsage(store, storageBytes);
  const body = {
    instanceId: config.licenseInstanceId || undefined,
    usage,
    license: getLicense(),
  };
  try {
    const res = await fetch(`${base}/api/v1/tenants/heartbeat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    assert(res.ok, `Control plane heartbeat failed (${res.status})`, 502);
    const json = (await res.json().catch(() => ({}))) as {
      license?: Partial<LicenseDocument>;
    };
    if (json.license) {
      applyLicense({
        ...json.license,
        updatedAt: new Date().toISOString(),
      });
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || "heartbeat failed" };
  }
}

export function startLicenseHeartbeat(store: Store) {
  const ms = config.licenseHeartbeatMs;
  if (!ms || !config.controlPlaneUrl) return () => {};
  const tick = () => {
    void runHeartbeat(store).then((r) => {
      if (!r.ok && process.env.NODE_ENV !== "test")
        console.warn("[license] heartbeat:", r.error);
    });
  };
  tick();
  const timer = setInterval(tick, ms);
  timer.unref?.();
  return () => clearInterval(timer);
}
