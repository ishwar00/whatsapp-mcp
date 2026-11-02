# Watch incoming replies

Call `watch` from the agent that should receive notifications:

```json
{"chat_id":"chat_...","timeout_seconds":3600}
```

Claude Code's stdio adapter supplies its own socket credentials privately. Codex supplies `codex_thread_id` from `$CODEX_THREAD_ID` or `$CODEX_SESSION_ID` in its shell. Other clients without either route receive `no_notify_target`. No separate registration or notification token is needed.

Optional `since` is an ISO timestamp. Without it, the watch starts at the latest outgoing message within 24 hours, or now. Replies already stored within that window are eligible. Optional `from_participant_ids` selects group senders whose unquoted messages should notify. It does not restrict quotes or mentions, and does not filter direct chats.

Timeout defaults to 86400 seconds and cannot exceed 604800. The result contains `watch_id`, `chat_id`, `since`, `expires_at`, and a non-secret target label. `get_status` lists active watches; at most 20 may be active per key. `unwatch({watch_id})` ends one.

Incoming replies coalesce until ten quiet seconds or sixty seconds from the start of a batch. Reactions and deletions do not wake the agent. A reply edited before processing still counts; editing a processed reply does not send another notice. Every incoming DM counts. In groups, replies quoting your outgoing messages, mentions of you and explicitly selected senders count directly. Other group messages are ignored and immediately recorded as handled.

An optional `.data/reply-settings.json` setting overrides the Codex executable path:

```json
{"codex_executable":"/absolute/path/to/codex"}
```

Without an override, the service searches PATH and standard installation directories.

Notices contain only message count, chat/watch IDs, a `read_messages` instruction and an untrusted-data reminder. They carry no WhatsApp text or names and grant no send permission. Claude receives the notice on its own session socket; Codex receives it through `codex queue --thread`. A successful write or queue command is submission, not an acknowledgement from the agent.

Delivery retries after 5, 30 and 120 seconds. After the final failure, the watch becomes `undeliverable`. Expiry, cancellation and delivery failure erase target credentials. Active watches reload after a daemon restart. Handled message IDs persist across clean restarts and identity merges. Late arrivals remain eligible regardless of the sent time of earlier notices. Pending batching and retry timing live in memory; a crash between native delivery and recording its handled IDs can repeat a pointer. Use `read_messages` as the source of truth.
