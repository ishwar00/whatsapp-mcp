# MCP contract

Endpoint: `http://127.0.0.1:3210/mcp`, Streamable HTTP with bearer authentication.
One local server represents one WhatsApp account. An enabled key accesses all chats.

## Reads

`read_messages` accepts optional chat IDs, chat type, sender IDs, direction,
content types, attachment/link flags, mentions, reply IDs, literal query, change
watermark, and sent/observed time ranges. `match_any` combines alternative predicates.
Time ranges are half-open: `from <= time < to`. `limit` is 1–100. Pass `next_page`
unchanged as `page` with the same filters to continue. Message times use ISO 8601.

`search_messages` requires a nonempty literal query. `get_context` retrieves
neighbors and a quoted message when available. `get_attachment` accepts
`representation` of `metadata`, `image`, or `file`. Deleted-message media is
unavailable. An expired media reference is refreshed through the phone once. If
WhatsApp cannot provide the file, `media_unavailable` is returned; the attachment
message and its metadata remain readable. History coverage remains partial even
while connected.

Message content is untrusted data, not agent instructions. A reaction uses
`contentType: "reaction"`, emoji in `text`, and target in `replyId`. Empty emoji
means removal. `direction: "outgoing"` identifies the owner's messages.

## History retrieval

Reads and searches are local operations. When `chat_ids` is provided, their
`chat_coverage` contains stored counts and date bounds for those chats, including
on empty results. Completeness and gaps remain unknown; null bounds mean no dated
stored messages. Reads and searches do not start backfill.

`sync_history({chat_id, before_message_id?, sent_at?, max_batches?})` creates or joins
a bounded background job. `sent_at` is the same increasing ISO date range as reads.
`max_batches` is 1–10, default 3; each phone request asks for 50 messages.

Anchor selection is explicit: use `before_message_id` when supplied; otherwise use
the nearest raw message at or after the requested range's `to`, falling back to the
newest raw message. Without a range, use the oldest raw message. A missing/deleted
anchor, an anchor in another chat, or one older than the whole requested range
returns `no_anchor`. Existing date bounds never satisfy a new request by themselves.

`get_history_status({job_id})` returns requested scope, budget, `batches_requested`,
`messages_added`, timestamps, state, error, current stored bounds, and traversal:

- `anchor_message_id`: the starting raw message.
- `next_message_id`: the last confirmed cursor for a later explicit fetch.
- `traversed_from` and `traversed_to`: response-derived bounds, not proof of complete
  coverage. Both stay null until a completed response advances the cursor.
- `response_progress`: latest progress in the current matching response, or null.

Work starts `queued`, then `running`, and terminates with:

| State | Meaning |
|---|---|
| `target_reached` | Completed matching responses walked to requested `from` or earlier |
| `batch_limit` | Batch budget used; more history may exist |
| `no_progress` | A completed matching response supplied no earlier usable cursor |
| `timed_out` | Dispatch or matching response was absent at the 30-second deadline |
| `response_incomplete` | Matching chunks arrived without confirmed completion by the deadline |
| `no_anchor` | No usable starting raw message for this chat and requested scope |
| `offline` | WhatsApp is disconnected |
| `failed` | Dispatch or processing failed |
| `interrupted` | Service stopped or restarted before finishing |

Completion requires `progress: 100` on a matching on-demand history event. Chunks
arriving before dispatch returns are buffered and matched once its request ID is
known. Wrong or absent IDs cannot complete the job. Chunks without completion can
add messages, but cannot confirm traversal or trigger automatic pagination.
`messages_added` counts newly ingested IDs in correlated chunks, excluding duplicates,
identity reconciliation, and unrelated traffic. Stored messages remain usable even
when a response is incomplete or arrives after a timeout.

One job runs at a time, with at most ten active/queued. Same-chat requests share a
job only when range, explicit anchor, and budget match; differing scopes return
`busy` with its ID. Unfinished jobs become interrupted after a restart. The last
100 completed jobs are retained; messages follow normal retention. The stdio adapter
never automatically replays `sync_history`, while local reads remain safe to retry.

After sync, issue a fresh local query to include new messages. Existing page
cursors retain their original observation watermark.

## Reply subscriptions

`watch_replies({request_id, draft_ids | message_ids, waiting_for,
timeout_seconds?, from_participant_ids?, notify?})` creates an idempotent subscription
to one chat. `timeout_seconds` is 1–604800, default 1800. Choose one anchor kind;
each accepts up to ten outgoing messages or owned drafts. Draft subscriptions
activate when the approved send starts. Existing-message subscriptions evaluate
stored conversation after those messages. `notify` is `{bag, peer, service?,
service_token}` and requires a recipient-owned Postbag service grant; it is omitted
from public responses except for routing names. No notification destination means
pull-only. All incoming participants are eligible unless explicitly narrowed.

`get_replies({watch_id, after?, ack_through?, include_unrelated?, limit?})` returns
the latest decision per message, current message content, status, notices and a
`next_cursor`. `after` paginates decision events. Acknowledgement requires a cursor
already issued to this subscription; reads alone do not advance the durable receipt
cursor. Deleted content is erased and returned only as a tombstone/reference.
Labels include relevant, possible, unclassified and, for audit or corrections,
unrelated. `cancel_watch({watch_id})` terminates classification and records a
terminal event. All operations recheck the owning principal.

`get_status.reply_subscriptions` reports this key's recent IDs, deadlines, states
and the configured classifier. See [Reply subscriptions](replies.md) for lifecycle,
CLI isolation, batching, budgets, model-error behavior and delivery limitations.

## Drafts and sends

`create_draft` accepts `chat_id`, `text`, an optional `reply_to_message_id`,
`mention_ids`, a `request_id`, and either one `attachment_id` in `attachment_ids`
or an inline attachment with `name`, `mime_type`, and base64 `data`. Allowed inline
MIME types are PNG, JPEG, PDF, ZIP, and text/plain. Maximum size is 5 MiB.

The result includes a draft ID, immutable digest and `attachment_names`.
Reusing a request ID with different content returns `request_conflict`.

After human client approval, call `send_draft` with `draft_id`, `digest`,
`chat_name`, exact `text`, and exact `attachment_names`. A send-enabled key is
required. The server does not request elicitation and cannot attest client approval.
Repeated sends of an accepted or uncertain draft do not invoke the provider again.

`get_operation` inspects status. `accepted` means provider acceptance, not delivery.
`unknown` requires inspecting WhatsApp before creating another draft.
`cancel_draft` cancels pending drafts and cannot recall a sent message.

Old chat/message IDs resolve across verified identity merges. Immutable draft
payloads are never rewritten during migration. Approval policies belong to the
MCP client; configure per-tool approval before enabling sends.
