# Upgrades

Read the new version's release notes, record your current API and UI image versions or digests, and make a tested [full backup](backup.md) before upgrading. Preserve `MILL_SECRET`, the database password and the PostgreSQL volume.

## Upgrade published images

Download the new release's `docker-compose.yml` and `.env.example` into a temporary directory. Compare the configuration options with your installation and apply any required changes. Do not overwrite your existing `.env` or replace its secrets with the empty example values.

Set `MILL_VERSION` in your existing `.env` to the new published version, without `v`. Keep the API and UI on that same version. If `MILL_API_IMAGE` or `MILL_WEB_IMAGE` digest overrides are set, update both from the new release's `mill-images.json`; an override takes precedence over `MILL_VERSION`.

```sh
docker compose --project-name mill pull api web
docker compose --project-name mill up --detach --wait --wait-timeout 180
curl --fail http://localhost:4321/health/ready
```

The API applies new migrations at startup and verifies old migration checksums. The UI waits for a healthy API. After readiness succeeds, test sign-in, a board, a task edit, notifications and any REST/MCP clients you rely on. Image pulls and readiness alone do not prove your team's workflow.

The publisher verifies both images on native AMD64 and ARM64 hosts, including installation, restart, database recovery, HTTPS proxy behavior and image security. Review the release notes and evidence before pointing an existing database at a new release.

## The first public release

The proposed first public release is `1.0.1`. Its schema starts with the immutable `001_initial.sql` baseline and the forward `002_key_policies.sql` migration. There is no earlier public release to upgrade from.

Private pre-launch builds used a different migration sequence. The API rejects those ledgers rather than applying the new baseline over existing tables. Stop the old application and follow the maintainer's [pre-launch conversion procedure](https://github.com/avgeek-oss/mill/blob/main/docs/rebase-prelaunch.md). Retain the original schema and a tested full backup. Never edit `mill_migrations` or an applied SQL file to bypass a startup error.

After publication, changes use new forward migrations; release notes describe compatibility and any required operator steps.

## Check client access and task visibility

Personal keys enforce their stored grant and the human owner's active membership and current role. Team keys enforce their stored team grant. MCP OAuth connections also enforce their owner's membership, approved scopes and optional board restrictions. Test allowed and denied actions after an upgrade.

The default task list hides Done and Won't Do tasks after 24 hours in their current status. Explicit Status filters and direct task links still reach them. This rule does not delete tasks; unrelated edits do not reset the clock.

## Roll back

An older API may not support an upgraded database schema. Do not point it at the new database unless the release notes explicitly confirm compatibility. Restore the pre-upgrade backup into a separate project using the matching old API and UI images. Verify the data and workflow, then move the original HTTPS proxy to the recovered UI during maintenance.

PostgreSQL major-version upgrades require a tested database upgrade plan. Changing the container tag across majors while reusing a volume is not a supported shortcut.

## Contributor source builds

Source builds are optional for contributors, not required for a normal installation. In a checkout of the reviewed revision, use the [package registry credentials](package-registry.md), contributor configuration and explicit source-build overlay:

```sh
node tools/with-package-token.mjs docker compose --project-name mill --env-file .env --file docker-compose.yml --file tools/compose-source.yml build --pull api web
docker compose --project-name mill --env-file .env --file docker-compose.yml --file tools/compose-source.yml up --no-build --detach --wait --wait-timeout 180
```

Back up first and verify the same workflow and recovery checks. Source builds do not change migration compatibility or secret-preservation requirements.
