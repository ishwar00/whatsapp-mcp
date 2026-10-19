import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, opaque, hash } from "../src/store.js";
import { WhatsApp } from "../src/whatsapp.js";
import { Service } from "../src/service.js";
import { querySchema, type Message, type Principal } from "../src/domain.js";
const lid = "777@lid",
  pn = "555@s.whatsapp.net",
  group = "120000@g.us";
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "wa-identity-"));
  const store = new Store(dir),
    wa = new WhatsApp(store);
  const p: Principal = {
    id: "agent",
    name: "Agent",
    tokenHash: hash("key"),
    enabled: true,
    canDraft: true,
    canSend: true,
  };
  store.put("client", p.id, p);
  const sent: string[] = [];
  const service = new Service(store, {
    connected: true,
    ownerIds: ["me"],
    send: async (d) => {
      sent.push(d.id);
      return "ack";
    },
  });
  const ingest = (
    jid: string,
    id: string,
    text: string,
    extra: Record<string, unknown> = {},
  ) =>
    wa.ingest(
      {
        key: { remoteJid: jid, id, fromMe: false },
        messageTimestamp: 1700000000,
        message: { conversation: text },
        ...extra,
      },
      "history",
    );
  return {
    dir,
    store,
    wa,
    p,
    service,
    sent,
    ingest,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("history group senders work in both locations and stored misattribution is repaired without replaying content", () => {
  const f = setup();
  try {
    f.ingest(group, "history", "original", {
      participant: pn,
      pushName: "Actual sender",
    });
    const id = f.store.messageId(group, "history");
    assert.equal(f.store.message(id).senderId, opaque("participant", pn));
    f.ingest(group, "live", "live", {
      key: { remoteJid: group, id: "live", participant: pn, fromMe: false },
    });
    assert.equal(
      f.store.message(f.store.messageId(group, "live")).senderId,
      opaque("participant", pn),
    );
    f.store.saveMessage({
      ...f.store.message(id),
      text: "edited content",
      editedAt: "2026-10-18T00:00:00Z",
    });
    f.store.repairSender(id, opaque("participant", group), "wrong");
    f.wa.repairHistoricalSenders();
    assert.equal(f.store.message(id).senderId, opaque("participant", pn));
    assert.equal(f.store.message(id).text, "edited content");
    assert.equal(f.store.message(id).editedAt, "2026-10-18T00:00:00Z");
  } finally {
    f.close();
  }
});
test("late identity merge deduplicates, preserves edits, files, quotes and immutable approved drafts across restart", async () => {
  const f = setup();
  try {
    f.ingest(lid, "same", "old", { pushName: "Client" });
    f.ingest(pn, "same", "old", { pushName: "Client" });
    const oldChat = opaque("chat", lid),
      oldId = f.store.messageId(lid, "same"),
      keep = f.store.messageId(pn, "same");
    f.store.saveMessage({
      ...f.store.message(oldId),
      text: "new edit",
      editedAt: "2026-10-18T00:00:00Z",
    });
    const aid = "file";
    f.store.saveMedia(
      {
        id: aid,
        chatId: oldChat,
        messageId: oldId,
        name: "proof.pdf",
        mime: "application/pdf",
        digest: null,
        size: 0,
        availability: "pending",
      },
      Buffer.from("original file bytes"),
    );
    f.store.saveMessage({
      ...f.store.message(oldId),
      attachmentId: aid,
      editedAt: "2026-10-18T00:00:01Z",
    });
    const draft = f.service.createDraft(f.p, {
      chat_id: oldChat,
      text: "reply",
      reply_to_message_id: oldId,
      attachment_ids: [aid],
      request_id: "immutable",
    });
    const frozen = JSON.stringify(draft);
    f.store.addAlias(lid, pn);
    assert.equal(f.store.chats().length, 1);
    assert.equal(f.store.messages([oldChat]).length, 1);
    assert.equal(f.store.message(oldId).id, keep);
    assert.equal(f.store.message(oldId).text, "new edit");
    assert.equal(f.store.message(oldId).attachmentId, aid);
    assert.equal(f.store.media(aid).data.toString(), "original file bytes");
    assert.equal(f.store.media(aid).meta.messageId, keep);
    assert.equal(JSON.stringify(f.store.draft(draft.id)), frozen);
    assert.equal(f.service.context(f.p, oldChat, oldId).messages[0]?.id, keep);
    f.service.validateReferences(f.p, draft.input);
    assert.ok(f.store.get("raw", oldId));
    f.ingest(lid, "same", "stale replay");
    f.ingest(pn, "same", "stale replay");
    assert.equal(f.store.messages([oldChat]).length, 1);
    assert.equal(f.store.message(oldId).text, "new edit");
    f.store.addAlias(lid, pn);
    assert.equal(
      (
        await f.service.sendDraft(
          f.p,
          draft.id,
          draft.digest,
          "Client",
          "reply",
          ["proof.pdf"],
        )
      ).status,
      "accepted",
    );
    const accepted = JSON.stringify(f.store.draft(draft.id));
    f.store.close();
    const reopened = new Store(f.dir);
    assert.equal(reopened.messages([oldChat]).length, 1);
    assert.equal(JSON.stringify(reopened.draft(draft.id)), accepted);
    reopened.close();
  } finally {
    f.close();
  }
});
test("deletion wins over duplicate edits and removes retained duplicate media", () => {
  const f = setup();
  try {
    f.ingest(lid, "same", "deleted");
    f.ingest(pn, "same", "stale copy");
    const id = f.store.messageId(pn, "same");
    f.store.saveMedia(
      {
        id: "dup-file",
        chatId: opaque("chat", pn),
        messageId: id,
        name: "secret",
        mime: "text/plain",
        digest: null,
        size: 0,
        availability: "pending",
      },
      Buffer.from("secret"),
    );
    f.store.saveMessage({ ...f.store.message(id), attachmentId: "dup-file" });
    const old = f.store.messageId(lid, "same");
    f.store.eraseMessage(old);
    f.store.addAlias(lid, pn);
    assert.equal(f.store.message(old).deleted, true);
    assert.equal(f.store.message(old).text, "");
    assert.equal(f.store.get("raw", id), undefined);
    assert.equal(f.store.get("attachment", "dup-file"), undefined);
    f.ingest(pn, "same", "resurrection");
    assert.equal(f.store.message(id).deleted, true);
  } finally {
    f.close();
  }
});
test("verified alternate addresses merge early, future replies and reactions resolve both IDs, and unrelated identities stay separate", () => {
  const f = setup();
  try {
    f.ingest(lid, "first", "one", {
      key: { remoteJid: lid, remoteJidAlt: pn, id: "first", fromMe: false },
    });
    f.ingest(pn, "first", "one");
    assert.equal(f.store.chats().length, 1);
    assert.equal(f.store.messages([opaque("chat", pn)]).length, 1);
    f.ingest(lid, "reaction", "", {
      message: {
        reactionMessage: {
          text: "👍",
          key: { remoteJid: lid, id: "first", fromMe: false },
        },
      },
    });
    const r = f.store.message(f.store.messageId(lid, "reaction"));
    assert.equal(r.replyId, f.store.messageId(pn, "first"));
    assert.equal(r.text, "👍");
    f.ingest("888@lid", "unrelated", "two");
    assert.equal(f.store.chats().length, 2);
    assert.throws(
      () => f.store.addAlias(lid, "999@s.whatsapp.net"),
      /Conflicting/,
    );
    f.store.addAlias(group, pn);
    assert.equal(f.store.get("alias", group), undefined);
  } finally {
    f.close();
  }
});
test("migration repairs an existing alias-only database and is idempotent", () => {
  const f = setup();
  try {
    f.ingest(lid, "same", "old");
    f.ingest(pn, "same", "old");
    f.store.db
      .prepare("INSERT INTO objects VALUES('alias',?,?)")
      .run(lid, JSON.stringify(pn));
    f.store.close();
    for (let n = 0; n < 2; n++) {
      const migrated = new Store(f.dir);
      assert.equal(migrated.chats().length, 1);
      assert.equal(migrated.messages([opaque("chat", lid)]).length, 1);
      migrated.close();
    }
  } finally {
    f.close();
  }
});
test("encrypted edits survive a verified LID to phone transition without accepting an unrelated chat", async () => {
  const { hkdfSync, createCipheriv } = await import("node:crypto");
  const { proto } = await import("@whiskeysockets/baileys");
  const f = setup();
  try {
    const secret = Buffer.alloc(32, 7);
    f.ingest(lid, "original", "old", {
      message: {
        conversation: "old",
        messageContextInfo: { messageSecret: secret },
      },
    });
    const original = f.store.messageId(lid, "original");
    f.store.addAlias(lid, pn);
    const payload = proto.Message.encode({
      protocolMessage: {
        type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
        key: { id: "original" },
        editedMessage: { conversation: "edited after merge" },
        timestampMs: 1800000000000,
      },
    }).finish();
    const derived = Buffer.from(
      hkdfSync(
        "sha256",
        secret,
        Buffer.alloc(0),
        Buffer.from(`original${pn}${pn}Message Edit`),
        32,
      ),
    );
    const iv = Buffer.alloc(12, 2),
      cipher = createCipheriv("aes-256-gcm", derived, iv);
    const encPayload = Buffer.concat([
      cipher.update(payload),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    f.ingest(pn, "encrypted", "", {
      messageTimestamp: 1800000000,
      message: {
        secretEncryptedMessage: {
          secretEncType:
            proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT,
          targetMessageKey: { remoteJid: pn, id: "original", fromMe: true },
          encIv: iv,
          encPayload,
        },
      },
    });
    assert.equal(f.store.message(original).text, "edited after merge");
    assert.equal(f.store.messages([opaque("chat", pn)]).length, 1);
    assert.equal(
      f.store.message(original).sentAt,
      new Date(1700000000000).toISOString(),
    );
  } finally {
    f.close();
  }
});
test("merged mentions, old quote IDs and deletion through an old ID remain valid", () => {
  const f = setup();
  try {
    f.ingest(lid, "anchor", "original");
    f.ingest(pn, "anchor", "original");
    const oldId = f.store.messageId(lid, "anchor");
    f.ingest(lid, "reply", "", {
      message: {
        extendedTextMessage: {
          text: "reply",
          contextInfo: { stanzaId: "anchor", mentionedJid: [lid] },
        },
      },
    });
    const replyId = f.store.messageId(lid, "reply");
    f.store.addAlias(lid, pn);
    const canonical = f.store.messageId(pn, "anchor");
    const reply = f.store.message(replyId);
    assert.deepEqual(reply.mentions, [opaque("participant", pn)]);
    assert.equal(
      f.service.context(f.p, opaque("chat", lid), replyId).quoted?.id,
      canonical,
    );
    assert.equal(
      f.service.read(f.p, { reply_to_ids: [oldId] }).messages.length,
      1,
    );
    assert.equal(
      f.service.read(f.p, { mention_ids: [opaque("participant", lid)] })
        .messages.length,
      1,
    );
    f.service.validateReferences(f.p, {
      chat_id: opaque("chat", lid),
      text: "reply",
      request_id: "test",
      attachment_ids: [],
      mention_ids: [opaque("participant", lid)],
      reply_to_message_id: oldId,
    });
    f.store.eraseMessage(oldId);
    assert.equal(f.store.message(canonical).deleted, true);
    assert.equal(f.store.get("raw", canonical), undefined);
  } finally {
    f.close();
  }
});
test("deletion after merging removes every attachment copy and blocks stale metadata reads", () => {
  const f = setup();
  try {
    for (const [jid, aid] of [
      [lid, "lid-file"],
      [pn, "pn-file"],
    ] as const) {
      f.ingest(jid, "same", "file");
      const id = f.store.messageId(jid, "same");
      f.store.saveMedia(
        {
          id: aid,
          chatId: opaque("chat", jid),
          messageId: id,
          name: "proof.pdf",
          mime: "application/pdf",
          digest: null,
          size: 0,
          availability: "pending",
        },
        Buffer.from("bytes"),
      );
      f.store.saveMessage({ ...f.store.message(id), attachmentId: aid });
    }
    const old = f.store.messageId(lid, "same");
    f.store.addAlias(lid, pn);
    assert.equal(f.store.media("lid-file").data.length, 5);
    assert.equal(f.store.media("pn-file").data.length, 5);
    f.store.eraseMessage(old);
    for (const aid of ["lid-file", "pn-file"]) {
      assert.equal(f.store.get("attachment", aid), undefined);
      assert.throws(() => f.service.attachment(f.p, aid));
      assert.throws(() => f.store.media(aid));
    }
    // Stale metadata from a pre-fix database must not make deleted media readable.
    f.store.saveMedia(
      {
        id: "stale",
        chatId: opaque("chat", pn),
        messageId: old,
        name: "old.pdf",
        mime: "application/pdf",
        digest: null,
        size: 0,
        availability: "pending",
      },
      Buffer.from("stale"),
    );
    assert.throws(
      () => f.service.attachment(f.p, "stale"),
      /media_unavailable/,
    );
    f.store.eraseMessage(old);
    assert.equal(f.store.get("attachment", "stale"), undefined);
  } finally {
    f.close();
  }
});
