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
  let replies = new ReplyWatches(
    store,
    { quiet_seconds: 0, ...settings },
    {
      now: () => now,
      notifier,
      classify: async (c, s) => {
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
      },
    },
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
        { quiet_seconds: 0 },
        { now: () => now, notifier, classify },
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

test("every incoming group bubble is classified; only relevant messages produce pointer notices and reads are acknowledged explicitly", async () => {
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
    assert.equal(read.watch.notices[0]?.state, "submitted");
    const acked = f.replies.read(f.p, {
      watch_id: w.id,
      ack_through: read.next_cursor,
    });
    assert.equal(acked.watch.notices[0]?.state, "acknowledged");
    assert.throws(
      () => f.replies.read(f.p, { watch_id: w.id, ack_through: 999999 }),
      /acknowledge/,
    );
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
    f.replies.read(f.p, { watch_id: w.id, ack_through: firstRead.next_cursor });
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

test("uncertainty is reconsidered once then surfaced; invalid classifier output is explicit unclassified data", async () => {
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
    assert.equal(f.replies.read(f.p, { watch_id: w.id }).replies.length, 0);
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

test("prepared draft watches capture a reply before send returns; timeout starts at approved send attempt", async () => {
  const f = fixture();
  try {
    const sender = {
      connected: true,
      ownerIds: [],
      send: async () => {
        f.ingest("done with both records");
        return "provider-out";
      },
    };
    const service = new Service(f.store, sender, f.replies);
    const d = service.createDraft(f.p, {
      chat_id: f.chat.id,
      text: "add the records",
      request_id: "draft",
    });
    const w = await f.create({ message_ids: undefined, draft_ids: [d.id] });
    assert.equal(w.state, "prepared");
    f.advance(10000);
    await service.sendDraft(f.p, d.id, d.digest, f.chat.name, d.input.text, []);
    await f.replies.tick();
    const read = f.replies.read(f.p, { watch_id: w.id });
    assert.equal(read.replies.length, 1);
    assert.equal(Date.parse(read.watch.expires_at), f.now() + 30000);
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

test("a reconsidered uncertain reply gets a new event beyond an already-read cursor", async () => {
  const f = fixture(async (c) => ({
    results: c.candidates.map((m) => ({
      message_id: m.id,
      revision: m.revision,
      label: m.text === "maybe" ? "uncertain" : "relevant",
      reason: "Synthetic judgement",
    })),
  }));
  try {
    const w = await f.create();
    f.advance();
    const uncertain = f.ingest("maybe");
    f.ingest("done with records");
    await f.replies.tick();
    const first = f.replies.read(f.p, { watch_id: w.id });
    assert.equal(first.replies.length, 1);
    f.replies.read(f.p, { watch_id: w.id, ack_through: first.next_cursor });
    await f.replies.tick();
    const second = f.replies.read(f.p, {
      watch_id: w.id,
      after: first.next_cursor,
    });
    assert.equal(second.replies.length, 1);
    assert.equal(second.replies[0]?.message?.id, uncertain.id);
    assert.equal(second.replies[0]?.label, "possible");
    assert.ok(second.next_cursor > first.next_cursor);
    assert.equal(
      f.contexts.length,
      1,
      "unchanged context must not launch the classifier twice",
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

test("same-second fast replies survive millisecond send arming and prepared watches never resurrect after expiry", async () => {
  const f = fixture();
  try {
    const service = new Service(
      f.store,
      {
        connected: true,
        ownerIds: [],
        send: async () => {
          f.ingest("done with records", {
            at: Math.floor(f.now() / 1000) * 1000,
          });
          return "sent";
        },
      },
      f.replies,
    );
    const d = service.createDraft(f.p, {
      chat_id: f.chat.id,
      text: "records",
      request_id: "fast",
    });
    const w = await f.create({
      message_ids: undefined,
      draft_ids: [d.id],
      timeout_seconds: 5,
    });
    f.advance(700);
    await service.sendDraft(f.p, d.id, d.digest, f.chat.name, d.input.text, []);
    await f.replies.tick();
    assert.equal(f.replies.read(f.p, { watch_id: w.id }).replies.length, 1);
    const d2 = service.createDraft(f.p, {
      chat_id: f.chat.id,
      text: "records",
      request_id: "late",
    });
    const late = await f.create({
      message_ids: undefined,
      draft_ids: [d2.id],
      timeout_seconds: 1,
    });
    f.advance(1001);
    f.replies.armDraft(d2.id);
    assert.equal(
      f.replies.read(f.p, { watch_id: late.id }).watch.state,
      "expired",
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
