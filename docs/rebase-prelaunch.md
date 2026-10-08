# Rebase a prelaunch installation

Before publishing v1.0.0, Mill uses one clean migration, `packages/database/migrations/001_initial.sql`. This is a maintainer procedure for the known earlier prelaunch schemas, including the clean baselines immediately before task types and start dates. It is not a general upgrade or import tool. After publication, applied migrations must remain unchanged and future releases must add forward migrations.

Startup refuses a retired migration ledger without modifying its data. Do not clear the ledger, point the baseline at populated tables, or remove an existing database to get past that guard.

## Inspect the installation

Keep an encrypted database backup and the installation's original `.env`. Use the same `DATABASE_URL` and, where applicable, the same `MILL_DB_SCHEMA` as the application. The helper defaults to a read-only inspection:

```sh
node --env-file=.env tools/rebase-prelaunch.mjs --schema public
```

The result contains table counts and the intended baseline. It contains no account, task, credential, or secret values. Inspection must match the exact known earlier migration checksums and complete schema catalog in `tools/prelaunch-legacy-layout.json`, `tools/prelaunch-task-type-layout.json` or `tools/prelaunch-start-date-layout.json`. The helper selects a clean source only for its pinned migration checksum. Any extra, missing, or altered table, column, constraint, index, function, trigger or migration causes refusal. The reviewed baseline checksum is pinned in the helper; changing the baseline requires a fresh review of the conversion and its tests.

## Apply the conversion

Stop every application, worker, migration process and database client connected to this Mill database. Keep PostgreSQL running. Verify that the backup is readable before proceeding:

```sh
node --env-file=.env tools/rebase-prelaunch.mjs --schema public --apply
```

The helper holds the migration advisory lock and exclusive locks on every source table. It creates a separate staging schema, installs the clean baseline, copies supported data in foreign-key order and checks every retained column against its expected source value. The schema swap happens in one transaction. A failed copy or validation leaves the original schema in place and rolls back the staging schema.

On success, the output records `archivedSchema`, table counts and the new baseline checksum. The original schema is renamed to `mill_prelaunch_backup_<identifier>` and kept intact; the verified staging schema takes the original name. Functions in both schemas receive their own fixed search paths. Preserve the archive and external backup until the installation has been reviewed. The helper does not delete that archive.

## What is preserved

Workspace, user, board, task, comment, session, authentication, security and credential identifiers stay unchanged. Task content, assignees, fixed statuses, status-change times, version numbers and timestamps remain unchanged. Tasks without a type become `task`; their identifiers, versions and status-change times stay unchanged. The preceding clean schema retains its existing human-owned credentials and attribution without the legacy Agent conversion. Existing source records for removed features remain in the retained archive, including old checklists and Agent records.

The active schema contains no Agent tables or columns. Existing OAuth connections become human-owned, keeping exactly their approved scopes and board IDs. A null board list remains unrestricted by board; an empty list remains deny-all. Previously revoked connections remain revoked. Connections or approved requests whose old Agent was missing or unavailable to the human owner are revoked or expired, so conversion does not restore access they lacked.

Existing activity retains its human owner ID. Old Agent actor labels become the human owner's name, with OAuth attribution. Removed Agent fields are omitted from activity metadata. Legacy notification labels containing a composite Agent and human name use the unambiguous current human name, or `Workspace member` when that owner cannot be determined safely. The complete original labels remain in the source archive.

Tasks without a start date receive `null`; all prior task fields remain unchanged. Cached idempotent response bodies are invalidated with `upgrade`; encrypted or plain cached responses cannot return removed Agent fields or obsolete task responses missing the new type or start date. The retry keys and request hashes remain recorded. Personal API keys keep their existing human ownership and restrictions.

## Review before restarting

Run the normal migration command and confirm that the ledger contains only `001_initial.sql` with its expected checksum. Start Mill and review existing accounts, boards, direct task links, comments, activity and OAuth connections. Check that approved board restrictions still apply and that unassigned tasks remain unassigned.

Keep the archive name and the conversion receipt with the local review evidence. Do not present conversion of one local installation as a production upgrade or publication. If restoring an external backup, restore it into a separate database and follow the normal installation and restore verification first.
