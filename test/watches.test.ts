import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, hash } from "../src/store.js";
import { Watches, deliver } from "../src/watches.js";
import { readInput } from "../src/mcp.js";
import type { Message } from "../src/domain.js";
const thread = "01234567-1234-4123-8123-123456789abc";
function fixture(group = false) {
  const dir = mkdtempSync(join(tmpdir(), "wa-watch-")),
    store = new Store(dir),
    chat = store.saveChat(
      group ? "111@g.us" : "111@s.whatsapp.net",
      group ? "Group" : "Person",
    );
  let now = Date.parse("2026-11-02T10:00:00Z");
  const notices: string[] = [];
  const p = {
    id: "agent",
    name: "Agent",
    enabled: true,
    canDraft: true,
    canSend: true,
    tokenHash: hash("key"),
  };
  store.put("client", p.id, p);
  const sender = { connected: true, ownerIds: ["me"], send: async () => "" };
  const watches = new Watches(store, sender, {
    now: () => now,
    deliver: async (_, notice) => {
      notices.push(notice);
    },
  });
  const message = (id: string, extra: Partial<Message> = {}) => {
    const m: Message = {
      id,
      chatId: chat.id,
      providerId: id,
      senderId: "person",
      senderName: "Sensitive Person",
      direction: "incoming",
      sentAt: new Date(now).toISOString(),
      observedAt: new Date(now).toISOString(),
      updatedAt: null,
      editedAt: null,
      text: "secret message content",
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
  const watch = (extra = {}) =>
    watches.create(p, {
      chat_id: chat.id,
      codex_thread_id: thread,
      ...extra,
    });
  return {
    dir,
    store,
    chat,
    p,
    sender,
    watches,
    notices,
    message,
    watch,
    advance: (ms: number) => (now += ms),
    tick: () => watches.tick(),
    now: () => now,
    close: async () => {
      await watches.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("watch catches pre-subscription replies, coalesces and emits only a schema-valid content-free pointer", async () => {
  const f = fixture();
  try {
    f.message("own", { direction: "outgoing" });
    f.advance(1000);
    f.message("a");
    const w = f.watch();
    await f.tick();
    f.advance(3000);
    f.message("b");
    await f.tick();
    f.advance(9999);
    await f.tick();
    assert.equal(f.notices.length, 0);
    f.advance(1);
    await f.tick();
    assert.equal(f.notices.length, 1);
    assert.match(f.notices[0], /2 new message\(s\)/);
    assert.ok(!f.notices[0].includes("secret"));
    assert.ok(!f.notices[0].includes("Sensitive"));
    const args = JSON.parse(
      f.notices[0]
        .split("Read: read_messages ")[1]
        .split(". Message content")[0],
    );
    assert.ok(readInput.safeParse(args).success);
    assert.equal(args.chat_ids[0], f.chat.id);
    assert.equal(w.target, `codex:${thread}`);
    f.advance(10000);
    await f.tick();
    assert.equal(f.notices.length, 1);
  } finally {
    await f.close();
  }
});
test("watch requires a usable target, named group sender and enforces per-key limit", async () => {
  const f = fixture(true);
  try {
    assert.throws(
      () => f.watches.create(f.p, { chat_id: f.chat.id }),
      /pass codex_thread_id/,
    );
    const w = f.watch({ from_participant_ids: ["allowed"] });
    f.message("ignored");
    f.message("reaction", { senderId: "allowed", contentType: "reaction" });
    await f.tick();
    f.advance(10000);
    await f.tick();
    assert.equal(f.notices.length, 0);
    f.message("yes", { senderId: "allowed" });
    await f.tick();
    f.advance(10000);
    await f.tick();
    assert.equal(f.notices.length, 1);
    f.watches.unwatch(f.p, w.watch_id);
    f.watches.unwatch(f.p, w.watch_id);
    assert.equal(
      f.store.db
        .prepare("SELECT target FROM watches WHERE id=?")
        .get(w.watch_id)?.target,
      null,
    );
    for (let i = 0; i < 20; i++) f.watch();
    assert.throws(() => f.watch(), /20 active/);
  } finally {
    await f.close();
  }
});
test("delivery retries at 5, 30, 120 seconds then becomes undeliverable and erases target", async () => {
  const f = fixture();
  let calls = 0;
  const watches = new Watches(f.store, f.sender, {
    now: f.now,
    deliver: async () => {
      calls++;
      throw Error("offline");
    },
  });
  try {
    const w = watches.create(f.p, {
      chat_id: f.chat.id,
      codex_thread_id: thread,
    });
    f.store.db
      .prepare("INSERT INTO watch_handled VALUES(?,?,?)")
      .run(w.watch_id, "previously-delivered", new Date(f.now()).toISOString());
    f.message("a");
    await watches.tick();
    f.advance(10000);
    await watches.tick();
    assert.equal(calls, 1);
    for (const [delay, count] of [
      [5000, 2],
      [30000, 3],
      [120000, 4],
    ]) {
      f.advance(delay - 1);
      await watches.tick();
      assert.equal(calls, count - 1);
      f.advance(1);
      await watches.tick();
      assert.equal(calls, count);
    }
    const row = f.store.db
      .prepare("SELECT state,target FROM watches WHERE id=?")
      .get(w.watch_id)!;
    assert.equal(
      f.store.db
        .prepare("SELECT count(*) n FROM watch_handled WHERE watch_id=?")
        .get(w.watch_id)?.n,
      0,
    );
    assert.equal(row.state, "undeliverable");
    assert.equal(row.target, null);
  } finally {
    await watches.close();
    await f.close();
  }
});
test("active watch reloads after restart with sender routing retained; expiry clears secrets and other principals cannot cancel", async () => {
  const f = fixture(true);
  let restarted: Watches | undefined;
  try {
    const w = f.watch({
      timeout_seconds: 30,
      from_participant_ids: ["person"],
    });
    await f.watches.close();
    restarted = new Watches(f.store, f.sender, {
      now: f.now,
      deliver: async (_, n) => {
        f.notices.push(n);
      },
    });
    assert.equal(restarted.status(f.p.id).length, 1);
    f.message("a");
    await restarted.tick();
    f.advance(10000);
    await restarted.tick();
    assert.equal(f.notices.length, 1);
    assert.equal(
      f.store.db
        .prepare("SELECT count(*) n FROM watch_handled WHERE watch_id=?")
        .get(w.watch_id)?.n,
      1,
    );
    const other = { ...f.p, id: "other" };
    f.store.put("client", "other", other);
    assert.throws(() => restarted!.unwatch(other, w.watch_id));
    f.advance(20000);
    await restarted.tick();
    assert.equal(
      f.store.db.prepare("SELECT state FROM watches WHERE id=?").get(w.watch_id)
        ?.state,
      "expired",
    );
    assert.equal(
      f.store.db
        .prepare("SELECT count(*) n FROM watch_handled WHERE watch_id=?")
        .get(w.watch_id)?.n,
      0,
    );
    assert.equal(
      f.store.db
        .prepare("SELECT target FROM watches WHERE id=?")
        .get(w.watch_id)?.target,
      null,
    );
  } finally {
    await restarted?.close();
    await f.close();
  }
});
test("native Claude delivery writes exactly auth and user JSON lines to a Unix socket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wa-sock-")),
    socket = join(dir, "s");
  let data = "";
  let done = () => {};
  const received = new Promise<void>((r) => (done = r));
  const server = createServer((s) => {
    s.on("data", (b) => (data += b));
    s.on("end", () => {
      s.end();
      done();
    });
  });
  await new Promise<void>((r) => server.listen(socket, r));
  try {
    await deliver(
      {
        kind: "claude",
        socket,
        token: "fixture-token",
        session_id: thread,
      },
      "pointer",
      AbortSignal.timeout(3000),
    );
    await received;
    assert.equal(
      data,
      JSON.stringify({ type: "auth", token: "fixture-token" }) +
        "\n" +
        JSON.stringify({
          type: "user",
          message: { role: "user", content: "pointer" },
        }) +
        "\n",
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  }
});
test("Codex delivery finds a fake executable on PATH and forwards thread/message without shell interpolation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wa-codex-")),
    command = join(dir, "codex"),
    audit = join(dir, "args");
  const old = process.env.PATH;
  writeFileSync(
    command,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(audit)},JSON.stringify(process.argv.slice(2)));`,
    { mode: 0o700 },
  );
  try {
    process.env.PATH = dir;
    await deliver(
      { kind: "codex", thread_id: thread },
      "$(echo data) `literal`",
      AbortSignal.timeout(3000),
    );
    assert.deepEqual(JSON.parse(readFileSync(audit, "utf8")), [
      "queue",
      "--thread",
      thread,
      "--message",
      "$(echo data) `literal`",
    ]);
  } finally {
    process.env.PATH = old;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("same-timestamp batches handle every message exactly once", async () => {
  const f = fixture();
  try {
    const w = f.watch();
    for (let i = 0; i < 65; i++) f.message("m" + String(i).padStart(2, "0"));
    await f.tick();
    f.advance(10000);
    await f.tick();
    assert.equal(f.notices.length, 1);
    assert.match(f.notices[0], /65 new/);
    assert.equal(
      f.store.db
        .prepare("SELECT count(*) n FROM watch_handled WHERE watch_id=?")
        .get(w.watch_id)?.n,
      65,
    );
    await f.tick();
    f.advance(10000);
    await f.tick();
    assert.equal(f.notices.length, 1);
  } finally {
    await f.close();
  }
});

test("edited replies before registration and within the quiet window notify once, later edits do not retrigger", async () => {
  const f = fixture();
  try {
    f.message("out", { direction: "outgoing" });
    f.advance(1000);
    const a = f.message("a");
    f.store.saveMessage({
      ...a,
      text: "fixed typo",
      editedAt: new Date(f.now()).toISOString(),
    });
    f.watch();
    await f.tick();
    f.advance(3000);
    const b = f.message("b");
    await f.tick();
    f.advance(3000);
    f.store.saveMessage({
      ...b,
      text: "also fixed",
      editedAt: new Date(f.now()).toISOString(),
    });
    await f.tick();
    f.advance(7000);
    await f.tick();
    assert.equal(f.notices.length, 1);
    assert.match(f.notices[0], /2 new/);
    f.store.saveMessage({
      ...b,
      text: "later edit",
      editedAt: new Date(f.now()).toISOString(),
    });
    await f.tick();
    f.advance(10000);
    await f.tick();
    assert.equal(f.notices.length, 1);
  } finally {
    await f.close();
  }
});
test("since offsets and omitted milliseconds normalize to the same UTC window and reject invalid timestamps", async () => {
  const f = fixture();
  try {
    f.message("before", { sentAt: "2026-11-02T09:59:59.999Z" });
    f.message("equal", { sentAt: "2026-11-02T10:00:00.000Z" });
    for (const since of ["2026-11-02T15:30:00+05:30", "2026-11-02T10:00:00Z"]) {
      const w = f.watch({ since });
      assert.equal(w.since, "2026-11-02T10:00:00.000Z");
    }
    assert.throws(() => f.watch({ since: "not-a-date" }));
    assert.throws(() => f.watch({ since: "2026-02-30T10:00:00Z" }));
    await f.tick();
    f.advance(10000);
    await f.tick();
    assert.equal(f.notices.length, 2);
    for (const notice of f.notices) assert.match(notice, /1 new/);
  } finally {
    await f.close();
  }
});
test("non-delivery processing errors preserve active watch and retry next tick", async () => {
  const f = fixture();
  const chat = f.store.chat.bind(f.store);
  try {
    const w = f.watch();
    f.message("a");
    await f.tick();
    f.advance(10000);
    let fail = true;
    f.store.chat = (id) => {
      if (fail) {
        fail = false;
        throw Error("synthetic processing error");
      }
      return chat(id);
    };
    await f.tick();
    assert.equal(
      f.store.db.prepare("SELECT state FROM watches WHERE id=?").get(w.watch_id)
        ?.state,
      "active",
    );
    assert.equal(f.notices.length, 0);
    await f.tick();
    assert.equal(f.notices.length, 1);
  } finally {
    f.store.chat = chat;
    await f.close();
  }
});
test("unwatch preserves expired and undeliverable terminal states and stays idempotent", async () => {
  const f = fixture();
  try {
    for (const state of ["expired", "undeliverable"]) {
      const w = f.watch();
      f.store.db
        .prepare("UPDATE watches SET state=?,target=NULL WHERE id=?")
        .run(state, w.watch_id);
      assert.equal(f.watches.unwatch(f.p, w.watch_id).state, state);
      assert.equal(f.watches.unwatch(f.p, w.watch_id).state, state);
      assert.equal(
        f.store.db
          .prepare("SELECT state FROM watches WHERE id=?")
          .get(w.watch_id)?.state,
        state,
      );
    }
  } finally {
    await f.close();
  }
});

test("existing watches retain routing and handled IDs while obsolete AI fields are removed", async () => {
  const f = fixture(true);
  let upgraded: Watches | undefined;
  try {
    const w = f.watch();
    await f.watches.close();
    const target = JSON.parse(
      String(
        f.store.db
          .prepare("SELECT target FROM watches WHERE id=?")
          .get(w.watch_id)?.target,
      ),
    );
    f.store.db
      .prepare("UPDATE watches SET target=? WHERE id=?")
      .run(JSON.stringify({ ...target, calls: 7 }), w.watch_id);
    f.store.db.exec(
      "ALTER TABLE watches ADD COLUMN waiting_for TEXT NOT NULL DEFAULT ''; ALTER TABLE watches ADD COLUMN calls INTEGER NOT NULL DEFAULT 0; ALTER TABLE watches ADD COLUMN last_notified_sent_at TEXT",
    );
    f.store.db
      .prepare("INSERT INTO watch_handled VALUES(?,?,?)")
      .run(w.watch_id, "earlier", new Date(f.now()).toISOString());
    f.store.put("watch-intent", w.watch_id, "old intent");
    for (let i = 0; i < 2; i++) {
      upgraded = new Watches(f.store, f.sender, {
        now: f.now,
        deliver: async (_, notice) => {
          f.notices.push(notice);
        },
      });
      const columns = f.store.db
        .prepare("PRAGMA table_info(watches)")
        .all()
        .map((c) => c.name);
      for (const field of ["waiting_for", "calls", "last_notified_sent_at"])
        assert.ok(!columns.includes(field));
      assert.equal(upgraded.status(f.p.id)[0]?.target, `codex:${thread}`);
      assert.equal(
        f.store.db
          .prepare("SELECT count(*) n FROM watch_handled WHERE watch_id=?")
          .get(w.watch_id)?.n,
        1,
      );
      assert.equal(f.store.all("watch-intent").length, 0);
      assert.ok(
        !(
          "calls" in
          JSON.parse(
            String(
              f.store.db
                .prepare("SELECT target FROM watches WHERE id=?")
                .get(w.watch_id)?.target,
            ),
          )
        ),
      );
      if (i === 1) {
        f.message("new-reply", { mentions: ["me"] });
        await upgraded.tick();
        f.advance(10000);
        await upgraded.tick();
        assert.equal(f.notices.length, 1);
      }
      await upgraded.close();
    }
  } finally {
    await upgraded?.close();
    await f.close();
  }
});
test("late arrivals sent before the last delivered reply still notify", async () => {
  const f = fixture();
  try {
    const w = f.watch();
    f.advance(5000);
    f.message("newer", { sentAt: "2026-11-02T10:00:05.000Z" });
    await f.tick();
    f.advance(10000);
    await f.tick();
    assert.equal(f.notices.length, 1);
    f.message("late", {
      sentAt: "2026-11-02T10:00:02.000Z",
      source: "history",
    });
    await f.tick();
    f.advance(10000);
    await f.tick();
    assert.equal(f.notices.length, 2);
    assert.ok(f.notices[1].includes("2026-11-02T10:00:02.000Z"));
    assert.equal(
      f.store.db
        .prepare("SELECT count(*) n FROM watch_handled WHERE watch_id=?")
        .get(w.watch_id)?.n,
      2,
    );
  } finally {
    await f.close();
  }
});
test("clean database restart and edits after delivery do not repeat a notice", async () => {
  const f = fixture();
  let reopened: Store | undefined, restarted: Watches | undefined;
  try {
    const w = f.watch();
    const m = f.message("reply");
    await f.tick();
    f.advance(10000);
    await f.tick();
    assert.equal(f.notices.length, 1);
    await f.watches.close();
    f.store.close();
    reopened = new Store(f.dir);
    restarted = new Watches(reopened, f.sender, {
      now: f.now,
      deliver: async (_, n) => {
        f.notices.push(n);
      },
    });
    await restarted.tick();
    f.advance(10000);
    await restarted.tick();
    assert.equal(f.notices.length, 1);
    reopened.saveMessage({
      ...m,
      text: "edited after restart",
      editedAt: new Date(f.now()).toISOString(),
    });
    await restarted.tick();
    f.advance(10000);
    await restarted.tick();
    assert.equal(f.notices.length, 1);
    assert.equal(
      reopened.db
        .prepare("SELECT count(*) n FROM watch_handled WHERE watch_id=?")
        .get(w.watch_id)?.n,
      1,
    );
  } finally {
    await restarted?.close();
    reopened?.close();
    await f.close();
  }
});
test("other group messages are handled immediately and not re-checked across restart", async () => {
  const f = fixture(true);
  let reopened: Store | undefined, restarted: Watches | undefined;
  try {
    const w = f.watch();
    f.message("anchor", { sentAt: "2026-11-02T09:59:59.000Z" });
    f.message("irrelevant", { replyId: "anchor" });
    await f.tick();
    assert.equal(f.notices.length, 0);
    assert.equal(
      f.store.db
        .prepare("SELECT count(*) n FROM watch_handled WHERE watch_id=?")
        .get(w.watch_id)?.n,
      1,
    );
    await f.watches.close();
    f.store.close();
    reopened = new Store(f.dir);
    let checks = 0;
    const find = reopened.findMessage.bind(reopened);
    reopened.findMessage = (id) => {
      checks++;
      return find(id);
    };
    restarted = new Watches(reopened, f.sender, {
      now: f.now,
      deliver: async (_, n) => {
        f.notices.push(n);
      },
    });
    await restarted.tick();
    f.advance(10000);
    await restarted.tick();
    assert.equal(checks, 0);
    assert.equal(f.notices.length, 0);
    assert.equal(
      reopened.db
        .prepare("SELECT count(*) n FROM watch_handled WHERE watch_id=?")
        .get(w.watch_id)?.n,
      1,
    );
  } finally {
    await restarted?.close();
    reopened?.close();
    await f.close();
  }
});
test("handled canonical identities survive duplicate message merging and watch end cleans handled rows", async () => {
  const f = fixture();
  try {
    const lid = "777@lid",
      pn = "555@s.whatsapp.net";
    const old = f.store.saveChat(lid, "Person");
    const oldId = f.store.messageId(lid, "same");
    f.store.saveChat(pn, "Person");
    const canonical = f.store.messageId(pn, "same");
    f.message(oldId, { chatId: old.id, providerId: "same" });
    f.message(canonical, {
      chatId: f.store.saveChat(pn, "Person").id,
      providerId: "same",
    });
    const w = f.watches.create(f.p, {
      chat_id: old.id,
      codex_thread_id: thread,
    });
    await f.tick();
    f.advance(10000);
    await f.tick();
    assert.equal(f.notices.length, 1);
    f.store.addAlias(lid, pn);
    await f.tick();
    f.advance(10000);
    await f.tick();
    assert.equal(f.notices.length, 1);
    assert.equal(f.store.message(oldId).id, canonical);
    f.watches.unwatch(f.p, w.watch_id);
    assert.equal(
      f.store.db
        .prepare("SELECT count(*) n FROM watch_handled WHERE watch_id=?")
        .get(w.watch_id)?.n,
      0,
    );
  } finally {
    await f.close();
  }
});
test("failed delivery leaves relevant messages unhandled until a retry succeeds", async () => {
  const f = fixture();
  let attempts = 0;
  const watches = new Watches(f.store, f.sender, {
    now: f.now,
    deliver: async () => {
      if (++attempts === 1) throw Error("retry");
    },
  });
  try {
    const w = watches.create(f.p, {
      chat_id: f.chat.id,
      codex_thread_id: thread,
    });
    f.message("reply");
    await watches.tick();
    f.advance(10000);
    await watches.tick();
    assert.equal(
      f.store.db
        .prepare("SELECT count(*) n FROM watch_handled WHERE watch_id=?")
        .get(w.watch_id)?.n,
      0,
    );
    f.advance(5000);
    await watches.tick();
    assert.equal(
      f.store.db
        .prepare("SELECT count(*) n FROM watch_handled WHERE watch_id=?")
        .get(w.watch_id)?.n,
      1,
    );
  } finally {
    await watches.close();
    await f.close();
  }
});

test("group quote, owner mention and named sender each notify without an AI layer", async () => {
  for (const kind of ["quote", "mention", "sender"]) {
    const f = fixture(true);
    try {
      f.message("owner", { direction: "outgoing" });
      f.watch(kind === "sender" ? { from_participant_ids: ["person"] } : {});
      f.message(
        "reply",
        kind === "quote"
          ? { replyId: "owner" }
          : kind === "mention"
            ? { mentions: ["me"] }
            : {},
      );
      await f.tick();
      f.advance(10000);
      await f.tick();
      assert.equal(f.notices.length, 1, kind);
      assert.match(f.notices[0], /1 new/);
    } finally {
      await f.close();
    }
  }
});
test("group matching is a union: unlisted sender quotes or mentions still notify", async () => {
  const f = fixture(true);
  try {
    f.message("owner", { direction: "outgoing" });
    const w = f.watch({ from_participant_ids: ["A"] });
    f.message("quoteB", { senderId: "B", replyId: "owner" });
    f.message("mentionB", { senderId: "B", mentions: ["me"] });
    f.message("senderA", { senderId: "A" });
    f.message("otherB", { senderId: "B" });
    await f.tick();
    assert.equal(
      f.store.db
        .prepare("SELECT count(*) n FROM watch_handled WHERE watch_id=?")
        .get(w.watch_id)?.n,
      1,
    );
    f.advance(10000);
    await f.tick();
    assert.equal(f.notices.length, 1);
    assert.match(f.notices[0], /3 new/);
  } finally {
    await f.close();
  }
});
test("direct chats count every message even with a different named sender configured", async () => {
  const f = fixture();
  try {
    f.watch({ from_participant_ids: ["different"] });
    f.message("reply");
    await f.tick();
    f.advance(10000);
    await f.tick();
    assert.equal(f.notices.length, 1);
  } finally {
    await f.close();
  }
});
