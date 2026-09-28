# Backup and recovery

A full PostgreSQL backup restores accounts, sessions, authenticators, boards, tasks, comments, members, notifications, and agent/OAuth records. A portable export is for moving work between workspaces and deliberately excludes login secrets and credentials. Keep both purposes separate.

## Create a full backup

Run this from the Mill checkout with the correct Compose project:

```sh
mkdir -p backups
bash tools/backup.sh --project mill --env-file .env --output backups/mill-2026-09-28.dump
```

The script uses `pg_dump` from the running PostgreSQL container and creates an owner-readable custom-format archive. It refuses to overwrite an existing output file and removes a partial archive if dumping fails. `pg_dump` takes a consistent snapshot while normal writes continue.

Back up `.env` separately using encryption. A dump contains private account and credential data, and the original `MILL_SECRET` is needed to decrypt protected values. Store encrypted copies off the host. Record the Mill commit/image digest and PostgreSQL major version with the backup.

## Practice a restore

Use a separate project so your running workspace stays available. Create `recovery.env` from `.env`, preserve `MILL_SECRET`, and change `MILL_PORT` and `MILL_BASE_URL` to a spare loopback port such as 4322. Keep this file private.

```sh
docker compose --project-name mill-recovery --env-file recovery.env up --detach --wait postgres
bash tools/restore.sh --project mill-recovery --confirm-project mill-recovery --env-file recovery.env --input backups/mill-2026-09-28.dump
curl --fail http://127.0.0.1:4322/health/ready
```

The restore command validates the archive before stopping Mill. It rejects a target with existing tables unless `--replace` is explicitly supplied. It restores in one PostgreSQL transaction and starts Mill only after the restore succeeds. A failed restore leaves the application stopped for investigation.

Sign in at the recovery URL and verify a task, comment, member, and notification. Password sign-in works at the changed origin; physical passkeys remain bound to the original origin. To test production passkeys, restore behind the original HTTPS origin in a controlled recovery environment.

When the recovery check is complete, remove only that project:

```sh
docker compose --project-name mill-recovery --env-file recovery.env down --volumes
```

## Replace an existing installation

Put the installation into maintenance, make a backup of its current state, and double-check the explicit target. Add `--replace` only when you intend to replace that project's database:

```sh
bash tools/restore.sh --project mill --confirm-project mill --env-file .env --input backups/mill-2026-09-28.dump --replace
```

Use the application version compatible with the backup. PostgreSQL dumps are not a substitute for testing a major-version database upgrade. See [upgrades](upgrades.md).

## Portable work export

Administrators can export and import the supported workspace data through **Export and import** in the sidebar or the authenticated API. The export includes work and member details, and excludes passwords, sessions, authenticators, credentials, and OAuth grants. Import preserves the operator's administrator access. Use [the API documentation](api.md) for the exact format and permission checks. Portable export does not replace the full recovery backup.
