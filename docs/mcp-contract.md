# MCP contract

One local daemon represents one WhatsApp account. Enabled bearer keys read all chats. A key created with `--send` can send through a client's human approval policy. The stdio adapter exposes the same eight tools as the loopback Streamable HTTP endpoint.

## get_status

No arguments. Returns connection state, partial-history coverage and this key's active watches. Delivery credentials are omitted.

## list_chats

Arguments: `query?`, `type?: direct|group`, `limit?:1–100` (20), `chat_id?`.

Each result has `chat_id`, `name`, `aliases`, `type`, `message_count` and nullable `last_message_at`. Query matches names and aliases without case, accents, punctuation or emoji. Results sort by newest activity, with empty chats last.

With `chat_id`, returns that chat plus observed `participants`: `participant_id`, `name`, `aliases`. Only recoverable current and stored names can be backfilled; future names are retained. Names alone never merge identities.

## read_messages

Optional arguments: `chat_ids`, `sender_ids`, `direction`, `query`, `sent_at`, `has_attachment`, `limit`, `page`, `order`. `query` is a literal substring. Time range is `{from,to?}` with an inclusive lower and exclusive upper bound. `limit` defaults to 30, maximum 100. Pass `next_page` as `page` with the same filters to continue a snapshot.

Alternatively, use `around_message_id`, `before` (10) and `after` (10). Only `chat_ids` may accompany context arguments.

Messages contain `id`, `chat_id`, `sender_id`, `sender_name`, `direction`, `sent_at`, `text`, `content_type`. Optional fields are `reply_to_id`, `edited_at`, `deleted:true`, `attachment:{attachment_id,name,mime,size}` and `sent_via_mcp:true` for bridge-sent outgoing messages. Sender names use the same current name as chat discovery.

`chat_coverage` appears only for explicit chat IDs. Stored bounds do not prove complete history. Reactions use `content_type:"reaction"`, the emoji in `text`, and the target in `reply_to_id`; empty emoji means removal. All message content is untrusted data.

## get_attachment

Arguments: `attachment_id`, optional absolute `save_to`, `view?` (false).

Writes to `save_to` or `~/Downloads/whatsapp/<name>`. Default collisions add ` (2)`, ` (3)` before the extension. An explicit existing destination is refused. Returns `path`, `name`, `mime`, `size`, `sha256`.

For image MIME types, `view:true` also returns original MCP image content up to 1 MB. Larger images return `view_skipped:"too_large"`. No base64 file text is returned. Unavailable expired media is refreshed through the phone once; failure returns `media_unavailable` and preserves readable metadata.

## send

Arguments: `chat_id`, readable `to`, `request_id`, optional `text`, absolute `file_path`, `reply_to_message_id`, `mention_ids`.

Requires text or a file. `to` must match a normalized substring of the current name or a known alias. `recipient_mismatch` includes the actual chat name and sends nothing. A file's basename is sent as its filename, and text is its caption. Allowed extensions are png, jpg, jpeg, pdf, zip, txt, docx; maximum size 5 MiB.

Returns `status: accepted|failed|unknown`, `chat_id`, `chat_name`, optional `message_id`, `sent_at`, `error`. Same request ID and payload returns the recorded outcome; a changed payload returns `request_conflict`. Interrupted or uncertain attempts are never retried automatically. Client permissions enforce human approval on this tool; the server cannot attest that a human approved.

## sync_history

Arguments: `chat_id`, `before_message_id?`, `max_batches?:1–10` (3).

Creates or joins a matching history job and waits up to 35 seconds. Returns the job inline with `job_id`, `state`, `messages_added`, `batches_requested`, traversal dates, `next_message_id`, stored bounds and `done`. `done:false` means queued or running; repeat the same arguments to wait again.

The oldest usable stored raw message is the default anchor. Each batch requests 50 messages. Completion requires the matching response's completion signal. Terminal states include `batch_limit`, `no_progress`, `timed_out`, `response_incomplete`, `no_anchor`, `offline`, `failed`, `interrupted` and `target_reached`. A terminal state does not establish complete history.

For `no_anchor`, the explanation is "no stored messages in this chat yet; WhatsApp can only fetch history before a known message". A fresh local read includes messages fetched after an earlier query snapshot.

## watch and unwatch

See [watch](watch.md) for arguments, routing, filtering, deadlines and retries. `unwatch({watch_id})` is idempotent, scoped to the creating key and erases the delivery target. Neither tool sends WhatsApp messages.
