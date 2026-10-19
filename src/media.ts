import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { BridgeError } from "./domain.js";
export const attachmentSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  messageId: z.string().nullable(),
  name: z.string(),
  mime: z.string(),
  digest: z.string().nullable(),
  size: z.number(),
  availability: z.enum(["pending", "stored", "unavailable"]),
});
export type Attachment = z.infer<typeof attachmentSchema>;
const columns =
  "id,chat_id AS chatId,message_id AS messageId,name,mime,digest,size,availability";
const digest = (data: Buffer) =>
  createHash("sha256").update(data).digest("hex");
export class MediaStore {
  constructor(
    private db: DatabaseSync,
    dir: string,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS attachments(
   id TEXT PRIMARY KEY,chat_id TEXT NOT NULL,message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
   name TEXT NOT NULL,mime TEXT NOT NULL,digest TEXT,size INTEGER NOT NULL,availability TEXT NOT NULL,
   data BLOB,CHECK(availability IN ('pending','stored','unavailable')),
   CHECK((availability='stored')=(data IS NOT NULL)),CHECK(data IS NULL OR length(data)=size));
   CREATE INDEX IF NOT EXISTS attachments_message ON attachments(message_id);
   CREATE INDEX IF NOT EXISTS attachments_chat ON attachments(chat_id);
   CREATE TRIGGER IF NOT EXISTS message_media_erased AFTER UPDATE OF value ON messages
   WHEN json_extract(new.value,'$.deleted')=1 BEGIN
    DELETE FROM attachments WHERE message_id=new.id;
    DELETE FROM objects WHERE kind='raw' AND id=new.id;
   END;
   CREATE TRIGGER IF NOT EXISTS attachment_live_insert BEFORE INSERT ON attachments
   WHEN EXISTS(SELECT 1 FROM messages WHERE id=new.message_id AND json_extract(value,'$.deleted')=1)
   BEGIN SELECT RAISE(ABORT,'message_deleted'); END;
   CREATE TRIGGER IF NOT EXISTS attachment_live_update BEFORE UPDATE ON attachments
   WHEN EXISTS(SELECT 1 FROM messages WHERE id=new.message_id AND json_extract(value,'$.deleted')=1)
   BEGIN SELECT RAISE(ABORT,'message_deleted'); END;`);
    this.migrateFiles(dir);
  }
  private migrateFiles(dir: string) {
    const rows = this.db
      .prepare("SELECT value FROM objects WHERE kind='attachment'")
      .all();
    if (rows.length) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const row of rows) {
          const meta = attachmentSchema.parse(
            JSON.parse(z.object({ value: z.string() }).parse(row).value),
          );
          if (meta.messageId) {
            let next: unknown;
            const seen = new Set<string>();
            while (!seen.has(meta.messageId)) {
              seen.add(meta.messageId);
              const alias = this.db
                .prepare(
                  "SELECT value FROM objects WHERE kind='message-alias' AND id=?",
                )
                .get(meta.messageId);
              next = alias
                ? JSON.parse(z.object({ value: z.string() }).parse(alias).value)
                : undefined;
              if (typeof next !== "string") break;
              meta.messageId = next;
            }
            const message = this.db
              .prepare(
                "SELECT json_extract(value,'$.deleted') AS deleted FROM messages WHERE id=?",
              )
              .get(meta.messageId);
            if (message?.deleted === 1) continue;
            if (!message) meta.messageId = null;
          }
          const path = join(dir, "media", meta.id);
          const data =
            meta.availability === "stored" && existsSync(path)
              ? readFileSync(path)
              : undefined;
          if (
            data &&
            (digest(data) !== meta.digest || data.length !== meta.size)
          )
            throw new Error(
              `Legacy attachment ${meta.id} failed integrity verification`,
            );
          this.write(
            {
              ...meta,
              availability: data
                ? "stored"
                : meta.availability === "stored"
                  ? "unavailable"
                  : meta.availability,
            },
            data,
          );
        }
        this.db.exec("DELETE FROM objects WHERE kind='attachment'; COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    }
    // Only remove legacy files once their metadata migration has committed.
    if (existsSync(join(dir, "media")))
      rmSync(join(dir, "media"), { recursive: true });
  }
  get(id: string): Attachment | undefined {
    const row = this.db
      .prepare(`SELECT ${columns} FROM attachments WHERE id=?`)
      .get(id);
    return row ? attachmentSchema.parse(row) : undefined;
  }
  register(meta: Omit<Attachment, "availability" | "digest">) {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO attachments(id,chat_id,message_id,name,mime,digest,size,availability,data) VALUES(?,?,?,?,?,NULL,?,'pending',NULL)",
      )
      .run(
        meta.id,
        meta.chatId,
        meta.messageId,
        meta.name,
        meta.mime,
        meta.size,
      );
  }
  private write(meta: Attachment, data?: Buffer) {
    this.db
      .prepare(
        `INSERT INTO attachments(id,chat_id,message_id,name,mime,digest,size,availability,data) VALUES(?,?,?,?,?,?,?,?,?)
   ON CONFLICT(id) DO UPDATE SET chat_id=excluded.chat_id,message_id=excluded.message_id,name=excluded.name,mime=excluded.mime,digest=excluded.digest,size=excluded.size,availability=excluded.availability,data=excluded.data`,
      )
      .run(
        meta.id,
        meta.chatId,
        meta.messageId,
        meta.name,
        meta.mime,
        meta.digest,
        meta.size,
        meta.availability,
        data ?? null,
      );
  }
  save(meta: Attachment, data: Buffer) {
    if (data.length > 5 * 1024 * 1024) throw new BridgeError("media_too_large");
    const row = this.db
      .prepare(
        "SELECT coalesce(sum(size),0)-coalesce((SELECT size FROM attachments WHERE id=? AND availability='stored'),0) AS used FROM attachments WHERE availability='stored'",
      )
      .get(meta.id);
    const used = z.object({ used: z.number() }).parse(row).used;
    if (used + data.length > 512 * 1024 * 1024)
      throw new BridgeError("storage_quota_exceeded");
    this.write(
      {
        ...meta,
        size: data.length,
        digest: digest(data),
        availability: "stored",
      },
      data,
    );
  }
  read(id: string) {
    const meta = this.get(id);
    if (!meta || meta.availability !== "stored")
      throw new BridgeError("media_unavailable");
    const row = z
      .object({ data: z.instanceof(Uint8Array) })
      .parse(
        this.db.prepare("SELECT data FROM attachments WHERE id=?").get(id),
      );
    const data = Buffer.from(row.data);
    if (digest(data) !== meta.digest)
      throw new BridgeError("media_unavailable");
    return { meta, data };
  }
}
