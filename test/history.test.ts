import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Store, hash } from "../src/store.js";
import { HistorySync, resolveHistoryMode } from "../src/history.js";
import { WhatsApp } from "../src/whatsapp.js";
import { Service } from "../src/service.js";
import { createMcp } from "../src/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wa-history-"));
  const store = new Store(dir),
    wa = new WhatsApp(store);
  const chat = store.saveChat("12345@g.us", "History test");
  let sequence = 0;
  const ingest = (date: string, providerId = `m${++sequence}`) => {
    const id = store.messageId(chat.jid, providerId);
    const existed = store.findMessage(id) !== null;
    wa.ingest(
      {
        key: {
          id: providerId,
          remoteJid: chat.jid,
          fromMe: false,
          participant: "321@s.whatsapp.net",
        },
        messageTimestamp: Date.parse(date) / 1000,
        message: { conversation: `message ${date}` },
      },
      "history",
    );
    return { id: store.message(id).id, added: !existed };
  };
  return {
    dir,
    store,
    wa,
    chat,
    ingest,
    close() {
      wa.stop();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
async function terminal(sync: HistorySync, id: string) {
  for (let n = 0; n < 1000; n++) {
    const job = sync.get(id);
    if (!["queued", "running"].includes(job.state)) return job;
    await delay(5);
  }
  throw new Error("history job did not finish");
}
const september = { from: "2026-09-01T00:00:00Z", to: "2026-10-01T00:00:00Z" };

test("sparse date ranges fetch near the range end and traverse responses rather than global stored bounds", async () => {
  const f = fixture();
  f.ingest("2026-08-01T00:00:00Z");
  const start = f.ingest("2026-10-01T00:00:00Z");
  let sync!: HistorySync,
    calls = 0,
    nextId = start.id;
  sync = new HistorySync(
    f.store,
    {
      connected: () => true,
      request: async (chat, count, anchorId) => {
        assert.equal(count, 50);
        assert.equal(anchorId, nextId);
        calls++;
        const message = f.ingest(
          calls === 1 ? "2026-09-20T00:00:00Z" : "2026-08-30T00:00:00Z",
        );
        nextId = message.id;
        sync.received({
          requestId: `r${calls}`,
          progress: 100,
          messages: [message],
        });
        return { requestId: `r${calls}` };
      },
    },
    100,
  );
  try {
    const job = sync.start({ chat_id: f.chat.id, sent_at: september });
    assert.equal(
      sync.start({ chat_id: f.chat.id, sent_at: september }).id,
      job.id,
    );
    const result = await terminal(sync, job.id);
    assert.equal(result.state, "target_reached");
    assert.equal(calls, 2);
    assert.equal(result.anchor_message_id, start.id);
    assert.equal(result.next_message_id, nextId);
    assert.equal(result.traversed_from, "2026-08-30T00:00:00.000Z");
    assert.equal(result.coverage.oldest_message_at, "2026-08-01T00:00:00.000Z");
    assert.equal(result.coverage.completeness, "unknown");
    assert.equal(result.messages_added, 2);
    const sender = {
      connected: true,
      ownerIds: [],
      send: async () => {
        throw new Error("Sends forbidden");
      },
    };
    const p = {
      id: "agent",
      name: "Agent",
      tokenHash: hash("key"),
      canDraft: false,
      canSend: false,
      enabled: true,
    };
    f.store.put("client", p.id, p);
    const resultRead = new Service(f.store, sender).read(p, {
      chat_ids: [f.chat.id],
      sent_at: september,
      query: "2026-09-20",
    });
    assert.equal(resultRead.messages.length, 1);
    assert.equal(resultRead.chat_coverage?.[0]?.stored_messages, 4);
    sync.close();
    const restarted = new HistorySync(f.store, {
      connected: () => false,
      request: async () => {
        throw new Error();
      },
    });
    assert.equal(restarted.get(job.id).traversed_from, result.traversed_from);
    restarted.close();
  } finally {
    sync.close();
    f.close();
  }
});

test("delayed chunks keep the job running beyond 750ms until explicit matching completion", async () => {
  const f = fixture();
  const anchor = f.ingest("2026-10-01T00:00:00Z");
  let sync!: HistorySync;
  const timers: ReturnType<typeof setTimeout>[] = [];
  sync = new HistorySync(
    f.store,
    {
      connected: () => true,
      request: async () => {
        sync.received({
          requestId: "chunked",
          progress: 10,
          messages: [{ ...anchor, added: false }],
        });
        timers.push(
          setTimeout(
            () =>
              sync.received({
                requestId: "chunked",
                progress: 70,
                messages: [f.ingest("2026-08-30T00:00:00Z")],
              }),
            900,
          ),
        );
        return { requestId: "chunked" };
      },
    },
    2000,
  );
  try {
    const job = sync.start({ chat_id: f.chat.id, sent_at: september });
    await delay(800);
    assert.equal(sync.get(job.id).state, "running");
    for (let n = 0; sync.get(job.id).response_progress !== 70 && n < 200; n++)
      await delay(5);
    const pending = sync.get(job.id);
    assert.equal(pending.state, "running");
    assert.equal(pending.response_progress, 70);
    assert.equal(pending.messages_added, 1);
    sync.received({ requestId: "chunked", progress: 100, messages: [] });
    const result = await terminal(sync, job.id);
    assert.equal(result.state, "target_reached");
    assert.equal(result.messages_added, 1);
  } finally {
    timers.forEach(clearTimeout);
    sync.close();
    f.close();
  }
});

test("wrong early request IDs and uncorrelated chunks never satisfy a request", async () => {
  const f = fixture();
  f.ingest("2026-10-01T00:00:00Z");
  let sync!: HistorySync;
  sync = new HistorySync(
    f.store,
    {
      connected: () => true,
      request: async () => {
        const message = f.ingest("2026-08-01T00:00:00Z");
        sync.received({
          requestId: "wrong",
          progress: 100,
          messages: [message],
        });
        sync.received({ progress: 100, messages: [message] });
        return { requestId: "expected" };
      },
    },
    30,
  );
  try {
    const result = await terminal(sync, sync.start({ chat_id: f.chat.id }).id);
    assert.equal(result.state, "timed_out");
    assert.equal(result.messages_added, 0);
    assert.equal(result.traversed_from, null);
    assert.equal(result.traversed_to, null);
  } finally {
    sync.close();
    f.close();
  }
});

test("correct empty early completion is no progress and missing completion is explicitly incomplete", async () => {
  const f = fixture();
  f.ingest("2026-10-01T00:00:00Z");
  let sync!: HistorySync;
  sync = new HistorySync(
    f.store,
    {
      connected: () => true,
      request: async () => {
        sync.received({ requestId: "empty", progress: 100, messages: [] });
        return { requestId: "empty" };
      },
    },
    30,
  );
  try {
    assert.equal(
      (await terminal(sync, sync.start({ chat_id: f.chat.id }).id)).state,
      "no_progress",
    );
    sync.close();
    sync = new HistorySync(
      f.store,
      {
        connected: () => true,
        request: async () => {
          f.ingest("2026-07-01T00:00:00Z"); // unrelated live/store growth must not count as this response
          sync.received({
            requestId: "partial",
            progress: 25,
            messages: [f.ingest("2026-09-01T00:00:00Z")],
          });
          return { requestId: "partial" };
        },
      },
      30,
    );
    const job = await terminal(sync, sync.start({ chat_id: f.chat.id }).id);
    assert.equal(job.state, "response_incomplete");
    assert.equal(job.messages_added, 1);
    assert.equal(job.traversed_from, null);
    assert.equal(job.traversed_to, null);
  } finally {
    sync.close();
    f.close();
  }
});

test("dispatch deadlines, service interruption, and offline jobs do not silently retry", async () => {
  const f = fixture();
  f.ingest("2026-10-01T00:00:00Z");
  let sync = new HistorySync(
    f.store,
    { connected: () => true, request: () => new Promise(() => {}) },
    20,
  );
  try {
    assert.equal(
      (await terminal(sync, sync.start({ chat_id: f.chat.id }).id)).state,
      "timed_out",
    );
    const queued = sync.start({ chat_id: f.chat.id });
    sync.close();
    assert.equal(sync.get(queued.id).state, "interrupted");
    sync = new HistorySync(f.store, {
      connected: () => false,
      request: async () => {
        throw new Error("Unexpected dispatch");
      },
    });
    assert.equal(sync.get(queued.id).state, "interrupted");
    assert.equal(
      (await terminal(sync, sync.start({ chat_id: f.chat.id }).id)).state,
      "offline",
    );
  } finally {
    sync.close();
    f.close();
  }
});

test("only usable scoped anchors are dispatched, timestamps use milliseconds, and budgets are enforced", async () => {
  const f = fixture();
  try {
    f.wa.connected = true;
    let calls = 0;
    f.wa.socket = {
      fetchMessageHistory: async (
        _count: number,
        key: { remoteJid?: string | null },
        timestamp: number,
      ) => {
        calls++;
        assert.equal(key.remoteJid, f.chat.jid);
        assert.equal(timestamp, Date.parse("2026-10-01T00:00:00Z"));
        return "wire-key";
      },
    } as unknown as NonNullable<WhatsApp["socket"]>;
    const missing = await terminal(
      f.wa.history,
      f.wa.history.start({ chat_id: f.chat.id }).id,
    );
    assert.equal(missing.state, "no_anchor");
    assert.equal(calls, 0);
    const anchor = f.ingest("2026-10-01T00:00:00Z");
    assert.equal(
      (await f.wa.requestHistory(f.chat.id, 50, anchor.id)).requestId,
      "wire-key",
    );
    assert.throws(() =>
      f.wa.history.start({ chat_id: f.chat.id, max_batches: 11 }),
    );
    assert.throws(() =>
      f.wa.history.start({
        chat_id: f.chat.id,
        sent_at: { from: september.to, to: september.from },
      }),
    );
  } finally {
    f.wa.socket = undefined;
    f.close();
  }
});

test("a completed batch advances a cursor even when all its messages were already stored", async () => {
  const f = fixture();
  const old = f.ingest("2026-09-20T00:00:00Z"),
    anchor = f.ingest("2026-10-01T00:00:00Z");
  let sync!: HistorySync;
  sync = new HistorySync(
    f.store,
    {
      connected: () => true,
      request: async () => {
        sync.received({
          requestId: "stored",
          progress: 100,
          messages: [{ ...old, added: false }],
        });
        return { requestId: "stored" };
      },
    },
    30,
  );
  try {
    const result = await terminal(
      sync,
      sync.start({
        chat_id: f.chat.id,
        before_message_id: anchor.id,
        max_batches: 1,
      }).id,
    );
    assert.equal(result.state, "batch_limit");
    assert.equal(result.next_message_id, old.id);
    assert.equal(result.messages_added, 0);
  } finally {
    sync.close();
    f.close();
  }
});

test("MCP reads/searches stay local, coverage is included, explicit sync reports status and revocation is enforced", async () => {
  const f = fixture();
  const p = {
    id: "agent",
    name: "Agent",
    tokenHash: hash("key"),
    canDraft: false,
    canSend: false,
    enabled: true,
  };
  f.store.put("client", p.id, p);
  f.ingest("2026-10-01T00:00:00Z");
  const server = createMcp(new Service(f.store, f.wa), f.wa, p);
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content;
    assert.ok(Array.isArray(content));
    const text = content.find((item) => item.type === "text");
    assert.ok(text && text.type === "text");
    return JSON.parse(text.text);
  };
  try {
    const tools = (await client.listTools()).tools;
    assert.equal(
      tools.some((t) => t.name === "get_history_coverage"),
      false,
    );
    const oldOption = await call("search_messages", {
      query: "older",
      fetch_history: true,
    });
    assert.ok(Array.isArray(oldOption.messages));
    assert.equal(f.store.all("history-job").length, 0);
    const local = await call("search_messages", {
      query: "older",
      chat_ids: [f.chat.id],
    });
    assert.equal(local.messages.length, 0);
    assert.equal(local.chat_coverage[0].stored_messages, 1);
    assert.equal(f.store.all("history-job").length, 0);
    const queued = await call("sync_history", { chat_id: f.chat.id });
    const result = await terminal(f.wa.history, queued.id);
    assert.equal(result.state, "offline");
    assert.equal(
      (await call("get_history_status", { job_id: result.id })).state,
      "offline",
    );
    f.store.put("client", p.id, { ...p, enabled: false });
    assert.equal(
      (await call("get_history_status", { job_id: result.id })).code,
      "not_found_or_not_permitted",
    );
  } finally {
    await client.close();
    await server.close();
    f.close();
  }
});

test("full initial sync preserves existing sync preferences", () => {
  assert.equal(resolveHistoryMode({ saved: undefined, paired: false }), "full");
  assert.equal(
    resolveHistoryMode({ saved: undefined, paired: true }),
    "recent",
  );
  assert.equal(resolveHistoryMode({ saved: "full", paired: true }), "full");
  assert.equal(
    resolveHistoryMode({ override: "recent", saved: "full", paired: true }),
    "recent",
  );
  assert.throws(() =>
    resolveHistoryMode({ override: "typo", saved: undefined, paired: false }),
  );
});

test("history ingestion does not count verified identity reconciliation as newly fetched messages", () => {
  const f = fixture();
  try {
    const pn = "222@s.whatsapp.net",
      lid = "333@lid";
    const base = {
      messageTimestamp: Date.parse("2026-10-01T00:00:00Z") / 1000,
      message: { conversation: "same message" },
    };
    assert.equal(
      f.wa.ingest(
        { ...base, key: { remoteJid: pn, fromMe: false, id: "same" } },
        "history",
      )?.added,
      true,
    );
    assert.equal(
      f.wa.ingest(
        {
          ...base,
          key: { remoteJid: lid, remoteJidAlt: pn, fromMe: false, id: "same" },
        },
        "history",
      )?.added,
      false,
    );
  } finally {
    f.close();
  }
});

test("same-second response messages advance by their actual key without requiring lexicographically smaller IDs", async () => {
  const f = fixture();
  const first = f.ingest("2026-10-01T00:00:00Z", "first"),
    second = f.ingest("2026-10-01T00:00:00Z", "second");
  const [anchor, earlier] = [first, second].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  assert.ok(anchor && earlier);
  let sync!: HistorySync;
  sync = new HistorySync(
    f.store,
    {
      connected: () => true,
      request: async () => {
        sync.received({
          requestId: "same-second",
          progress: 100,
          messages: [{ ...earlier, added: false }],
        });
        return { requestId: "same-second" };
      },
    },
    30,
  );
  try {
    const job = await terminal(
      sync,
      sync.start({
        chat_id: f.chat.id,
        before_message_id: anchor.id,
        max_batches: 1,
      }).id,
    );
    assert.equal(job.state, "batch_limit");
    assert.equal(job.next_message_id, earlier.id);
  } finally {
    sync.close();
    f.close();
  }
});

test("metadata-only history rows cannot become pagination anchors", async () => {
  const f = fixture();
  const ghost = f.ingest("2026-09-01T00:00:00Z", "metadata");
  f.store.put("raw", ghost.id, {
    key: { id: "metadata", remoteJid: f.chat.jid, fromMe: false },
    messageTimestamp: Date.parse("2026-09-01T00:00:00Z") / 1000,
    message: { messageContextInfo: {} },
  });
  const anchor = f.ingest("2026-10-01T00:00:00Z");
  assert.equal(f.store.historyAnchor(f.chat.id)?.id, anchor.id);
  assert.equal(f.store.historyAnchor(f.chat.id, { messageId: ghost.id }), null);
  let sync!: HistorySync;
  let calls = 0;
  sync = new HistorySync(
    f.store,
    {
      connected: () => true,
      request: async (_chat, _count, id) => {
        assert.equal(id, anchor.id);
        calls++;
        sync.received({
          requestId: "metadata-page",
          progress: 100,
          messages: [ghost],
        });
        return { requestId: "metadata-page" };
      },
    },
    100,
  );
  try {
    const result = await terminal(sync, sync.start({ chat_id: f.chat.id }).id);
    assert.equal(result.state, "no_progress");
    assert.equal(result.next_message_id, anchor.id);
    assert.equal(result.traversed_from, null);
    assert.equal(calls, 1);
  } finally {
    sync.close();
    f.close();
  }
});
