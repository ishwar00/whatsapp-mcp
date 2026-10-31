import test from "node:test";
import { request, createServer } from "node:http";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, hash, opaque } from "../src/store.js";
import { Service, type Sender } from "../src/service.js";
import {
  draftInputSchema,
  type Message,
  type Principal,
} from "../src/domain.js";
import { WhatsApp } from "../src/whatsapp.js";
import { createApp } from "../src/server.js";
import { createMcp } from "../src/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createStdioProxy } from "../src/stdio.js";
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bridge-test-"));
  const store = new Store(dir);
  const a = store.saveChat("111@s.whatsapp.net", "Client A");
  const b = store.saveChat("222@s.whatsapp.net", "Private");
  const p: Principal = {
    id: "agent",
    name: "Agent",
    tokenHash: hash("agent-key"),
    canDraft: true,
    canSend: false,
    enabled: true,
  };
  store.put("client", p.id, p);
  let sends = 0;
  const sender: Sender = {
    connected: true,
    ownerIds: ["me"],
    send: async () => {
      sends++;
      return "provider-1";
    },
  };
  const service = new Service(store, sender);
  const makeMessage = (id: string, overrides: Partial<Message> = {}) => ({
    id,
    chatId: a.id,
    providerId: id,
    senderId: "client",
    senderName: "Client A",
    direction: "incoming" as const,
    sentAt: "2026-10-06T00:00:00Z",
    observedAt: "2026-10-06T00:00:01Z",
    editedAt: null,
    updatedAt: null,
    text: "DNS instructions",
    contentType: "text",
    mentions: [],
    replyId: null,
    deleted: false,
    source: "live" as const,
    attachmentId: null,
    expiresAt: null,
    ...overrides,
  });
  return {
    dir,
    store,
    a,
    b,
    p,
    sender,
    service,
    makeMessage,
    sends: () => sends,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("combined filters, OR predicates, pagination and scoped reads", () => {
  const f = fixture();
  try {
    f.store.saveMessage(f.makeMessage("m1", { mentions: ["me"] }));
    f.store.saveMessage(
      f.makeMessage("m2", { replyId: "anchor", text: "done" }),
    );
    f.store.saveMessage(f.makeMessage("secret", { chatId: f.b.id }));
    const first = f.service.read(f.p, {
      match_any: [{ mentions_me: true }, { reply_to_ids: ["anchor"] }],
      order: "oldest_first",
      limit: 1,
    });
    assert.equal(first.messages[0]?.id, "m1");
    assert.ok(first.next_page);
    const second = f.service.read(f.p, {
      match_any: [{ mentions_me: true }, { reply_to_ids: ["anchor"] }],
      order: "oldest_first",
      limit: 1,
      page: first.next_page,
    });
    assert.equal(second.messages[0]?.id, "m2");
    assert.equal(second.next_page, null);
    assert.equal(
      f.service.read(f.p, { chat_ids: [f.b.id] }).messages.length,
      1,
    );
    assert.throws(() => f.service.read(f.p, { chat_ids: ["missing"] }));
    assert.throws(() =>
      f.service.read(f.p, { query: "different", page: first.next_page }),
    );
    assert.throws(() => f.service.read(f.p, { invented_filter: true }));
    assert.throws(() =>
      f.service.read(f.p, {
        sent_at: { from: "2026-10-07T00:00:00Z", to: "2026-10-06T00:00:00Z" },
      }),
    );
  } finally {
    f.close();
  }
});
test("draft request idempotency, explicit approval, and duplicate approval", async () => {
  const f = fixture();
  try {
    const input = {
      chat_id: f.a.id,
      text: "Update DNS",
      request_id: "request-1",
    };
    const draft = f.service.createDraft(f.p, input);
    assert.equal(f.sends(), 0);
    assert.equal(f.service.createDraft(f.p, input).id, draft.id);
    assert.throws(() =>
      f.service.createDraft(f.p, { ...input, text: "different" }),
    );
    assert.equal(
      (await f.service.approve(draft.id, draft.digest)).status,
      "accepted",
    );
    await f.service.approve(draft.id, draft.digest);
    assert.equal(f.sends(), 1);
    assert.throws(() => f.service.ownDraft({ ...f.p, id: "other" }, draft.id));
  } finally {
    f.close();
  }
});
test("in-flight repeated approval and cancellation never create another send", async () => {
  const f = fixture();
  try {
    let complete: (id: string) => void = () => {};
    let calls = 0;
    f.sender.send = () => {
      calls++;
      return new Promise((resolve) => {
        complete = resolve;
      });
    };
    const d = f.service.createDraft(f.p, {
      chat_id: f.a.id,
      text: "Hello",
      request_id: "x",
    });
    const pending = f.service.approve(d.id, d.digest);
    assert.equal(
      (await f.service.approve(d.id, d.digest)).status,
      "attempting",
    );
    assert.equal(f.service.cancel(f.p, d.id).status, "attempting");
    complete("sent");
    await pending;
    assert.equal(calls, 1);
  } finally {
    f.close();
  }
});
test("uncertain send is persistent and cannot be retried; interrupted attempt recovers as unknown", async () => {
  const f = fixture();
  try {
    f.sender.send = async () => {
      throw new Error("Connection lost");
    };
    const d = f.service.createDraft(f.p, {
      chat_id: f.a.id,
      text: "Hello",
      request_id: "x",
    });
    assert.equal((await f.service.approve(d.id, d.digest)).status, "unknown");
    assert.equal((await f.service.approve(d.id, d.digest)).status, "unknown");
    f.store.saveDraft({ ...d, status: "attempting" });
    f.store.close();
    const reopened = new Store(f.dir);
    assert.equal(reopened.draft(d.id).status, "unknown");
    reopened.close();
  } finally {
    f.close();
  }
});
test("sending rechecks client revocation, references and attachment digest", async () => {
  const f = fixture();
  try {
    const d = f.service.createDraft(f.p, {
      chat_id: f.a.id,
      text: "Hello",
      request_id: "x",
    });
    f.store.put("client", f.p.id, { ...f.p, enabled: false });
    await assert.rejects(f.service.approve(d.id, d.digest));
    assert.equal(f.sends(), 0);
  } finally {
    f.close();
  }
});
test("attachment forwarding stays in scope; deleting a message destroys bytes and prevents resurrection", () => {
  const f = fixture();
  try {
    const m = f.makeMessage("m", { attachmentId: "attachment_x" });
    f.store.saveMessage(m);
    f.store.attachments.save(
      {
        id: "attachment_x",
        chatId: f.a.id,
        messageId: "m",
        name: "test.txt",
        mime: "text/plain",
        digest: null,
        size: 0,
        availability: "pending",
      },
      Buffer.from("secret"),
    );
    f.store.put("raw", "m", { conversation: "secret" });
    f.store.put("client", f.p.id, { ...f.p, enabled: false });
    assert.throws(() => f.service.attachment(f.p, "attachment_x"));
    f.store.put("client", f.p.id, f.p);
    f.store.eraseMessage("m");
    assert.throws(() => f.store.attachments.read("attachment_x"));
    assert.equal(f.store.get("raw", "m"), undefined);
    f.store.saveMessage(m);
    assert.equal(f.store.message("m").deleted, true);
    assert.equal(f.store.message("m").text, "");
  } finally {
    f.close();
  }
});
test("SQLite Signal auth preserves key buffers and deletion across restart", async () => {
  const f = fixture();
  try {
    const wa = new WhatsApp(f.store);
    const auth = wa.auth();
    await auth.keys.set({
      "pre-key": {
        one: { public: Buffer.from([1, 2]), private: Buffer.from([3, 4]) },
      },
      session: { s: Buffer.from([9, 8]) },
    });
    const keys = await wa.auth().keys.get("pre-key", ["one"]);
    assert.deepEqual(keys.one?.public, Buffer.from([1, 2]));
    await auth.keys.set({ "pre-key": { one: null } });
    assert.deepEqual(await wa.auth().keys.get("pre-key", ["one"]), {});
    assert.deepEqual(
      (await wa.auth().keys.get("session", ["s"])).s,
      Buffer.from([9, 8]),
    );
  } finally {
    f.close();
  }
});
test("draft schema rejects arbitrary paths, approval flags, and empty messages", () => {
  assert.equal(
    draftInputSchema.safeParse({
      chat_id: "c",
      text: "x",
      request_id: "a",
      approved: true,
    }).success,
    false,
  );
  assert.equal(
    draftInputSchema.safeParse({
      chat_id: "c",
      text: "x",
      request_id: "a",
      file_path: "/etc/passwd",
    }).success,
    false,
  );
  assert.equal(
    draftInputSchema.safeParse({ chat_id: "c", request_id: "a" }).success,
    false,
  );
});
test("real Streamable HTTP client, owner bearer authentication and origin/host checks", async () => {
  const f = fixture();
  const wa = new WhatsApp(f.store);
  const port = 33219;
  const app = createApp(f.service, wa, "owner-key", port);
  const server = app.listen(port, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${port}`;
  const client = new Client({ name: "test", version: "1.0" });
  try {
    assert.equal(
      (
        await fetch(`${base}/mcp`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
      401,
    );
    assert.equal(
      (await fetch(`${base}/`, { headers: { Origin: "http://evil.example" } }))
        .status,
      403,
    );
    assert.equal(
      await new Promise<number | undefined>((resolve, reject) => {
        const r = request(
          `${base}/`,
          { headers: { Host: "evil.example" } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        );
        r.on("error", reject);
        r.end();
      }),
      403,
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { Authorization: "Bearer agent-key" } },
      }),
    );
    const list = await client.listTools();
    assert.ok(list.tools.find((t) => t.name === "create_draft"));
    assert.equal(
      list.tools.some(
        (t) => t.name.includes("approve") || t.name === "send_message",
      ),
      false,
    );
    const draftResult = await client.callTool({
      name: "create_draft",
      arguments: { chat_id: f.a.id, text: "Hello", request_id: "http-1" },
    });
    assert.equal(draftResult.isError, undefined);
    assert.equal(f.sends(), 0);
    assert.equal(
      (
        await fetch(`${base}/owner/pairing`, {
          headers: { Authorization: "Bearer agent-key" },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${base}/owner/pairing`, {
          headers: { Authorization: "Bearer owner-key" },
        })
      ).status,
      200,
    );
    assert.equal(f.sends(), 0);
    const pending = f.service.createDraft(f.p, {
      chat_id: f.a.id,
      text: "Pending before permissions change",
      request_id: "pending-edit",
    });
    const originalHash = f.store.clients()[0]?.tokenHash;
    const headers = {
      "Content-Type": "application/json",
      Authorization: "Bearer owner-key",
      Origin: base,
    };
    const editBody = {
      name: "Renamed agent",
      can_draft: false,
    };
    assert.equal(
      (
        await fetch(`${base}/owner/clients/${f.p.id}/access`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer agent-key",
            Origin: base,
          },
          body: JSON.stringify(editBody),
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${base}/owner/clients/${f.p.id}/access`, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...editBody, unsupported: true }),
        })
      ).status,
      400,
    );

    assert.equal(
      (
        await fetch(`${base}/owner/clients/${f.p.id}/access`, {
          method: "POST",
          headers,
          body: JSON.stringify(editBody),
        })
      ).status,
      200,
    );
    assert.equal(f.store.principal("agent-key")?.name, "Renamed agent");
    assert.equal(f.store.clients()[0]?.tokenHash, originalHash);
    assert.equal(
      (
        await client.callTool({
          name: "read_messages",
          arguments: { chat_ids: [f.a.id] },
        })
      ).isError,
      undefined,
    );
    assert.equal(
      (
        await client.callTool({
          name: "read_messages",
          arguments: { chat_ids: [f.b.id] },
        })
      ).isError,
      undefined,
    );
    assert.equal(
      (
        await client.callTool({
          name: "create_draft",
          arguments: {
            chat_id: f.b.id,
            text: "Blocked",
            request_id: "blocked",
          },
        })
      ).isError,
      true,
    );
    await assert.rejects(f.service.approve(pending.id, pending.digest));
    assert.equal(f.sends(), 0);
    assert.equal(
      (
        await fetch(`${base}/owner/clients/${f.p.id}/access`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            name: "Agent",
            can_draft: true,
          }),
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await client.callTool({
          name: "create_draft",
          arguments: {
            chat_id: f.a.id,
            text: "Enabled again",
            request_id: "after-edit",
          },
        })
      ).isError,
      undefined,
    );
    f.store.put("client", f.p.id, { ...f.p, enabled: false });
    assert.equal(
      (
        await fetch(`${base}/owner/clients/${f.p.id}/access`, {
          method: "POST",
          headers,
          body: JSON.stringify(editBody),
        })
      ).status,
      409,
    );
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    f.close();
  }
});
test("expired messages erase content before retrieval; view-once messages are not archived", () => {
  const f = fixture();
  try {
    f.store.saveMessage(
      f.makeMessage("expired", { expiresAt: "2026-01-01T00:00:00Z" }),
    );
    assert.equal(f.service.read(f.p, {}).messages.length, 0);
    assert.equal(f.store.message("expired").text, "");
    const wa = new WhatsApp(f.store);
    wa.ingest(
      {
        key: { remoteJid: f.a.jid, id: "view" },
        message: {
          viewOnceMessage: {
            message: { imageMessage: { caption: "private" } },
          },
        },
      },
      "live",
    );
    assert.throws(() => f.store.message("view"));
  } finally {
    f.close();
  }
});
test("normalization retains text, sender name, mention, quote and partial attachment metadata", () => {
  const f = fixture();
  try {
    const wa = new WhatsApp(f.store);
    wa.ingest(
      {
        key: { remoteJid: f.a.jid, id: "raw" },
        pushName: "Alice",
        messageTimestamp: 1770000000,
        message: {
          imageMessage: {
            caption: "Screenshot",
            mimetype: "image/png",
            contextInfo: {
              mentionedJid: ["555@s.whatsapp.net"],
              stanzaId: "quote",
            },
          },
        },
      },
      "live",
    );
    const message = f.store.messages([f.a.id])[0];
    assert.equal(message?.senderName, "Alice");
    assert.equal(message?.text, "Screenshot");
    assert.equal(message?.contentType, "image");
    assert.equal(message?.mentions.length, 1);
    assert.ok(message?.attachmentId);
    assert.ok(message?.replyId);
  } finally {
    f.close();
  }
});
test("verified LID/phone aliases match explicit mentions, without matching names", () => {
  const f = fixture();
  try {
    const pn = "555@s.whatsapp.net",
      lid = "777@lid";
    f.store.addAlias(lid, pn);
    f.sender.ownerIds = [opaque("participant", pn)];
    f.store.saveMessage(
      f.makeMessage("alias", { mentions: [opaque("participant", lid)] }),
    );
    f.store.saveMessage(f.makeMessage("name", { text: "Hi owner" }));
    assert.equal(f.service.read(f.p, { mentions_me: true }).messages.length, 1);
  } finally {
    f.close();
  }
});
test("contact history and updates resolve direct chat names and verified aliases", () => {
  const f = fixture();
  try {
    const wa = new WhatsApp(f.store);
    wa.saveContact({
      id: "777@lid",
      lid: "777@lid",
      phoneNumber: "555@s.whatsapp.net",
      name: "Saved client",
      notify: "Profile name",
    });
    assert.equal(f.store.chat(opaque("chat", "777@lid")).name, "Saved client");
    assert.equal(
      f.store.chat(opaque("chat", "555@s.whatsapp.net")).name,
      "Saved client",
    );
    wa.saveContact({ id: "777@lid", notify: "Changed profile name" });
    assert.equal(f.store.chat(opaque("chat", "777@lid")).name, "Saved client");
    assert.ok(
      f.store
        .equivalents(opaque("participant", "777@lid"))
        .has(opaque("participant", "555@s.whatsapp.net")),
    );
  } finally {
    f.close();
  }
});
test("group subject updates and later nameless messages preserve names", () => {
  const f = fixture();
  try {
    const group = f.store.saveChat("120000@g.us");
    assert.equal(group.name, "Group name unavailable");
    f.store.saveChat(group.jid, "Client operations");
    assert.equal(f.store.saveChat(group.jid).name, "Client operations");
    assert.ok(f.store.authorize(f.p, group.id).id === group.id);
  } finally {
    f.close();
  }
});
test("incoming direct messages are collected and accessible automatically", () => {
  const f = fixture();
  try {
    const wa = new WhatsApp(f.store);
    wa.ingest(
      {
        key: { remoteJid: "888@lid", id: "new" },
        pushName: "New client",
        message: { conversation: "Automatically retained" },
      },
      "live",
    );
    const chat = f.store.chat(opaque("chat", "888@lid"));
    assert.equal(chat.name, "New client");
    assert.equal(f.store.messages([chat.id]).length, 1);
    assert.equal(
      f.service.read(f.p, { chat_ids: [chat.id] }).messages.length,
      1,
    );
  } finally {
    f.close();
  }
});

test("send_draft needs a send-enabled key and exact recipient, text and attachment names", async () => {
  const f = fixture();
  try {
    const code = async (promise: Promise<unknown>) => {
      try {
        await promise;
        return "ok";
      } catch (e) {
        return (e as { code?: string }).code ?? "error";
      }
    };
    const draft = f.service.createDraft(f.p, {
      chat_id: f.a.id,
      text: "Order #9655 update",
      request_id: "send-1",
    });
    const send = (
      over: Partial<Record<"digest" | "chat" | "text", string>> = {},
    ) =>
      f.service.sendDraft(
        f.p,
        draft.id,
        over.digest ?? draft.digest,
        over.chat ?? "Client A",
        over.text ?? "Order #9655 update",
      );
    assert.equal(await code(send()), "not_found_or_not_permitted");
    f.store.put("client", f.p.id, { ...f.p, canSend: true });
    assert.equal(await code(send({ chat: "Private" })), "request_conflict");
    assert.equal(
      await code(send({ text: "Order #9655 update!" })),
      "request_conflict",
    );
    assert.equal(await code(send({ digest: "tampered" })), "request_conflict");
    assert.equal(f.sends(), 0);
    const sent = await send();
    assert.equal(sent.status, "accepted");
    assert.equal(f.sends(), 1);
    assert.equal((await send()).status, "accepted");
    assert.equal(f.sends(), 1);
    const withFile = f.service.createDraft(f.p, {
      chat_id: f.a.id,
      text: "see file",
      attachment: {
        name: "a.txt",
        mime_type: "text/plain",
        data: Buffer.from("hi").toString("base64"),
      },
      request_id: "send-2",
    });
    assert.equal(
      await code(
        f.service.sendDraft(
          f.p,
          withFile.id,
          withFile.digest,
          "Client A",
          "see file",
        ),
      ),
      "request_conflict",
    );
    assert.equal(f.sends(), 1);
    const sendFile = (names: string[]) =>
      f.service.sendDraft(
        f.p,
        withFile.id,
        withFile.digest,
        "Client A",
        "see file",
        names,
      );
    assert.equal(await code(sendFile(["wrong.txt"])), "request_conflict");
    assert.equal(f.sends(), 1);
    assert.equal((await sendFile(["a.txt"])).status, "accepted");
    assert.equal(f.sends(), 2);
    assert.equal((await sendFile(["a.txt"])).status, "accepted");
    assert.equal(f.sends(), 2);
  } finally {
    f.close();
  }
});

test("edits preserve send time, survive replay, and appear in changed_since reads", () => {
  const f = fixture();
  try {
    const wa = new WhatsApp(f.store);
    const key = {
      remoteJid: "111@s.whatsapp.net",
      id: "edit-test",
      fromMe: true,
    };
    wa.ingest(
      { key, messageTimestamp: 1000, message: { conversation: "before" } },
      "live",
    );
    const id = opaque("message", `${key.remoteJid}:${key.id}`);
    const original = f.store.message(id);
    wa.ingest(
      {
        key,
        messageTimestamp: 2000,
        message: { editedMessage: { message: { conversation: "after" } } },
      },
      "live",
    );
    const edited = f.store.message(id);
    assert.equal(edited.text, "after");
    assert.equal(edited.sentAt, original.sentAt);
    assert.equal(edited.observedAt, original.observedAt);
    assert.equal(edited.editedAt, new Date(2000000).toISOString());
    assert.equal(
      f.service.read(f.p, { changed_since: edited.updatedAt }).messages[0]
        ?.text,
      "after",
    );
    wa.ingest(
      { key, messageTimestamp: 1000, message: { conversation: "before" } },
      "history",
    );
    wa.ingest(
      {
        key,
        messageTimestamp: 1500,
        message: { editedMessage: { message: { conversation: "stale" } } },
      },
      "live",
    );
    assert.equal(f.store.message(id).text, "after");
    f.store.eraseMessage(id);
    wa.ingest(
      {
        key,
        messageTimestamp: 3000,
        message: { editedMessage: { message: { conversation: "resurrect" } } },
      },
      "live",
    );
    assert.equal(f.store.message(id).text, "");
    assert.equal(f.store.get("raw", id), undefined);
  } finally {
    f.close();
  }
});

test("protocol edits without an original retain content with unknown send time", () => {
  const f = fixture();
  try {
    const wa = new WhatsApp(f.store);
    wa.ingest(
      {
        key: { remoteJid: "111@s.whatsapp.net", id: "envelope" },
        messageTimestamp: 2000,
        message: {
          protocolMessage: {
            key: { id: "missing" },
            timestampMs: 2000000,
            editedMessage: { conversation: "updated" },
          },
        },
      },
      "live",
    );
    const m = f.store.message(opaque("message", "111@s.whatsapp.net:missing"));
    assert.equal(m.text, "updated");
    assert.equal(m.sentAt, null);
    assert.equal(m.editedAt, new Date(2000000).toISOString());
  } finally {
    f.close();
  }
});

test("encrypted edits authenticate, update the original, and preserve the secret for later edits", async () => {
  const { hkdfSync, createCipheriv } = await import("node:crypto");
  const { proto } = await import("@whiskeysockets/baileys");
  const f = fixture();
  try {
    const wa = new WhatsApp(f.store);
    const jid = "111@s.whatsapp.net";
    const key = { remoteJid: jid, id: "original", fromMe: false };
    const secret = Buffer.alloc(32, 7);
    wa.ingest(
      {
        key,
        messageTimestamp: 1000,
        message: {
          conversation: "old",
          messageContextInfo: { messageSecret: secret },
        },
      },
      "live",
    );
    const id = opaque("message", `${jid}:original`);
    const encrypted = (text: string, time: number) => {
      const payload = proto.Message.encode({
        protocolMessage: {
          type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
          key: { id: "original" },
          editedMessage: { conversation: text },
          timestampMs: time * 1000,
        },
      }).finish();
      const derived = Buffer.from(
        hkdfSync(
          "sha256",
          secret,
          Buffer.alloc(0),
          Buffer.from(`original${jid}${jid}Message Edit`),
          32,
        ),
      );
      const iv = Buffer.alloc(12, time % 255);
      const cipher = createCipheriv("aes-256-gcm", derived, iv);
      const encPayload = Buffer.concat([
        cipher.update(payload),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      return {
        key: { ...key, id: `edit-${time}` },
        messageTimestamp: time,
        message: {
          secretEncryptedMessage: {
            secretEncType:
              proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT,
            targetMessageKey: { remoteJid: jid, id: "original", fromMe: true },
            encIv: iv,
            encPayload,
          },
        },
      };
    };
    const first = encrypted("corrected", 2000);
    wa.ingest(first, "live");
    assert.equal(f.store.message(id).text, "corrected");
    assert.equal(f.store.message(id).sentAt, new Date(1000000).toISOString());
    assert.equal(f.store.message(id).editedAt, new Date(2000000).toISOString());
    assert.equal(f.store.messages([f.a.id]).length, 1);
    wa.ingest(encrypted("second edit", 3000), "live");
    assert.equal(f.store.message(id).text, "second edit");
    wa.ingest(first, "live");
    assert.equal(f.store.message(id).text, "second edit");
    const corrupt = encrypted("tampered", 4000);
    corrupt.message.secretEncryptedMessage.encPayload[0] ^= 1;
    wa.ingest(corrupt, "live");
    assert.equal(f.store.message(id).text, "second edit");
    f.store.eraseMessage(id);
    wa.ingest(encrypted("resurrection", 5000), "live");
    assert.equal(f.store.message(id).text, "");
  } finally {
    f.close();
  }
});

test("stdio reads do not wait behind an in-flight send", async () => {
  const f = fixture();
  f.store.put("client", f.p.id, { ...f.p, canSend: true });
  let release = () => {};
  let started = () => {};
  const sending = new Promise<void>((resolve) => {
    started = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.sender.send = async () => {
    started();
    await held;
    return "held-send";
  };
  const port = 33223;
  const http = createApp(
    f.service,
    new WhatsApp(f.store),
    "owner-key",
    port,
  ).listen(port, "127.0.0.1");
  await new Promise<void>((resolve) => http.once("listening", resolve));
  const proxy = createStdioProxy(`http://127.0.0.1:${port}/mcp`, "agent-key");
  const client = new Client({ name: "concurrent-read", version: "1" });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  try {
    await proxy.connect(remote);
    await client.connect(local);
    const draft = f.service.createDraft(f.p, {
      chat_id: f.a.id,
      text: "held",
      request_id: "held",
    });
    const send = client.callTool({
      name: "send_draft",
      arguments: {
        draft_id: draft.id,
        digest: draft.digest,
        chat_name: "Client A",
        text: "held",
      },
    });
    await sending;
    const read = await client.callTool(
      { name: "get_status", arguments: {} },
      undefined,
      { timeout: 2_000 },
    );
    assert.equal(read.isError, undefined);
    release();
    assert.equal((await send).isError, undefined);
  } finally {
    release();
    await client.close();
    await proxy.close();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    f.close();
  }
});

test("HTTP and stdio clients send without elicitation and do not resend accepted drafts", async () => {
  const f = fixture();
  f.store.put("client", f.p.id, { ...f.p, canSend: true });
  const port = 33221;
  const http = createApp(
    f.service,
    new WhatsApp(f.store),
    "owner-key",
    port,
  ).listen(port, "127.0.0.1");
  await new Promise<void>((resolve) => http.once("listening", resolve));
  const clients = [
    new Client({ name: "http-no-elicitation", version: "1" }),
    new Client({ name: "stdio-no-elicitation", version: "1" }),
  ];
  try {
    await clients[0]!.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`),
        { requestInit: { headers: { Authorization: "Bearer agent-key" } } },
      ),
    );
    await clients[1]!.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", join(process.cwd(), "src/stdio.ts")],
        env: {
          WHATSAPP_BRIDGE_TOKEN: "agent-key",
          WHATSAPP_BRIDGE_URL: `http://127.0.0.1:${port}/mcp`,
        },
      }),
    );
    for (const [i, client] of clients.entries()) {
      const draft = f.service.createDraft(f.p, {
        chat_id: f.a.id,
        text: "Client approved test",
        request_id: `client-approved-${i}`,
      });
      const args = {
        draft_id: draft.id,
        digest: draft.digest,
        chat_name: "Client A",
        text: draft.input.text,
      };
      assert.equal(
        (
          await client.callTool({
            name: "send_draft",
            arguments: { ...args, text: "changed" },
          })
        ).isError,
        true,
      );
      assert.equal(f.sends(), i);
      assert.equal(
        (await client.callTool({ name: "send_draft", arguments: args }))
          .isError,
        undefined,
      );
      assert.equal(f.sends(), i + 1);
      await client.callTool({ name: "send_draft", arguments: args });
      assert.equal(f.sends(), i + 1);
    }
  } finally {
    for (const client of clients) await client.close();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    f.close();
  }
});

