import { store } from "../apps/api/src/store.js";
import { requireSecrets } from "../apps/api/src/config.js";
requireSecrets();
await store.init();
console.log("ROS Foundry schema version 1 is ready.");
