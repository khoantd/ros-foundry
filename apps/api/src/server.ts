import { config, requireSecrets } from "./config.js";
import { store } from "./store.js";
import { createApp } from "./app.js";
import { startWorker } from "./jobs.js";
import { startLicenseHeartbeat } from "./license.js";
requireSecrets();
if (
  !["127.0.0.1", "localhost", "::1"].includes(config.host) &&
  !config.allowNetwork
)
  throw new Error(
    config.authMode === "hosted"
      ? `HOST is ${config.host}. Set ALLOW_NETWORK_ACCESS=true when a reverse proxy keeps Helix and the executor private.`
      : `ROS Foundry has no sign-in, so it only listens on this computer. Use HOST=127.0.0.1, or set ALLOW_NETWORK_ACCESS=true when something in front of it keeps it private (HOST is ${config.host}).`,
  );
await store.init();
const app = await createApp(store);
await app.listen({ port: config.port, host: config.host });
const stop = config.inlineWorker ? startWorker(store) : () => {};
const stopHeartbeat = startLicenseHeartbeat(store);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    stopHeartbeat();
    await stop();
    await app.close();
    process.exit(0);
  });