test("adapter reconnects expired reads once and never automatically replays a send", async () => {
  const f = fixture();
  f.store.put("client", f.p.id, { ...f.p, canSend: true });
  const port = 33222;
  const app = createApp(f.service, new WhatsApp(f.store), "owner-key", port);
  let sessionId = "";
  let failInitialization = true;
  let rejectSessions = false;
  const calls: string[] = [];
  const http = createServer((req, res) => {
    const session = req.headers["mcp-session-id"];
    if (typeof session === "string") sessionId = session;
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (body) {
        const parsed = JSON.parse(body);
        calls.push(
          parsed.method === "tools/call" ? parsed.params.name : parsed.method,
        );
      }
    });
    if (req.method === "POST" && !session && failInitialization) {
      failInitialization = false;
      res.writeHead(503).end();
      req.resume();
    } else if (req.method === "POST" && session && rejectSessions) {
      res.writeHead(404).end();
      req.resume();
    } else app(req, res);
  }).listen(port, "127.0.0.1");
  await new Promise<void>((resolve) => http.once("listening", resolve));
  const proxy = createStdioProxy(`http://127.0.0.1:${port}/mcp`, "agent-key");
  const client = new Client(
    { name: "recovery-test", version: "1" },
    { capabilities: { elicitation: { form: {} } } },
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  let prompts = 0;
  client.setRequestHandler(ElicitRequestSchema, async () => {
    prompts++;
    return { action: "accept", content: {} };
  });
  const status = () => client.callTool({ name: "get_status", arguments: {} });
  const expireSession = async () => {
    assert.ok(sessionId);
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "DELETE",
      headers: {
        Authorization: "Bearer agent-key",
        "mcp-session-id": sessionId,
      },
    });
    assert.equal(response.status, 200);
    await response.body?.cancel();
  };
  try {
    await Promise.all([proxy.connect(a), client.connect(b)]);
    await assert.rejects(status(), /503/);
    const connected = await status();
    assert.match(JSON.stringify(connected), /Client-enforced approval/);
    await expireSession();
    assert.match(JSON.stringify(await status()), /Client-enforced approval/);
    await expireSession();
    assert.ok(
      (await client.listTools()).tools.some(
        (tool) => tool.name === "send_draft",
      ),
    );
    await expireSession();
    const localRead = await client.callTool({
      name: "read_messages",
      arguments: { chat_ids: [f.a.id] },
    });
    assert.equal(localRead.isError, undefined);
    assert.equal(calls.filter((name) => name === "read_messages").length, 2);
    await expireSession();
    await assert.rejects(
      client.callTool({ name: "sync_history", arguments: { chat_id: f.a.id } }),
      /404/,
    );
    assert.equal(calls.filter((name) => name === "sync_history").length, 1);
    await status();
    const draft = f.service.createDraft(f.p, {
      chat_id: f.a.id,
      text: "Recovery test",
      request_id: "recovery-test",
    });
    const args = {
      draft_id: draft.id,
      digest: draft.digest,
      chat_name: "Client A",
      text: draft.input.text,
    };
    await expireSession();
    await assert.rejects(
      client.callTool({ name: "send_draft", arguments: args }),
      /404/,
    );
    assert.equal(calls.filter((name) => name === "send_draft").length, 1);
    assert.equal(prompts, 0);
    assert.equal(f.sends(), 0);
    assert.equal(f.store.draft(draft.id).status, "pending");
    assert.match(JSON.stringify(await status()), /Client-enforced approval/);
    assert.equal(
      (await client.callTool({ name: "send_draft", arguments: args })).isError,
      undefined,
    );
    assert.equal(prompts, 0);
    assert.equal(f.sends(), 1);
    await expireSession();
    await assert.rejects(
      client.callTool({ name: "send_draft", arguments: args }),
      /404/,
    );
    await client.callTool({ name: "send_draft", arguments: args });
    assert.equal(prompts, 0);
    assert.equal(f.sends(), 1);
    const before = calls.filter((name) => name === "get_status").length;
    const initializations = calls.filter(
      (name) => name === "initialize",
    ).length;
    rejectSessions = true;
    await assert.rejects(status(), /404/);
    assert.equal(
      calls.filter((name) => name === "get_status").length - before,
      1,
    );
    // The replacement session's initialization notification also gets 404.
    // Recovery stops there instead of repeatedly reconnecting.
    assert.equal(
      calls.filter((name) => name === "initialize").length - initializations,
      1,
    );
    rejectSessions = false;
    assert.match(JSON.stringify(await status()), /Client-enforced approval/);
  } finally {
    await client.close();
    await proxy.close();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    f.close();
  }
});

