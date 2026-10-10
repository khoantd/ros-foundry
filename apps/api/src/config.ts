import "dotenv/config";
import { resolve } from "node:path";
export type AuthMode = "local" | "hosted";
export const config = {
  port: Number(process.env.PORT || 3001),
  host: process.env.HOST || "127.0.0.1",
  // There is no sign-in, so listening beyond this computer must be explicit
  // (e.g. inside a container whose port is published only on loopback).
  allowNetwork: process.env.ALLOW_NETWORK_ACCESS === "true",
  // local = single-machine owner (default). hosted = email/password + invites.
  authMode: (process.env.AUTH_MODE === "hosted" ? "hosted" : "local") as AuthMode,
  // License quotas (0 = unlimited). Refreshed by control-plane heartbeat when set.
  licenseSeats: Number(process.env.LICENSE_SEATS || 0) || 0,
  licenseMaxSources: Number(process.env.LICENSE_MAX_SOURCES || 0) || 0,
  licenseMaxStorageBytes: Number(process.env.LICENSE_MAX_STORAGE_BYTES || 0) || 0,
  licenseAiUnitsMonthly: Number(process.env.LICENSE_AI_UNITS_MONTHLY || 0) || 0,
  licensePlan: process.env.LICENSE_PLAN || "",
  licenseFeatures: (process.env.LICENSE_FEATURES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // Optional control plane for license heartbeat (Phase 3+).
  controlPlaneUrl: (process.env.CONTROL_PLANE_URL || "").replace(/\/$/, ""),
  licenseInstanceId: process.env.LICENSE_INSTANCE_ID || "",
  // Heartbeat interval; 0 disables. Default 1 hour when CONTROL_PLANE_URL is set.
  licenseHeartbeatMs: (() => {
    if (process.env.LICENSE_HEARTBEAT_MS !== undefined)
      return Number(process.env.LICENSE_HEARTBEAT_MS) || 0;
    return process.env.CONTROL_PLANE_URL ? 60 * 60 * 1000 : 0;
  })(),
  origin: process.env.APP_ORIGIN || "http://localhost:5173",
  helix: process.env.HELIX_URL || "http://127.0.0.1:6969",
  // Cloud GA requires these; leave blank for local HelixDB.
  helixApiKey: process.env.HELIX_API_KEY || "",
  helixDatabaseId: process.env.HELIX_DATABASE_ID || "",
  executor: process.env.EXECUTOR_URL || "http://127.0.0.1:3002",
  internalKey: process.env.INTERNAL_KEY || "",
  encryptionKey: process.env.ENCRYPTION_KEY || "",
  dataDir: resolve(process.env.DATA_DIR || ".data"),
  inlineWorker: process.env.INLINE_WORKER !== "false",
  ollama: process.env.OLLAMA_URL || "http://127.0.0.1:11434",
  // Requests per minute per IP; local acceptance runs raise it.
  rateLimit: Number(process.env.RATE_LIMIT_MAX) || 240,
};
export function requireSecrets() {
  if (config.encryptionKey.length < 32 || config.internalKey.length < 32)
    throw new Error(
      "Run ./scripts/setup.sh to generate ENCRYPTION_KEY and INTERNAL_KEY (32+ characters).",
    );
}
