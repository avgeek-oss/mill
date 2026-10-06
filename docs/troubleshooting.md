# Troubleshooting

## Compose rejects a variable

Generate `.env` with `node tools/init-env.mjs` and use `--env-file .env` in the command. The generator refuses to overwrite a file. If one exists, inspect its required variable names without sharing its values. `POSTGRES_PASSWORD`, `MILL_SECRET`, and `MILL_BASE_URL` cannot be blank.

## Mill does not become ready

```sh
docker compose --project-name mill --env-file .env ps
docker compose --project-name mill --env-file .env logs --tail 100 postgres mill
curl --include http://127.0.0.1:4321/health/ready
```

Check PostgreSQL health, the application's migration error, and disk space. If the port is in use, stop the conflicting service or change `MILL_PORT` and `MILL_BASE_URL` together. Do not delete volumes or migration records to clear an error.

## Sign-in works locally but fails through the proxy

`MILL_BASE_URL` must exactly match the browser's scheme, hostname, and port. Use HTTPS for remote access. Confirm the proxy preserves the host and does not cache authentication responses. Browser mutations from another origin are rejected.

Passkeys are bound to the registration origin. If you changed domains, use your password and authenticator/recovery fallback, then register a new passkey at the final origin. Keep one administrator with a verified recovery path before changing the URL.

## Send an invitation or recover an account

Mill has in-app notifications; email delivery is unavailable. Administrators share an invitation link privately with the intended recipient. The server operator handles [local account recovery](operations.md#account-recovery) when a person loses access. Neither procedure requires an email provider.

## A task save reports a conflict

Another person or client changed the task or its status after you opened it. Reload the current task and apply your change to that version. Mill checks row versions so one edit does not silently replace another. API clients must also send the current version and handle HTTP 409.

## A client gets permission denied

For a personal REST key, check the human owner's current membership and role, then the key's expiry and revocation state. A Viewer-owned key cannot write. Personal keys cannot use MCP or human-only management routes.

For MCP OAuth, check the connection owner's active membership, current role, approved scopes and approved boards. A board-restricted connection cannot create boards or list the team directory. If its last approved board is deleted, the connection is revoked; reconnect and review the new access request. See [the connection guide](clients.md) and [access security](authentication.md#external-credential-boundaries).

## A restore is rejected

Use an explicit `--project`, matching `--confirm-project`, a valid custom-format backup, and a running PostgreSQL target. An existing database needs `--replace`; make a backup before using it. A changed encryption secret prevents decrypting protected authentication data even when the database restores successfully.

## Report a bug

Include the exact commit/version, failed action, HTTP status, and configuration names with values removed. Use a disposable reproduction when possible. Do not attach `.env`, a database dump, account recovery links, cookies, or API tokens. Follow [security reporting](../SECURITY.md) for security reports.
