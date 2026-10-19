import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import lockfile from "proper-lockfile";
import { Store } from "./store.js";
import { WhatsApp } from "./whatsapp.js";
import { Service } from "./service.js";
import { createApp } from "./server.js";
process.umask(0o077);
const dir = resolve(process.env.BRIDGE_DATA_DIR || ".data");
mkdirSync(dir, { recursive: true, mode: 0o700 });
const port = Number(process.env.BRIDGE_PORT || 3210);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Invalid BRIDGE_PORT");
const release = await lockfile.lock(dir, {
  realpath: false,
  stale: 30000,
  update: 10000,
  retries: 0,
  onCompromised: () => process.exit(1),
});
const keyPath = join(dir, "owner-key");
if (!existsSync(keyPath))
  writeFileSync(keyPath, randomBytes(32).toString("base64url"), {
    mode: 0o600,
  });
const store = new Store(dir);
store.prune();
store.expire();
const maintenance = setInterval(() => {
  store.expire();
  store.prune();
}, 3600000);
maintenance.unref();
const wa = new WhatsApp(store);
wa.repairHistoricalSenders();
wa.restoreReactions();
wa.replayEncryptedEdits();
const service = new Service(store, wa);
const app = createApp(service, wa, readFileSync(keyPath, "utf8").trim(), port);
const server = app.listen(port, "127.0.0.1", () => {
  process.stderr.write(
    `WhatsApp MCP listening at http://127.0.0.1:${port}.\n`,
  );
  wa.start();
});
server.on("error", async () => {
  wa.stop();
  store.close();
  await release();
  process.exitCode = 1;
});
let closing = false;
async function stop() {
  if (closing) return;
  closing = true;
  clearInterval(maintenance);
  wa.stop();
  server.close();
  server.closeAllConnections();
  store.close();
  await release();
  process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
