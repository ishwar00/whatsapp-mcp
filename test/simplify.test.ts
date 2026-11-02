import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store, hash, opaque } from "../src/store.js";
import { Service, type Sender } from "../src/service.js";
import { WhatsApp } from "../src/whatsapp.js";
import { createMcp, readInput } from "../src/mcp.js";
import { type Message, type Draft } from "../src/domain.js";
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wa-surface-")),
    store = new Store(dir),
    wa = new WhatsApp(store);
  const chat = store.saveChat("111@s.whatsapp.net", ", Rágavendra(Bro)😎");
  const p = {
    id: "agent",
    name: "Agent",
    tokenHash: hash("key"),
    canDraft: true,
    canSend: true,
    enabled: true,
  };
  store.put("client", p.id, p);
  let count = 0;
  const sender: Sender = {
    connected: true,
    ownerIds: ["me"],
    send: async () => `sent-${++count}`,
  };
  const service = new Service(store, sender);
  const message = (id: string, extra: Partial<Message> = {}) => {
    const m: Message = {
      id,
      chatId: chat.id,
      providerId: id,
      senderId: opaque("participant", chat.jid),
      senderName: "old push name",
      direction: "incoming",
      sentAt: "2026-11-02T01:00:00.000Z",
      observedAt: "2026-11-02T01:00:00.000Z",
      updatedAt: null,
      editedAt: null,
      text: "literal %_ query",
      contentType: "text",
      mentions: [],
      replyId: null,
      deleted: false,
      source: "live",
      attachmentId: null,
      expiresAt: null,
      ...extra,
    };
    store.saveMessage(m);
    return m;
  };
  const server = createMcp(service, wa, p),
    client = new Client({ name: "surface-test", version: "1" });
  const connect = async () => {
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
  };
  const raw = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args });
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await raw(name, args);
    assert.ok(Array.isArray(r.content));
    const text = r.content.find((c) => c.type === "text");
    assert.ok(text?.type === "text");
    return JSON.parse(text.text);
  };
  return {
    dir,
    store,
    wa,
    chat,
    p,
    sender,
    service,
    message,
    connect,
    client,
    raw,
    call,
    count: () => count,
    close: async () => {
      await client.close();
      await server.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("eight short tool contracts expose no legacy APIs or hidden caller credentials", async () => {
  const f = fixture();
  try {
    await f.connect();
    const { tools } = await f.client.listTools();
    assert.deepEqual(
      tools.map((t) => t.name).sort(),
      [
        "get_status",
        "list_chats",
        "read_messages",
        "get_attachment",
        "send",
        "sync_history",
        "watch",
        "unwatch",
      ].sort(),
    );
    for (const t of tools) {
      assert.equal(t.annotations?.readOnlyHint, t.name !== "send");
      assert.ok(!JSON.stringify(t.inputSchema).includes("_caller"));
    }
    const schema = tools.find((t) => t.name === "read_messages")!.inputSchema;
    assert.deepEqual(
      Object.keys(schema.properties!).sort(),
      [
        "chat_ids",
        "sender_ids",
        "direction",
        "query",
        "sent_at",
        "has_attachment",
        "around_message_id",
        "before",
        "after",
        "limit",
        "page",
        "order",
      ].sort(),
    );
    assert.equal(readInput.safeParse({ mentions_me: true }).success, false);
  } finally {
    await f.close();
  }
});
test("canonical names, recoverable aliases, counts, ordering, compact literal and context reads", async () => {
  const f = fixture();
  try {
    f.store.rememberName(f.chat.id, "Earlier Name");
    f.message("a");
    f.message("b", { text: "next", sentAt: "2026-11-02T01:01:00.000Z" });
    f.store.saveChat("222@s.whatsapp.net", "Empty");
    await f.connect();
    const { chats } = await f.call("list_chats", { query: "ragavendra" });
    assert.equal(chats.length, 1);
    assert.equal(chats[0].message_count, 2);
    assert.ok(chats[0].aliases.includes("Earlier Name"));
    const all = await f.call("list_chats");
    assert.equal(all.chats[0].chat_id, f.chat.id);
    assert.equal(all.chats.at(-1).last_message_at, null);
    const r = await f.call("read_messages", {
      chat_ids: [f.chat.id],
      query: "%_",
      sent_at: { from: "2026-11-02T00:00:00Z" },
    });
    assert.equal(r.messages.length, 1);
    assert.equal(r.messages[0].sender_name, chats[0].name);
    assert.equal(r.chat_coverage[0].stored_messages, 2);
    assert.deepEqual(
      Object.keys(r.messages[0]).sort(),
      [
        "id",
        "chat_id",
        "sender_id",
        "sender_name",
        "direction",
        "sent_at",
        "text",
        "content_type",
      ].sort(),
    );
    assert.ok(!("chat_coverage" in (await f.call("read_messages", {}))));
    const around = await f.call("read_messages", {
      around_message_id: "a",
      before: 0,
      after: 1,
    });
    assert.deepEqual(
      around.messages.map((m: Message) => m.id),
      ["a", "b"],
    );
    assert.equal(
      (await f.call("read_messages", { around_message_id: "a", query: "next" }))
        .code,
      "invalid_argument",
    );
    const details = await f.call("list_chats", { chat_id: f.chat.id });
    assert.equal(details.chats[0].participants[0].name, chats[0].name);
    f.store.saveChat(f.chat.jid, "New name");
    assert.ok(f.service.listChats(f.p, { query: "Earlier Name" }).length);
  } finally {
    await f.close();
  }
});
test("single-call text send enforces readable recipient, records in-flight outcome, is idempotent and marks compact output", async () => {
  const f = fixture();
  try {
    await f.connect();
    const args = {
      chat_id: f.chat.id,
      to: "ragavendra",
      text: "hi",
      request_id: "one",
    };
    assert.equal(
      (await f.call("send", { ...args, to: "someone else" })).code,
      "recipient_mismatch",
    );
    assert.equal(f.count(), 0);
    const r = await f.call("send", args);
    assert.equal(r.status, "accepted");
    assert.equal(f.count(), 1);
    assert.deepEqual(await f.call("send", args), r);
    assert.equal(f.count(), 1);
    assert.equal(
      (await f.call("send", { ...args, text: "changed" })).code,
      "request_conflict",
    );
    const m = f.message(r.message_id, {
      providerId: "sent-1",
      direction: "outgoing",
    });
    assert.equal(f.service.compact(m).sent_via_mcp, true);
    const legacy: Draft = {
      id: "legacy",
      clientId: f.p.id,
      input: {
        chat_id: f.chat.id,
        text: "old",
        attachment_ids: [],
        mention_ids: [],
        request_id: "old",
      },
      digest: "old",
      status: "accepted",
      createdAt: new Date().toISOString(),
      providerId: "old-provider",
      error: null,
    };
    f.store.saveDraft(legacy);
    assert.equal(
      f.service.compact({ ...m, providerId: "old-provider" }).sent_via_mcp,
      true,
    );
    let release = () => {};
    const held = new Promise<void>((r) => (release = r));
    let calls = 0;
    f.sender.send = async () => {
      calls++;
      await held;
      throw Error("uncertain");
    };
    const pending = f.service.send(f.p, { ...args, request_id: "unknown" });
    assert.equal(
      (await f.service.send(f.p, { ...args, request_id: "unknown" })).status,
      "unknown",
    );
    release();
    assert.equal((await pending).status, "unknown");
    assert.equal(
      (await f.service.send(f.p, { ...args, request_id: "unknown" })).status,
      "unknown",
    );
    assert.equal(calls, 1);
  } finally {
    await f.close();
  }
});
test("file_path sends DOCX/PDF/ZIP through actual provider path with exact bytes, caption and filename", async () => {
  const f = fixture();
  try {
    f.wa.connected = true;
    let calls = 0;
    let expected: {
      bytes: Buffer;
      name: string;
      caption: string;
      mime: string;
    };
    Object.defineProperty(f.wa, "socket", {
      value: {
        sendMessage: async (jid: string, c: any) => {
          calls++;
          assert.equal(jid, f.chat.jid);
          assert.deepEqual(c.document, expected.bytes);
          assert.equal(c.fileName, expected.name);
          assert.equal(c.caption, expected.caption);
          assert.equal(c.mimetype, expected.mime);
          return { key: { id: "provider-" + calls } };
        },
      },
    });
    const svc = new Service(f.store, f.wa);
    for (const [ext, mime] of [
      [
        "docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ],
      ["pdf", "application/pdf"],
      ["zip", "application/zip"],
    ]) {
      const file = join(f.dir, "proof." + ext),
        bytes = Buffer.from("exact bytes\0\xff", "latin1");
      writeFileSync(file, bytes);
      expected = {
        bytes,
        name: "proof." + ext,
        caption: ext === "docx" ? "" : "caption",
        mime,
      };
      const args = {
        chat_id: f.chat.id,
        to: "ragavendra",
        file_path: file,
        text: expected.caption,
        request_id: ext,
      };
      assert.equal((await svc.send(f.p, args)).status, "accepted");
      await svc.send(f.p, args);
    }
    assert.equal(calls, 3);
    for (const [file, code] of [
      [join(f.dir, "missing.pdf"), "file_unavailable"],
      [join(f.dir, "bad.exe"), "unsupported_file_type"],
    ])
      await assert.rejects(
        svc.send(f.p, {
          chat_id: f.chat.id,
          to: "ragavendra",
          file_path: file,
          request_id: file,
        }),
        (e) => (e as any).code === code,
      );
    const big = join(f.dir, "big.pdf");
    writeFileSync(big, Buffer.alloc(5 * 1024 * 1024 + 1));
    await assert.rejects(
      svc.send(f.p, {
        chat_id: f.chat.id,
        to: "ragavendra",
        file_path: big,
        request_id: "big",
      }),
      (e) => (e as any).code === "media_too_large",
    );
    assert.equal(calls, 3);
  } finally {
    await f.close();
  }
});
test("attachment writes exact bytes, hash, suffix, explicit path and bounded original image without base64 text", async () => {
  const f = fixture();
  const defaultDir = join(f.dir, "downloads"); // explicit paths avoid touching the user Downloads
  try {
    await f.connect();
    const bytes = Buffer.from("a PDF");
    f.store.attachments.save(
      {
        id: "file",
        chatId: f.chat.id,
        messageId: null,
        name: "test.pdf",
        mime: "application/pdf",
        size: 0,
        digest: null,
        availability: "pending",
      },
      bytes,
    );
    const dest = join(defaultDir, "test.pdf");
    const r = await f.call("get_attachment", {
      attachment_id: "file",
      save_to: dest,
    });
    assert.deepEqual(readFileSync(r.path), bytes);
    assert.equal(r.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.ok(!JSON.stringify(r).includes(bytes.toString("base64")));
    assert.equal(
      (await f.call("get_attachment", { attachment_id: "file", save_to: dest }))
        .code,
      "file_unavailable",
    );
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR1kAAAAASUVORK5CYII=",
      "base64",
    );
    f.store.attachments.save(
      {
        id: "img",
        chatId: f.chat.id,
        messageId: null,
        name: "pixel.png",
        mime: "image/png",
        size: 0,
        digest: null,
        availability: "pending",
      },
      image,
    );
    const result = await f.raw("get_attachment", {
      attachment_id: "img",
      save_to: join(defaultDir, "pixel.png"),
      view: true,
    });
    assert.ok(Array.isArray(result.content));
    assert.deepEqual(
      result.content.find((c) => c.type === "image"),
      { type: "image", mimeType: "image/png", data: image.toString("base64") },
    );
    f.store.attachments.save(
      {
        id: "large",
        chatId: f.chat.id,
        messageId: null,
        name: "large.png",
        mime: "image/png",
        size: 0,
        digest: null,
        availability: "pending",
      },
      Buffer.alloc(1000001),
    );
    const large = await f.call("get_attachment", {
      attachment_id: "large",
      save_to: join(defaultDir, "large.png"),
      view: true,
    });
    assert.equal(large.view_skipped, "too_large");
  } finally {
    await f.close();
  }
});
test("sync_history blocks until terminal and reports the no-anchor explanation", async () => {
  const f = fixture();
  try {
    f.wa.connected = true;
    await f.connect();
    const r = await f.call("sync_history", { chat_id: f.chat.id });
    assert.equal(r.state, "no_anchor");
    assert.equal(r.done, true);
    assert.equal(
      r.error,
      "no stored messages in this chat yet; WhatsApp can only fetch history before a known message",
    );
  } finally {
    await f.close();
  }
});

test("default attachment destination adds a collision suffix before extension", async () => {
  const f = fixture();
  const paths: string[] = [];
  try {
    await f.connect();
    const name = f.store.uuid("fixture") + ".pdf";
    f.store.attachments.save(
      {
        id: "default",
        chatId: f.chat.id,
        messageId: null,
        name,
        mime: "application/pdf",
        size: 0,
        digest: null,
        availability: "pending",
      },
      Buffer.from("download fixture"),
    );
    const first = await f.call("get_attachment", { attachment_id: "default" });
    paths.push(first.path);
    const second = await f.call("get_attachment", { attachment_id: "default" });
    paths.push(second.path);
    assert.equal(second.path, first.path.replace(/\.pdf$/, " (2).pdf"));
    assert.deepEqual(readFileSync(first.path), readFileSync(second.path));
  } finally {
    for (const p of paths) rmSync(p, { force: true });
    await f.close();
  }
});

test("recoverable names backfill once and survive identity merges and restart", async () => {
  const f = fixture();
  try {
    const lid = "777@lid",
      pn = "555@s.whatsapp.net";
    const a = f.store.saveChat(lid, "Lost group alias");
    f.wa.saveContact({
      id: lid,
      name: "Saved Person",
      notify: "Push Name",
      verifiedName: "Business Name",
    });
    f.message("legacy-name", {
      senderId: opaque("participant", lid),
      senderName: "Previous push",
    });
    f.store.remove("setting", "chat-names-backfilled");
    f.store.db.exec("DELETE FROM chat_names");
    f.store.close();
    const reopened = new Store(f.dir);
    try {
      for (const n of ["Saved Person", "Push Name", "Previous push"])
        assert.ok(reopened.names(a.id).includes(n));
      reopened.addAlias(lid, pn);
      assert.ok(reopened.names(opaque("chat", pn)).includes("Previous push"));
      reopened.rememberName(a.id, "Future Name");
      assert.ok(reopened.names(opaque("chat", pn)).includes("Future Name"));
    } finally {
      reopened.close();
    }
  } finally {
    await f.close();
  }
});

test("600-chat and 4600-name discovery completes under 500 ms with indexed name reads", async (t) => {
  const f = fixture();
  try {
    f.store.transaction(() => {
      for (let i = 0; i < 599; i++) {
        const chat = f.store.saveChat(
          `${2000 + i}@s.whatsapp.net`,
          `Person ${i}`,
        );
        for (let n = 0; n < 6; n++)
          f.store.rememberName(chat.id, `Alias ${i} ${n}`);
      }
      for (let i = 0; i < 406; i++)
        f.store.rememberName(f.chat.id, `Extra ${i}`);
    });
    assert.equal(f.store.chats().length, 600);
    assert.equal(
      f.store.db.prepare("SELECT count(*) n FROM chat_names").get()?.n,
      4600,
    );
    const start = performance.now();
    const results = f.service.listChats(f.p, { limit: 100 });
    const elapsed = performance.now() - start;
    t.diagnostic(`600 chats / 4600 names: ${elapsed.toFixed(1)} ms`);
    assert.equal(results.length, 100);
    assert.ok(elapsed < 500, `discovery took ${elapsed.toFixed(1)}ms`);
  } finally {
    await f.close();
  }
});
test("name rows rekey on verified identity merge and preserve first/last observation bounds", async () => {
  const f = fixture();
  try {
    const lid = "777@lid",
      pn = "555@s.whatsapp.net";
    const a = f.store.saveChat(lid, "Old Name"),
      b = f.store.saveChat(pn, "New Name");
    f.store.db
      .prepare("INSERT INTO chat_names VALUES(?,?,?,?)")
      .run(a.id, "Shared", "2026-01-01", "2026-02-01");
    f.store.db
      .prepare("INSERT INTO chat_names VALUES(?,?,?,?)")
      .run(b.id, "Shared", "2026-01-02", "2026-03-01");
    f.store.addAlias(lid, pn);
    assert.deepEqual(
      f.store.db.prepare("SELECT * FROM chat_names WHERE chat_id=?").all(a.id),
      [],
    );
    assert.deepEqual(f.store.names(a.id), f.store.names(b.id));
    assert.ok(f.store.names(b.id).includes("Old Name"));
    const shared = f.store.db
      .prepare(
        "SELECT first_seen_at,last_seen_at FROM chat_names WHERE chat_id=? AND name=?",
      )
      .get(b.id, "Shared");
    assert.equal(shared?.first_seen_at, "2026-01-01");
    assert.equal(shared?.last_seen_at, "2026-03-01");
  } finally {
    await f.close();
  }
});
test("chat details reject list filters, match list aliases and expose only observed participant identity fields", async () => {
  const f = fixture();
  try {
    f.message("sender");
    f.wa.saveContact({
      id: f.chat.jid,
      name: "Saved Contact",
      notify: "Push Alias",
    });
    f.store.saveChat(f.chat.jid, "Current Subject");
    await f.connect();
    for (const filter of [{ query: "x" }, { type: "direct" }, { limit: 20 }])
      assert.equal(
        (await f.call("list_chats", { chat_id: f.chat.id, ...filter })).code,
        "invalid_argument",
      );
    const detail = (await f.call("list_chats", { chat_id: f.chat.id }))
        .chats[0],
      listing = (await f.call("list_chats")).chats[0];
    assert.deepEqual(detail.aliases, listing.aliases);
    assert.ok(detail.aliases.includes("Current Subject"));
    assert.deepEqual(
      Object.keys(detail.participants[0]).sort(),
      ["participant_id", "name", "aliases"].sort(),
    );
  } finally {
    await f.close();
  }
});
test("read_messages scans accepted send/legacy records once per page and once per context read", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 10; i++)
      f.message("m" + i, {
        direction: "outgoing",
        providerId: "provider-" + i,
      });
    f.store.put("send", "sent", {
      status: "accepted",
      providerId: "provider-1",
      chat_id: f.chat.id,
    });
    f.store.put("draft", "old", {
      status: "accepted",
      providerId: "provider-2",
      input: { chat_id: f.chat.id },
    });
    await f.connect();
    const all = f.store.all.bind(f.store);
    let sendReads = 0,
      draftReads = 0;
    f.store.all = (kind) => {
      if (kind === "send") sendReads++;
      if (kind === "draft") draftReads++;
      return all(kind);
    };
    const page = await f.call("read_messages", { chat_ids: [f.chat.id] });
    assert.equal(
      page.messages.filter((m: { sent_via_mcp?: boolean }) => m.sent_via_mcp)
        .length,
      2,
    );
    assert.equal(sendReads, 1);
    assert.equal(draftReads, 1);
    await f.call("read_messages", { around_message_id: "m5" });
    assert.equal(sendReads, 2);
    assert.equal(draftReads, 2);
  } finally {
    await f.close();
  }
});

test("startup repairs previously aliased name rows before indexed lookups and is repeatable", async () => {
  const f = fixture();
  try {
    const lid = "777@lid",
      pn = "555@s.whatsapp.net";
    const a = f.store.saveChat(lid, "Legacy Alias"),
      b = f.store.saveChat(pn, "Canonical");
    f.store.addAlias(lid, pn);
    f.store.db
      .prepare("UPDATE chat_names SET chat_id=? WHERE chat_id=? AND name=?")
      .run(a.id, b.id, "Legacy Alias");
    f.store.remove("setting", "chat-names-canonical");
    f.store.close();
    for (let i = 0; i < 2; i++) {
      const reopened = new Store(f.dir);
      try {
        assert.ok(reopened.names(b.id).includes("Legacy Alias"));
        assert.equal(
          reopened.db
            .prepare("SELECT count(*) n FROM chat_names WHERE chat_id=?")
            .get(a.id)?.n,
          0,
        );
      } finally {
        reopened.close();
      }
    }
  } finally {
    await f.close();
  }
});
