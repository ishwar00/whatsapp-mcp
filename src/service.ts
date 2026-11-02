import { z } from "zod";
import {
  BridgeError,
  querySchema,
  type Draft,
  type Principal,
} from "./domain.js";
import { Store, hash } from "./store.js";
import type { Watches } from "./watches.js";
import { readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute } from "node:path";
import { type Message } from "./domain.js";
export const normalizeName = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
export const sendInput = z
  .object({
    chat_id: z.string(),
    to: z.string().min(1),
    text: z.string().max(10000).default(""),
    file_path: z.string().refine(isAbsolute).optional(),
    reply_to_message_id: z.string().optional(),
    mention_ids: z.array(z.string()).max(50).default([]),
    request_id: z.string().min(1).max(200),
  })
  .strict();
const sendRecord = z.object({
  payloadHash: z.string(),
  providerId: z.string().nullable(),
  status: z.enum(["attempting", "accepted", "failed", "unknown"]),
  chat_id: z.string(),
  chat_name: z.string(),
  sent_at: z.string().optional(),
  message_id: z.string().optional(),
  error: z.string().optional(),
});
const mimes: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".txt": "text/plain",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};
export interface Sender {
  connected: boolean;
  ownerIds: string[];
  send(draft: Draft): Promise<string>;
}
const cursorSchema = z.object({
  offset: z.number().int().min(0),
  watermark: z.string(),
  binding: z.string(),
  after: z.object({ time: z.string(), id: z.string() }).optional(),
});
export class Service {
  constructor(
    public store: Store,
    public sender: Sender,
    public watches?: Watches,
  ) {}
  coverage() {
    return {
      connected: this.sender.connected,
      snapshot_at: new Date().toISOString(),
      completeness: "unknown",
      history: "partial",
      note: "All chats are collected automatically; only locally observed messages are available. WhatsApp history may be incomplete.",
    };
  }
  read(p: Principal, input: unknown) {
    this.store.expire();
    const q = querySchema.parse(input);
    this.store.requirePrincipal(p);
    for (const id of q.chat_ids ?? []) this.store.chat(id);
    const selection = q.chat_ids;
    const binding = hash(JSON.stringify({ ...q, page: undefined }) + p.id);
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
      if (range?.to && Date.parse(range.from) >= Date.parse(range.to))
        throw new BridgeError("invalid_argument", "Time range must increase");
    const result = this.store.queryMessages(
      selection,
      q,
      this.sender.ownerIds,
      cursor.watermark,
      cursor.offset,
      cursor.after,
    );
    const items = result.messages;
    const offset = cursor.offset + items.length;
    return {
      schema_version: 1,
      messages: items,
      next_page: result.hasMore
        ? Buffer.from(
            JSON.stringify({
              ...cursor,
              offset,
              after: items.length
                ? {
                    time:
                      items[items.length - 1]!.sentAt ??
                      items[items.length - 1]!.observedAt,
                    id: items[items.length - 1]!.id,
                  }
                : cursor.after,
            }),
          ).toString("base64url")
        : null,
      coverage: this.coverage(),
      chat_coverage: q.chat_ids?.map((id) => this.store.historyCoverage(id)),
    };
  }
  context(p: Principal, chatId: string, id: string, before = 10, after = 10) {
    this.store.expire();
    this.store.authorize(p, chatId);
    const anchor = this.store.message(id);
    if (anchor.chatId !== this.store.chatId(chatId))
      throw new BridgeError("not_found_or_not_permitted");
    let quote = null;
    if (anchor.replyId) {
      try {
        const message = this.store.message(anchor.replyId);
        if (message.chatId === anchor.chatId) quote = message;
      } catch {}
    }
    return {
      schema_version: 1,
      messages: this.store.contextMessages(anchor, before, after),
      quoted: quote,
      missing_quote: Boolean(anchor.replyId && !quote),
      coverage: this.coverage(),
    };
  }
  attachment(p: Principal, id: string) {
    this.store.expire();
    const meta = this.store.attachments.get(id);
    if (!meta) throw new BridgeError("media_unavailable");
    this.store.authorize(p, meta.chatId);
    return meta;
  }
  chatName(chatId: string) {
    const chat = this.store.chat(chatId),
      p = this.store.get(
        "participant",
        chat.id.replace(/^chat_/, "participant_"),
      );
    const contact = z.object({ savedName: z.string().optional() }).safeParse(p);
    return contact.success && contact.data.savedName
      ? contact.data.savedName
      : chat.name;
  }
  listChats(p: Principal, input: unknown) {
    this.store.requirePrincipal(p);
    const q = z
      .object({
        query: z.string().optional(),
        type: z.enum(["direct", "group"]).optional(),
        limit: z.number().int().min(1).max(100).default(20),
      })
      .strict()
      .parse(input);
    return this.store
      .chats()
      .map((c) => {
        const name = this.chatName(c.id),
          aliases = [...new Set([c.name, ...this.store.names(c.id)])].filter(
            (n) => n !== name,
          );
        const coverage = this.store.historyCoverage(c.id);
        return {
          chat_id: c.id,
          name,
          aliases,
          type: c.type,
          message_count: coverage.stored_messages,
          last_message_at: coverage.newest_message_at,
        };
      })
      .filter(
        (c) =>
          (!q.type || c.type === q.type) &&
          (!q.query ||
            [c.name, ...c.aliases].some((n) =>
              normalizeName(n).includes(normalizeName(q.query!)),
            )),
      )
      .sort((a, b) =>
        (b.last_message_at ?? "").localeCompare(a.last_message_at ?? ""),
      )
      .slice(0, q.limit);
  }
  chatDetails(chatId: string) {
    const chat = this.store.chat(chatId),
      name = this.chatName(chat.id),
      coverage = this.store.historyCoverage(chat.id);
    const participants = [
      ...new Map(
        this.store.messages([chat.id]).map((m) => [
          m.senderId,
          {
            participant_id: m.senderId,
            name: this.senderName(m),
            aliases: this.store
              .names(m.senderId.replace(/^participant_/, "chat_"))
              .filter((n) => n !== this.senderName(m)),
          },
        ]),
      ).values(),
    ];
    return {
      chat_id: chat.id,
      name,
      aliases: [...new Set([chat.name, ...this.store.names(chat.id)])].filter(
        (n) => n !== name,
      ),
      type: chat.type,
      message_count: coverage.stored_messages,
      last_message_at: coverage.newest_message_at,
      participants,
    };
  }
  senderName(m: Message) {
    const id = m.senderId.replace(/^participant_/, "chat_");
    try {
      return this.chatName(this.store.chatId(id));
    } catch {}
    const p = z
      .object({ savedName: z.string().optional(), name: z.string().optional() })
      .safeParse(this.store.get("participant", m.senderId));
    return p.success
      ? (p.data.savedName ?? p.data.name ?? m.senderName)
      : (this.store.names(id)[0] ?? m.senderName);
  }
  private sentMessages() {
    const sent = new Set<string>();
    for (const v of [...this.store.all("send"), ...this.store.all("draft")]) {
      const r = z
        .object({
          status: z.string(),
          providerId: z.string().nullable().optional(),
          chat_id: z.string().optional(),
          input: z.object({ chat_id: z.string() }).optional(),
        })
        .safeParse(v);
      if (r.success && r.data.status === "accepted" && r.data.providerId)
        sent.add(
          JSON.stringify([
            this.store.chatId(r.data.chat_id ?? r.data.input?.chat_id ?? ""),
            r.data.providerId,
          ]),
        );
    }
    return sent;
  }
  compactMessages(messages: Message[]) {
    const sent = this.sentMessages();
    return messages.map((m) => this.compact(m, sent));
  }
  compact(m: Message, sent = this.sentMessages()) {
    const attachment = m.attachmentId
      ? this.store.attachments.get(m.attachmentId)
      : undefined;
    return {
      id: m.id,
      chat_id: m.chatId,
      sender_id: m.senderId,
      sender_name: this.senderName(m),
      direction: m.direction,
      sent_at: m.sentAt,
      text: m.text,
      content_type: m.contentType,
      ...(m.replyId ? { reply_to_id: m.replyId } : {}),
      ...(m.editedAt ? { edited_at: m.editedAt } : {}),
      ...(m.deleted ? { deleted: true } : {}),
      ...(attachment
        ? {
            attachment: {
              attachment_id: attachment.id,
              name: attachment.name,
              mime: attachment.mime,
              size: attachment.size,
            },
          }
        : {}),
      ...(m.direction === "outgoing" &&
      sent.has(JSON.stringify([this.store.chatId(m.chatId), m.providerId]))
        ? { sent_via_mcp: true }
        : {}),
    };
  }
  async send(p: Principal, input: unknown) {
    this.store.requirePrincipal(p);
    if (!this.store.clients().find((c) => c.id === p.id)?.canSend)
      throw new BridgeError("not_found_or_not_permitted");
    const q = sendInput.parse(input);
    this.store.authorize(p, q.chat_id);
    const chat = this.store.chat(q.chat_id),
      id = hash(JSON.stringify([p.id, q.request_id])),
      payloadHash = hash(JSON.stringify(q));
    const old = this.store.get("send", id);
    const publicResult = (r: z.infer<typeof sendRecord>) => {
      const { payloadHash, providerId, ...safe } = r;
      return {
        ...safe,
        status: r.status === "attempting" ? "unknown" : r.status,
      };
    };
    if (old) {
      const r = sendRecord.parse(old);
      if (r.payloadHash !== payloadHash)
        throw new BridgeError("request_conflict");
      return publicResult(r);
    }
    const name = this.chatName(chat.id),
      match = normalizeName(q.to);
    if (
      !match ||
      ![name, ...this.store.names(chat.id)].some((n) =>
        normalizeName(n).includes(match),
      )
    )
      throw new BridgeError(
        "recipient_mismatch",
        `Recipient does not match chat name: ${name}`,
      );
    if (!q.text && !q.file_path)
      throw new BridgeError("invalid_argument", "Provide text or file_path");
    if (q.reply_to_message_id) {
      const m = this.store.message(q.reply_to_message_id);
      if (this.store.chatId(m.chatId) !== chat.id || m.deleted)
        throw new BridgeError("not_found_or_not_permitted");
    }
    for (const participant of q.mention_ids)
      if (
        !this.store.hasParticipant(chat.id, [
          ...this.store.equivalents(participant),
        ])
      )
        throw new BridgeError("not_found_or_not_permitted");
    const attachmentIds: string[] = [];
    if (q.file_path) {
      const mime = mimes[extname(q.file_path).toLowerCase()];
      if (!mime) throw new BridgeError("unsupported_file_type");
      let bytes: Buffer;
      try {
        const stat = statSync(q.file_path);
        if (!stat.isFile()) throw new Error();
        if (stat.size > 5 * 1024 * 1024)
          throw new BridgeError("media_too_large");
        bytes = readFileSync(q.file_path);
      } catch (e) {
        if (e instanceof BridgeError) throw e;
        throw new BridgeError("file_unavailable");
      }
      if (!bytes.length) throw new BridgeError("file_unavailable");
      const aid = this.store.uuid("attachment");
      this.store.attachments.save(
        {
          id: aid,
          chatId: chat.id,
          messageId: null,
          name: basename(q.file_path),
          mime,
          size: 0,
          digest: null,
          availability: "pending",
        },
        bytes,
      );
      attachmentIds.push(aid);
    }
    const sentAt = new Date().toISOString();
    let record: z.infer<typeof sendRecord> = {
      payloadHash,
      providerId: null,
      status: this.sender.connected ? "attempting" : "failed",
      chat_id: chat.id,
      chat_name: name,
      ...(!this.sender.connected ? { error: "WhatsApp is offline" } : {}),
    };
    this.store.put("send", id, record);
    if (record.status === "failed") return publicResult(record);
    const envelope: Draft = {
      id,
      clientId: p.id,
      input: {
        chat_id: chat.id,
        text: q.text,
        attachment_ids: attachmentIds,
        mention_ids: q.mention_ids,
        reply_to_message_id: q.reply_to_message_id,
        request_id: q.request_id,
      },
      digest: payloadHash,
      status: "attempting",
      createdAt: sentAt,
      providerId: null,
      error: null,
    };
    try {
      const providerId = await this.sender.send(envelope);
      record = {
        ...record,
        status: "accepted",
        providerId,
        message_id: this.store.messageId(chat.jid, providerId),
        sent_at: sentAt,
      };
    } catch {
      record = {
        ...record,
        status: "unknown",
        error:
          "Provider result uncertain. Check WhatsApp before sending again.",
      };
    }
    this.store.put("send", id, record);
    return publicResult(record);
  }
}
