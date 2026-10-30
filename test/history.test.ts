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
  const store = new Store(dir);
  const wa = new WhatsApp(store);
  const chat = store.saveChat("12345@g.us", "History test");
  let id = 0;
  const ingest = (date: string) =>
    wa.ingest(
      {
        key: {
          id: `m${++id}`,
          remoteJid: chat.jid,
          fromMe: false,
          participant: "321@s.whatsapp.net",
        },
        messageTimestamp: Date.parse(date) / 1000,
        message: { conversation: `message ${date}` },
      },
      "history",
    );
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
test("backfill walks older anchors, persists received messages, reaches the date, and shares in-flight jobs", async () => {
  const f = fixture();
  let sync!: HistorySync;
  let calls = 0;
  f.ingest("2026-10-20T00:00:00Z");
  sync = new HistorySync(
    f.store,
    {
      connected: () => true,
      request: async (chat, count) => {
        assert.equal(count, 50);
        assert.equal(
          f.store.historyAnchor(chat)?.sentAt,
          calls === 0 ? "2026-10-20T00:00:00.000Z" : "2026-09-20T00:00:00.000Z",
        );
        calls++;
        f.ingest(calls === 1 ? "2026-09-20T00:00:00Z" : "2026-08-20T00:00:00Z");
        sync.received({ chats: [chat], requestId: `r${calls}` });
        return { requestId: `r${calls}` };
      },
    },
    100,
  );
  try {
    const input = {
      chat_id: f.chat.id,
      sent_at: { from: "2026-09-01T00:00:00Z", to: "2026-10-01T00:00:00Z" },
    };
    const job = sync.start(input);
    assert.equal(sync.start(input).id, job.id);
    const result = await terminal(sync, job.id);
    assert.equal(result.state, "target_reached");
    assert.equal(result.messages_added, 2);
    assert.equal(result.batches_requested, 2);
    assert.equal(result.coverage.completeness, "unknown");
    assert.equal(f.store.historyCoverage(f.chat.id).stored_messages, 3);
    sync.close();
    const next = new HistorySync(f.store, {
      connected: () => false,
      request: async () => {
        throw new Error();
      },
    });
    assert.equal(next.get(job.id).messages_added, 2);
    next.close();
  } finally {
    sync.close();
    f.close();
  }
});
test("unrelated notifications cannot complete a job and a hung dispatch has a bounded timeout", async () => {
  const f = fixture();
  const sync = new HistorySync(
    f.store,
    { connected: () => true, request: () => new Promise(() => {}) },
    20,
  );
  try {
    const job = sync.start({ chat_id: f.chat.id });
    await delay(1);
    sync.received({ chats: ["unrelated"] });
    assert.equal((await terminal(sync, job.id)).state, "timed_out");
  } finally {
    sync.close();
    f.close();
  }
});
test("duplicate history reports no progress, never exhausted, and restart marks unfinished jobs interrupted", async () => {
  const f = fixture();
  let sync!: HistorySync;
  f.ingest("2026-10-01T00:00:00Z");
  sync = new HistorySync(
    f.store,
    {
      connected: () => true,
      request: async (chat) => {
        sync.received({ chats: [chat] });
        return { requestId: "duplicate" };
      },
    },
    30,
  );
  try {
    assert.equal(
      (await terminal(sync, sync.start({ chat_id: f.chat.id }).id)).state,
      "no_progress",
    );
    const persisted = sync.start({ chat_id: f.chat.id });
    sync.close();
    assert.equal(sync.get(persisted.id).state, "interrupted");
    const next = new HistorySync(f.store, {
      connected: () => false,
      request: async () => {
        throw new Error();
      },
    });
    assert.equal(next.get(persisted.id).state, "interrupted");
    next.close();
  } finally {
    sync.close();
    f.close();
  }
});
test("no raw anchor is explicit, timestamp is milliseconds, and a usable raw message anchors the request", async () => {
  const f = fixture();
  try {
    f.wa.connected = true;
    f.wa.socket = {
      fetchMessageHistory: async (
        _count: number,
        key: { remoteJid?: string | null },
        timestamp: number,
      ) => {
        assert.equal(key.remoteJid, f.chat.jid);
        assert.equal(timestamp, Date.parse("2026-10-01T00:00:00Z"));
        return "real-key";
      },
    } as unknown as NonNullable<WhatsApp["socket"]>;
    const empty = f.wa.history.start({ chat_id: f.chat.id });
    const missing = await terminal(f.wa.history, empty.id);
    assert.equal(missing.state, "no_anchor");
    assert.equal(missing.batches_requested, 0);
    f.ingest("2026-10-01T00:00:00Z");
    assert.equal(
      (await f.wa.requestHistory(f.chat.id, 50)).requestId,
      "real-key",
    );
  } finally {
    f.wa.socket = undefined;
    f.close();
  }
});
test("MCP search backfills only with explicit one-chat scope, exposes progress, and enforces revocation", async () => {
  const f = fixture();
  const p = {
    id: "agent",
    name: "Agent",
    tokenHash: hash("key"),
    canDraft: true,
    canSend: false,
    enabled: true,
  };
  f.store.put("client", p.id, p);
  f.ingest("2026-10-01T00:00:00Z");
  const service = new Service(f.store, f.wa);
  const server = createMcp(service, f.wa, p);
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    return JSON.parse(
      (result.content as { type: string; text: string }[])[0]!.text,
    );
  };
  try {
    assert.equal(
      (await call("search_messages", { query: "older", fetch_history: true }))
        .code,
      "invalid_argument",
    );
    const result = await call("search_messages", {
      query: "older",
      chat_ids: [f.chat.id],
      fetch_history: true,
    });
    assert.equal(result.results_scope, "local_so_far");
    const job = await terminal(f.wa.history, result.history_sync.id);
    assert.equal(job.state, "offline");
    assert.equal(
      (await call("get_history_coverage", { chat_id: f.chat.id }))
        .stored_messages,
      1,
    );
    assert.equal(
      (await call("get_history_status", { job_id: job.id })).state,
      "offline",
    );
    f.store.put("client", p.id, { ...p, enabled: false });
    assert.equal(
      (await call("get_history_status", { job_id: job.id })).code,
      "not_found_or_not_permitted",
    );
  } finally {
    await client.close();
    await server.close();
    f.close();
  }
});

