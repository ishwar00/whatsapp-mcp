import { z } from "zod";
import {
  BridgeError,
  draftInputSchema,
  querySchema,
  type Draft,
  type DraftInput,
  type Principal,
} from "./domain.js";
import { Store, hash } from "./store.js";
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
      if (range && Date.parse(range.from) >= Date.parse(range.to))
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
  createDraft(p: Principal, input: unknown) {
    if (!this.store.clients().find((c) => c.id === p.id && c.enabled)?.canDraft)
      throw new BridgeError("not_found_or_not_permitted");
    const payload = draftInputSchema.parse(input);
    this.validateReferences(p, payload);
    const digest = hash(JSON.stringify(payload));
    return this.store.transaction(() => {
      const existing = this.store.db
        .prepare(
          "SELECT digest,draft FROM requests WHERE client=? AND request=?",
        )
        .get(p.id, payload.request_id);
      if (existing) {
        const row = z
          .object({ digest: z.string(), draft: z.string() })
          .parse(existing);
        if (row.digest !== digest) throw new BridgeError("request_conflict");
        return this.store.draft(row.draft);
      }
      const id = this.store.uuid("draft");
      const normalized = { ...payload };
      if (payload.attachment) {
        const bytes = Buffer.from(payload.attachment.data, "base64");
        if (!bytes.length || bytes.length > 5 * 1024 * 1024)
          throw new BridgeError("media_too_large");
        const aid = this.store.uuid("attachment");
        this.store.attachments.save(
          {
            id: aid,
            chatId: payload.chat_id,
            messageId: null,
            name: payload.attachment.name,
            mime: payload.attachment.mime_type,
            digest: null,
            size: 0,
            availability: "pending",
          },
          bytes,
        );
        normalized.attachment_ids = [aid];
        delete normalized.attachment;
      }
      const frozenAttachments = normalized.attachment_ids.map(
        (aid) => this.store.attachments.read(aid).meta.digest,
      );
      const draft: Draft = {
        id,
        clientId: p.id,
        input: normalized,
        digest: hash(
          JSON.stringify(normalized) + JSON.stringify(frozenAttachments),
        ),
        status: "pending",
        createdAt: new Date().toISOString(),
        providerId: null,
        error: null,
      };
      this.store.saveDraft(draft);
      this.store.db
        .prepare("INSERT INTO requests VALUES(?,?,?,?)")
        .run(p.id, payload.request_id, digest, id);
      return draft;
    });
  }
  validateReferences(p: Principal, input: DraftInput) {
    this.store.expire();
    this.store.authorize(p, input.chat_id);
    if (input.reply_to_message_id) {
      const m = this.store.message(input.reply_to_message_id);
      if (m.chatId !== this.store.chatId(input.chat_id) || m.deleted)
        throw new BridgeError("not_found_or_not_permitted");
    }
    for (const id of input.mention_ids)
      if (
        !this.store.hasParticipant(input.chat_id, [
          ...this.store.equivalents(id),
        ])
      )
        throw new BridgeError("not_found_or_not_permitted");
    for (const aid of input.attachment_ids) {
      this.attachment(p, aid);
      this.store.attachments.read(aid);
    }
  }
  ownDraft(p: Principal, id: string) {
    const draft = this.store.draft(id);
    if (draft.clientId !== p.id)
      throw new BridgeError("not_found_or_not_permitted");
    this.store.authorize(p, draft.input.chat_id);
    return draft;
  }
  cancel(p: Principal, id: string) {
    const draft = this.ownDraft(p, id);
    if (draft.status === "pending") {
      draft.status = "cancelled";
      this.store.saveDraft(draft);
    }
    return draft;
  }
  // The MCP client must obtain tool approval before calling send_draft.
  async sendDraft(
    p: Principal,
    id: string,
    digest: string,
    chatName: string,
    text: string,
    attachmentNames: string[] = [],
  ) {
    if (!this.store.clients().find((c) => c.id === p.id && c.enabled)?.canSend)
      throw new BridgeError("not_found_or_not_permitted");
    const draft = this.ownDraft(p, id);
    const actualNames = draft.input.attachment_ids.map(
      (aid) => this.store.attachments.read(aid).meta.name,
    );
    if (JSON.stringify(actualNames) !== JSON.stringify(attachmentNames))
      throw new BridgeError(
        "request_conflict",
        "attachment_names does not match the draft",
      );
    if (
      this.store.chat(draft.input.chat_id).name !== chatName ||
      draft.input.text !== text
    )
      throw new BridgeError(
        "request_conflict",
        "chat_name or text does not match the draft",
      );
    if (draft.digest !== digest) throw new BridgeError("request_conflict");
    if (draft.status !== "pending") return draft;
    return this.approve(id, digest);
  }
  async approve(id: string, digest: string) {
    let draft = this.store.draft(id);
    if (draft.digest !== digest) throw new BridgeError("request_conflict");
    if (draft.status !== "pending") return draft;
    const principal = this.store.clients().find((p) => p.id === draft.clientId);
    if (!principal?.canDraft)
      throw new BridgeError("not_found_or_not_permitted");
    this.validateReferences(principal, draft.input);
    const actual = hash(
      JSON.stringify(draft.input) +
        JSON.stringify(
          draft.input.attachment_ids.map(
            (aid) => this.store.attachments.read(aid).meta.digest,
          ),
        ),
    );
    if (actual !== draft.digest) throw new BridgeError("request_conflict");
    if (!this.sender.connected) throw new BridgeError("service_offline");
    draft = { ...draft, status: "attempting" };
    this.store.saveDraft(draft);
    try {
      const providerId = await this.sender.send(draft);
      draft = { ...draft, status: "accepted", providerId };
    } catch {
      draft = {
        ...draft,
        status: "unknown",
        error:
          "Provider result uncertain. Check WhatsApp before creating another draft.",
      };
    }
    this.store.saveDraft(draft);
    return draft;
  }
}