test("legacy chat restrictions are ignored and new groups need no grant, but revoked keys cannot send", async () => {
  const f = fixture();
  try {
    f.store.put("client", f.p.id, { ...f.p, chats: [], canSend: true });
    f.store.put("chat", f.b.id, { ...f.b, allowed: false });
    assert.ok(f.store.authorize(f.p, f.b.id).id === f.b.id);
    const wa = new WhatsApp(f.store);
    wa.ingest(
      {
        key: {
          remoteJid: "999@g.us",
          id: "new-group-message",
          participant: "111@s.whatsapp.net",
        },
        message: { conversation: "hello" },
      },
      "live",
    );
    const chatId = opaque("chat", "999@g.us");
    assert.equal(
      f.service.read(f.p, { chat_ids: [chatId] }).messages[0]?.text,
      "hello",
    );
    const d = f.service.createDraft(f.p, {
      chat_id: chatId,
      text: "reply",
      request_id: "all-chat-draft",
    });
    assert.equal(f.sends(), 0);
    f.store.put("client", f.p.id, { ...f.p, canSend: false });
    await assert.rejects(
      f.service.sendDraft(
        f.p,
        d.id,
        d.digest,
        f.store.chat(chatId).name,
        "reply",
      ),
    );
    assert.equal(f.sends(), 0);
    f.store.put("client", f.p.id, { ...f.p, enabled: false });
    assert.throws(() => f.service.read(f.p, { chat_ids: [chatId] }));
  } finally {
    f.close();
  }
});

