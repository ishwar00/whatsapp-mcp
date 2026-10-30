import makeWASocket, {
  BufferJSON,
  DisconnectReason,
  initAuthCreds,
  proto,
  downloadMediaMessage,
  getContentType,
  normalizeMessageContent,
  toNumber,
  jidNormalizedUser,
  type AuthenticationState,
  type SignalDataTypeMap,
  type WAMessage,
  type WASocket,
  type Contact,
} from "@whiskeysockets/baileys";
import pino from "pino";
import { HistorySync, resolveHistoryMode } from "./history.js";
import { decryptEdit } from "./encrypted-edit.js";
import { z } from "zod";
import { Store, opaque } from "./store.js";
import { BridgeError, messageSchema, type Draft } from "./domain.js";
import type { Sender } from "./service.js";
function toMessage(value: unknown): WAMessage {
  const message = proto.WebMessageInfo.fromObject(
    z.record(z.unknown()).parse(value),
  );
  const key = z
    .object({
      remoteJid: z.string(),
      id: z.string(),
      fromMe: z.boolean().nullish(),
      participant: z.string().nullish(),
      remoteJidAlt: z.string().optional(),
      participantAlt: z.string().optional(),
    })
    .parse(message.key);
  return {
    ...message,
    key: {
      ...key,
      participant: key.participant || message.participant || undefined,
    },
  };
}
const logger = pino({ level: "silent" });
const diagnostics = pino({ level: "info" }, pino.destination(2));
function httpStatus(error: unknown) {
  const parsed = z
    .object({
      status: z.number().optional(),
      output: z.object({ statusCode: z.number() }).optional(),
    })
    .safeParse(error);
  return parsed.success
    ? (parsed.data.output?.statusCode ?? parsed.data.status)
    : undefined;
}
export class WhatsApp implements Sender {
  connected = false;
  ownerIds: string[] = [];
  qr: string | null = null;
  state = "offline";
  socket: WASocket | undefined;
  stopping = false;
  reconnectAttempt = 0;
  caching = 0;
  historyMode: "full" | "recent" = "full";
  readonly history: HistorySync;
  constructor(public store: Store) {
    this.history = new HistorySync(store, {
      connected: () => this.connected,
      request: (chat, count, anchorId) =>
        this.requestHistory(chat, count, anchorId),
    });
  }
  auth(): AuthenticationState {
    const saved = this.store.get("auth", "creds");
    const creds = saved
      ? JSON.parse(
          JSON.stringify(saved, BufferJSON.replacer),
          BufferJSON.reviver,
        )
      : initAuthCreds();
    return {
      creds,
      keys: {
        get: async (type, ids) => {
          const result: { [key: string]: SignalDataTypeMap[typeof type] } = {};
          for (const id of ids) {
            const value = this.store.get("key", `${type}:${id}`);
            if (value) {
              // Baileys owns these formats. In rc14, Signal sessions are objects
              // even though SignalDataTypeMap declares Uint8Array.
              result[id] = (
                type === "app-state-sync-key"
                  ? proto.Message.AppStateSyncKeyData.fromObject(
                      z.record(z.unknown()).parse(value),
                    )
                  : value
              ) as SignalDataTypeMap[typeof type];
            }
          }
          return result;
        },
        set: async (data) => {
          this.store.transaction(() => {
            for (const [type, entries] of Object.entries(data)) {
              for (const [id, value] of Object.entries(entries ?? {})) {
                if (value) this.store.put("key", `${type}:${id}`, value);
                else this.store.remove("key", `${type}:${id}`);
              }
            }
          });
        },
      },
    };
  }
  saveContact(contact: Partial<Contact>) {
    if (!contact.id) return;
    const addresses = [contact.id, contact.lid, contact.phoneNumber]
      .filter((id): id is string => Boolean(id))
      .map(jidNormalizedUser);
    const previous = z
      .object({
        savedName: z.string().optional(),
        profileName: z.string().optional(),
        name: z.string().optional(),
      })
      .safeParse(
        this.store.get(
          "participant",
          opaque("participant", jidNormalizedUser(contact.id)),
        ),
      );
    const savedName =
      contact.name || (previous.success ? previous.data.savedName : undefined);
    const profileName =
      contact.notify ||
      contact.verifiedName ||
      (previous.success ? previous.data.profileName : undefined);
    const name = savedName || profileName;
    if (
      (contact.lid || contact.id.endsWith("@lid")) &&
      (contact.phoneNumber || contact.id.endsWith("@s.whatsapp.net"))
    )
      this.store.addAlias(
        jidNormalizedUser(contact.lid || contact.id),
        jidNormalizedUser(contact.phoneNumber || contact.id),
      );
    for (const jid of addresses) {
      if (name)
        this.store.put("participant", opaque("participant", jid), {
          id: opaque("participant", jid),
          jid,
          name,
          savedName,
          profileName,
        });
      if (!jid.endsWith("@g.us")) this.store.saveChat(jid, name);
    }
  }
  async refreshGroups(sock: Pick<WASocket, "groupFetchAllParticipating">) {
    const groups = await sock.groupFetchAllParticipating();
    if (this.stopping || this.socket !== sock) return;
    for (const group of Object.values(groups))
      if (group.id) this.store.saveChat(group.id, group.subject);
  }
  start() {
    if (this.stopping) return;
    const auth = this.auth();
    this.historyMode = resolveHistoryMode({
      override: process.env.WHATSAPP_HISTORY_MODE,
      saved: this.store.get("setting", "history-mode"),
      paired: Boolean(auth.creds.me),
    });
    // Persist the sync preference without changing the paired browser identity.
    this.store.put("setting", "history-mode", this.historyMode);
    const historyMode = this.historyMode === "full";
    diagnostics.info({
      event: "wa_connect_start",
      historyMode: this.historyMode,
      registered: auth.creds.registered,
    });
    const sock = makeWASocket({
      auth,
      logger,
      markOnlineOnConnect: false,
      syncFullHistory: historyMode,
      generateHighQualityLinkPreview: false,
      getMessage: async (key) => {
        if (!key.remoteJid || !key.id) return undefined;
        const id = this.store.messageId(key.remoteJid, key.id);
        const raw = this.store.get("raw", id);
        if (!raw) return undefined;
        return proto.WebMessageInfo.fromObject(raw).message ?? undefined;
      },
    });
    this.socket = sock;
    this.state = "connecting";
    sock.ev.on("lid-mapping.update", (mapping) => {
      if (this.socket !== sock || this.stopping) return;
      this.store.addAlias(
        jidNormalizedUser(mapping.lid),
        jidNormalizedUser(mapping.pn),
      );
    });
    sock.ev.on("creds.update", () => {
      if (this.socket === sock && !this.stopping)
        this.store.put("auth", "creds", auth.creds);
    });
    sock.ev.on("connection.update", (update) => {
      if (this.socket !== sock || this.stopping) return;
      if (update.connection)
        diagnostics.info({ event: "wa_connection", state: update.connection });
      if (update.qr) this.qr = update.qr;
      if (update.connection === "open") {
        this.reconnectAttempt = 0;
        this.connected = true;
        this.state = "connected";
        this.qr = null;
        for (const chat of this.store.chats()) this.store.saveChat(chat.jid);
        void this.refreshGroups(sock).catch(() => {
          process.stderr.write(
            "Group names could not be refreshed; waiting for metadata updates.\n",
          );
        });
        this.ownerIds = [sock.user?.id, sock.user?.lid]
          .filter((id): id is string => Boolean(id))
          .map((id) => opaque("participant", jidNormalizedUser(id)));
      }
      if (update.connection === "close") {
        this.connected = false;
        this.qr = null;
        const error = update.lastDisconnect?.error;
        const status =
          error && "output" in error
            ? z.object({ statusCode: z.number() }).safeParse(error.output)
            : null;
        diagnostics.warn({
          event: "wa_disconnect",
          status: status?.success ? status.data.statusCode : null,
          reason: error?.message?.slice(0, 200),
          attempt: this.reconnectAttempt,
        });
        const loggedOut =
          status?.success &&
          status.data.statusCode === DisconnectReason.loggedOut;
        this.state = loggedOut ? "reauth_required" : "offline";
        if (!loggedOut && !this.stopping)
          setTimeout(
            () => this.start(),
            Math.min(60000, 2000 * 2 ** Math.min(this.reconnectAttempt++, 5)) +
              Math.random() * 1000,
          ).unref();
      }
    });
    sock.ev.on("chats.upsert", (chats) => {
      if (this.socket !== sock || this.stopping) return;
      for (const c of chats)
        if (c.id) this.store.saveChat(c.id, c.name ?? undefined);
    });
    sock.ev.on("contacts.upsert", (contacts) => {
      if (this.socket !== sock || this.stopping) return;
      for (const contact of contacts) this.saveContact(contact);
    });
    sock.ev.on("contacts.update", (contacts) => {
      if (this.socket !== sock || this.stopping) return;
      for (const contact of contacts) this.saveContact(contact);
    });
    sock.ev.on("groups.update", (groups) => {
      if (this.socket !== sock || this.stopping) return;
      for (const group of groups)
        if (group.id) this.store.saveChat(group.id, group.subject);
    });
    sock.ev.on("chats.update", (chats) => {
      if (this.socket !== sock || this.stopping) return;
      for (const chat of chats)
        if (chat.id && chat.name) this.store.saveChat(chat.id, chat.name);
    });
    sock.ev.on(
      "messaging-history.set",
      ({
        chats,
        contacts,
        messages,
        syncType,
        isLatest,
        progress,
        lidPnMappings,
        peerDataRequestSessionId,
      }) => {
        if (this.socket !== sock || this.stopping) return;
        diagnostics.info({
          event: "wa_history_received",
          syncType,
          isLatest,
          progress,
          chats: chats.length,
          messages: messages.length,
          chatIds: [
            ...new Set(messages.map((m) => m.key.remoteJid).filter(Boolean)),
          ].map((jid) => opaque("chat", String(jid))),
        });
        this.store.put("setting", "history-last-event", {
          received_at: new Date().toISOString(),
          sync_type: syncType,
          messages: messages.length,
          progress: progress ?? null,
        });
        for (const mapping of lidPnMappings ?? [])
          this.store.addAlias(mapping.lid, mapping.pn);
        for (const c of chats)
          if (c.id) this.store.saveChat(c.id, c.name ?? undefined);
        for (const contact of contacts) this.saveContact(contact);
        const historyMessages: { id: string; added: boolean }[] = [];
        for (const raw of messages) {
          const stored = this.ingest(raw, "history");
          if (stored) historyMessages.push(stored);
        }
        if (syncType === proto.HistorySync.HistorySyncType.ON_DEMAND)
          this.history.received({
            requestId: peerDataRequestSessionId,
            progress,
            messages: historyMessages,
          });
      },
    );
    sock.ev.on("messaging-history.status", (status) => {
      if (this.socket !== sock || this.stopping) return;
      this.store.put("setting", "history-phase", {
        ...status,
        updated_at: new Date().toISOString(),
      });
      diagnostics.info({ event: "wa_history_phase", ...status });
    });
    sock.ev.on("messages.upsert", ({ messages }) => {
      if (this.socket !== sock || this.stopping) return;
      for (const m of messages) {
        const protocol = normalizeMessageContent(m.message)?.protocolMessage;
        if (protocol?.historySyncNotification)
          diagnostics.info({
            event: "wa_history_notification",
            syncType: protocol.historySyncNotification.syncType,
          });
        const response = protocol?.peerDataOperationRequestResponseMessage;
        if (response)
          diagnostics.info({
            event: "wa_peer_response",
            requestType: response.peerDataOperationRequestType,
            requestId: response.stanzaId,
            results: response.peerDataOperationResult?.map((r) => ({
              historyCode:
                r.fullHistorySyncOnDemandRequestResponse?.responseCode,
            })),
          });
        this.ingest(m, "live");
      }
    });
    sock.ev.on("messages.update", (updates) => {
      if (this.socket !== sock || this.stopping) return;
      for (const { key, update } of updates) {
        if (!key.remoteJid || !key.id) continue;
        const id = this.store.messageId(key.remoteJid, key.id);
        if (
          update.message === null ||
          update.messageStubType === proto.WebMessageInfo.StubType.REVOKE
        )
          this.store.eraseMessage(id);
        else if (update.message) {
          const raw = this.store.get("raw", id);
          const previous = raw ? proto.WebMessageInfo.fromObject(raw) : { key };
          this.ingest({ ...previous, ...update, key }, "live");
        }
      }
    });
    sock.ev.on("messages.delete", (event) => {
      if (this.socket !== sock || this.stopping) return;
      if ("keys" in event) {
        for (const key of event.keys)
          if (key.remoteJid && key.id)
            this.store.eraseMessage(
              this.store.messageId(key.remoteJid, key.id),
            );
      } else {
        const chat = opaque("chat", event.jid);
        for (const m of this.store.messages([chat]))
          this.store.eraseMessage(m.id);
      }
    });
  }
  async requestHistory(chatId: string, count: number, anchorId?: string) {
    if (!this.connected || !this.socket)
      throw new BridgeError("service_offline");
    const chat = this.store.chat(chatId);
    const oldest = this.store.historyAnchor(chatId, { messageId: anchorId });
    const value = oldest && this.store.get("raw", oldest.id);
    const anchor = value ? toMessage(value) : undefined;
    if (!anchor?.key.id || !anchor.messageTimestamp)
      throw new BridgeError(
        "history_anchor_missing",
        "No stored message anchor. Initial history sync or a new message in this chat is needed before fetching older history.",
      );
    const requestId = await this.socket.fetchMessageHistory(
      count,
      { ...anchor.key, remoteJid: chat.jid },
      toNumber(anchor.messageTimestamp) * 1000,
    );
    diagnostics.info({
      event: "wa_history_requested",
      chatId,
      count,
      anchored: Boolean(anchor),
      requestId,
    });
    return {
      requestId,
      anchored: Boolean(anchor),
      status: "requested",
      note: "Request submitted; only a history event confirms receipt.",
    };
  }
  repairHistoricalSenders() {
    for (const row of this.store.db
      .prepare(
        "SELECT value FROM messages WHERE json_extract(value,'$.direction')='incoming' AND json_extract(value,'$.source')='history'",
      )
      .all()) {
      const value = z.object({ value: z.string() }).parse(row).value;
      const message = messageSchema.parse(JSON.parse(value));
      const raw = this.store.get("raw", message.id);
      if (!raw) continue;
      const original = toMessage(raw);
      if (!original.key.remoteJid?.endsWith("@g.us")) continue;
      const sender = original.key.participant || original.participant;
      if (!sender) continue;
      const jid = this.store.canonicalJid(jidNormalizedUser(sender));
      const senderId = opaque("participant", jid);
      if (senderId === message.senderId) continue;
      const name = z
        .object({ name: z.string() })
        .safeParse(this.store.get("participant", senderId));
      this.store.repairSender(
        message.id,
        senderId,
        name.success ? name.data.name : original.pushName || jid.split("@")[0]!,
      );
    }
  }
  replayEncryptedEdits() {
    for (const value of this.store.all("raw")) {
      const raw = toMessage(value);
      if (normalizeMessageContent(raw.message)?.secretEncryptedMessage)
        this.ingest(raw, "live");
    }
  }
  restoreReactions() {
    for (const message of this.store.messages(
      this.store.chats().map((c) => c.id),
    )) {
      if (message.contentType !== "reaction" || message.deleted) continue;
      const value = this.store.get("raw", message.id);
      if (!value) continue;
      const raw = toMessage(value);
      const reaction = normalizeMessageContent(raw.message)?.reactionMessage;
      if (!reaction) continue;
      const replyId =
        reaction.key?.id && raw.key.remoteJid
          ? opaque(
              "message",
              `${reaction.key.remoteJid || raw.key.remoteJid}:${reaction.key.id}`,
            )
          : null;
      const text = reaction.text ?? "";
      if (message.text === text && message.replyId === replyId) continue;
      this.store.saveMessage({
        ...message,
        text,
        replyId,
        updatedAt: new Date().toISOString(),
      });
    }
  }
  ingest(
    raw: WAMessage,
    source: "live" | "history",
    editTime?: string,
  ): { id: string; added: boolean } | undefined {
    const timestamp = toNumber(raw.messageTimestamp);
    const eventTime =
      timestamp > 0 && timestamp < 8640000000000 && Number.isFinite(timestamp)
        ? new Date(timestamp * 1000).toISOString()
        : null;
    const editedAt =
      editTime ??
      (raw.message?.editedMessage
        ? (eventTime ?? new Date().toISOString())
        : null);
    const jid = raw.key.remoteJid;
    if (!jid || !raw.key.id || jid === "status@broadcast") return;
    for (const [address, alt] of [
      [jid, raw.key.remoteJidAlt],
      [raw.key.participant || raw.participant, raw.key.participantAlt],
    ]) {
      if (address?.endsWith("@lid") && alt?.endsWith("@s.whatsapp.net"))
        this.store.addAlias(jidNormalizedUser(address), jidNormalizedUser(alt));
      else if (alt?.endsWith("@lid") && address?.endsWith("@s.whatsapp.net"))
        this.store.addAlias(jidNormalizedUser(alt), jidNormalizedUser(address));
    }
    if (!raw.key.fromMe && !jid.endsWith("@g.us") && raw.pushName)
      this.saveContact({ id: jid, notify: raw.pushName });
    const chat = this.store.saveChat(jid);
    const id = this.store.messageId(jid, raw.key.id);
    if (
      raw.message?.viewOnceMessage ||
      raw.message?.viewOnceMessageV2 ||
      raw.message?.viewOnceMessageV2Extension
    )
      return;
    const content = normalizeMessageContent(raw.message);
    if (!content) return;
    if (content.secretEncryptedMessage) {
      const encrypted = content.secretEncryptedMessage;
      if (
        encrypted.secretEncType !==
        proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT
      )
        return;
      const targetId = encrypted.targetMessageKey?.id;
      if (!targetId || targetId === raw.key.id) return;
      const target = this.store.messageId(jid, targetId);
      const value = this.store.get("raw", target);
      if (!value) {
        this.store.put("raw", id, raw);
        return;
      }
      const original = toMessage(value);
      const decrypted = decryptEdit(
        original,
        raw,
        this.socket?.user?.id,
        (jid) => this.store.canonicalJid(jid),
      );
      if (!decrypted) {
        this.store.put("raw", id, raw);
        return;
      }
      const protocol = decrypted.protocolMessage;
      if (
        protocol &&
        (protocol.type !== proto.Message.ProtocolMessage.Type.MESSAGE_EDIT ||
          protocol.key?.id !== targetId)
      )
        return;
      const stored = this.ingest(
        {
          ...original,
          message: {
            ...decrypted,
            messageContextInfo: original.message?.messageContextInfo,
          },
        },
        source,
        eventTime ?? new Date().toISOString(),
      );
      this.store.removeMessageEvent(id);
      return stored;
    }
    if (content.protocolMessage) {
      const protocol = content.protocolMessage;
      if (
        protocol.type === proto.Message.ProtocolMessage.Type.REVOKE &&
        protocol.key?.id
      )
        this.store.eraseMessage(this.store.messageId(jid, protocol.key.id));
      if (protocol.editedMessage && protocol.key?.id)
        return this.ingest(
          {
            ...raw,
            key: { ...raw.key, id: protocol.key.id },
            message: protocol.editedMessage,
          },
          source,
          protocol.timestampMs && toNumber(protocol.timestampMs) > 0
            ? new Date(toNumber(protocol.timestampMs)).toISOString()
            : (editedAt ?? eventTime ?? new Date().toISOString()),
        );
      return;
    }
    const sender = this.store.canonicalJid(
      jidNormalizedUser(
        raw.key.fromMe
          ? this.socket?.user?.id || "owner"
          : raw.key.participant || raw.participant || jid,
      ),
    );
    const senderId = opaque("participant", sender);
    const prior = this.store.get("participant", senderId);
    const name = z.object({ name: z.string() }).safeParse(prior);
    const senderName =
      (name.success ? name.data.name : undefined) ||
      raw.pushName ||
      (name.success ? name.data.name : sender.split("@")[0] || "Unknown");
    this.store.put("participant", senderId, {
      ...(z.record(z.unknown()).safeParse(prior).success
        ? z.record(z.unknown()).parse(prior)
        : {}),
      id: senderId,
      jid: sender,
      name: senderName,
    });
    const body =
      content.imageMessage ||
      content.videoMessage ||
      content.documentMessage ||
      content.audioMessage ||
      content.stickerMessage ||
      content.extendedTextMessage;
    const context = body?.contextInfo;
    const text =
      content.reactionMessage?.text ??
      (content.conversation ||
        content.extendedTextMessage?.text ||
        content.imageMessage?.caption ||
        content.videoMessage?.caption ||
        content.documentMessage?.caption ||
        "");
    const type = getContentType(content) || "unsupported";
    const media =
      content.imageMessage ||
      content.videoMessage ||
      content.documentMessage ||
      content.audioMessage ||
      content.stickerMessage;
    const attachmentId = media ? opaque("attachment", id) : null;
    // HistorySync keeps the original sent timestamp even when the payload is an edit.
    const sentAt = editedAt && source !== "history" ? null : eventTime;
    const previous = this.store.findMessage(id);
    const existed = previous !== null;
    const saved = this.store.saveMessage({
      editedAt,
      updatedAt: new Date().toISOString(),
      id,
      chatId: chat.id,
      providerId: raw.key.id,
      senderId,
      senderName,
      direction: raw.key.fromMe ? "outgoing" : "incoming",
      sentAt,
      observedAt: new Date().toISOString(),
      text,
      contentType:
        type === "conversation" || type === "extendedTextMessage"
          ? "text"
          : type.replace("Message", ""),
      mentions: (context?.mentionedJid ?? []).map((v) =>
        opaque("participant", jidNormalizedUser(v)),
      ),
      replyId: content.reactionMessage?.key?.id
        ? this.store.messageId(
            content.reactionMessage.key.remoteJid || jid,
            content.reactionMessage.key.id,
          )
        : context?.stanzaId
          ? this.store.messageId(jid, context.stanzaId)
          : null,
      deleted: false,
      source,
      attachmentId,
      expiresAt:
        context?.expiration && sentAt
          ? new Date(
              Date.parse(sentAt) + context.expiration * 1000,
            ).toISOString()
          : null,
    });
    const current = this.store.message(id);
    if (current.deleted) return;
    if (!saved) {
      if (source === "history" && !previous?.sentAt && current.sentAt) {
        const retained = this.store.get("raw", id);
        if (retained)
          this.store.put("raw", id, {
            ...z.record(z.unknown()).parse(retained),
            messageTimestamp: Date.parse(current.sentAt) / 1000,
          });
      }
      return { id: current.id, added: false };
    }
    const previousRaw = this.store.get("raw", id);
    const previousMessage = previousRaw
      ? proto.WebMessageInfo.fromObject(previousRaw)
      : undefined;
    const secretContext = previousMessage?.message?.messageContextInfo;
    this.store.put(
      "raw",
      id,
      editedAt && secretContext
        ? {
            ...raw,
            message: { ...content, messageContextInfo: secretContext },
          }
        : raw,
    );
    if (media && attachmentId) {
      const meta = {
        id: attachmentId,
        chatId: chat.id,
        messageId: id,
        name: content.documentMessage?.fileName || type,
        mime: media.mimetype || "application/octet-stream",
        digest: null,
        size: Number(media.fileLength || 0),
        availability: "pending",
      } satisfies import("./media.js").Attachment;
      if (!this.store.attachments.get(attachmentId))
        this.store.attachments.register(meta);
      if (
        source === "live" &&
        this.socket &&
        meta.mime.startsWith("image/") &&
        meta.size <= 5 * 1024 * 1024 &&
        this.caching < 2
      ) {
        this.caching++;
        void this.download(attachmentId)
          .catch(() => {})
          .finally(() => {
            this.caching--;
          });
      }
    }
    return { id: this.store.message(id).id, added: !existed };
  }
  async download(id: string) {
    const parsed = this.store.attachments.get(id);
    if (!parsed?.messageId) throw new BridgeError("media_unavailable");
    const raw = this.store.get("raw", parsed.messageId);
    if (!raw) throw new Error("Media unavailable");
    const message = toMessage(raw);
    const download = (message: WAMessage) =>
      downloadMediaMessage(message, "stream", {
        options: { signal: AbortSignal.timeout(20000) },
      });
    const stream = await download(message).catch(async (error: unknown) => {
      if (!this.socket || ![403, 404, 410].includes(httpStatus(error) ?? 0))
        throw error;
      // rc14 throws Boom errors here but its retry path checks error.status.
      let refreshed: WAMessage;
      try {
        refreshed = await this.socket.updateMediaMessage(message);
      } catch (error) {
        if (httpStatus(error) === 404)
          throw new BridgeError(
            "media_unavailable",
            "WhatsApp could not provide this attachment. Its message and metadata remain available, but file bytes were not retrieved.",
          );
        throw error;
      }
      return download(refreshed);
    });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > 5 * 1024 * 1024) {
        stream.destroy();
        throw new Error("media_too_large");
      }
      chunks.push(chunk);
    }
    const current = this.store.attachments.get(id);
    if (!current || this.store.message(parsed.messageId).deleted)
      throw new BridgeError("media_unavailable");
    this.store.attachments.save(current, Buffer.concat(chunks));
  }
  async send(draft: Draft) {
    if (!this.socket || !this.connected) throw new Error("Offline");
    const chat = this.store.chat(draft.input.chat_id);
    const mentions = draft.input.mention_ids.map(
      (id) =>
        z.object({ jid: z.string() }).parse(this.store.get("participant", id))
          .jid,
    );
    const quote = draft.input.reply_to_message_id
      ? this.store.get("raw", draft.input.reply_to_message_id)
      : undefined;
    const options = quote ? { quoted: toMessage(quote) } : {};
    const aid = draft.input.attachment_ids[0];
    let content;
    if (aid) {
      const { meta, data } = this.store.attachments.read(aid);
      content =
        meta.mime === "image/png" || meta.mime === "image/jpeg"
          ? { image: data, caption: draft.input.text, mentions }
          : {
              document: data,
              mimetype: meta.mime,
              fileName: meta.name,
              caption: draft.input.text,
              mentions,
            };
    } else content = { text: draft.input.text, mentions };
    const result = await this.socket.sendMessage(chat.jid, content, options);
    if (!result?.key.id) throw new Error("No provider acknowledgment");
    return result.key.id;
  }
  stop() {
    this.history.close();
    this.stopping = true;
    this.connected = false;
    this.socket?.end(undefined);
  }
}
