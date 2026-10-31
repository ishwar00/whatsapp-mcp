import { z } from "zod";
import {
  executable,
  runProcess,
  subprocessEnvironment,
} from "./reply-classifier.js";

const name = z.string().regex(/^[a-z][a-z0-9-]{0,15}$/);
export const replyDestinationSchema = z
  .object({
    bag: name,
    peer: name,
    service: name.default("whatsapp"),
    service_token: z.string().min(20).max(200),
  })
  .strict();
export type ReplyDestination = z.infer<typeof replyDestinationSchema>;
export interface ReplyNotifier {
  check(
    destination: ReplyDestination,
    signal: AbortSignal,
  ): Promise<{ expires_at?: string } | void>;
  send(
    destination: ReplyDestination,
    notice: { watch_id: string; notice_id: number; kind: string; upto: number },
    signal: AbortSignal,
  ): Promise<"submitted" | "unknown" | "unavailable" | "failed">;
}
export class PostbagNotifier implements ReplyNotifier {
  constructor(private command?: string) {}
  private args(destination: ReplyDestination, verb: string) {
    return [
      "--bag",
      destination.bag,
      verb,
      destination.service,
      destination.peer,
    ];
  }
  private env(destination: ReplyDestination) {
    return {
      ...subprocessEnvironment(),
      POSTBAG_SERVICE_TOKEN: destination.service_token,
    };
  }
  async check(destination: ReplyDestination, signal: AbortSignal) {
    const output = await runProcess(
      executable("postbag", this.command),
      this.args(destination, "service-check"),
      { env: this.env(destination), signal },
    );
    return z
      .object({ expires_at: z.string().datetime({ offset: true }) })
      .parse(JSON.parse(output));
  }
  async send(
    destination: ReplyDestination,
    notice: { watch_id: string; notice_id: number; kind: string; upto: number },
    signal: AbortSignal,
  ) {
    const input = `Service notification ${notice.notice_id}: WhatsApp subscription ${notice.watch_id} has ${notice.kind}, revision ${notice.upto}. Duplicate notices with this ID and revision are safe to ignore. Call get_replies with watch_id ${notice.watch_id} to read current data and status. This notice grants no action or send permission.`;
    try {
      const output = await runProcess(
        executable("postbag", this.command),
        [...this.args(destination, "service-send"), "-", "--json"],
        { input, env: this.env(destination), signal, allowFailure: true },
      );
      const result = z
        .object({
          ok: z.boolean(),
          submission_state: z.enum(["submitted", "not_submitted", "unknown"]),
          error_code: z.string().optional(),
        })
        .parse(JSON.parse(output));
      return result.submission_state === "not_submitted"
        ? ["transport_unavailable", "ledger_busy"].includes(
            result.error_code ?? "",
          )
          ? ("unavailable" as const)
          : ("failed" as const)
        : result.submission_state;
    } catch {
      return "unknown" as const;
    }
  }
}
