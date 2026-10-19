import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store.js";
import { WhatsApp } from "../src/whatsapp.js";
import { Service } from "../src/service.js";
import { createApp } from "../src/server.js";
const run = promisify(execFile);
test("fresh terminal setup pairs, reports status and creates read/draft and send-enabled keys over authenticated owner API", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wa-owner-cli-"));
  const store = new Store(dir),
    wa = new WhatsApp(store);
  const service = new Service(store, {
    connected: false,
    ownerIds: [],
    send: async () => {
      throw Error("no network sends");
    },
  });
  const port = 33226,
    token = "owner-test-token";
  writeFileSync(join(dir, "owner-key"), token, { mode: 0o600 });
  const http = createApp(service, wa, token, port).listen(port, "127.0.0.1");
  await new Promise<void>((resolve) => http.once("listening", resolve));
  const env = {
    ...process.env,
    BRIDGE_DATA_DIR: dir,
    BRIDGE_PORT: String(port),
  };
  const cli = (...args: string[]) =>
    run(process.execPath, ["--import", "tsx", "src/owner.ts", ...args], {
      env,
      timeout: 10000,
    });
  try {
    assert.match((await cli("status")).stdout, /WhatsApp: offline/);
    const read = await cli("key", "Reader");
    const readToken = read.stdout.match(/Bearer token: (\S+)/)?.[1];
    assert.ok(readToken);
    assert.equal(store.principal(readToken)?.canSend, false);
    assert.equal(store.principal(readToken)?.canDraft, true);
    const sender = await cli("key", "Sender", "--send");
    const sendToken = sender.stdout.match(/Bearer token: (\S+)/)?.[1];
    assert.ok(sendToken);
    assert.equal(store.principal(sendToken)?.canSend, true);
    wa.state = "connecting";
    wa.qr = "synthetic-test-qr";
    const pair = spawn(
      process.execPath,
      ["--import", "tsx", "src/owner.ts", "pair"],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    pair.stdout.on("data", (chunk) => {
      output += String(chunk);
      if (output.includes("Link a device")) wa.state = "connected";
    });
    const timer = setTimeout(() => pair.kill(), 10000);
    try {
      assert.equal(
        await new Promise<number | null>((resolve) =>
          pair.once("exit", resolve),
        ),
        0,
      );
    } finally {
      clearTimeout(timer);
    }
    assert.match(output, /Link a device/);
    assert.match(output, /WhatsApp: connected/);
  } finally {
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
