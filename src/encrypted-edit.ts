import { hkdfSync } from "node:crypto";
import {
  aesDecryptGCM,
  jidNormalizedUser,
  normalizeMessageContent,
  proto,
  type WAMessage,
} from "@whiskeysockets/baileys";

// Protocol reference: https://github.com/tulir/whatsmeow/blob/main/msgsecret.go
export function decryptEdit(
  original: WAMessage,
  edit: WAMessage,
  ownJid?: string,
  canonicalJid: (jid: string) => string = (jid) => jid,
) {
  const encrypted = normalizeMessageContent(
    edit.message,
  )?.secretEncryptedMessage;
  const target = encrypted?.targetMessageKey;
  const secret = original.message?.messageContextInfo?.messageSecret;
  if (
    encrypted?.secretEncType !==
      proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT ||
    !target?.id ||
    target.id !== original.key.id ||
    canonicalJid(original.key.remoteJid ?? "") !==
      canonicalJid(edit.key.remoteJid ?? "") ||
    (target.remoteJid &&
      canonicalJid(target.remoteJid) !==
        canonicalJid(edit.key.remoteJid ?? "")) ||
    !secret ||
    !encrypted.encPayload ||
    !encrypted.encIv
  )
    return null;
  const sender = (message: WAMessage) =>
    jidNormalizedUser(
      message.key.participant ||
        message.participant ||
        (message.key.fromMe ? ownJid : message.key.remoteJid) ||
        "",
    );
  const editor = sender(edit);
  const author = sender(original);
  if (!editor || !author) return null;
  const claimedAuthor = target.fromMe
    ? editor
    : jidNormalizedUser(target.participant || target.remoteJid || "");
  for (const creator of new Set([claimedAuthor, author])) {
    if (!creator) continue;
    const key = Buffer.from(
      hkdfSync(
        "sha256",
        secret,
        Buffer.alloc(0),
        Buffer.from(`${target.id}${creator}${editor}Message Edit`),
        32,
      ),
    );
    try {
      return proto.Message.decode(
        aesDecryptGCM(
          encrypted.encPayload,
          key,
          encrypted.encIv,
          Buffer.alloc(0),
        ),
      );
    } catch {
      // PN/LID transitions can require the original stored sender identity.
    }
  }
  return null;
}
