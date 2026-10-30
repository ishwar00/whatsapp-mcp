import { MediaStore } from "./media.js";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { BufferJSON } from "@whiskeysockets/baileys";
import {
  BridgeError,
  clientSchema,
  draftSchema,
  messageSchema,
  type Draft,
  type Message,
  type Principal,
  type Query,
} from "./domain.js";
export const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export const opaque = (kind: string, value: string) =>
  `${kind}_${hash(value).slice(0, 32)}`;
export const chatSchema = z.object({
  id: z.string(),
  jid: z.string(),
  name: z.string(),
  type: z.enum(["direct", "group"]),
  updatedAt: z.string(),
});
export type Chat = z.infer<typeof chatSchema>;
const rowSchema = z.object({ value: z.string() });
export class Store {
  db: DatabaseSync;
  private closed = false;
  attachments: MediaStore;
  constructor(public dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    this.db = new DatabaseSync(join(dir, "bridge.sqlite"));
    chmodSync(join(dir, "bridge.sqlite"), 0o600);
    this.db
      .exec(`PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS objects(kind TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(kind,id));
    CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,chat TEXT NOT NULL,observed TEXT NOT NULL,sent TEXT,value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat,observed,id);
    CREATE TABLE IF NOT EXISTS requests(client TEXT,request TEXT,digest TEXT,draft TEXT,PRIMARY KEY(client,request));`);
    try {
      this.attachments = new MediaStore(this.db, dir);
    } catch (error) {
      this.db.close();
      throw error;
    }
    this.db.function("contains_text", { deterministic: true }, (text, query) =>
      String(text ?? "")
        .toLocaleLowerCase()
        .includes(String(query ?? "").toLocaleLowerCase())
        ? 1
        : 0,
    );
    this.db.function("has_link", { deterministic: true }, (text) =>
      /https?:\/\/\S+/i.test(String(text ?? "")) ? 1 : 0,
    );
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS messages_chat_time ON messages(chat,coalesce(sent,observed),id);
      CREATE INDEX IF NOT EXISTS messages_time ON messages(coalesce(sent,observed),id);
      CREATE INDEX IF NOT EXISTS messages_provider ON messages(chat,json_extract(value,'$.providerId'));
      CREATE INDEX IF NOT EXISTS messages_expiry ON messages(json_extract(value,'$.expiresAt')) WHERE json_extract(value,'$.deleted')=0;
    `);
    for (const row of this.db
      .prepare("SELECT id,value FROM objects WHERE kind='alias'")
      .all()) {
      const alias = z.object({ id: z.string(), value: z.string() }).parse(row);
      this.addAlias(alias.id, z.string().parse(JSON.parse(alias.value)));
    }
    this.db.exec(
      "UPDATE objects SET value=json_set(value,'$.status','unknown','$.error','Process stopped during send') WHERE kind='draft' AND json_extract(value,'$.status')='attempting'",
    );
  }
  close() {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  put(kind: string, id: string, value: unknown) {
    this.db
      .prepare(
        "INSERT INTO objects VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value",
      )
      .run(kind, id, JSON.stringify(value, BufferJSON.replacer));
  }
  get(kind: string, id: string): unknown {
    if (kind === "raw") id = this.resolveId("message-alias", id);
    const row = this.db
      .prepare("SELECT value FROM objects WHERE kind=? AND id=?")
      .get(kind, id);
    return row
      ? JSON.parse(rowSchema.parse(row).value, BufferJSON.reviver)
      : undefined;
  }
  all(kind: string): unknown[] {
    return this.db
      .prepare("SELECT value FROM objects WHERE kind=?")
      .all(kind)
      .map((v) => JSON.parse(rowSchema.parse(v).value, BufferJSON.reviver));
  }
  remove(kind: string, id: string) {
    this.db.prepare("DELETE FROM objects WHERE kind=? AND id=?").run(kind, id);
  }
  resolveId(kind: "chat-alias" | "message-alias", id: string) {
    const seen = new Set<string>();
    while (!seen.has(id)) {
      seen.add(id);
      const next = this.get(kind, id);
      if (typeof next !== "string") break;
      id = next;
    }
    return id;
  }
  canonicalJid(jid: string) {
    const pn = jid.endsWith("@lid") ? this.get("alias", jid) : undefined;
    return typeof pn === "string" ? pn : jid;
  }
  chatId(id: string) {
    return this.resolveId("chat-alias", id);
  }
  messageId(jid: string, providerId: string): string {
    jid = this.canonicalJid(jid);
    const row = this.db
      .prepare(
        "SELECT id FROM messages WHERE chat=? AND json_extract(value,'$.providerId')=? LIMIT 1",
      )
      .get(opaque("chat", jid), providerId);
    return row
      ? z.object({ id: z.string() }).parse(row).id
      : opaque("message", `${jid}:${providerId}`);
  }
  chats() {
    return this.all("chat").map((v) => chatSchema.parse(v));
  }
  addAlias(lid: string, pn: string) {
    if (!lid.endsWith("@lid") || !pn.endsWith("@s.whatsapp.net")) return;
    const previous = this.get("alias", lid);
    if (
      previous === pn &&
      this.get("chat-alias", opaque("chat", lid)) === opaque("chat", pn) &&
      !this.get("chat", opaque("chat", lid))
    )
      return;
    if (previous && previous !== pn)
      throw new BridgeError(
        "identity_conflict",
        "Conflicting verified identity mapping",
      );
    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO objects VALUES('alias',?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value",
        )
        .run(lid, JSON.stringify(pn));
      const from = opaque("chat", lid),
        to = opaque("chat", pn);
      const old = this.get("chat", from),
        target = this.get("chat", to);
      if (old) {
        const a = chatSchema.parse(old),
          b = target ? chatSchema.parse(target) : undefined;
        this.put("chat", to, {
          ...(b ?? a),
          id: to,
          jid: pn,
          name:
            b && !/^(Contact name unavailable|\+\d+)$/.test(b.name)
              ? b.name
              : a.name,
          updatedAt: [a.updatedAt, b?.updatedAt ?? ""].sort().at(-1),
        });
      }
      this.put("chat-alias", from, to);
      const lidSender = opaque("participant", lid),
        pnSender = opaque("participant", pn);
      const oldParticipant = this.get("participant", lidSender);
      if (!this.get("participant", pnSender) && oldParticipant)
        this.put("participant", pnSender, {
          ...z.record(z.unknown()).parse(oldParticipant),
          id: pnSender,
          jid: pn,
        });
      this.db
        .prepare(
          `UPDATE messages SET value=json_set(value,'$.senderId',?,'$.updatedAt',?) WHERE json_extract(value,'$.senderId')=?`,
        )
        .run(pnSender, new Date().toISOString(), lidSender);
      this.db
        .prepare(
          `UPDATE messages SET value=json_set(value,'$.mentions',json((SELECT json_group_array(CASE WHEN value=? THEN ? ELSE value END) FROM json_each(messages.value,'$.mentions'))),'$.updatedAt',?) WHERE EXISTS (SELECT 1 FROM json_each(messages.value,'$.mentions') WHERE value=?)`,
        )
        .run(lidSender, pnSender, new Date().toISOString(), lidSender);
      for (const row of this.db
        .prepare("SELECT value FROM messages WHERE chat=?")
        .all(from)) {
        const m = messageSchema.parse(JSON.parse(rowSchema.parse(row).value));
        const duplicate = this.db
          .prepare(
            "SELECT value FROM messages WHERE chat=? AND json_extract(value,'$.providerId')=? LIMIT 1",
          )
          .get(to, m.providerId);
        if (!duplicate) {
          this.writeMessage({
            ...m,
            chatId: to,
            updatedAt: new Date().toISOString(),
          });
          continue;
        }
        const keep = messageSchema.parse(
          JSON.parse(rowSchema.parse(duplicate).value),
        );
        const latest = m.deleted
          ? m
          : keep.deleted
            ? keep
            : Date.parse(m.editedAt ?? "1970-01-01") >
                Date.parse(keep.editedAt ?? "1970-01-01")
              ? m
              : keep;
        const attachmentId = latest.deleted
          ? null
          : ([latest.attachmentId, keep.attachmentId, m.attachmentId].find(
              (aid) =>
                aid && this.attachments.get(aid)?.availability === "stored",
            ) ?? latest.attachmentId);
        if (latest.deleted)
          this.db
            .prepare("DELETE FROM attachments WHERE message_id IN (?,?)")
            .run(keep.id, m.id);
        else
          this.db
            .prepare(
              "UPDATE attachments SET message_id=?,chat_id=? WHERE message_id=?",
            )
            .run(keep.id, to, m.id);
        this.writeMessage({
          ...latest,
          id: keep.id,
          chatId: to,
          attachmentId,
          observedAt: [m.observedAt, keep.observedAt].sort()[0]!,
          sentAt: keep.sentAt ?? m.sentAt,
          text: latest.deleted ? "" : latest.text,
          mentions: latest.deleted ? [] : latest.mentions,
          replyId: latest.deleted ? null : latest.replyId,
          updatedAt: new Date().toISOString(),
        });
        const raw = this.get("raw", latest.id);
        if (!latest.deleted && raw) this.put("raw", keep.id, raw);
        this.db.prepare("DELETE FROM messages WHERE id=?").run(m.id);
        this.remove("raw", m.id);
        this.put("message-alias", m.id, keep.id);
      }
      for (const row of this.db
        .prepare("SELECT value FROM messages WHERE chat=?")
        .all(to)) {
        const m = messageSchema.parse(JSON.parse(rowSchema.parse(row).value));
        this.aliasMessageKeys(m, [lid, pn]);
      }
      this.db
        .prepare("UPDATE attachments SET chat_id=? WHERE chat_id=?")
        .run(to, from);
      this.remove("chat", from);
    });
  }
  chat(id: string) {
    const value = this.get("chat", this.chatId(id));
    if (!value) throw new BridgeError("not_found_or_not_permitted");
    return chatSchema.parse(value);
  }
  saveChat(jid: string, name?: string) {
    jid = this.canonicalJid(jid);
    const id = opaque("chat", jid);
    const previous = this.get("chat", id);
    const old = previous ? chatSchema.parse(previous) : undefined;
    const contact = z
      .object({ name: z.string() })
      .safeParse(this.get("participant", opaque("participant", jid)));
    const oldName =
      old?.name && old.name !== jid.split("@")[0] ? old.name : undefined;
    const resolved =
      name?.trim() ||
      (contact.success ? contact.data.name : undefined) ||
      oldName;
    const fallback = jid.endsWith("@g.us")
      ? "Group name unavailable"
      : jid.endsWith("@lid")
        ? "Contact name unavailable"
        : `+${jid.split("@")[0]}`;
    const chat: Chat = {
      id,
      jid,
      name: resolved || fallback,
      type: jid.endsWith("@g.us") ? "group" : "direct",
      updatedAt: new Date().toISOString(),
    };
    this.put("chat", id, chat);
    return chat;
  }
  clients() {
    return this.all("client").map((v) => clientSchema.parse(v));
  }
  principal(token: string) {
    const digest = hash(token);
    return this.clients().find((p) => p.enabled && p.tokenHash === digest);
  }
  requirePrincipal(p: Principal) {
    const current = this.clients().find((v) => v.id === p.id && v.enabled);
    if (!current) throw new BridgeError("not_found_or_not_permitted");
    return current;
  }
  authorize(p: Principal, chatId: string) {
    this.requirePrincipal(p);
    return this.chat(chatId);
  }
  expire() {
    const now = new Date().toISOString();
    const rows = this.db
      .prepare(
        "SELECT value FROM messages WHERE json_extract(value,'$.deleted')=0 AND json_extract(value,'$.expiresAt') IS NOT NULL AND json_extract(value,'$.expiresAt')<=?",
      )
      .all(now);
    for (const row of rows) {
      const message = messageSchema.parse(
        JSON.parse(rowSchema.parse(row).value),
      );
      if (!message.deleted && message.expiresAt && message.expiresAt <= now)
        this.eraseMessage(message.id);
    }
  }
  historyCoverage(chatId?: string) {
    const id = chatId ? this.chat(chatId).id : null;
    const row = this.db
      .prepare(
        `SELECT count(*) AS count, min(sent) AS oldest, max(sent) AS newest
      FROM messages WHERE json_extract(value,'$.deleted')=0 AND sent IS NOT NULL
      ${id ? "AND chat=?" : ""}`,
      )
      .get(...(id ? [id] : []));
    const result = z
      .object({
        count: z.number(),
        oldest: z.string().nullable(),
        newest: z.string().nullable(),
      })
      .parse(row);
    return {
      chat_id: id,
      stored_messages: result.count,
      oldest_message_at: result.oldest,
      newest_message_at: result.newest,
      completeness: "unknown",
      gaps: "unknown",
    };
  }
  historyAnchor(chatId: string) {
    const chat = this.chat(chatId);
    const row = this.db
      .prepare(
        `SELECT m.value FROM messages m JOIN objects r ON r.kind='raw' AND r.id=m.id
      WHERE m.chat=? AND json_extract(m.value,'$.deleted')=0 AND m.sent IS NOT NULL
      ORDER BY coalesce(m.sent,m.observed),m.id LIMIT 1`,
      )
      .get(chat.id);
    return row
      ? messageSchema.parse(JSON.parse(rowSchema.parse(row).value))
      : null;
  }
  prune(days = 90) {
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    for (const row of this.db
      .prepare("SELECT value FROM messages WHERE observed<?")
      .all(cutoff)) {
      const m = messageSchema.parse(JSON.parse(rowSchema.parse(row).value));
      this.eraseMessage(m.id);
    }
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  equivalents(id: string) {
    const ids = new Set([id]);
    for (const row of this.db
      .prepare("SELECT id,value FROM objects WHERE kind='alias'")
      .all()) {
      const alias = z.object({ id: z.string(), value: z.string() }).parse(row);
      const pn = z.string().parse(JSON.parse(alias.value));
      const a = opaque("participant", alias.id),
        b = opaque("participant", pn);
      if (ids.has(a) || ids.has(b)) {
        ids.add(a);
        ids.add(b);
      }
    }
    return ids;
  }
  messages(chatIds: string[]) {
    if (!chatIds.length) return [];
    chatIds = [...new Set(chatIds.map((id) => this.chatId(id)))];
    const placeholders = chatIds.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT value FROM messages WHERE chat IN (${placeholders})`)
      .all(...chatIds)
      .map((v) => messageSchema.parse(JSON.parse(rowSchema.parse(v).value)));
  }
  messageQuery(
    chatIds: string[] | undefined,
    q: Query,
    ownerIds: string[],
    watermark: string,
    offset: number,
    after?: { time: string; id: string },
  ) {
    const where: string[] = [];
    const args: (string | number)[] = [];
    const field = (name: string) => `json_extract(value,'$.${name}')`;
    const add = (sql: string, ...values: (string | number)[]) => {
      where.push(sql);
      args.push(...values);
    };
    const list = (expr: string, values: string[]) => {
      args.push(JSON.stringify(values));
      return `${expr} IN (SELECT value FROM json_each(?))`;
    };
    const expand = (ids: string[]) => [
      ...new Set(ids.flatMap((id) => [...this.equivalents(id)])),
    ];
    const mentions = (ids: string[]) => {
      args.push(JSON.stringify(expand(ids)));
      return `EXISTS (SELECT 1 FROM json_each(messages.value,'$.mentions') m WHERE m.value IN (SELECT value FROM json_each(?)))`;
    };
    const replies = (ids: string[]) => {
      const canonical = new Set(
        ids.map((id) => this.resolveId("message-alias", id)),
      );
      for (const row of this.db
        .prepare("SELECT id,value FROM objects WHERE kind='message-alias'")
        .all()) {
        const alias = z
          .object({ id: z.string(), value: z.string() })
          .parse(row);
        if (canonical.has(this.resolveId("message-alias", alias.id)))
          canonical.add(alias.id);
      }
      return list(field("replyId"), [...canonical]);
    };
    const selection =
      chatIds === undefined
        ? undefined
        : [...new Set(chatIds.map((id) => this.chatId(id)))];
    if (selection) {
      if (selection.length === 1) add("chat=?", selection[0]!);
      else where.push(list("chat", selection));
    }
    add("observed<=?", watermark);
    if (!q.include_tombstones) add(`${field("deleted")}=0`);
    if (q.changed_since)
      add(
        `julianday(coalesce(${field("updatedAt")},observed))>=julianday(?)`,
        q.changed_since,
      );
    if (q.chat_type)
      add(
        `chat IN (SELECT id FROM objects WHERE kind='chat' AND json_extract(value,'$.type')=?)`,
        q.chat_type,
      );
    for (const [column, range] of [
      ["sent", q.sent_at],
      ["observed", q.observed_at],
    ] as const) {
      if (range)
        add(
          `julianday(${column})>=julianday(?) AND julianday(${column})<julianday(?)`,
          range.from,
          range.to,
        );
    }
    if (q.sender_ids) where.push(list(field("senderId"), expand(q.sender_ids)));
    if (q.direction) add(`${field("direction")}=?`, q.direction);
    if (q.content_types)
      where.push(list(field("contentType"), q.content_types));
    if (q.has_attachment !== undefined)
      add(`(${field("attachmentId")} IS NOT NULL)=?`, Number(q.has_attachment));
    if (q.has_link !== undefined)
      add(`has_link(${field("text")})=?`, Number(q.has_link));
    if (q.mention_ids) where.push(mentions(q.mention_ids));
    if (q.mentions_me !== undefined)
      where.push(`${q.mentions_me ? "" : "NOT "}${mentions(ownerIds)}`);
    if (q.reply_to_ids) where.push(replies(q.reply_to_ids));
    if (q.query) add(`contains_text(${field("text")},?)=1`, q.query);
    if (q.match_any) {
      const choices = q.match_any.map((v) => {
        if (v.mentions_me) return mentions(ownerIds);
        if (v.reply_to_ids) return replies(v.reply_to_ids);
        if (v.query) {
          args.push(v.query);
          return `contains_text(${field("text")},?)=1`;
        }
        return "0";
      });
      where.push(`(${choices.join(" OR ") || "0"})`);
    }
    if (after) {
      add(
        `coalesce(sent,observed) ${q.order === "oldest_first" ? ">=" : "<="} ?`,
        after.time,
      );
      add(
        `(coalesce(sent,observed),id) ${q.order === "oldest_first" ? ">" : "<"} (?,?)`,
        after.time,
        after.id,
      );
    }
    const order = q.order === "oldest_first" ? "ASC" : "DESC";
    // One chat can seek its own time index; multiple/all chats share the global time index.
    const index =
      selection?.length === 1 ? "messages_chat_time" : "messages_time";
    const sql = `SELECT value FROM messages INDEXED BY ${index} WHERE ${where.join(" AND ")} ORDER BY coalesce(sent,observed) ${order},id ${order} LIMIT ? OFFSET ?`;
    return { sql, args: [...args, q.limit + 1, after ? 0 : offset] };
  }
  queryMessages(...input: Parameters<Store["messageQuery"]>) {
    const { sql, args } = this.messageQuery(...input);
    const q = input[1];
    const rows = this.db.prepare(sql).all(...args);
    return {
      messages: rows
        .slice(0, q.limit)
        .map((row) =>
          messageSchema.parse(JSON.parse(rowSchema.parse(row).value)),
        ),
      hasMore: rows.length > q.limit,
    };
  }
  hasParticipant(chatId: string, ids: string[]) {
    const candidates = JSON.stringify(ids);
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 FROM messages WHERE chat=? AND
      (json_extract(value,'$.senderId') IN (SELECT value FROM json_each(?)) OR
       EXISTS (SELECT 1 FROM json_each(messages.value,'$.mentions') m WHERE m.value IN (SELECT value FROM json_each(?)))) LIMIT 1`,
        )
        .get(this.chatId(chatId), candidates, candidates),
    );
  }
  contextMessages(anchor: Message, before: number, after: number) {
    const time = anchor.sentAt ?? anchor.observedAt;
    const side = (
      comparison: "<" | ">",
      order: "ASC" | "DESC",
      limit: number,
    ) =>
      this.db
        .prepare(
          `SELECT value FROM messages WHERE chat=? AND (coalesce(sent,observed),id) ${comparison} (?,?) ORDER BY coalesce(sent,observed) ${order},id ${order} LIMIT ?`,
        )
        .all(anchor.chatId, time, anchor.id, limit)
        .map((row) =>
          messageSchema.parse(JSON.parse(rowSchema.parse(row).value)),
        );
    return [
      ...side("<", "DESC", before).reverse(),
      anchor,
      ...side(">", "ASC", after),
    ];
  }
  message(id: string) {
    id = this.resolveId("message-alias", id);
    const row = this.db
      .prepare("SELECT value FROM messages WHERE id=?")
      .get(id);
    if (!row) throw new BridgeError("not_found_or_not_permitted");
    return messageSchema.parse(JSON.parse(rowSchema.parse(row).value));
  }
  saveMessage(message: Message) {
    message = {
      ...message,
      id: this.resolveId("message-alias", message.id),
      chatId: this.chatId(message.chatId),
    };
    message.updatedAt ??= message.observedAt;
    const old = this.db
      .prepare("SELECT value FROM messages WHERE id=?")
      .get(message.id);
    if (old) {
      const prior = messageSchema.parse(JSON.parse(rowSchema.parse(old).value));
      if (
        !message.deleted &&
        (prior.deleted ||
          (prior.editedAt &&
            (!message.editedAt ||
              Date.parse(message.editedAt) <= Date.parse(prior.editedAt))))
      )
        return false;
      message.observedAt = prior.observedAt;
      if (message.editedAt) {
        message.sentAt = prior.sentAt;
        message.senderId = prior.senderId;
        message.senderName = prior.senderName;
        message.direction = prior.direction;
        message.expiresAt = prior.expiresAt;
      }
      if (prior.deleted) {
        message.deleted = true;
        message.text = "";
        message.mentions = [];
        message.attachmentId = null;
      }
    }
    this.writeMessage(message);
    const chat = this.get("chat", message.chatId);
    if (chat) {
      const jid = chatSchema.parse(chat).jid;
      const lids = this.db
        .prepare("SELECT id FROM objects WHERE kind='alias' AND value=?")
        .all(JSON.stringify(jid))
        .map((row) => z.object({ id: z.string() }).parse(row).id);
      this.aliasMessageKeys(message, [jid, ...lids]);
    }
    return true;
  }
  private aliasMessageKeys(message: Message, jids: string[]) {
    for (const jid of jids) {
      const id = opaque("message", `${jid}:${message.providerId}`);
      if (id !== message.id) this.put("message-alias", id, message.id);
    }
  }
  private writeMessage(message: Message) {
    this.db
      .prepare(
        "INSERT INTO messages VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET chat=excluded.chat,value=excluded.value,sent=excluded.sent,observed=excluded.observed",
      )
      .run(
        message.id,
        message.chatId,
        message.observedAt,
        message.sentAt,
        JSON.stringify(message),
      );
  }
  repairSender(id: string, senderId: string, senderName: string) {
    const message = this.message(id);
    this.writeMessage({
      ...message,
      senderId,
      senderName,
      updatedAt: new Date().toISOString(),
    });
  }
  removeMessageEvent(id: string) {
    this.db.prepare("DELETE FROM messages WHERE id=?").run(id);
    this.remove("raw", id);
  }
  eraseMessage(id: string) {
    id = this.resolveId("message-alias", id);
    try {
      const m = this.message(id);
      this.saveMessage({
        ...m,
        updatedAt: new Date().toISOString(),
        deleted: true,
        text: "",
        mentions: [],
        replyId: null,
        attachmentId: null,
      });
    } catch (e) {
      if (!(e instanceof BridgeError)) throw e;
    }
  }
  drafts() {
    return this.all("draft").map((v) => draftSchema.parse(v));
  }
  draft(id: string) {
    return draftSchema.parse(this.get("draft", id));
  }
  saveDraft(d: Draft) {
    this.put("draft", d.id, d);
  }
  uuid(prefix: string) {
    return `${prefix}_${randomUUID()}`;
  }
}
