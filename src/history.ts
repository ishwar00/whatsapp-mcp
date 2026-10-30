import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { BridgeError } from "./domain.js";
import type { Store } from "./store.js";

export function resolveHistoryMode(options: {
  override?: string;
  saved: unknown;
  paired: boolean;
}) {
  return z
    .enum(["desktop", "recent"])
    .parse(
      options.override ??
        options.saved ??
        (options.paired ? "recent" : "desktop"),
    );
}

export const historyInput = z
  .object({
    chat_id: z.string(),
    sent_at: z
      .object({
        from: z.string().datetime({ offset: true }),
        to: z.string().datetime({ offset: true }),
      })
      .optional(),
    max_batches: z.number().int().min(1).max(10).default(3),
  })
  .strict();
const jobSchema = z.object({
  id: z.string(),
  chat_id: z.string(),
  sent_at: historyInput.shape.sent_at,
  max_batches: z.number(),
  state: z.enum([
    "queued",
    "running",
    "target_reached",
    "batch_limit",
    "no_progress",
    "timed_out",
    "no_anchor",
    "offline",
    "failed",
    "interrupted",
  ]),
  batches_requested: z.number(),
  messages_added: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
  error: z.string().nullable(),
});
type Job = z.infer<typeof jobSchema>;
type Signal = { chats: string[]; requestId?: string | null };

export class HistorySync {
  private active = new Map<string, Job>();
  private queue: Promise<void> = Promise.resolve();
  private waiter: {
    chat: string;
    requestId?: string;
    earlyIds: Set<string>;
    finish: (received: boolean) => void;
  } | null = null;
  private closed = false;
  constructor(
    private store: Store,
    private source: {
      connected: () => boolean;
      request: (chat: string, count: number) => Promise<{ requestId: string }>;
    },
    private waitMs = 30_000,
  ) {
    for (const value of store.all("history-job")) {
      const job = jobSchema.parse(value);
      if (job.state === "running" || job.state === "queued") {
        job.state = "interrupted";
        this.save(job);
      }
    }
  }
  private save(job: Job) {
    job.updated_at = new Date().toISOString();
    this.store.put("history-job", job.id, job);
  }
  private trimJobs() {
    const completed = this.store
      .all("history-job")
      .map((v) => jobSchema.parse(v))
      .filter((j) => j.state !== "running" && j.state !== "queued")
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    for (const old of completed.slice(100))
      this.store.remove("history-job", old.id);
  }
  start(input: unknown) {
    if (this.closed) throw new BridgeError("service_offline");
    const q = historyInput.parse(input);
    this.store.expire();
    if (q.sent_at && Date.parse(q.sent_at.from) >= Date.parse(q.sent_at.to))
      throw new BridgeError("invalid_argument", "Time range must increase");
    const chat = this.store.chat(q.chat_id).id;
    const existing = [...this.active.values()].find(
      (j) => this.store.chatId(j.chat_id) === chat,
    );
    if (existing) return this.get(existing.id);
    if (this.active.size >= 10)
      throw new BridgeError(
        "busy",
        "Too many history requests; poll existing jobs first",
      );
    const now = new Date().toISOString();
    const job: Job = {
      ...q,
      chat_id: chat,
      id: `history_${randomUUID()}`,
      state: "queued",
      batches_requested: 0,
      messages_added: 0,
      created_at: now,
      updated_at: now,
      error: null,
    };
    this.save(job);
    this.active.set(job.id, job);
    this.queue = this.queue.then(() => this.run(job));
    return this.get(job.id);
  }
  get(id: string) {
    const value = this.store.get("history-job", id);
    if (!value) throw new BridgeError("not_found_or_not_permitted");
    const job = jobSchema.parse(value);
    return {
      ...job,
      coverage: this.store.historyCoverage(job.chat_id),
      note: "Date bounds describe stored messages, not continuous coverage. A timeout or no progress does not prove there are no older messages. Read/search again without a page cursor after sync.",
    };
  }
  received(signal: Signal) {
    const waiter = this.waiter;
    if (!waiter) return;
    if (signal.requestId && !waiter.requestId && waiter.earlyIds.size < 100)
      waiter.earlyIds.add(signal.requestId);
    const matches =
      signal.requestId && waiter.requestId
        ? signal.requestId === waiter.requestId
        : signal.chats.some(
            (chat) =>
              this.store.chatId(chat) === this.store.chatId(waiter.chat),
          );
    if (matches) waiter.finish(true);
  }
  private async run(job: Job) {
    if (this.closed) return;
    job.state = "running";
    this.save(job);
    try {
      for (let n = 0; n < job.max_batches && !this.closed; n++) {
        if (!this.source.connected()) {
          job.state = "offline";
          break;
        }
        const before = this.store.historyCoverage(job.chat_id);
        if (
          job.sent_at &&
          before.oldest_message_at &&
          Date.parse(before.oldest_message_at) <= Date.parse(job.sent_at.from)
        ) {
          job.state = "target_reached";
          break;
        }
        let finish!: (received: boolean) => void;
        const arrival = new Promise<boolean>((resolve) => {
          finish = resolve;
        });
        const timer = setTimeout(() => finish(false), this.waitMs);
        this.waiter = { chat: job.chat_id, finish, earlyIds: new Set() };
        let received: boolean;
        try {
          // Start the waiter before dispatch: history may arrive before the request returns.
          const result = await Promise.race([
            this.source.request(job.chat_id, 50),
            arrival.then(() => null),
          ]);
          if (result) {
            job.batches_requested++;
            this.save(job);
            if (this.waiter) {
              this.waiter.requestId = result.requestId;
              if (this.waiter.earlyIds.has(result.requestId))
                this.waiter.finish(true);
            }
          }
          received = await arrival;
          if (!result && received) job.batches_requested++;
        } finally {
          clearTimeout(timer);
          this.waiter = null;
        }
        // History responses can contain multiple chunks; allow the arriving batch to settle.
        if (received) await delay(750);
        if (this.closed) return;
        const after = this.store.historyCoverage(job.chat_id);
        job.messages_added += Math.max(
          0,
          after.stored_messages - before.stored_messages,
        );
        if (!received) {
          job.state = this.source.connected() ? "timed_out" : "offline";
          break;
        }
        if (
          !after.oldest_message_at ||
          (before.oldest_message_at &&
            Date.parse(after.oldest_message_at) >=
              Date.parse(before.oldest_message_at))
        ) {
          job.state = "no_progress";
          break;
        }
        job.state =
          job.sent_at &&
          Date.parse(after.oldest_message_at) <= Date.parse(job.sent_at.from)
            ? "target_reached"
            : n + 1 === job.max_batches
              ? "batch_limit"
              : "running";
        this.save(job);
        if (job.state !== "running") break;
      }
    } catch (error) {
      job.state =
        error instanceof BridgeError && error.code === "history_anchor_missing"
          ? "no_anchor"
          : "failed";
      job.error =
        error instanceof BridgeError
          ? error.message
          : "History request failed; check service diagnostics";
      process.stderr.write(
        `History job ${job.id}: ${error instanceof Error ? error.message : "request failed"}\n`,
      );
    } finally {
      if (!this.closed) {
        this.save(job);
        this.trimJobs();
      }
      this.active.delete(job.id);
    }
  }
  close() {
    this.closed = true;
    this.waiter?.finish(false);
    for (const job of this.active.values()) {
      job.state = "interrupted";
      this.save(job);
    }
    this.active.clear();
  }
}
