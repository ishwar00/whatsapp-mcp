import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, hash } from "../src/store.js";
import { Watches, deliver } from "../src/watches.js";
import { classifierConfig } from "../src/reply-classifier.js";
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
  const runner = join(dir, "runner.mjs"),
    audit = join(dir, "audit.json");
  const script = (output: unknown, fail = false) =>
    writeFileSync(
      runner,
      `#!${process.execPath}\nimport{readFileSync,writeFileSync}from'node:fs';const data=JSON.parse(readFileSync(0,'utf8'));writeFileSync(${JSON.stringify(audit)},JSON.stringify(data));${fail ? "process.exit(1);" : `console.log(JSON.stringify({structured_output:${JSON.stringify(output)}}));`}`,
      { mode: 0o700 },
    );
  script({ relevant_ids: [] });
  const config = classifierConfig.parse({ executable: runner });
  const watches = new Watches(store, sender, config, {
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
      ...(group ? { waiting_for: "DNS records" } : {}),
      ...extra,
    });
  return {
    dir,
    store,
    chat,
    p,
    sender,
    watches,
    config,
    notices,
    message,
    watch,
    script,
    audit,
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
test("watch requires a usable target, group intent, sender scope and enforces per-key limit", async () => {
  const f = fixture(true);
  try {
    assert.throws(
      () => f.watches.create(f.p, { chat_id: f.chat.id, waiting_for: "x" }),
      /pass codex_thread_id/,
    );
    assert.throws(
      () =>
        f.watches.create(f.p, { chat_id: f.chat.id, codex_thread_id: thread }),
      /waiting_for/,
    );
    const w = f.watch({ from_participant_ids: ["allowed"] });
    f.message("ignored");
    f.message("reaction", { senderId: "allowed", contentType: "reaction" });
    f.message("edited", {
      senderId: "allowed",
      editedAt: new Date(f.now()).toISOString(),
    });
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
test("group relevance calls isolate a bounded batch, discard invented IDs, skip unrelated and fail toward waking", async () => {
  const f = fixture(true);
  try {
    f.message("out", { direction: "outgoing", text: "add DNS records" });
    const w = f.watch();
    f.message("a", { text: "done" });
    f.message("b", { text: "unrelated" });
    f.script({ relevant_ids: ["a", "invented"] });
    await f.tick();
    f.advance(10000);
    await f.tick();
    assert.equal(f.notices.length, 1);
    assert.match(f.notices[0], /1 new/);
    const input = JSON.parse(readFileSync(f.audit, "utf8"));
    assert.equal(input.waiting_for, "DNS records");
    assert.equal(input.outgoing, "add DNS records");
    assert.equal(input.messages.length, 2);
    f.advance(1000);
    f.message("c");
    f.script({ relevant_ids: [] });
    await f.tick();
    f.advance(10000);
    await f.tick();
    assert.equal(f.notices.length, 1);
    f.advance(1000);
    f.message("d");
    f.script(null, true);
    await f.tick();
    f.advance(10000);
    await f.tick();
    assert.equal(f.notices.length, 2);
    const row = f.store.db
      .prepare("SELECT target FROM watches WHERE id=?")
      .get(w.watch_id)!;
    assert.equal(JSON.parse(String(row.target)).calls, 3);
  } finally {
    await f.close();
  }
});
test("quoted outgoing replies, owner mentions and sender filter bypass group relevance; cap 50 fails toward waking", async () => {
  const f = fixture(true);
  try {
    f.message("out", { direction: "outgoing" });
    const w = f.watch();
    f.message("quote", { replyId: "out" });
    f.message("mention", { mentions: ["me"] });
    f.script(null, true);
    await f.tick();
    f.advance(10000);
    await f.tick();
    assert.equal(f.notices.length, 1);
    assert.match(f.notices[0], /2 new/);
    let row = f.store.db
      .prepare("SELECT target FROM watches WHERE id=?")
      .get(w.watch_id)!;
    assert.equal(JSON.parse(String(row.target)).calls, 0);
    const t = JSON.parse(String(row.target));
    t.calls = 50;
    f.store.db
      .prepare("UPDATE watches SET target=? WHERE id=?")
      .run(JSON.stringify(t), w.watch_id);
    f.advance(1000);
    f.message("budget");
    await f.tick();
    f.advance(10000);
    await f.tick();
    assert.equal(f.notices.length, 2);
    row = f.store.db
      .prepare("SELECT target FROM watches WHERE id=?")
      .get(w.watch_id)!;
    assert.equal(JSON.parse(String(row.target)).calls, 50);
  } finally {
    await f.close();
  }
});
test("delivery retries at 5, 30, 120 seconds then becomes undeliverable and erases target", async () => {
  const f = fixture();
  let calls = 0;
  const watches = new Watches(f.store, f.sender, f.config, {
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
    assert.equal(row.state, "undeliverable");
    assert.equal(row.target, null);
  } finally {
    await watches.close();
    await f.close();
  }
});
test("active watch reloads after restart with intent retained; expiry clears secrets and other principals cannot cancel", async () => {
  const f = fixture(true);
  let restarted: Watches | undefined;
  try {
    const w = f.watch({ timeout_seconds: 30 });
    await f.watches.close();
    restarted = new Watches(f.store, f.sender, f.config, {
      now: f.now,
      deliver: async (_, n) => {
        f.notices.push(n);
      },
    });
    assert.equal(restarted.status(f.p.id).length, 1);
    f.script({ relevant_ids: ["a"] });
    f.message("a");
    await restarted.tick();
    f.advance(10000);
    await restarted.tick();
    assert.equal(f.notices.length, 1);
    assert.equal(
      JSON.parse(readFileSync(f.audit, "utf8")).waiting_for,
      "DNS records",
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
        calls: 0,
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
      { kind: "codex", thread_id: thread, calls: 0 },
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

test("batches over thirty retain same-second messages for the next notice", async () => {
  const f = fixture();
  try {
    f.watch();
    for (let i = 0; i < 31; i++) f.message("m" + String(i).padStart(2, "0"));
    await f.tick();
    f.advance(10000);
    await f.tick();
    assert.match(f.notices[0], /30 new/);
    await f.tick();
    f.advance(10000);
    await f.tick();
    assert.equal(f.notices.length, 2);
    assert.match(f.notices[1], /1 new/);
  } finally {
    await f.close();
  }
});
