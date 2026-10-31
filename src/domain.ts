import { z } from "zod";
export const messageSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  providerId: z.string(),
  senderId: z.string(),
  senderName: z.string(),
  direction: z.enum(["incoming", "outgoing"]),
  sentAt: z.string().nullable(),
  observedAt: z.string(),
  editedAt: z.string().nullable().default(null),
  updatedAt: z.string().nullable().default(null),
  text: z.string(),
  contentType: z.string(),
  mentions: z.array(z.string()),
  replyId: z.string().nullable(),
  deleted: z.boolean().default(false),
  source: z.enum(["live", "history", "local"]),
  attachmentId: z.string().nullable(),
  expiresAt: z.string().nullable().default(null),
});
export type Message = z.infer<typeof messageSchema>;
export const querySchema = z
  .object({
    chat_ids: z.array(z.string()).max(50).optional(),
    changed_since: z.string().datetime({ offset: true }).optional(),
    chat_type: z.enum(["direct", "group"]).optional(),
    sent_at: z
      .object({
        from: z.string().datetime({ offset: true }),
        to: z.string().datetime({ offset: true }),
      })
      .optional(),
    observed_at: z
      .object({
        from: z.string().datetime({ offset: true }),
        to: z.string().datetime({ offset: true }),
      })
      .optional(),
    sender_ids: z.array(z.string()).max(50).optional(),
    direction: z.enum(["incoming", "outgoing"]).optional(),
    mention_ids: z.array(z.string()).max(50).optional(),
    mentions_me: z.boolean().optional(),
    reply_to_ids: z.array(z.string()).max(50).optional(),
    content_types: z.array(z.string()).max(10).optional(),
    has_attachment: z.boolean().optional(),
    has_link: z.boolean().optional(),
    query: z.string().max(500).optional(),
    include_tombstones: z.boolean().default(false),
    match_any: z
      .array(
        z
          .object({
            mentions_me: z.literal(true).optional(),
            reply_to_ids: z.array(z.string()).optional(),
            query: z.string().optional(),
          })
          .refine((v) => Object.keys(v).length === 1),
      )
      .max(10)
      .optional(),
    limit: z.number().int().min(1).max(100).default(50),
    order: z.enum(["oldest_first", "newest_first"]).default("newest_first"),
    page: z.string().optional(),
  })
  .strict();
export type Query = z.infer<typeof querySchema>;
export const inlineSchema = z.object({
  name: z.string().max(150),
  mime_type: z.enum([
    "image/png",
    "image/jpeg",
    "application/pdf",
    "application/zip",
    "text/plain",
  ]),
  data: z.string().max(7_000_000),
});
export const draftObjectSchema = z
  .object({
    chat_id: z.string(),
    text: z.string().max(10_000).default(""),
    attachment_ids: z.array(z.string()).max(1).default([]),
    attachment: inlineSchema.optional(),
    reply_to_message_id: z.string().optional(),
    mention_ids: z.array(z.string()).max(50).default([]),
    request_id: z.string().min(1).max(200),
  })
  .strict();
export const draftInputSchema = draftObjectSchema
  .refine(
    (v) => Boolean(v.text || v.attachment || v.attachment_ids.length),
    "Empty draft",
  )
  .refine(
    (v) => !(v.attachment && v.attachment_ids.length),
    "Choose one attachment",
  );
export type DraftInput = z.infer<typeof draftInputSchema>;
export const draftSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  input: draftInputSchema,
  digest: z.string(),
  status: z.enum([
    "pending",
    "cancelled",
    "rejected",
    "attempting",
    "accepted",
    "unknown",
    "failed_before_attempt",
  ]),
  createdAt: z.string(),
  attemptedAt: z.string().optional(),
  providerId: z.string().nullable(),
  error: z.string().nullable(),
});
export type Draft = z.infer<typeof draftSchema>;
export const clientSchema = z.object({
  id: z.string(),
  name: z.string(),
  tokenHash: z.string(),
  canDraft: z.boolean(),
  // Lets this key call send_draft. Off by default; the human gate is the MCP client's
  // permission prompt (see README "Send from the agent"), not this flag.
  canSend: z.boolean().default(false),
  enabled: z.boolean(),
});
export type Principal = z.infer<typeof clientSchema>;
export class BridgeError extends Error {
  constructor(
    public code: string,
    message = code,
  ) {
    super(message);
  }
}
