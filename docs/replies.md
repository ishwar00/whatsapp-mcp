# Reply subscriptions

Reply subscriptions notify an agent about responses to selected outgoing messages.
Unquoted group messages are classified against the original request, so unrelated
conversation does not wake the working agent. Subscription state, decisions and
pending notices live in the WhatsApp service's SQLite database.

## Configure the classifier

Install and sign in to either Claude Code or Codex on the machine running the
service. Save a settings file, for example:

```json
{
  "classifier": {
    "runner": "claude-code",
    "model": "haiku",
    "executable": "/absolute/path/to/claude",
    "effort": "low",
    "execution_timeout_seconds": 45
  },
  "quiet_seconds": 5,
  "max_batch_delay_seconds": 30,
  "max_classifier_calls": 30,
  "max_context_characters": 32000
}
```

Run `npm run owner -- reply-config /absolute/path/to/settings.json` and restart the
service. The file is validated and saved privately as `.data/reply-settings.json`.
For Codex, select `runner: "codex"` and a model available to your Codex login.
The executable is optional when it can be found in PATH or common installation
directories. There is no automatic fallback to another model.

Each classification is a fresh execution. Claude uses `--no-session-persistence`;
Codex uses `--ephemeral`. Both run in an empty temporary working directory, with
inherited agent identities removed. The runners disable inherited customizations,
MCP connections and action tools using their CLI configuration. These controls
depend on the installed CLI version and are not an OS-level security boundary.
The classifier returns labels and IDs, never actions. Output is schema-validated
and every returned ID and revision must belong to the input batch.

The per-call execution deadline is separate from the subscription deadline. A
single worker bounds concurrent execution; context size and per-watch call limits
bound model usage. CLI authentication must work for the service manager's user,
not only an interactive terminal.

## Connect notification delivery

Push delivery requires Postbag with `service-grant`, `service-check` and
`service-send --json` support. Until that extension is released upstream, install
the reviewed build in a separate tool environment:

```sh
uv tool install --from git+https://github.com/ishwar00/postbag.git@ac98e12 postbag
```

If you already use another Postbag version, keep it installed and use a dedicated
virtual environment for this build instead. Point `postbag_executable` at the new
executable. Existing peer sessions can keep their old Postbag version because the
service grants use a separate sidecar.

Run these commands from the **receiving agent's session**; an agent can do this
setup itself:

```sh
postbag --bag client-work join codex my-agent
postbag --bag client-work service-grant whatsapp --ttl 3600
```

Use `join claude my-agent` for Claude. Reuse an existing peer registration rather
than taking another session's name. The grant returns a token scoped to that bag,
recipient and service. Keep it private and provide it in `watch_replies.notify`.
Registering another grant rotates the token; `--ttl 0` revokes it. A recipient
rejoin invalidates its earlier grants. Renew the grant from the receiving session
when needed. Credentials are stored once per agent key and notification destination;
renewing a grant through any one watch updates all sibling watches using it.
The default grant lifetime is one hour, capped at seven days.
The watch result warns if the grant can end before its deadline. Renew by calling
`watch_replies` with the same request ID and scope plus the fresh token; definite
failed deliveries then become pending again. Use the executable reported in
`get_status.reply_subscriptions.postbag_executable` for grant commands when the
service uses a separately installed Postbag build.

The daemon never borrows an agent's native identity. Postbag verifies the grant
and uses its existing authenticated Claude socket or Codex queue transport. Grants
are stored in an owner-private sidecar; existing peer ledgers keep their format.
Configure `postbag_executable` in reply settings when the service cannot find the
required Postbag executable.

Postbag receives a fixed pointer notice containing subscription/event IDs and the
event kind. WhatsApp text, sender names and classifier-generated text are not
inserted into a user-role notification. The agent retrieves actual content through
`get_replies`. Notices never grant permission to send or perform other actions.

## Subscribe and read

1. Create and send the outgoing draft or drafts through the existing human-approved
   `send_draft` workflow.
2. Call `watch_replies` with accepted `draft_ids` or outgoing `message_ids`, a
   `waiting_for` description, `timeout_seconds`, a unique `request_id`, and optional
   `notify` credentials. Pending drafts are rejected.