test("idle sessions at capacity do not block new MCP connections", async () => {
  const f = fixture();
  const port = 33224;
  const http = createApp(
    f.service,
    new WhatsApp(f.store),
    "owner-key",
    port,
  ).listen(port, "127.0.0.1");
  await new Promise<void>((resolve) => http.once("listening", resolve));
  const headers = {
    Authorization: "Bearer agent-key",
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  let first = "";
  let latest = "";
  try {
    for (let i = 0; i < 101; i++) {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: i,
          method: "initialize",
          params: {
            protocolVersion: "2025-11-25",
            capabilities: {},
            clientInfo: { name: "session-test", version: "1" },
          },
        }),
      });
      assert.equal(response.status, 200);
      latest = response.headers.get("mcp-session-id") ?? "";
      assert.ok(latest);
      if (i === 0) first = latest;
      await response.text();
    }
    const list = async (session: string) => {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: { ...headers, "mcp-session-id": session },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "list",
          method: "tools/list",
          params: {},
        }),
      });
      await response.text();
      return response.status;
    };
    assert.equal(await list(first), 404);
    assert.equal(await list(latest), 200);
    assert.equal(f.sends(), 0);
  } finally {
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    f.close();
  }
});

test("reactions expose emoji and target, including removals and retained-event recovery", () => {
  const f = fixture();
  try {
    const wa = new WhatsApp(f.store);
    const jid = "111@s.whatsapp.net";
    const target = opaque("message", `${jid}:original`);
    const raw = {
      key: { remoteJid: jid, id: "reaction-1", fromMe: false },
      pushName: "Bhagyashree",
      messageTimestamp: 1791857432,
      message: {
        reactionMessage: {
          key: { remoteJid: jid, id: "original" },
          text: "👍",
        },
      },
    };
    wa.ingest(raw, "live");
    const id = opaque("message", `${jid}:reaction-1`);
    const message = f.store.message(id);
    assert.equal(message.contentType, "reaction");
    assert.equal(message.text, "👍");
    assert.equal(message.replyId, target);
    assert.equal(
      f.service.read(f.p, { reply_to_ids: [target] }).messages[0]?.text,
      "👍",
    );
    f.store.saveMessage({ ...message, text: "", replyId: null });
    wa.restoreReactions();
    assert.equal(f.store.message(id).text, "👍");
    assert.equal(f.store.message(id).replyId, target);
    assert.equal(f.store.message(id).observedAt, message.observedAt);
    const updatedAt = f.store.message(id).updatedAt;
    wa.restoreReactions();
    assert.equal(f.store.message(id).updatedAt, updatedAt);
    wa.ingest(
      {
        ...raw,
        key: { ...raw.key, id: "reaction-removed" },
        message: { reactionMessage: { key: { id: "original" }, text: "" } },
      },
      "live",
    );
    const removed = f.store.message(
      opaque("message", `${jid}:reaction-removed`),
    );
    assert.equal(removed.text, "");
    assert.equal(removed.replyId, target);
    f.store.eraseMessage(id);
    wa.restoreReactions();
    assert.equal(f.store.message(id).text, "");
    assert.equal(f.store.message(id).deleted, true);
    assert.equal(f.sends(), 0);
  } finally {
    f.close();
  }
});

