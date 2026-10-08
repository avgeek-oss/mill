# Upgrades

Read the new version's release notes before changing an installation. Record your current source commit or immutable image digest, then make and test a [full backup](backup.md).

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
node tools/with-package-token.mjs docker compose --project-name mill --env-file .env --file docker-compose.yml --file tools/compose-source.yml build --pull mill
docker compose --project-name mill --env-file .env --file docker-compose.yml --file tools/compose-source.yml up --no-build --detach --wait --wait-timeout 180
curl --fail http://127.0.0.1:4321/health/ready
```

Replace the placeholder with the exact reviewed revision. Keep `.env` and the PostgreSQL volume. Mill applies new migrations at startup and checks the hashes of old ones. Test sign-in, a board, a task edit, and client access after readiness succeeds.

## Upgrade a published image

Choose a published release and read its notes. Back up the existing database before changing the installation:

```sh
bash tools/backup.sh --project mill --env-file .env --output backups/before-upgrade.dump
git fetch --tags origin
release_tag=v1.0.1 # replace with the published release tag
git checkout "$release_tag"
curl --fail --location --output mill-images.json "https://github.com/avgeek-oss/mill/releases/download/$release_tag/mill-images.json"
test "$(jq -r .version mill-images.json)" = "$release_tag"
test "$(jq -r .commit mill-images.json)" = "$(git rev-parse HEAD)"
jq -e '.platforms == ["linux/amd64", "linux/arm64"] and (.image | test("^ghcr[.]io/avgeek-oss/mill@sha256:[0-9a-f]{64}$"))' mill-images.json
```

Set the existing `.env` file's `MILL_IMAGE` line to the manifest's `image` value. Keep exactly one `MILL_IMAGE` line and preserve every other setting and the PostgreSQL volume. The [installation guide](installation.md#install-a-published-image) shows an anonymous image check. Then pull and start the new digest:

```sh
docker compose --project-name mill --env-file .env pull mill
docker compose --project-name mill --env-file .env up --no-build --detach --wait --wait-timeout 180
curl --fail http://127.0.0.1:4321/health/ready
```

The release workflow verifies the registry image on native AMD64 and ARM64 hosts, including installation, restart, and database recovery. Review its evidence and the release notes for any compatibility limits before pointing an existing database at the new image. The separate review-artifact workflow creates architecture-specific archives for inspection; those are not the published installation path.

## Roll back

An older application image may not support an upgraded schema. Do not point it at the new database unless the release notes explicitly confirm compatibility. Restore the pre-upgrade backup into a separate project with the matching old image first. Verify the data, then move the original HTTPS proxy to the recovered service during maintenance.

Database major-version upgrades need a tested PostgreSQL upgrade plan. Changing the container tag across majors while reusing a volume is not a supported shortcut.

Fresh installation, repeated startup, backup/restore, permissions and production container checks must pass for the reviewed release. Private pre-launch conversion is verified separately from the public upgrade path.
