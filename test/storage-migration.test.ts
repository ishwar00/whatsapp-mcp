import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync, backup } from "node:sqlite";
import { Store, hash } from "../src/store.js";
import { type Attachment } from "../src/media.js";
const meta = (id: string): Attachment => ({
  id,
  chatId: "chat",
  messageId: null,
  name: id + ".pdf",
  mime: "application/pdf",
  size: 0,
  digest: null,
  availability: "pending",
});
function legacy(corrupt = false) {
  const dir = mkdtempSync(join(tmpdir(), "wa-storage-migration-"));
  const s = new Store(dir);
  mkdirSync(join(dir, "media"));
  for (const id of ["one", "two"]) {
    const data = Buffer.from(id + " original bytes");
    s.put("attachment", id, {
      ...meta(id),
      availability: "stored",
      size: data.length,
      digest: hash(data),
    });
    writeFileSync(
      join(dir, "media", id),
      corrupt && id === "two" ? Buffer.from("corrupt") : data,
    );
  }
  s.put("draft", "unchanged", {
    input: "opaque frozen payload",
    digest: "unchanged",
  });
  s.close();
  return dir;
}
test("legacy file migration preserves exact IDs, metadata, bytes and opaque drafts and is repeatable", () => {
  const dir = legacy();
  try {
    const s = new Store(dir);
    for (const id of ["one", "two"])
      assert.equal(
        s.attachments.read(id).data.toString(),
        id + " original bytes",
      );
    assert.deepEqual(s.get("draft", "unchanged"), {
      input: "opaque frozen payload",
      digest: "unchanged",
    });
    assert.equal(s.all("attachment").length, 0);
    assert.equal(existsSync(join(dir, "media")), false);
    assert.deepEqual(s.db.prepare("PRAGMA foreign_key_check").all(), []);
    s.close();
    const again = new Store(dir);
    assert.equal(
      again.attachments.read("one").data.toString(),
      "one original bytes",
    );
    again.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("corrupt legacy bytes roll the entire migration back and keep source files for repair and retry", () => {
  const dir = legacy(true);
  try {
    assert.throws(() => new Store(dir), /integrity verification/);
    const db = new DatabaseSync(join(dir, "bridge.sqlite"));
    assert.equal(
      db.prepare("SELECT count(*) n FROM objects WHERE kind='attachment'").get()
        ?.n,
      2,
    );
    assert.equal(db.prepare("SELECT count(*) n FROM attachments").get()?.n, 0);
    db.close();
    assert.equal(
      readFileSync(join(dir, "media", "one")).toString(),
      "one original bytes",
    );
    writeFileSync(join(dir, "media", "two"), Buffer.from("two original bytes"));
    const repaired = new Store(dir);
    assert.equal(
      repaired.attachments.read("two").data.toString(),
      "two original bytes",
    );
    repaired.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("bytes and metadata roll back together; overwrites replace quota usage and oversized writes leave original bytes", () => {
  const dir = mkdtempSync(join(tmpdir(), "wa-storage-transaction-"));
  const s = new Store(dir);
  try {
    assert.throws(
      () =>
        s.transaction(() => {
          s.attachments.save(meta("rolled-back"), Buffer.from("bytes"));
          throw Error("rollback");
        }),
      /rollback/,
    );
    assert.equal(s.attachments.get("rolled-back"), undefined);
    s.attachments.save(meta("replacement"), Buffer.alloc(100));
    s.attachments.save(meta("replacement"), Buffer.alloc(50));
    assert.equal(
      s.db.prepare("SELECT sum(length(data)) used FROM attachments").get()
        ?.used,
      50,
    );
    assert.throws(
      () =>
        s.attachments.save(
          meta("replacement"),
          Buffer.alloc(5 * 1024 * 1024 + 1),
        ),
      /media_too_large/,
    );
    assert.equal(s.attachments.read("replacement").data.length, 50);
    assert.throws(
      () =>
        s.attachments.save(
          { ...meta("orphan"), messageId: "missing" },
          Buffer.from("bytes"),
        ),
      /FOREIGN KEY/,
    );
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("a single SQLite backup restores media bytes without any media directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wa-storage-backup-"));
  const dest = mkdtempSync(join(tmpdir(), "wa-storage-restore-"));
  const s = new Store(dir);
  try {
    s.attachments.save(meta("backup"), Buffer.from("backup proof"));
    await backup(s.db, join(dest, "bridge.sqlite"));
    const restored = new Store(dest);
    assert.equal(
      restored.attachments.read("backup").data.toString(),
      "backup proof",
    );
    assert.equal(existsSync(join(dest, "media")), false);
    restored.close();
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});
test("failed inline draft creation leaves neither a draft nor orphan attachment bytes", async () => {
  const { Service } = await import("../src/service.js");
  const dir = mkdtempSync(join(tmpdir(), "wa-draft-rollback-"));
  const s = new Store(dir);
  try {
    const p = {
      id: "agent",
      name: "Agent",
      enabled: true,
      canDraft: true,
      canSend: false,
      tokenHash: hash("key"),
    };
    s.put("client", p.id, p);
    const chat = s.saveChat("111@s.whatsapp.net", "Client");
    const service = new Service(s, {
      connected: false,
      ownerIds: [],
      send: async () => {
        throw Error("no sends");
      },
    });
    s.saveDraft = () => {
      throw Error("simulated failure after media insert");
    };
    assert.throws(
      () =>
        service.createDraft(p, {
          chat_id: chat.id,
          text: "file",
          request_id: "rollback",
          attachment: {
            name: "proof.pdf",
            mime_type: "application/pdf",
            data: Buffer.from("inline bytes").toString("base64"),
          },
        }),
      /simulated failure/,
    );
    assert.equal(
      s.db.prepare("SELECT count(*) n FROM attachments").get()?.n,
      0,
    );
    assert.equal(s.db.prepare("SELECT count(*) n FROM requests").get()?.n, 0);
    assert.equal(s.drafts().length, 0);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("orphaned legacy attachments retain their bytes as unattached records instead of blocking startup", () => {
  const dir = legacy();
  try {
    const db = new DatabaseSync(join(dir, "bridge.sqlite"));
    db.prepare(
      "UPDATE objects SET value=json_set(value,'$.messageId','missing-message') WHERE kind='attachment' AND id='one'",
    ).run();
    db.close();
    const s = new Store(dir);
    assert.equal(
      s.attachments.read("one").data.toString(),
      "one original bytes",
    );
    assert.equal(s.attachments.get("one")?.messageId, null);
    assert.deepEqual(s.db.prepare("PRAGMA foreign_key_check").all(), []);
    s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("backup command preserves an unmigrated corrupt source without opening Store or removing source files", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const dir = legacy(true),
    dest = mkdtempSync(join(tmpdir(), "wa-before-upgrade-"));
  try {
    await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "src/owner.ts", "backup", dest],
      { env: { ...process.env, BRIDGE_DATA_DIR: dir } },
    );
    for (const folder of [dir, dest]) {
      const db = new DatabaseSync(join(folder, "bridge.sqlite"), {
        readOnly: true,
      });
      assert.equal(
        db
          .prepare("SELECT count(*) n FROM objects WHERE kind='attachment'")
          .get()?.n,
        2,
      );
      assert.equal(
        db.prepare("SELECT count(*) n FROM attachments").get()?.n,
        0,
      );
      db.close();
      assert.equal(
        readFileSync(join(folder, "media", "two")).toString(),
        "corrupt",
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(dest, { recursive: true, force: true });
  }
});
test("registering an already stored attachment cannot discard its bytes or change availability", () => {
  const dir = mkdtempSync(join(tmpdir(), "wa-register-"));
  const s = new Store(dir);
  try {
    s.attachments.save(meta("stored"), Buffer.from("bytes"));
    s.attachments.register(meta("stored"));
    assert.equal(s.attachments.read("stored").data.toString(), "bytes");
    assert.equal(s.attachments.get("stored")?.availability, "stored");
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