test("MCP accepts ZIP drafts, exposes filenames for approval, and sends the stored attachment once", async () => {
  const f = fixture();
  const server = createMcp(f.service, new WhatsApp(f.store), f.p);
  const client = new Client({ name: "zip-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(a), client.connect(b)]);
    const listed = await client.listTools();
    assert.match(
      JSON.stringify(listed.tools.find((t) => t.name === "create_draft")),
      /application\/zip/,
    );
    assert.match(
      JSON.stringify(listed.tools.find((t) => t.name === "send_draft")),
      /attachment_names/,
    );
    const bytes = Buffer.from("PK\u0005\u0006" + "\u0000".repeat(18));
    const created = await client.callTool({
      name: "create_draft",
      arguments: {
        chat_id: f.a.id,
        text: "invoices",
        request_id: "zip-test",
        attachment: {
          name: "invoices.zip",
          mime_type: "application/zip",
          data: bytes.toString("base64"),
        },
      },
    });
    assert.ok(!created.isError);
    assert.match(JSON.stringify(created), /attachment_names/);
    const draft = f.store.drafts()[0]!;
    const aid = draft.input.attachment_ids[0]!;
    assert.deepEqual(f.store.attachments.read(aid).data, bytes);
    assert.equal(f.store.attachments.read(aid).meta.mime, "application/zip");
    f.store.put("client", f.p.id, { ...f.p, canSend: true });
    const args = {
      draft_id: draft.id,
      digest: draft.digest,
      chat_name: "Client A",
      text: "invoices",
    };
    const missing = await client.callTool({
      name: "send_draft",
      arguments: args,
    });
    assert.equal(missing.isError, true);
    assert.equal(f.sends(), 0);
    const sent = await client.callTool({
      name: "send_draft",
      arguments: { ...args, attachment_names: ["invoices.zip"] },
    });
    assert.ok(!sent.isError);
    assert.equal(f.store.draft(draft.id).status, "accepted");
    assert.equal(f.sends(), 1);
    await client.callTool({
      name: "send_draft",
      arguments: { ...args, attachment_names: ["invoices.zip"] },
    });
    assert.equal(f.sends(), 1);
  } finally {
    await client.close();
    await server.close();
    f.close();
  }
});
