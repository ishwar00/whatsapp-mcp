# Verification map

The current interface contains eight tools. Run `npm run check`, `npm test`, and `npm run build` before a release.

The tests cover SQLite queries and pagination, identity merges, names, encrypted edits, reactions, media refresh and erasure, history queue correlation, loopback authentication and MCP session recovery. Interface tests exercise compact reads, path-based files and idempotent sends through provider fixtures.

Watch tests use fake time, a local relevance executable, Unix socket receivers and a Codex executable fixture. They check coalescing, deterministic group matches, relevance failures, delivery retries, expiry, restart and target erasure. No test sends a real WhatsApp message.

A release cutover separately verifies client permission prompts, a live WhatsApp read, native session routing and the installed daemon's version. Build in the intended checkout and coordinate its restart with active users.
