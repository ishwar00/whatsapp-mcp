import { randomUUID } from "node:crypto";
import { z } from "zod";
import { BridgeError, type Message } from "./domain.js";
import type { Store } from "./store.js";

export function resolveHistoryMode(options: {
  override?: string;
  saved: unknown;
  paired: boolean;
}) {
  const saved = options.saved === "desktop" ? "full" : options.saved;
  return z
    .enum(["full", "recent"])
    .parse(options.override ?? saved ?? (options.paired ? "recent" : "full"));
}

export const historyInput = z
  .object({
    chat_id: z.string(),
    before_message_id: z.string().optional(),
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
  before_message_id: historyInput.shape.before_message_id,
  max_batches: z.number(),
  state: z.enum([
    "queued",
    "running",
    "target_reached",
    "batch_limit",
    "no_progress",
    "timed_out",
    "response_incomplete",
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
  anchor_message_id: z.string().nullable().default(null),
  next_message_id: z.string().nullable().default(null),
  traversed_from: z.string().nullable().default(null),
  traversed_to: z.string().nullable().default(null),
  response_progress: z.number().nullable().default(null),
});
type Job = z.infer<typeof jobSchema>;
export type HistoryChunk = {
  requestId?: string | null;
  progress?: number | null;
  messages: { id: string; added: boolean }[];
};
type Batch = {
  ids: Set<string>;
  added: Set<string>;
  progress: number | null;
  complete: boolean;
};
type End = "complete" | "deadline" | "interrupted";
type Waiter = {
  job: Job;
  requestId: string | null;
  batches: Map<string, Batch>;
  baseAdded: number;
  finish: (end: End) => void;
};

export class HistorySync {
  private active = new Map<string, Job>();
  private queue: Promise<void> = Promise.resolve();
  private waiter: Waiter | null = null;
  private closed = false;
  constructor(
    private store: Store,
    private source: {
      connected: () => boolean;
      request: (
        chat: string,
        count: number,
        anchorId: string,
      ) => Promise<{ requestId: string }>;
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
    if (existing) {
      if (
        JSON.stringify([
          existing.sent_at,
          existing.before_message_id,
          existing.max_batches,
        ]) !== JSON.stringify([q.sent_at, q.before_message_id, q.max_batches])
      )
        throw new BridgeError(
          "busy",
          `History job ${existing.id} already has a different scope; poll it before starting another request for this chat`,
        );
      return this.get(existing.id);
    }
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
      anchor_message_id: null,
      next_message_id: null,
      traversed_from: null,
      traversed_to: null,
      response_progress: null,
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
      note: "Stored bounds are not continuous coverage. traversed_from/to describe completed matching responses only. A timeout, incomplete response, or no progress never proves there are no older messages. Read/search locally with a fresh page cursor after sync.",
    };
  }
  received(chunk: HistoryChunk) {
    const waiter = this.waiter;
    // Request IDs are authoritative, including before dispatch returns. Never fall back to chat identity.
    if (
      !waiter ||
      !chunk.requestId ||
      (waiter.requestId && chunk.requestId !== waiter.requestId)
    )
      return;
    if (!waiter.batches.has(chunk.requestId) && waiter.batches.size >= 64)
      return;
    const batch = waiter.batches.get(chunk.requestId) ?? {
      ids: new Set<string>(),
      added: new Set<string>(),
      progress: null,
      complete: false,
    };
    for (const item of chunk.messages) {
      const message = this.store.findMessage(item.id);
      if (
        !message ||
        message.deleted ||
        message.chatId !== this.store.chatId(waiter.job.chat_id)
      )
        continue;
      batch.ids.add(message.id);
      if (item.added) batch.added.add(message.id);
    }
    batch.progress = chunk.progress ?? batch.progress;
    batch.complete ||= chunk.progress === 100;
    waiter.batches.set(chunk.requestId, batch);
    if (waiter.requestId === chunk.requestId) this.publish(waiter, batch);
  }
  private publish(waiter: Waiter, batch: Batch) {
    waiter.job.messages_added = waiter.baseAdded + batch.added.size;
    waiter.job.response_progress = batch.progress;
    this.save(waiter.job);
    if (batch.complete) waiter.finish("complete");
  }
  private async requestBatch(job: Job, anchorId: string) {
    job.response_progress = null;
    this.save(job);
    let finish!: (end: End) => void;
    const end = new Promise<End>((resolve) => {
      finish = resolve;
    });
    const timer = setTimeout(() => finish("deadline"), this.waitMs);
    const waiter: Waiter = {
      job,
      requestId: null,
      batches: new Map(),
      baseAdded: job.messages_added,
      finish,
    };
    this.waiter = waiter;
    try {
      const dispatch = await Promise.race([
        this.source
          .request(job.chat_id, 50, anchorId)
          .then((result) => ({ kind: "dispatched" as const, ...result })),
        end.then((kind) => ({ kind })),
      ]);
      if (dispatch.kind !== "dispatched")
        return { end: dispatch.kind, batch: null };
      if (this.closed) return { end: "interrupted" as const, batch: null };
      waiter.requestId = dispatch.requestId;
      job.batches_requested++;
      this.save(job);
      const early = waiter.batches.get(dispatch.requestId);
      if (early) this.publish(waiter, early);
      const outcome = await end;
      return {
        end: outcome,
        batch: waiter.batches.get(dispatch.requestId) ?? null,
      };
    } finally {
      clearTimeout(timer);
      if (this.waiter === waiter) this.waiter = null;
    }
  }
  private async run(job: Job) {
    if (this.closed) return;
    job.state = "running";
    this.save(job);
    try {
      const initialAnchor = this.store.historyAnchor(job.chat_id, {
        messageId: job.before_message_id,
        atOrAfter: job.sent_at?.to,
      });
      if (
        !initialAnchor?.sentAt ||
        (job.sent_at &&
          Date.parse(initialAnchor.sentAt) < Date.parse(job.sent_at.from))
      )
        throw new BridgeError(
          "history_anchor_missing",
          "A stored raw message at or after the requested period is needed to walk backwards through it.",
        );
      let anchor: Message = initialAnchor;
      const visited = new Set([anchor.id]);
      job.anchor_message_id = job.next_message_id = anchor.id;
      this.save(job);
      for (let n = 0; n < job.max_batches; n++) {
        if (!this.source.connected()) {
          job.state = "offline";
          break;
        }
        const result = await this.requestBatch(job, anchor.id);
        if (this.closed) return;
        if (result.end !== "complete") {
          job.state = !this.source.connected()
            ? "offline"
            : result.batch
              ? "response_incomplete"
              : "timed_out";
          break;
        }
        const currentAnchor = anchor;
        const candidates = [...(result.batch?.ids ?? [])]
          .flatMap((id) => {
            const message = this.store.historyAnchor(job.chat_id, {
              messageId: id,
            });
            return message &&
              !message.deleted &&
              message.sentAt &&
              message.chatId === this.store.chatId(job.chat_id)
              ? [message]
              : [];
          })
          .filter(
            (message) =>
              !visited.has(message.id) &&
              Date.parse(message.sentAt ?? message.observedAt) <=
                Date.parse(currentAnchor.sentAt ?? currentAnchor.observedAt),
          )
          .sort(compareMessages);
        const next = candidates[0];
        if (!next) {
          job.state = "no_progress";
          break;
        }
        anchor = next;
        visited.add(anchor.id);
        job.next_message_id = anchor.id;
        job.traversed_from = anchor.sentAt;
        job.traversed_to ??= initialAnchor.sentAt;
        job.state =
          job.sent_at &&
          Date.parse(anchor.sentAt ?? anchor.observedAt) <=
            Date.parse(job.sent_at.from)
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
    this.waiter?.finish("interrupted");
    for (const job of this.active.values()) {
      job.state = "interrupted";
      this.save(job);
    }
    this.active.clear();
  }
}

function compareMessages(a: Message, b: Message) {
  return (
    Date.parse(a.sentAt ?? a.observedAt) -
      Date.parse(b.sentAt ?? b.observedAt) || a.id.localeCompare(b.id)
  );
}
