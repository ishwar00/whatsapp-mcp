import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store, hash } from "../src/store.js";
import { Service } from "../src/service.js";
import { WhatsApp } from "../src/whatsapp.js";
import { Watches } from "../src/watches.js";
import { createApp } from "../src/server.js";
import { createStdioProxy } from "../src/stdio.js";

test("stdio privately attaches its own Claude session identity, overriding caller metadata and never publishing secrets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wa-caller-")),
    store = new Store(dir),
    wa = new WhatsApp(store);
  const p = {
    id: "agent",
    name: "Agent",
    enabled: true,
    canDraft: true,
    canSend: false,
    tokenHash: hash("key"),
  };
  store.put("client", p.id, p);
  const chat = store.saveChat("111@s.whatsapp.net", "Person");
  const watches = new Watches(store, wa),
    service = new Service(store, wa, watches);
  const http = createApp(service, wa, "owner", 33227).listen(
    33227,
    "127.0.0.1",
  );
  await new Promise<void>((r) => http.once("listening", r));
  const session = "01234567-1234-4123-8123-123456789abc";
  const proxy = createStdioProxy("http://127.0.0.1:33227/mcp", "key", {
    CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/fixture-socket",
    CLAUDE_CODE_MESSAGING_TOKEN: "private-fixture-token",
    CLAUDE_CODE_SESSION_ID: session,
  });
  const client = new Client({ name: "caller", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([proxy.connect(a), client.connect(b)]);
    const tools = await client.listTools();
    assert.ok(!JSON.stringify(tools).includes("private-fixture-token"));
    assert.ok(!JSON.stringify(tools).includes("_caller"));
    const result = await client.callTool({
      name: "watch",
      arguments: { chat_id: chat.id },
      _meta: {
        _caller: { socket: "/wrong", token: "wrong", session_id: session },
      },
    });
    assert.equal(result.isError, undefined);
    assert.ok(!JSON.stringify(result).includes("private-fixture-token"));
    const target = JSON.parse(
      String(store.db.prepare("SELECT target FROM watches").get()?.target),
    );
    assert.equal(target.token, "private-fixture-token");
    assert.equal(target.socket, "/tmp/fixture-socket");
    assert.equal(target.session_id, session);
    const status = await client.callTool({ name: "get_status", arguments: {} });
    assert.ok(!JSON.stringify(status).includes("private-fixture-token"));
  } finally {
    await client.close();
    await proxy.close();
    http.closeAllConnections();
    await new Promise<void>((r) => http.close(() => r()));
    await watches.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
