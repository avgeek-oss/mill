# Upgrades

Read the [release notes on GitHub](https://github.com/avgeek-oss/mill/releases), record your current API and UI versions, and take a [full backup](backup.md) before upgrading. Keep your existing PostgreSQL storage, database connection settings and `MILL_SECRET`.

## Docker Compose

Download the new release’s Compose files into a temporary directory. Compare them with your installation and preserve any local port or hosting changes. Update the API and UI to the same release.

Pull the images, then recreate the services using your existing project name and environment:

```sh
docker compose --project-name mill pull api web
docker compose --project-name mill up --detach --wait --wait-timeout 180
curl --fail http://localhost:4321/health/ready
```

If you use bundled PostgreSQL, include `-f docker-compose.yml -f docker-compose.postgres.yml` in both Compose commands. Keep its existing volume and review changes to the PostgreSQL overlay before applying them.

Do not replace your `.env` with the release’s example file. Add only the settings you need and preserve your existing secrets.

## Towbar

Update both image references in your deployment manifests to the same published release. Sync the repository, then deploy **Mill API** followed by **Mill UI**. See [Install with Towbar](installation/towbar.md) for the file structure and runtime settings.

## Check the upgrade

The API applies new database migrations at startup. Wait for both services to become ready, then check sign-in, a board and a task. Test any REST or MCP clients you use.

If an update fails, inspect its logs before retrying. Do not edit migration files or database migration records to bypass an error. Existing task links remain available, including tasks hidden by the default completed-task filter.

## Roll back

An older API may not support an upgraded database. Follow the release’s compatibility guidance before changing images back.

When a database restore is needed, restore the pre-upgrade backup into a separate installation with the matching previous API and UI versions. Verify it before switching traffic. Keep the original database until recovery is confirmed; an image rollback does not undo a migration.

PostgreSQL major-version upgrades need their own database upgrade procedure. Do not change the major version while reusing the existing volume without following that procedure.
