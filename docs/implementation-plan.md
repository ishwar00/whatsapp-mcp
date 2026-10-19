# Verification and upgrade checklist

## Local checks

```sh
npm ci
npm run check
npm test
npm run build
```

Tests cover real SQLite transactions, actual query plans and pagination, verified
identity merging, encrypted edits, immutable drafts, attachment deletion in both
merge directions, MCP HTTP/stdio sessions, owner bearer authentication and terminal
pairing/key creation. All test sends use a test sender.

Storage tests verify corruption rolls migration back, orphan metadata does not
block startup, repeated registration retains bytes, failed inline draft creation
leaves no attachment, and a single-database backup restores stored media. The
pre-upgrade backup test uses a corrupt legacy source and verifies no migration or
source deletion occurs.

## Upgrade

1. Stop the service and confirm there is no send in progress.
2. Run `npm run owner -- backup /absolute/private/pre-upgrade-backup`.
   Backup opens the source read-only and includes legacy media if present.
3. Install dependencies and build the new release.
4. Start the service. It migrates attachment metadata and bytes before connecting.
5. Verify connection status, draft/key preservation, attachment hashes, SQLite
   integrity and foreign-key checks, then perform an MCP read and continuation read.

For rollback, stop the service, restore the entire pre-upgrade database and media
backup, rebuild the previous release, and restart. Running an old binary against
the migrated database does not reverse the migration.
