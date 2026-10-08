# Backup and recovery

A full PostgreSQL backup preserves accounts, sessions, passkeys and their recovery-code digests, boards, tasks, comments, members, activity, notifications and API-key/OAuth records. Retained pre-launch archive schemas are included when present. Database backup is the supported recovery method; Mill has no portable work export/import.

Also save the original `MILL_SECRET` and runtime settings securely. Protected database values require that secret even after a successful restore. Record both API/UI versions or digests, the Compose project name and PostgreSQL major version with each backup.

## Create a backup

From the installation directory, use PostgreSQL's packaged `pg_dump`. You do not need Git, Node or a source checkout:

```sh
umask 077
mkdir -p backups
backup_file="backups/mill-$(date +%Y%m%d-%H%M%S).dump"
docker compose --project-name mill exec -T postgres sh -c 'exec pg_dump --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --format=custom --no-owner --no-acl' > "$backup_file"
```

Confirm the command succeeded before relying on the file. A failed dump may leave a partial file; remove that file and investigate the failure. Do not overwrite an existing backup. `pg_dump` takes a consistent database snapshot while ordinary writes continue.

Encrypt backups and a separate copy of the runtime secrets, store a copy off the Docker host and periodically rehearse recovery. Keep enough free space for both the archive and a separate restored database. For managed PostgreSQL, use the provider's supported backup/restore procedures and verify that they preserve the complete Mill database.

## Rehearse recovery in a separate project

Use the same compatible API and UI images as the backup. Copy `.env` to `recovery.env`, preserve `MILL_SECRET` and the database settings, and change `MILL_PORT` and `MILL_BASE_URL` to a spare loopback port such as `4322`. Keep the new file private. A separate Compose project creates its own PostgreSQL volume.

```sh
cp .env recovery.env
chmod 600 recovery.env
# Edit recovery.env: MILL_PORT=4322 and MILL_BASE_URL=http://localhost:4322.
docker compose --project-name mill-recovery --env-file recovery.env up --detach --wait postgres
```

Restore into that new empty database. Replace the example filename with your backup:

```sh
docker compose --project-name mill-recovery --env-file recovery.env exec -T postgres sh -c 'exec pg_restore --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --no-owner --no-acl --exit-on-error --single-transaction' < backups/mill-YYYYMMDD-HHMMSS.dump
docker compose --project-name mill-recovery --env-file recovery.env up --detach --wait
curl --fail http://localhost:4322/health/ready
```

Run the second command only after restore succeeds. Keep the API and UI stopped if restore fails. Do not run this empty-database recipe against an existing workspace.

Sign in at the recovery URL and check a board, task, comment, member, notification and a client credential that you can safely test. OAuth may require reconnection if its resource URL points to the original installation. Password sign-in works at the recovery origin; physical passkeys stay bound to their original origin. To test production passkeys, use the original HTTPS origin in a controlled recovery environment.

After the rehearsal, remove only the disposable recovery project:

```sh
docker compose --project-name mill-recovery --env-file recovery.env down --volumes
```

## Recover the running installation

Put the public UI into maintenance. Back up the existing database before replacing it, then stop **both `api` and `web`**. Restore to a separate project first using the compatible images, verify it, and switch the HTTPS proxy to its UI. Retain the original database until the recovered installation is confirmed.

If you deliberately need to replace an existing database, use PostgreSQL's documented restore process or the reviewed repository helper with explicit project confirmation. Do not add `--clean` casually to a restore command: it removes existing database objects.

## Optional repository helpers

Operators who keep a source checkout can use the guarded scripts. They create private backup files, reject overwrite, validate the archive and require explicit target confirmation:

```sh
bash tools/backup.sh --project mill --env-file .env --output backups/mill.dump
bash tools/restore.sh --project mill-recovery --confirm-project mill-recovery --env-file recovery.env --input backups/mill.dump
```

The restore helper stops both API and UI, rejects a nonempty target unless `--replace` is explicitly supplied, restores in one transaction, and starts both services only after success. A failed restore leaves them stopped. These helpers are optional; a published-image installation does not require them.

See [upgrades](upgrades.md) for schema compatibility and private pre-launch conversion. Historical portable JSON exports have no importer in v1; retain them separately if needed, but use database backups for supported recovery.
