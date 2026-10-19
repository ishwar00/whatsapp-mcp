import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { randomBytes } from "node:crypto";
import { backup } from "node:sqlite";
import lockfile from "proper-lockfile";
import { z } from "zod";
import QRCode from "qrcode";
import { setTimeout as delay } from "node:timers/promises";
import { Store } from "./store.js";
process.umask(0o077);
const dir = resolve(process.env.BRIDGE_DATA_DIR || ".data");
const command = process.argv[2];
if (command === "init") {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "owner-key");
  if (!existsSync(path))
    writeFileSync(path, randomBytes(32).toString("base64url"), { mode: 0o600 });
  process.stdout.write("Owner key initialized.\n");
} else if (command === "pair" || command === "status" || command === "key") {
  const base = `http://127.0.0.1:${process.env.BRIDGE_PORT || 3210}`;
  const token = readFileSync(join(dir, "owner-key"), "utf8").trim();
  const login = await fetch(`${base}/owner/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!login.ok)
    throw new Error(
      "Could not authenticate to the local server. Start npm start with the same BRIDGE_DATA_DIR.",
    );
  const { csrf } = z.object({ csrf: z.string() }).parse(await login.json());
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error("Local owner session was not created");
  const headers = {
    Cookie: cookie,
    Origin: base,
    "x-csrf-token": csrf,
    "Content-Type": "application/json",
  };
  if (command === "key") {
    const name = process.argv[3];
    if (!name || name.startsWith("--"))
      throw new Error('Usage: npm run owner -- key "My agent" [--send]');
    const response = await fetch(`${base}/owner/clients`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        name,
        can_draft: true,
        can_send: process.argv.includes("--send"),
      }),
    });
    if (!response.ok)
      throw new Error(`Key creation failed (${response.status})`);
    const key = z
      .object({ id: z.string(), token: z.string() })
      .parse(await response.json());
    process.stdout.write(
      `Client: ${key.id}\nBearer token: ${key.token}\nMCP URL: ${base}/mcp\nSave this token now; it will not be shown again.\n`,
    );
  } else {
    let previousQr: string | null = null;
    const deadline = Date.now() + 120_000;
    do {
      const response = await fetch(`${base}/owner/pairing`, { headers });
      if (!response.ok)
        throw new Error(`Pairing status failed (${response.status})`);
      const status = z
        .object({ state: z.string(), qr: z.string().nullable() })
        .parse(await response.json());
      if (command === "status" || status.state === "connected") {
        process.stdout.write(`WhatsApp: ${status.state}\n`);
        break;
      }
      if (status.state === "reauth_required")
        throw new Error(
          "This device was logged out. Stop the server and use a new BRIDGE_DATA_DIR to pair again.",
        );
      if (status.qr && status.qr !== previousQr) {
        process.stdout.write(
          await QRCode.toString(status.qr, { type: "terminal", small: true }),
        );
        process.stdout.write(
          "WhatsApp > Settings > Linked devices > Link a device\n",
        );
        previousQr = status.qr;
      }
      if (Date.now() >= deadline)
        throw new Error("Pairing timed out; run the pair command again.");
      await delay(2000);
    } while (true);
  }
} else if (command === "backup") {
  const target = process.argv[3];
  if (!target)
    throw new Error(
      "Usage: npm run owner -- backup /absolute/backup-directory",
    );
  const release = await lockfile.lock(dir, { realpath: false, retries: 0 });
  try {
    const store = new Store(dir);
    const dest = resolve(target);
    mkdirSync(dest, { recursive: true, mode: 0o700 });
    await backup(store.db, join(dest, "bridge.sqlite"));
    const { cpSync } = await import("node:fs");
    cpSync(join(dir, "media"), join(dest, "media"), { recursive: true });
    store.close();
    process.stdout.write(
      "Backup created. Keep it private. Stop the service before restoring.\n",
    );
  } finally {
    await release();
  }
} else if (command === "launchd") {
  const root = resolve(".");
  const escape = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const path = join(root, "com.local.whatsapp-agent-bridge.plist");
  writeFileSync(
    path,
    `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>com.local.whatsapp-agent-bridge</string><key>ProgramArguments</key><array><string>${escape(process.execPath)}</string><string>${escape(join(root, "dist/main.js"))}</string></array><key>WorkingDirectory</key><string>${escape(root)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>StandardErrorPath</key><string>${escape(join(dir, "daemon.log"))}</string><key>EnvironmentVariables</key><dict><key>BRIDGE_DATA_DIR</key><string>${escape(dir)}</string></dict></dict></plist>`,
  );
  process.stdout.write(
    `Generated ${path}\nLoad with: launchctl bootstrap gui/$(id -u) ${path}\n`,
  );
} else throw new Error("Commands: init, pair, status, key, backup, launchd");