3. The service includes replies already stored after the send, so an immediate
   response arriving before subscription creation is still found. The deadline is
   the earliest watched send time plus the timeout; registering late cannot extend
   it. Registration is rejected once the deadline has passed; choose a larger timeout
   if the intended wait should still be active.
4. On a notice, call `get_replies({watch_id})`. Save `next_cursor` and pass it as
   `after` for later reads. There is no separate acknowledgment call. Notices carry
   stable IDs and revisions; duplicate pointers are safe to ignore.
5. Use `cancel_watch` when the replies are sufficient. Otherwise the subscription
   continues until its absolute deadline.

All watched messages must belong to one chat. Multiple bubbles can share one
subscription. Omit `from_participant_ids` to evaluate messages from any teammate;
an explicit sender filter narrows candidates. Omit `notify` for pull-only use.
`get_status.reply_subscriptions` lists this key's recent subscription IDs and the
configured classifier.

## What the classifier sees

Every eligible incoming message becomes a candidate. Calls receive consecutive
batches rather than the entire conversation repeatedly. The packet contains:

- The waiting intent and exact original outgoing bubbles.
- Up to 20 preceding messages from that chat, in chronological order.
- Up to ten earlier relevant exchanges from this subscription.
- Up to 20 new candidate messages with IDs, revisions, sender IDs and names,
  timestamps, quote references, captions and attachment metadata.

Older supporting context is removed first when the context budget is reached;
the omission count is included. Original messages are never silently truncated.
Batches are packed to the context limit. An individually oversized message is
retained as unclassified while fitting neighboring messages are still classified.
Quoted replies to selected messages bypass semantic classification.

The model returns `relevant`, `unrelated` or `uncertain`. Uncertain results surface
immediately as `possible`, with the model's reason. There is no deferred recheck
queue or repeated classification of unchanged content. Relevant/possible events
produce coalesced pointer notices. `include_unrelated` allows audit reads.
Edits create new decision events; deletions remain readable as tombstones without
sending another reply notification.

Classifier failure or call-budget exhaustion produces one warning per watch,
not a notification for every subsequent group message. Unclassified candidates
remain readable and are reported in the terminal outcome. Classification is a
model judgement and can make mistakes; a relevant label establishes neither
task completion nor authorization.

## Deadlines and recovery

`timeout_seconds` defaults to 1800 and is capped at seven days. Random activity
does not extend it. At the deadline, classification is aborted, late results are
discarded, and undecided in-window messages are retained as unclassified. A single
terminal notice reports `expired_no_reply`, `expired_with_replies`,
`expired_unclassified`. Cancellation also persists a
terminal notice.

Message revisions, decisions and notices survive restarts. Decisions are keyed by
provider identity and revision, so verified identity reconciliation does not turn
old content into new replies. Existing messages are assigned revisions when the
feature is first opened. Sender timestamps have second precision; subscriptions
include the starting second to avoid losing immediate replies.

Decisions, cursor advancement and notice creation commit in one SQLite transaction.
A crash cannot leave a new decision without its corresponding notice.

Postbag submission does not prove agent processing. Pointer notices use bounded
exponential retries, including uncertain submissions and interrupted sends, for up
to seven days and at most 256 attempts. Retries reuse the notice ID and revision;
a duplicate notice is possible. Successful submission stops retries. Permanent
refusals fail immediately; renewing the destination grant requeues failed notices
for every watch sharing that destination. Reads are repeatable and never consume
or authorize anything.

`get_replies` exposes notice states `pending`, `sending`, `sent`, and `failed`.
`sent` means submitted to Postbag, not confirmed as processed by the agent. Terminal
subscription data is retained for seven days after its deadline; active watches
are capped at ten per key, stored watches at 1000 per key. Sender timestamps and
the local clock can differ; including the starting second handles timestamp
precision but cannot eliminate larger clock skew.

The service cannot recover messages WhatsApp never delivered. A subscription
deadline with no classified reply is not proof that nobody responded on WhatsApp.
