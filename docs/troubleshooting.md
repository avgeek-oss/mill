# Troubleshooting

## Compose rejects a variable

Copy `.env.example` to `.env` next to `docker-compose.yml`, then set `DATABASE_URL`, `MILL_SECRET` and both `MILL_WEB_URL` and `MILL_API_URL`. Compose reads this file automatically. Use `--env-file /path/to/your.env` when it lives elsewhere. Check that `DATABASE_URL` is complete and each configured origin matches its public URL. The optional PostgreSQL overlay also needs `POSTGRES_PASSWORD`. Do not share secret values when reporting an error.

## An image cannot be pulled

Check that both `image` fields in Compose match a published release. Both `ghcr.io/avgeek-oss/mill-api` and `ghcr.io/avgeek-oss/mill-web` must allow anonymous pulls. A proposed release is not a published image. If you use digest overrides, put `images.api` and `images.web` from the same release's `mill-images.json` into their services' `image` fields; do not mix versions.

## Mill does not become ready

```sh
docker compose --project-name mill --env-file .env ps
docker compose --project-name mill --env-file .env logs --tail 100 api web
curl --include http://127.0.0.1:4321/health/ready
```

Check database reachability, the API's migration error and disk space. For bundled PostgreSQL, include both Compose files and inspect the `postgres` service's logs too. On a deployment platform, confirm that the browser can reach the public `MILL_API_URL` and that its runtime script contains the same origin. UI readiness only checks the UI server. Keep API and UI on the same release version. If the port is in use, stop the conflicting service or edit the web service's host port in Compose and update `MILL_WEB_URL` to match. Do not delete volumes or migration records to clear an error.

## Sign-in works locally but fails through the proxy

`MILL_WEB_URL` must match the browser UI origin and `MILL_API_URL` must match the public API origin. Use HTTPS for remote access. Confirm the proxy preserves the host and does not cache authentication responses. Browser mutations from origins other than the configured UI origin are rejected.

Passkeys are bound to the registration origin. If you changed domains and cannot use a passkey, use your password and a passkey recovery code for ordinary account access. Ask the operator to recover the account with `--reset-mfa` before adding passkeys at the final origin; recovery-code access cannot approve security changes. Keep one administrator with a verified recovery path before changing the URL.

## An invitation or reset email does not arrive

Check whether `MILL_SMTP_HOST` and `MILL_SMTP_FROM` are configured together. Without SMTP, administrators copy and share private invitation links; a server operator uses [local account recovery](operations.md#account-recovery) when a person loses access. With SMTP, a successful request queues an email but does not confirm delivery. Check the application's logs and the mail server, then use the resend action if the proof is still needed. Invitation verification codes expire after ten minutes; reset and verification links have their own expiry. Task assignment and mention notifications appear in Mill and are never sent by email.

## A completed task disappeared from the board

Done and Won't Do tasks leave the default list 24 hours after entering that status. Select **Done** or **Won't Do** in the Status filter to include older tasks. Direct task links continue to work. The Boards overview still counts all Backlog, To Do and In Progress tasks, independent of the board's current search, filters, and page.

## A task save reports a conflict

Another person or client changed the task or its status after you opened it. Review the saved value and your draft in the task page; choose **Retry**, **Use saved value**, or **Keep my change** as appropriate. Mill checks row versions so one edit does not silently replace another. API clients must read the latest task, send its current `version`, and reconcile an HTTP `409` before a new mutation. If a board list returns `409 task_list_changed`, restart that filtered and sorted list from its first page.

## A client gets permission denied

For a personal key on REST or MCP, check the owner's active membership and role, stored grant, expiry, and revocation state. A Viewer-owned key cannot write. For a team key, check its stored team grant, expiry, and revocation state. Neither key type can use browser-only identity, membership, account security, or credential-management routes.

For MCP OAuth, check the connection owner's active membership, current role, approved scopes and current board access. An older board-restricted connection cannot create boards or list the team directory. If its last approved board is deleted, the connection is revoked; reconnect and review the new access request. See [the connection guide](clients.md) and [access security](authentication.md#external-credential-boundaries).

## An MCP client cannot connect

Use the exact URL shown in **Account Settings → MCP Guide**, ending in `/mcp`. Remote connections need HTTPS; local HTTP OAuth works only when the configured `MILL_API_URL` is an exact loopback origin. A connection approved for OAuth cannot use its token on REST routes. Check the client's consent, current scopes, role, and expiry under **MCP Connections**. OAuth does not issue refresh tokens, so reconnect after expiry. API-key clients should use a current personal or team key as a bearer token. Do not place tokens in logs or support reports.

## A restore is rejected

Use an explicit `--project`, matching `--confirm-project`, a valid custom-format backup, and a running PostgreSQL target. An existing database needs `--replace`; make a backup before using it. A changed encryption secret prevents decrypting protected authentication data even when the database restores successfully.

## Report a bug

Include the exact commit/version, failed action, HTTP status, and configuration names with values removed. Use a disposable reproduction when possible. Do not attach `.env`, a database dump, account recovery links, cookies, or API tokens. Follow [security reporting](https://github.com/avgeek-oss/mill/blob/main/SECURITY.md) for security reports.

## Attachments do not appear or uploads fail

The attachment area and Upload attachment button below the task description are hidden when the API has no S3 storage configuration. Configure the endpoint, bucket and both keys together, and restart with the new environment. Check [configuration](configuration.md#optional-task-attachments) for the full list.

For a browser upload failure, check that bucket CORS allows the exact `MILL_WEB_URL` origin, PUT/GET/HEAD and Content-Type. The API and UI must use the same public S3 endpoint; recreate both services after a change. A private container hostname cannot be reached by the browser. Confirm the key can read, write and delete objects in the configured private bucket.

Check file size and type after a completion failure. Files must be at most 20 MiB and contain PNG, JPEG, WebP, GIF or PDF bytes matching their MIME type. A renamed extension cannot make another format supported. Expired upload URLs require a new upload attempt. Reopen an expired preview to request a new URL.