test("broader sync defaults apply to new pairings without changing existing linked-device profiles", () => {
  assert.equal(
    resolveHistoryMode({ saved: undefined, paired: false }),
    "desktop",
  );
  assert.equal(
    resolveHistoryMode({ saved: undefined, paired: true }),
    "recent",
  );
  assert.equal(
    resolveHistoryMode({ saved: "desktop", paired: true }),
    "desktop",
  );
  assert.equal(
    resolveHistoryMode({ override: "recent", saved: "desktop", paired: true }),
    "recent",
  );
  assert.throws(() =>
    resolveHistoryMode({ override: "typo", saved: undefined, paired: false }),
  );
});

test("batch budgets stop pagination, invalid ranges are rejected, and wrong request IDs cannot complete jobs", async () => {
  const f = fixture();
  f.ingest("2026-10-20T00:00:00Z");
  let sync: HistorySync;
  sync = new HistorySync(
    f.store,
    {
      connected: () => true,
      request: async (chat) => {
        f.ingest("2026-09-20T00:00:00Z");
        sync.received({ chats: [chat] });
        return { requestId: "one-batch" };
      },
    },
    50,
  );
  try {
    assert.throws(() => sync.start({ chat_id: f.chat.id, max_batches: 11 }));
    assert.throws(() =>
      sync.start({
        chat_id: f.chat.id,
        sent_at: { from: "2026-10-20T00:00:00Z", to: "2026-09-20T00:00:00Z" },
      }),
    );
    const job = await terminal(
      sync,
      sync.start({ chat_id: f.chat.id, max_batches: 1 }).id,
    );
    assert.equal(job.state, "batch_limit");
    assert.equal(job.batches_requested, 1);
    const already = await terminal(
      sync,
      sync.start({
        chat_id: f.chat.id,
        sent_at: { from: "2026-10-01T00:00:00Z", to: "2026-10-02T00:00:00Z" },
      }).id,
    );
    assert.equal(already.state, "target_reached");
    assert.equal(already.batches_requested, 0);
    sync.close();
    sync = new HistorySync(
      f.store,
      {
        connected: () => true,
        request: async () => ({ requestId: "expected" }),
      },
      30,
    );
    const mismatched = sync.start({ chat_id: f.chat.id });
    await delay(5);
    sync.received({ chats: [f.chat.id], requestId: "wrong" });
    assert.equal((await terminal(sync, mismatched.id)).state, "timed_out");
  } finally {
    sync.close();
    f.close();
  }
});

test("an empty correlated response arriving before dispatch returns is no progress, not a timeout", async () => {
  const f = fixture();
  f.ingest("2026-10-20T00:00:00Z");
  let sync: HistorySync;
  sync = new HistorySync(
    f.store,
    {
      connected: () => true,
      request: async () => {
        sync.received({ chats: [], requestId: "early-empty" });
        return { requestId: "early-empty" };
      },
    },
    100,
  );
  try {
    assert.equal(
      (await terminal(sync, sync.start({ chat_id: f.chat.id }).id)).state,
      "no_progress",
    );
  } finally {
    sync.close();
    f.close();
  }
});
