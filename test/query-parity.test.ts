import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Store, hash, opaque } from "../src/store.js";
import { Service } from "../src/service.js";
import {
  BridgeError,
  querySchema,
  type Query,
  type Message,
  type Principal,
} from "../src/domain.js";
const cursorSchema = z.object({
  offset: z.number(),
  watermark: z.string(),
  binding: z.string(),
});
// Frozen previous reader is the differential oracle for compatibility of combined filters.
class PreviousReader extends Service {
  allowed(p: Principal) {
    return this.store.clients().some((c) => c.id === p.id && c.enabled)
      ? this.store.chats().map((c) => c.id)
      : [];
  }

  read(p: Principal, input: unknown) {
    this.store.expire();
    const q = querySchema.parse(input);
    const allowed = this.allowed(p);
    for (const id of q.chat_ids ?? []) this.store.authorize(p, id);
    const selection = q.chat_ids ?? allowed;
    const binding = hash(
      JSON.stringify({ ...q, page: undefined }) +
        p.id +
        JSON.stringify(allowed),
    );
    const cursor = q.page
      ? cursorSchema.parse(
          JSON.parse(Buffer.from(q.page, "base64url").toString()),
        )
      : { offset: 0, watermark: new Date().toISOString(), binding };
    if (cursor.binding !== binding)
      throw new BridgeError(
        "invalid_argument",
        "Pagination scope or query changed",
      );
    for (const range of [q.sent_at, q.observed_at])
      if (range && Date.parse(range.from) >= Date.parse(range.to))
        throw new BridgeError("invalid_argument", "Time range must increase");
    const rangeMatch = (value: string | null, range: Query["sent_at"]) =>
      !range ||
      (value !== null &&
        Date.parse(value) >= Date.parse(range.from) &&
        Date.parse(value) < Date.parse(range.to));
    const matches = this.store.messages(selection).filter((m) => {
      if (
        m.observedAt > cursor.watermark ||
        (!q.include_tombstones && m.deleted)
      )
        return false;
      if (
        q.changed_since &&
        Date.parse(m.updatedAt ?? m.observedAt) < Date.parse(q.changed_since)
      )
        return false;
      if (q.chat_type && this.store.chat(m.chatId).type !== q.chat_type)
        return false;
      if (
        !rangeMatch(m.sentAt, q.sent_at) ||
        !rangeMatch(m.observedAt, q.observed_at)
      )
        return false;
      if (
        (q.sender_ids &&
          !q.sender_ids.some((id) =>
            this.store.equivalents(id).has(m.senderId),
          )) ||
        (q.direction && q.direction !== m.direction)
      )
        return false;
      if (
        (q.content_types && !q.content_types.includes(m.contentType)) ||
        (q.has_attachment !== undefined &&
          q.has_attachment !== Boolean(m.attachmentId))
      )
        return false;
      if (
        q.has_link !== undefined &&
        q.has_link !== /https?:\/\/\S+/i.test(m.text)
      )
        return false;
      if (
        q.mention_ids &&
        !q.mention_ids.some((id) =>
          m.mentions.some((mention) => this.store.equivalents(id).has(mention)),
        )
      )
        return false;
      const mine = m.mentions.some((id) =>
        this.sender.ownerIds.some((owner) =>
          this.store.equivalents(owner).has(id),
        ),
      );
      if (q.mentions_me !== undefined && q.mentions_me !== mine) return false;
      if (q.reply_to_ids && (!m.replyId || !q.reply_to_ids.includes(m.replyId)))
        return false;
      if (
        q.query &&
        !m.text.toLocaleLowerCase().includes(q.query.toLocaleLowerCase())
      )
        return false;
      if (
        q.match_any &&
        !q.match_any.some(
          (v) =>
            (v.mentions_me && mine) ||
            (v.reply_to_ids &&
              m.replyId &&
              v.reply_to_ids.includes(m.replyId)) ||
            (v.query &&
              m.text.toLocaleLowerCase().includes(v.query.toLocaleLowerCase())),
        )
      )
        return false;
      return true;
    });
    matches.sort((a, b) => {
      const compare =
        (a.sentAt ?? a.observedAt).localeCompare(b.sentAt ?? b.observedAt) ||
        a.id.localeCompare(b.id);
      return q.order === "oldest_first" ? compare : -compare;
    });
    const items = matches.slice(cursor.offset, cursor.offset + q.limit);
    const offset = cursor.offset + items.length;
    return {
      schema_version: 1,
      messages: items,
      next_page:
        offset < matches.length
          ? Buffer.from(JSON.stringify({ ...cursor, offset })).toString(
              "base64url",
            )
          : null,
      coverage: this.coverage(),
    };
  }
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "wa-query-"));
  const store = new Store(dir);
  const p: Principal = {
    id: "agent",
    name: "Agent",
    tokenHash: hash("key"),
    enabled: true,
    canDraft: true,
    canSend: false,
  };
  store.put("client", p.id, p);
  const chats = [
    store.saveChat("11@s.whatsapp.net", "Client"),
    store.saveChat("22@g.us", "Group"),
  ];
  const sender = {
    connected: true,
    ownerIds: ["me"],
    send: async () => {
      throw new Error("must not send");
    },
  };
  const service = new Service(store, sender),
    previous = new PreviousReader(store, sender);
  for (let i = 0; i < 160; i++) {
    const id = `message_${String(i).padStart(4, "0")}`;
    store.saveMessage({
      id,
      chatId: chats[i % 2]!.id,
      providerId: id,
      senderId: i % 3 ? "person" : "me",
      senderName: "person",
      direction: i % 3 ? "incoming" : "outgoing",
      sentAt:
        i % 11 ? new Date(Date.UTC(2026, 9, 5, 0, i)).toISOString() : null,
      observedAt: new Date(Date.UTC(2026, 9, 5, 0, i, 5)).toISOString(),
      editedAt: null,
      updatedAt: i % 5 ? null : "2026-10-06T00:00:00Z",
      text: [
        "DNS records 100%_ ready",
        "Ärger नमस्ते HELLO",
        "https://example.com/path",
        "plain reply",
      ][i % 4]!,
      contentType: i % 7 ? "text" : "image",
      mentions: i % 5 ? [] : ["me", "other"],
      replyId: i % 9 ? null : "anchor",
      deleted: i % 13 === 0,
      source: "history",
      attachmentId: i % 7 ? null : "attachment",
      expiresAt: null,
    });
  }
  return {
    store,
    p,
    chats,
    service,
    previous,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("SQL query results match previous reader across filters, Unicode literals, offsets and every page", () => {
  const f = fixture();
  try {
    const filters: Record<string, unknown>[] = [
      {},
      { query: "dns" },
      { query: "%_" },
      { query: "ÄRGER" },
      { query: "नमस्ते" },
      { direction: "outgoing" },
      { chat_type: "group" },
      { chat_ids: [f.chats[0]!.id] },
      { chat_ids: [] },
      { sender_ids: ["me"] },
      { sender_ids: [] },
      { mention_ids: ["other"] },
      { mention_ids: [] },
      { mentions_me: true },
      { mentions_me: false },
      { has_link: true },
      { has_link: false },
      { has_attachment: true },
      { has_attachment: false },
      { content_types: ["image"] },
      { content_types: [] },
      { reply_to_ids: ["anchor"] },
      { reply_to_ids: [] },
      { include_tombstones: true },
      { changed_since: "2026-10-06T05:30:00+05:30" },
      {
        sent_at: {
          from: "2026-10-05T06:00:00+05:30",
          to: "2026-10-05T07:00:00+05:30",
        },
      },
      {
        observed_at: {
          from: "2026-10-05T00:10:00Z",
          to: "2026-10-05T00:30:00Z",
        },
      },
      {
        match_any: [
          { mentions_me: true },
          { query: "dns" },
          { reply_to_ids: ["anchor"] },
        ],
      },
      { match_any: [] },
      { match_any: [{ query: "" }] },
      { match_any: [{ reply_to_ids: [] }] },
    ];
    const cases = [
      ...filters,
      ...filters.flatMap((q, i) =>
        filters
          .slice(i + 1)
          .filter((_, j) => j % 5 === 0)
          .map((other) => ({ ...q, ...other })),
      ),
    ];
    for (const filter of cases) {
      for (const order of ["oldest_first", "newest_first"]) {
        let page: string | undefined, legacyPage: string | undefined;
        do {
          const actual = f.service.read(f.p, {
            ...filter,
            order,
            limit: 7,
            page,
          });
          const expected = f.previous.read(f.p, {
            ...filter,
            order,
            limit: 7,
            page: legacyPage,
          });
          assert.deepEqual(
            actual.messages,
            expected.messages,
            JSON.stringify({ filter, order, page }),
          );
          assert.equal(Boolean(actual.next_page), Boolean(expected.next_page));
          page = actual.next_page ?? undefined;
          legacyPage = expected.next_page ?? undefined;
        } while (page);
      }
    }
  } finally {
    f.close();
  }
});
test("reads and context use bounded SQL, and keyset pagination does not repeat messages after an earlier message arrives", () => {
  const f = fixture();
  try {
    f.store.messages = () => {
      throw new Error("full-chat materialization is forbidden");
    };
    const first = f.service.read(f.p, { order: "oldest_first", limit: 5 });
    assert.equal(first.messages.length, 5);
    const anchor = first.messages[2]!;
    assert.equal(
      f.service.context(f.p, anchor.chatId, anchor.id, 1, 1).messages.length,
      3,
    );
    f.store.saveMessage({
      ...anchor,
      id: "message_0000a",
      providerId: "late",
      sentAt: "2026-10-04T00:00:00Z",
    });
    const next = f.service.read(f.p, {
      order: "oldest_first",
      limit: 5,
      page: first.next_page,
    });
    assert.equal(
      next.messages.some((m) =>
        first.messages.some((prior) => prior.id === m.id),
      ),
      false,
    );
    const plan = f.store.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT value FROM messages WHERE chat=? ORDER BY coalesce(sent,observed),id LIMIT 5",
      )
      .all(anchor.chatId);
    assert.ok(
      plan.some((row) => String(row.detail).includes("messages_chat_time")),
    );
  } finally {
    f.close();
  }
});
test("unrelated new chats do not invalidate either explicit-chat or all-chat cursors; revoked principals cannot continue", () => {
  const f = fixture();
  try {
    for (const chat_ids of [undefined, [f.chats[0]!.id]]) {
      const q = { chat_ids, limit: 3, order: "oldest_first" as const };
      const first = f.service.read(f.p, q);
      f.store.saveChat(
        `new-${chat_ids ? "single" : "all"}@s.whatsapp.net`,
        "Unrelated",
      );
      const second = f.service.read(f.p, { ...q, page: first.next_page });
      assert.equal(second.messages.length, 3);
      assert.equal(
        second.messages.some((m) => first.messages.some((a) => a.id === m.id)),
        false,
      );
      assert.throws(() =>
        f.service.read(f.p, { ...q, query: "changed", page: first.next_page }),
      );
      f.store.put("client", f.p.id, { ...f.p, enabled: false });
      assert.throws(
        () => f.service.read(f.p, { ...q, page: first.next_page }),
        /not_found_or_not_permitted/,
      );
      f.store.put("client", f.p.id, f.p);
    }
  } finally {
    f.close();
  }
});
test("actual production query builder avoids temporary sorts for global, single and multiple chats including continuation pages", () => {
  const f = fixture();
  try {
    f.store.chats = () => {
      throw Error("read must not enumerate chats");
    };
    const cases = [
      {},
      { chat_ids: [f.chats[0]!.id] },
      { chat_ids: f.chats.map((c) => c.id) },
      { query: "dns" },
      { direction: "outgoing", mentions_me: false },
    ];
    for (const input of cases) {
      const q = querySchema.parse({ ...input, limit: 5 });
      const first = f.service.read(f.p, q);
      for (const after of [
        undefined,
        first.messages.at(-1)
          ? {
              time:
                first.messages.at(-1)!.sentAt ??
                first.messages.at(-1)!.observedAt,
              id: first.messages.at(-1)!.id,
            }
          : undefined,
      ]) {
        const { sql, args } = f.store.messageQuery(
          q.chat_ids,
          q,
          f.service.sender.ownerIds,
          new Date().toISOString(),
          0,
          after,
        );
        const plan = f.store.db
          .prepare("EXPLAIN QUERY PLAN " + sql)
          .all(...args)
          .map((r) => String(r.detail));
        assert.equal(
          plan.some((line) => line.includes("TEMP B-TREE")),
          false,
          plan.join("\n"),
        );
        if (after)
          assert.ok(
            plan.some((line) => line.includes("SEARCH messages USING INDEX")),
            plan.join("\n"),
          );
        assert.ok(
          plan.some((line) =>
            line.includes(
              input.chat_ids?.length === 1
                ? "messages_chat_time"
                : "messages_time",
            ),
          ),
          plan.join("\n"),
        );
        assert.ok(f.store.db.prepare(sql).all(...args).length <= 6);
      }
    }
  } finally {
    f.close();
  }
});
