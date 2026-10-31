import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createCipheriv, createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMediaKeys, type WASocket } from "@whiskeysockets/baileys";
import { Store, hash } from "../src/store.js";
import { WhatsApp } from "../src/whatsapp.js";
import { Service } from "../src/service.js";
import { createMcp } from "../src/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wa-media-refresh-"));
  const store = new Store(dir),
    wa = new WhatsApp(store);
  const data = Buffer.from("<!doctype html><title>Shared document</title>");
  const mediaKey = Buffer.alloc(32, 7);
  const keys = await getMediaKeys(mediaKey, "document");
  const cipher = createCipheriv("aes-256-cbc", keys.cipherKey, keys.iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const mac = createHmac("sha256", keys.macKey)
    .update(keys.iv)
    .update(encrypted)
    .digest()
    .subarray(0, 10);
  const calls: string[] = [];
  const server = createServer((req, res) => {
    calls.push(req.url || "");
    if (req.url === "/expired") {
      res.writeHead(403);
      res.end();
    } else {
      res.writeHead(200);
      res.end(Buffer.concat([encrypted, mac]));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const chat = store.saveChat("12345@g.us", "Media test");
  const result = wa.ingest(
    {
      key: { id: "file", remoteJid: chat.jid, fromMe: false },
      participant: "321@s.whatsapp.net",
      messageTimestamp: Date.parse("2026-01-02T00:00:00Z") / 1000,
      message: {
        documentMessage: {
          url: `${base}/expired`,
          mediaKey,
          fileName: "shared.html",
          mimetype: "text/html",
          fileLength: data.length,
          caption: "document context",
        },
      },
    },
    "history",
  );
  assert.ok(result);
  const attachmentId = store.message(result.id).attachmentId;
  assert.ok(attachmentId);
  return {
    store,
    wa,
    base,
    data,
    calls,
    attachmentId,
    messageId: result.id,
    async close() {
      wa.socket = undefined;
      wa.stop();
      store.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("a forbidden old media URL refreshes through the phone once, preserving the historical group sender", async () => {
  const f = await fixture();
  let refreshes = 0;
  f.wa.socket = {
    updateMediaMessage: async (message) => {
      refreshes++;
      assert.equal(message.key.participant, "321@s.whatsapp.net");
      assert.ok(message.message?.documentMessage);
      message.message.documentMessage.url = `${f.base}/fresh`;
      return message;
    },
  } satisfies Pick<WASocket, "updateMediaMessage"> as WASocket;
  try {
    await f.wa.download(f.attachmentId);
    assert.equal(refreshes, 1);
    assert.deepEqual(f.calls, ["/expired", "/fresh"]);
    assert.deepEqual(f.store.attachments.read(f.attachmentId).data, f.data);
    assert.equal(f.store.message(f.messageId).text, "document context");
  } finally {
    await f.close();
  }
});

test("phone NOT_FOUND produces media_unavailable while preserving the message and metadata", async () => {
  const f = await fixture();
  let refreshes = 0;
  f.wa.socket = {
    updateMediaMessage: async () => {
      refreshes++;
      throw Object.assign(new Error("Failed to re-upload media (2)"), {
        output: { statusCode: 404 },
        data: { code: "2" },
      });
    },
  } satisfies Pick<WASocket, "updateMediaMessage"> as WASocket;
  const principal = {
    id: "test",
    name: "test",
    tokenHash: hash("key"),
    enabled: true,
    canDraft: false,
    canSend: false,
  };
  f.store.put("client", principal.id, principal);
  const server = createMcp(new Service(f.store, f.wa), f.wa, principal);
  const client = new Client({ name: "media-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  try {
    const result = await client.callTool({
      name: "get_attachment",
      arguments: { attachment_id: f.attachmentId, representation: "file" },
    });
    assert.equal(result.isError, true);
    assert.ok(Array.isArray(result.content));
    const content = result.content.find((c) => c.type === "text");
    assert.ok(content?.type === "text");
    const error = JSON.parse(content.text);
    assert.equal(error.code, "media_unavailable");
    assert.ok(error.message.includes("message and metadata remain available"));
    assert.equal(refreshes, 1);
    assert.deepEqual(f.calls, ["/expired"]);
    assert.equal(f.store.message(f.messageId).text, "document context");
    assert.equal(f.store.attachments.get(f.attachmentId)?.name, "shared.html");
  } finally {
    await client.close();
    await server.close();
    await f.close();
  }
});
