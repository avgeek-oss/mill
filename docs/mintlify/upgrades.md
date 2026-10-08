---
title: "Upgrades"
description: "Migrate an existing installation with a tested backup."
---

Read the new version's release notes before changing an installation. Record your current source commit or immutable image digest, then make and test a [full backup](/backup).

## The first release

Mill 1.0.0 uses one `001_initial.sql` migration that creates the supported schema directly. There is no earlier public release to upgrade from. Private pre-launch builds used a different migration sequence; the server rejects those ledgers rather than applying the new baseline over existing tables. Stop the old application and follow the maintainer's pre-launch conversion procedure before using this build. Keep the retained original schema and a tested full backup.

After 1.0.0 is published, applied migrations remain unchanged. Later versions add forward migrations, and their release notes describe compatibility and any required operator steps. Never edit `mill_migrations` or an applied SQL file to bypass a startup error.

## Check client access

Personal REST keys use the human owner's current membership and role. MCP OAuth connections also enforce approved scopes and optional board restrictions. Test a connection's permitted boards and denied actions after changing the installation. Revoking a connection or removing its owner ends access immediately.

## Task visibility

The default task list hides Done and Won't Do tasks after 24 hours in their current status. An explicit Status filter includes older matching tasks, and direct task links continue to work. Search, totals and pagination use the same rule. Status changes restart the clock; unrelated edits preserve it. This does not delete tasks.

## Upgrade a source installation

```sh
bash tools/backup.sh --project mill --env-file .env --output backups/before-upgrade.dump
git fetch --tags origin
git checkout <reviewed-release-tag-or-commit>
docker compose --project-name mill --env-file .env build --pull mill
docker compose --project-name mill --env-file .env up --detach --wait --wait-timeout 180
curl --fail http://127.0.0.1:4321/health/ready
```

Replace the placeholder with the exact reviewed revision. Keep `.env` and the PostgreSQL volume. Mill applies new migrations at startup and checks the hashes of old ones. Test sign-in, a board, a task edit, and client access after readiness succeeds.

## Upgrade a packaged image

Private review artifacts include a saved image, source archive, `source-manifest.json`, `release-manifest.json`, and `SHA256SUMS`. The source manifest records each tracked source file's path, byte length, and SHA-256 digest. Choose the package matching your server's architecture. The packaging gate checks the image's Linux architecture, source revision, non-root user, and config digest against the clean source commit.

Verify all files before loading them:

```sh
# Linux, from the extracted artifact directory
sha256sum --check SHA256SUMS
# macOS alternative
shasum --algorithm 256 --check SHA256SUMS
```

Load the image with `docker load --input <image-archive>`, and set `MILL_IMAGE` to the `imageTag` recorded in `release-manifest.json`. Keep the manifest with your backup records. Start with `docker compose --project-name mill --env-file .env up --no-build --detach --wait`.

The v1 packaging workflow does not publish a registry image or public release. Publication is an owner decision after independent review. Do not invent a public image URL during private review.

## Roll back

An older application image may not support an upgraded schema. Do not point it at the new database unless the release notes explicitly confirm compatibility. Restore the pre-upgrade backup into a separate project with the matching old image first. Verify the data, then move the original HTTPS proxy to the recovered service during maintenance.

Database major-version upgrades need a tested PostgreSQL upgrade plan. Changing the container tag across majors while reusing a volume is not a supported shortcut.

Fresh installation, repeated startup, backup/restore, permissions and production container checks must pass for the reviewed release. Private pre-launch conversion is verified separately from the public upgrade path.
