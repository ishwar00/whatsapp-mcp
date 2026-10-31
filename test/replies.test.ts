import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store, hash } from "../src/store.js";
import { WhatsApp } from "../src/whatsapp.js";
import { Service } from "../src/service.js";
import { ReplyWatches } from "../src/replies.js";
import type { ReplySettings } from "../src/replies.js";
import type { Classification, ReplyContext } from "../src/reply-classifier.js";

function fixture(
  classify?: (
    context: ReplyContext,
    signal: AbortSignal,
  ) => Promise<Classification>,
  settings: Partial<ReplySettings> = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "wa-replies-"));
  const store = new Store(dir),
    wa = new WhatsApp(store);
  const chat = store.saveChat("12345@g.us", "Synthetic test group");
  const p = {
    id: "agent",
    name: "test",
    tokenHash: hash("test"),
    enabled: true,
    canDraft: true,
    canSend: true,
  };
  store.put("client", p.id, p);
  let now = Math.floor(Date.now() / 1000) * 1000;
  let sequence = 0;
  const notices: { watch_id: string; notice_id: number; kind: string }[] = [];
  const contexts: ReplyContext[] = [];
  const notifier = {
    check: async () => {},
    send: async (_destination: unknown, notice: (typeof notices)[number]) => {
      notices.push(notice);
      return "submitted" as const;
    },
  };
  const runClassify = async (
    c: ReplyContext,
    s: AbortSignal,
  ): Promise<Classification> => {
    contexts.push(c);
    if (classify) return classify(c, s);
    return {
      results: c.candidates.map((m) => ({
        message_id: m.id,
        revision: m.revision,
        label: /record|done/.test(m.text) ? "relevant" : "unrelated",
        reason: "Synthetic test classification",
      })),
    };
  };
  let replies = new ReplyWatches(
    store,
    { quiet_seconds: 0, ...settings },
    { now: () => now, notifier, classify: runClassify },
  );
  const ingest = (
    text: string,
    options: {
      outgoing?: boolean;
      provider?: string;
      at?: number;
      reply?: string;
      history?: boolean;
    } = {},
  ) => {
    const provider = options.provider ?? `m${++sequence}`;
    const result = wa.ingest(
      {
        key: {
          id: provider,
          remoteJid: chat.jid,
          fromMe: options.outgoing ?? false,
          participant: "321@s.whatsapp.net",
        },
        messageTimestamp: (options.at ?? now) / 1000,
        message: {
          extendedTextMessage: {
            text,
            ...(options.reply
              ? { contextInfo: { stanzaId: options.reply } }
              : {}),
          },
        },
      },
      options.history ? "history" : "live",
    );
    assert.ok(result);
    return store.message(result.id);
  };
  const original = ingest("please update both DNS records", { outgoing: true });
  const create = (extra: Record<string, unknown> = {}) =>
    replies.create(p, {
      request_id: `req${++sequence}`,
      message_ids: [original.id],
      waiting_for: "confirmation or questions about DNS records",
      timeout_seconds: 30,
      notify: {
        bag: "test",
        peer: "codex",
        service_token: "synthetic-service-token-value",
      },
      ...extra,
    });
  return {
    dir,
    store,
    wa,
    chat,
    p,
    original,
    ingest,
    create,
    contexts,
    notices,
    get replies() {
      return replies;
    },
    advance(ms = 1000) {
      now += ms;
    },
    now: () => now,
    async restart() {
      await replies.close();
      replies = new ReplyWatches(
        store,
        { quiet_seconds: 0, ...settings },
        { now: () => now, notifier, classify: runClassify },
      );
    },
    async close() {
      await replies.close();
      wa.stop();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("every incoming group bubble is classified; only relevant messages produce pointer notices without a receipt-acknowledgment protocol", async () => {
  const f = fixture();
  try {
    const w = await f.create();
    assert.equal(
      JSON.stringify(w).includes("synthetic-service-token-value"),
      false,
    );
    f.advance();
    const meeting = f.ingest("what time is the meeting?");
    const first = f.ingest("first record added");
    const chatter = f.ingest("4pm works");
    const second = f.ingest("second record already exists");
    await f.replies.tick();
    await f.replies.tick();
    assert.deepEqual(
      f.contexts[0]?.candidates.map((m) => m.id),
      [meeting.id, first.id, chatter.id, second.id],
    );
    assert.equal(f.contexts[0]?.original_messages[0]?.text, f.original.text);
    const read = f.replies.read(f.p, { watch_id: w.id });
    assert.deepEqual(
      read.replies.map((r) => r.message?.id),
      [first.id, second.id],
    );
    assert.equal(read.unrelated_count, 2);
    assert.equal(f.notices.length, 1);
    assert.equal(JSON.stringify(f.notices).includes("record"), false);
    assert.equal(read.watch.notices[0]?.state, "sent");
    f.advance();
    f.ingest("done, both records are there");
    await f.replies.tick();
    await f.replies.tick();
    assert.ok(
      f.contexts[1]?.earlier_relevant_messages.some((m) => m.id === first.id),
    );
    assert.ok(f.contexts[1]?.recent_messages.some((m) => m.id === chatter.id));
    const next = f.replies.read(f.p, {
      watch_id: w.id,
      after: read.next_cursor,
    });
    assert.equal(next.replies.length, 1);
  } finally {
    await f.close();
  }
});

test("quoted replies skip the classifier, duplicates don't notify, and edits/deletion preserve current content", async () => {
  const f = fixture(async () => {
    throw new Error("Should not classify a quote");
  });
  try {
    const w = await f.create();
    f.advance();
    const quote = f.ingest("yes", {
      reply: f.original.providerId,
      provider: "reply",
    });
    await f.replies.tick();
    await f.replies.tick();
    assert.equal(f.contexts.length, 0);
    assert.equal(f.notices.length, 1);
    f.ingest("yes", {
      reply: f.original.providerId,
      provider: "reply",
      history: true,
    });
    await f.replies.tick();
    await f.replies.tick();
    assert.equal(f.notices.length, 1);
    const firstRead = f.replies.read(f.p, { watch_id: w.id });
    f.store.saveMessage({
      ...f.store.message(quote.id),
      text: "actually no",
      editedAt: new Date(f.now()).toISOString(),
    });
    await f.replies.tick();
    await f.replies.tick();
    assert.equal(f.notices.length, 2);
    f.store.eraseMessage(quote.id);
    const read = f.replies.read(f.p, { watch_id: w.id });
    assert.ok(
      read.replies.every((r) => r.message?.text === "" && r.message.deleted),
    );
    assert.ok(
      f.store.db.prepare("SELECT rev FROM messages WHERE id=?").get(quote.id)
        ?.rev,
    );
  } finally {
    await f.close();
  }
});

test("uncertainty surfaces immediately; invalid classifier output is explicit unclassified data", async () => {
  let calls = 0;
  const f = fixture(async (c) => ({
    results: c.candidates.map((m) => ({
      message_id: ++calls === 2 ? "invented-id" : m.id,
      revision: m.revision,
      label: "uncertain",
      reason: "Missing context",
    })),
  }));
  try {
    const w = await f.create();
    f.advance();
    f.ingest("maybe");
    await f.replies.tick();
    assert.equal(f.replies.read(f.p, { watch_id: w.id }).replies.length, 1);
    await f.replies.tick();
    assert.equal(
      f.replies.read(f.p, { watch_id: w.id }).replies[0]?.label,
      "possible",
    );
    f.advance();
    f.ingest("another message");
    await f.replies.tick();
    assert.ok(
      f.replies
        .read(f.p, { watch_id: w.id })
        .replies.some((r) => r.label === "unclassified"),
    );
  } finally {
    await f.close();
  }
});

test("hard deadline aborts in-flight classification, unrelated chatter cannot extend it, and restart keeps one terminal notice", async () => {
  let began!: () => void;
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const f = fixture(async (_c, signal) => {
    began();
    await new Promise<void>((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(new Error("aborted")), {
        once: true,
      }),
    );
    return { results: [] };
  });
  try {
    const w = await f.create({ timeout_seconds: 5 });
    f.advance();
    f.ingest("done");
    const running = f.replies.tick();
    await started;
    f.advance(5000);
    await f.replies.tick();
    await running;
    const read = f.replies.read(f.p, { watch_id: w.id });
    assert.equal(read.watch.state, "expired");
    assert.equal(read.replies.length, 1);
    assert.equal(read.replies[0]?.label, "unclassified");
    assert.equal(
      read.watch.notices.filter((n) => n.kind === "expired_unclassified")
        .length,
      1,
    );
    await f.restart();
    await f.replies.tick();
    assert.equal(
      f.replies.read(f.p, { watch_id: w.id }).watch.notices.length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("subscribe after accepted send catches an immediate reply without prepared state", async () => {
  const f = fixture();
  try {
    const service = new Service(
      f.store,
      {
        connected: true,
        ownerIds: [],
        send: async () => {
          f.ingest("done with both records");
          return "provider-out";
        },
      },
      f.replies,
    );
    const d = service.createDraft(f.p, {
      chat_id: f.chat.id,
      text: "add records",
      request_id: "draft",
    });
    await assert.rejects(
      f.create({ message_ids: undefined, draft_ids: [d.id] }),
      /after the draft/,
    );
    await service.sendDraft(f.p, d.id, d.digest, f.chat.name, d.input.text, []);
    const attemptedAt = f.store.draft(d.id).attemptedAt!;
    f.advance(1000);
    const w = await f.create({ message_ids: undefined, draft_ids: [d.id] });
    assert.equal(w.state, "active");
    assert.equal(Date.parse(w.expires_at), Date.parse(attemptedAt) + 30000);
    await f.replies.tick();
    assert.equal(f.replies.read(f.p, { watch_id: w.id }).replies.length, 1);
  } finally {
    await f.close();
  }
});

test("revoked keys, wrong principals, expired preparation and old backfill are handled without false new replies", async () => {
  const f = fixture();
  try {
    const w = await f.create();
    f.ingest("old record reply", { at: f.now() - 86400000, history: true });
    await f.replies.tick();
    assert.equal(f.contexts.length, 0);
    const other = { ...f.p, id: "other" };
    f.store.put("client", other.id, other);
    assert.throws(() => f.replies.read(other, { watch_id: w.id }), /not_found/);
    assert.throws(() => f.replies.cancel(other, w.id), /not_found/);
    const same = await f.replies.create(f.p, {
      request_id: w.request_id,
      message_ids: [f.original.id],
      waiting_for: w.waiting_for,
      timeout_seconds: 30,
      notify: {
        bag: "test",
        peer: "codex",
        service_token: "synthetic-service-token-value",
      },
    });
    assert.equal(same.id, w.id);
    f.store.put("client", f.p.id, { ...f.p, enabled: false });
    await f.replies.tick();
    assert.throws(() => f.replies.read(f.p, { watch_id: w.id }), /not_found/);
    assert.equal(f.notices.length, 0);
  } finally {
    await f.close();
  }
});

test("uncertain replies surface immediately as possible without rechecks or extra calls", async () => {
  const f = fixture(async (c) => ({
    results: c.candidates.map((m) => ({
      message_id: m.id,
      revision: m.revision,
      label: "uncertain",
      reason: "ambiguous acknowledgment",
    })),
  }));
  try {
    const w = await f.create();
    f.advance();
    f.ingest("maybe");
    await f.replies.tick();
    const first = f.replies.read(f.p, { watch_id: w.id });
    assert.equal(first.replies[0]?.label, "possible");
    await f.replies.tick();
    assert.equal(f.contexts.length, 1);
    assert.equal(
      f.replies.read(f.p, { watch_id: w.id, after: first.next_cursor }).replies
        .length,
      0,
    );
  } finally {
    await f.close();
  }
});

test("pull-only subscriptions cannot starve Postbag delivery and multiple watches get fair processing", async () => {
  const f = fixture();
  try {
    for (let n = 0; n < 5; n++) await f.create({ notify: undefined });
    const push = await f.create();
    f.advance();
    f.ingest("yes", { reply: f.original.providerId });
    for (let n = 0; n < 12; n++) await f.replies.tick();
    assert.equal(f.notices.length, 1);
    assert.equal(f.notices[0]?.watch_id, push.id);
  } finally {
    await f.close();
  }
});

test("budget exhaustion sends one warning instead of notifying for every unrelated group batch", async () => {
  const f = fixture(
    async (c) => ({
      results: c.candidates.map((m) => ({
        message_id: m.id,
        revision: m.revision,
        label: "unrelated",
        reason: "Meeting chatter",
      })),
    }),
    { max_classifier_calls: 1 },
  );
  try {
    const w = await f.create();
    for (let n = 0; n < 6; n++) {
      f.advance();
      f.ingest(`meeting chatter ${n}`);
      await f.replies.tick();
      await f.replies.tick();
    }
    assert.equal(f.contexts.length, 1);
    assert.equal(f.notices.length, 1);
    assert.equal(f.notices[0]?.kind, "classifier_unavailable");
    const before = f.replies.read(f.p, { watch_id: w.id });
    assert.equal(before.replies.length, 5);
    f.advance(30000);
    await f.replies.tick();
    await f.replies.tick();
    const end = f.replies.read(f.p, { watch_id: w.id });
    assert.equal(end.watch.state, "expired");
    assert.ok(end.watch.notices.some((n) => n.kind === "expired_unclassified"));
  } finally {
    await f.close();
  }
});

test("same-second replies survive millisecond send time and a late subscription cannot extend its deadline", async () => {
  const f = fixture();
  try {
    const d = new Service(f.store, {
      connected: true,
      ownerIds: [],
      send: async () => "sent",
    }).createDraft(f.p, {
      chat_id: f.chat.id,
      text: "records",
      request_id: "fast",
    });
    const sentAt = f.now() + 700;
    f.store.saveDraft({
      ...d,
      status: "accepted",
      providerId: "sent",
      attemptedAt: new Date(sentAt).toISOString(),
    });
    f.advance(700);
    f.ingest("done with records", { at: Math.floor(f.now() / 1000) * 1000 });
    const w = await f.create({
      message_ids: undefined,
      draft_ids: [d.id],
      timeout_seconds: 5,
    });
    await f.replies.tick();
    assert.equal(f.replies.read(f.p, { watch_id: w.id }).replies.length, 1);
    f.advance(6000);
    await assert.rejects(
      f.create({
        message_ids: undefined,
        draft_ids: [d.id],
        timeout_seconds: 5,
      }),
      /deadline already passed/,
    );
  } finally {
    await f.close();
  }
});

test("legacy revision bootstrap prevents skipping more than one page of existing replies", async () => {
  const f = fixture();
  let reopened: Store | undefined, replies: ReplyWatches | undefined;
  try {
    f.advance();
    for (let n = 0; n < 125; n++) f.ingest(`record ${n}`);
    f.store.db.exec("UPDATE messages SET rev=0");
    await f.replies.close();
    f.store.close();
    reopened = new Store(f.dir);
    assert.equal(
      reopened.db
        .prepare("SELECT count(*) AS n FROM messages WHERE rev=0")
        .get()?.n,
      0,
    );
    replies = new ReplyWatches(
      reopened,
      { quiet_seconds: 0 },
      {
        now: f.now,
        classify: async (c) => ({
          results: c.candidates.map((m) => ({
            message_id: m.id,
            revision: m.revision,
            label: "relevant",
            reason: "record update",
          })),
        }),
      },
    );
    const w = await replies.create(f.p, {
      request_id: "old",
      message_ids: [f.original.id],
      waiting_for: "record updates",
      timeout_seconds: 30,
    });
    for (let n = 0; n < 10; n++) await replies.tick();
    const first = replies.read(f.p, { watch_id: w.id, limit: 100 });
    const second = replies.read(f.p, {
      watch_id: w.id,
      after: first.next_cursor,
      limit: 100,
    });
    assert.equal(first.replies.length + second.replies.length, 125);
  } finally {
    await replies?.close();
    reopened?.close();
    await f.close();
  }
});

test("a failed notice transaction rolls back decisions and cursor, then restart recovers one reply notice", async () => {
  const f = fixture();
  try {
    const w = await f.create();
    f.advance();
    f.ingest("done with records");
    const before = f.replies.read(f.p, { watch_id: w.id }).watch.cursor_rev;
    f.store.db.exec(
      "CREATE TRIGGER fail_notice BEFORE INSERT ON reply_notices BEGIN SELECT RAISE(ABORT,'simulated failure before notice commit'); END;",
    );
    await f.replies.tick();
    assert.equal(
      f.store.db.prepare("SELECT count(*) n FROM reply_decisions").get()?.n,
      0,
    );
    assert.equal(
      f.replies.read(f.p, { watch_id: w.id }).watch.cursor_rev,
      before,
    );
    f.store.db.exec("DROP TRIGGER fail_notice");
    await f.restart();
    await f.replies.tick();
    await f.replies.tick();
    const result = f.replies.read(f.p, { watch_id: w.id });
    assert.equal(result.replies.length, 1);
    assert.equal(result.watch.notices.length, 1);
    assert.equal(result.watch.notices[0]?.state, "sent");
    assert.equal(f.notices.length, 1);
    await f.restart();
    await f.replies.tick();
    assert.equal(f.notices.length, 1);
  } finally {
    await f.close();
  }
});

test("oversized candidates are isolated and fitting batches never skip their neighbors", async () => {
  const f = fixture(undefined, { max_context_characters: 4000 });
  try {
    const w = await f.create();
    f.advance();
    const long = f.ingest("unrelated " + "x".repeat(6000));
    const short = f.ingest("both records added");
    for (let i = 0; i < 12; i++)
      f.ingest("record " + i + " " + "x".repeat(1100));
    for (let i = 0; i < 16; i++) await f.replies.tick();
    const r = f.replies.read(f.p, { watch_id: w.id });
    assert.equal(
      r.replies.find((x) => x.message?.id === long.id)?.label,
      "unclassified",
    );
    assert.equal(
      r.replies.find((x) => x.message?.id === short.id)?.label,
      "relevant",
    );
    assert.equal(r.replies.filter((x) => x.label === "relevant").length, 13);
    assert.ok(f.contexts.length > 1);
    for (const c of f.contexts) {
      assert.ok(JSON.stringify(c).length <= 4000);
      assert.ok(!c.candidates.some((x) => x.id === long.id));
    }
  } finally {
    await f.close();
  }
});

test("rotating a shared destination renews sibling watches and their failed deliveries without copying tokens into watches", async () => {
  const f = fixture();
  let replies: ReplyWatches | undefined;
  try {
    let token = "synthetic-original-token-value";
    const r = (replies = new ReplyWatches(
      f.store,
      { quiet_seconds: 0 },
      {
        now: f.now,
        notifier: {
          check: async () => ({
            expires_at: new Date(f.now() + 3600000).toISOString(),
          }),
          send: async (d) =>
            d.service_token === token ? "submitted" : "failed",
        },
        classify: async (c) => ({
          results: c.candidates.map((m) => ({
            message_id: m.id,
            revision: m.revision,
            label: "relevant",
            reason: "fixture",
          })),
        }),
      },
    ));
    const scope = (request_id: string) => ({
      request_id,
      message_ids: [f.original.id],
      waiting_for: "records",
      notify: { bag: "test", peer: "agent", service_token: token },
    });
    const a = await r.create(f.p, scope("a")),
      b = await r.create(f.p, scope("b"));
    token = "synthetic-rotated-token-value";
    f.advance();
    f.ingest("records added");
    await r.tick();
    await r.tick();
    await r.tick();
    assert.equal(
      r.read(f.p, { watch_id: a.id }).watch.notices[0]?.state,
      "failed",
    );
    await r.create(f.p, scope("b"));
    await r.tick();
    for (const id of [a.id, b.id])
      assert.equal(
        r.read(f.p, { watch_id: id }).watch.notices[0]?.state,
        "sent",
      );
    assert.equal(f.store.all("reply-destination").length, 1);
    assert.equal(
      JSON.stringify(f.store.all("reply-watch")).includes("service_token"),
      false,
    );
    f.store.eraseMessage(f.original.id);
    await r.create(f.p, scope("b")); // Renewal does not depend on retaining original content.
  } finally {
    await replies?.close();
    await f.close();
  }
});

test("unknown pointer submissions retry the same notice identity without an acknowledgment call", async () => {
  const f = fixture();
  let replies: ReplyWatches | undefined;
  try {
    const attempts: { id: number; upto: number }[] = [];
    const r = (replies = new ReplyWatches(
      f.store,
      { quiet_seconds: 0 },
      {
        now: f.now,
        notifier: {
          check: async () => {},
          send: async (_d, n) => {
            attempts.push({ id: n.notice_id, upto: n.upto });
            return attempts.length === 1 ? "unknown" : "submitted";
          },
        },
        classify: async (c) => ({
          results: c.candidates.map((m) => ({
            message_id: m.id,
            revision: m.revision,
            label: "relevant",
            reason: "fixture",
          })),
        }),
      },
    ));
    const w = await r.create(f.p, {
      request_id: "retry",
      message_ids: [f.original.id],
      waiting_for: "records",
      notify: {
        bag: "test",
        peer: "agent",
        service_token: "synthetic-service-token-value",
      },
    });
    f.advance();
    f.ingest("done");
    await r.tick();
    await r.tick();
    assert.equal(
      r.read(f.p, { watch_id: w.id }).watch.notices[0]?.state,
      "pending",
    );
    f.advance(5001);
    await r.tick();
    assert.equal(
      r.read(f.p, { watch_id: w.id }).watch.notices[0]?.state,
      "sent",
    );
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[0], attempts[1]);
    const first = r.read(f.p, { watch_id: w.id });
    assert.equal(
      r.read(f.p, { watch_id: w.id, after: first.next_cursor }).replies.length,
      0,
    );
  } finally {
    await replies?.close();
    await f.close();
  }
});

test("concurrent notification preflights preserve request idempotency", async () => {
  const f = fixture();
  try {
    const [a, b] = await Promise.all([
      f.create({ request_id: "concurrent" }),
      f.create({ request_id: "concurrent" }),
    ]);
    assert.equal(a.id, b.id);
    assert.equal(f.store.all("reply-watch").length, 1);
    const other = await Promise.allSettled([
      f.create({ request_id: "conflict", waiting_for: "records" }),
      f.create({ request_id: "conflict", waiting_for: "something else" }),
    ]);
    assert.equal(other.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(other.filter((r) => r.status === "rejected").length, 1);
  } finally {
    await f.close();
  }
});

test("default quiet window catches a fresh reply without walking a thousand legacy messages", async () => {
  const f = fixture(undefined, { quiet_seconds: 5 });
  try {
    f.store.removeMessageEvent(f.original.id);
    for (let i = 0; i < 1000; i++)
      f.ingest("old chatter", { at: f.now() - 86400000 + i * 1000 });
    // Ingestion records wall time; keep the simulated clock ahead of it.
    f.advance(60000);
    const original = f.ingest("please update records", { outgoing: true });
    const w = await f.create({ message_ids: [original.id] });
    f.advance();
    f.ingest("both records done");
    let ticks = 0;
    for (; ticks < 7 && !f.contexts.length; ticks++) {
      await f.replies.tick();
      f.advance();
    }
    assert.equal(f.contexts.length, 1);
    assert.ok(ticks <= 6);
    assert.equal(f.replies.read(f.p, { watch_id: w.id }).replies.length, 1);
  } finally {
    await f.close();
  }
});

test("default quiet window never delays pages containing no eligible candidates", async () => {
  const f = fixture(undefined, { quiet_seconds: 5 });
  try {
    const w = await f.create();
    const before = f.replies.read(f.p, { watch_id: w.id }).watch.cursor_rev;
    for (let i = 0; i < 110; i++)
      f.ingest("old backfill", { at: f.now() - 86400000, history: true });
    await f.replies.tick();
    assert.ok(
      f.replies.read(f.p, { watch_id: w.id }).watch.cursor_rev > before,
    );
    assert.equal(f.contexts.length, 0);
  } finally {
    await f.close();
  }
});

test("expired anchors are rejected rather than forwarding old group chatter as unclassified", async () => {
  const f = fixture(undefined, { quiet_seconds: 5 });
  try {
    const old = f.ingest("old request", {
      outgoing: true,
      at: f.now() - 7200000,
    });
    for (let i = 0; i < 50; i++)
      f.ingest("unrelated chatter", { at: f.now() - 600000 + i * 1000 });
    await assert.rejects(
      f.create({ message_ids: [old.id], timeout_seconds: 1800 }),
      /deadline already passed/,
    );
    assert.equal(f.store.all("reply-watch").length, 0);
    assert.equal(f.contexts.length, 0);
    assert.equal(f.notices.length, 0);
  } finally {
    await f.close();
  }
});

test("chronological context includes interleaved owner followups, filtered senders and recently edited old messages", async () => {
  const f = fixture(undefined, { quiet_seconds: 5 });
  try {
    f.advance();
    const first = f.ingest("record one done");
    f.advance();
    const owner = f.ingest("also check the second record", { outgoing: true });
    f.advance();
    const other = f.ingest("that is a different topic");
    f.store.saveMessage({ ...other, senderId: "other" });
    f.advance();
    f.ingest("record two done");
    f.store.saveMessage({
      ...f.store.message(owner.id),
      text: "also check record two, edited",
      editedAt: new Date(f.now()).toISOString(),
    });
    await f.create({ from_participant_ids: [first.senderId] });
    for (let i = 0; i < 7 && !f.contexts.length; i++) {
      await f.replies.tick();
      f.advance();
    }
    assert.ok(f.contexts[0]?.recent_messages.some((m) => m.id === owner.id));
    assert.ok(f.contexts[0]?.recent_messages.some((m) => m.id === other.id));
    assert.ok(!f.contexts[0]?.candidates.some((m) => m.id === other.id));
  } finally {
    await f.close();
  }
});

test("a quoted reply remains exact when the deadline aborts a neighboring model batch", async () => {
  let began = () => {};
  const started = new Promise<void>((resolve) => {
    began = resolve;
  });
  const f = fixture(
    async (_c, signal) => {
      began();
      await new Promise<void>((_r, reject) =>
        signal.addEventListener("abort", () => reject(new Error("abort")), {
          once: true,
        }),
      );
      return { results: [] };
    },
    { quiet_seconds: 5 },
  );
  try {
    const w = await f.create({ timeout_seconds: 12 });
    f.advance();
    const quote = f.ingest("yes", { reply: f.original.providerId });
    f.ingest("unquoted records reply");
    await f.replies.tick();
    f.advance(5000);
    const running = f.replies.tick();
    await started;
    f.advance(7000);
    await f.replies.tick();
    await running;
    const r = f.replies.read(f.p, { watch_id: w.id });
    assert.equal(
      r.replies.find((x) => x.message?.id === quote.id)?.label,
      "relevant",
    );
  } finally {
    await f.close();
  }
});

test("an older concurrent preflight cannot overwrite a newer grant, including a shorter new lifetime", async () => {
  const f = fixture();
  let replies: ReplyWatches | undefined;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const r = (replies = new ReplyWatches(
      f.store,
      {},
      {
        now: f.now,
        notifier: {
          check: async (d) => {
            if (d.service_token === "synthetic-older-token-value") await held;
            return {
              expires_at: new Date(
                f.now() + (d.service_token.includes("older") ? 3600000 : 60000),
              ).toISOString(),
            };
          },
          send: async () => "submitted",
        },
      },
    ));
    const scope = (id: string, token: string) => ({
      request_id: id,
      message_ids: [f.original.id],
      waiting_for: "records",
      notify: { bag: "test", peer: "agent", service_token: token },
    });
    const older = r.create(f.p, scope("older", "synthetic-older-token-value"));
    await r.create(f.p, scope("newer", "synthetic-newer-token-value"));
    release();
    await assert.rejects(older, /credentials changed/);
    const stored = f.store.all("reply-destination");
    assert.equal(stored.length, 1);
    assert.equal(
      JSON.stringify(stored).includes("synthetic-newer-token-value"),
      true,
    );
  } finally {
    release();
    await replies?.close();
    await f.close();
  }
});

test("deleting a relevant message retains its tombstone without another push", async () => {
  const f = fixture();
  try {
    const w = await f.create();
    f.advance();
    const m = f.ingest("done with records");
    await f.replies.tick();
    await f.replies.tick();
    assert.equal(f.notices.length, 1);
    const before = f.replies.read(f.p, { watch_id: w.id }).next_cursor;
    f.store.eraseMessage(m.id);
    await f.replies.tick();
    await f.replies.tick();
    assert.equal(f.notices.length, 1);
    assert.equal(
      f.replies.read(f.p, { watch_id: w.id, after: before }).replies[0]?.message
        ?.deleted,
      true,
    );
  } finally {
    await f.close();
  }
});

test("deployed prototype decisions upgrade without losing event IDs or deletion erasure", async () => {
  const f = fixture();
  try {
    const w = await f.create();
    f.advance();
    const m = f.ingest("done with records");
    await f.replies.tick();
    const before = f.replies.read(f.p, { watch_id: w.id });
    await f.replies.close();
    f.store.db.exec(
      "ALTER TABLE reply_decisions ADD COLUMN checked_count INTEGER NOT NULL DEFAULT 1; UPDATE reply_decisions SET label='uncertain';",
    );
    await f.restart();
    const after = f.replies.read(f.p, { watch_id: w.id });
    assert.equal(after.replies[0]?.event_id, before.replies[0]?.event_id);
    assert.equal(after.replies[0]?.label, "possible");
    assert.equal(
      f.store.db
        .prepare(
          "SELECT count(*) n FROM pragma_table_info('reply_decisions') WHERE name='checked_count'",
        )
        .get()?.n,
      0,
    );
    f.store.eraseMessage(m.id);
    assert.equal(
      f.store.db
        .prepare("SELECT reason FROM reply_decisions WHERE watch=?")
        .get(w.id)?.reason,
      "Message deleted",
    );
  } finally {
    await f.close();
  }
});
