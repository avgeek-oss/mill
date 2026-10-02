---
title: "Operations"
description: "Health checks, migrations, recovery, and routine care."
---

Use the same explicit Compose project and environment file for every command. The examples below target `mill`; replace it with the exact project name you created.

```sh
docker compose --project-name mill --env-file .env ps
curl --fail http://127.0.0.1:4321/health/ready
docker compose --project-name mill --env-file .env logs --tail 100 mill
docker compose --project-name mill --env-file .env restart mill
```

`/health/live` checks that the HTTP service is responsive. `/health/ready` runs a bounded PostgreSQL check after migration and returns 503 when the database is unavailable. Liveness can still return 200 during that database outage. Health endpoints do not expose configuration or account data. Container readiness and a successful sign-in/task edit prove different things; check both after recovery or upgrades.

Mill runs as the non-root `node` user, with a read-only application filesystem, no added capabilities, and a small temporary directory. PostgreSQL writes to its own persistent volume. There is no Docker socket mount, agent process execution, or separate queue service.

## Migrations

Mill applies packaged PostgreSQL migrations at startup. The runner uses a PostgreSQL advisory lock, stores applied names and checksums, and stops on a changed migration. Starting two services against a fresh database cannot apply the same migration twice.

Do not edit an applied migration or remove migration records to get a service running. Use a reviewed new migration and a backup. If migration fails, keep the service stopped until you understand the error. See [upgrades](/upgrades) and [troubleshooting](/troubleshooting).

## Account recovery

Recovery codes let a person satisfy a second-factor challenge after losing an authenticator. When a person cannot sign in at all, the server operator can run the recovery command against the intended installation. It prints a private, one-time link valid for 30 minutes. After the person uses it to choose a new password, Mill revokes their existing sessions and agent credentials.

This command requires shell and database access to the installation; it is an operator action, not an unauthenticated web endpoint. Save the database first, then run:

```sh
docker compose --project-name mill --env-file .env exec -T mill node dist/apps/api/src/auth/recovery-cli.js --email person@example.com
```

Add `--reset-mfa` only when the account owner also lost their second factor. In a development checkout, `pnpm recover-account --email person@example.com` runs the same command against `.env`. Consult `pnpm recover-account --help` for the supported arguments. Do not include recovery links in a terminal recording or support issue.

## Routine care

- Back up PostgreSQL and the encryption secret regularly. Verify restores in a separate project.
- Keep the host, Docker, reverse proxy, and reviewed Mill image current.
- Review memberships, active sessions, Agent access grants, and personal API keys/OAuth connections when a person leaves or access changes.
- Check disk capacity for the database and backups. Store another encrypted backup off the Docker host.
- Test changes to the public origin, proxy, and authentication using an account with a working fallback.

Do not rotate `MILL_SECRET` by replacing it casually. Protected database values require the original secret. If a secret is compromised, coordinate recovery, credential revocation, and a reviewed data migration.
