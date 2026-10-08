# Configuration

The API needs three values. Copy `.env.example` to `.env` for Compose, or supply them as runtime environment variables through your deployment platform:

| Variable        | Purpose                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`  | Complete PostgreSQL connection URL for your dedicated Mill database. Include the provider's required TLS settings.                    |
| `MILL_SECRET`   | Random secret of at least 32 characters. Recommend 64 hexadecimal characters. Keep private and preserve across upgrades and restores. |
| `MILL_BASE_URL` | Public HTTP(S) origin without path, query or credentials, such as `https://tasks.example.com`. Use `http://localhost:4321` locally.   |

Percent-encode special characters in the database URL's username or password. Mill rejects missing or invalid configuration before it serves requests; there is no fallback production database or default login. It applies the migrations packaged in the API image automatically.

For [bundled PostgreSQL](installation.md#optional-run-postgresql-with-compose), also set `POSTGRES_PASSWORD` and put that same password in `DATABASE_URL=postgres://mill:<password>@postgres:5432/mill`. An existing or managed database needs no `POSTGRES_PASSWORD` variable.

The UI needs only the private API origin. Compose already connects it to `http://api:4321`. On another deployment platform, set `MILL_API_URL` if the API lives at a different private origin. Never give the UI database credentials or `MILL_SECRET`.

Image versions and published ports belong in the Compose file. Both API and UI image references must come from the same release. Runtime internals such as migration paths, production mode and password-work limits are already set by the images and their safe defaults; they are not installation fields.

Environment changes take effect when you recreate the affected service using your installation's Compose command. A container restart alone keeps its old environment. Preserve the original `MILL_SECRET` with encrypted backups of your configuration.

## Public URL

Remote access requires HTTPS. Local HTTP OAuth is permitted automatically only for an exact loopback `MILL_BASE_URL`; there is no insecure-origin switch. For browser passkeys, use `localhost` locally or an HTTPS DNS hostname remotely. Browsers do not allow passkey registration with an IP address as the relying-party domain.

The public origin is used for cookies, passkeys, links and OAuth. Set it correctly before people register passkeys. A base URL change can invalidate passkey origin checks; read [operations](operations.md) before changing an established installation's URL.

## Advanced: forwarded client addresses

Proxy trust is optional and defaults to empty. Mill ignores forwarded client addresses from untrusted connections, preventing a client from choosing its own address to bypass rate limits. A normal installation works with the defaults.

If you need per-client address throttling behind a controlled HTTPS proxy, `MILL_WEB_TRUSTED_PROXY_IPS` lists the exact proxy peer IPs seen by the UI, and `MILL_TRUSTED_PROXY_IPS` lists the exact UI peer IPs seen by the API. Configure them in the respective service environments, not in the basic installation file. Trust only peers you control; keep the API and database private.

## Notifications

Mill v1 uses in-app assignment and mention notifications; task email notifications are excluded. Identity and invitation email is optional. Configure `MILL_SMTP_HOST` and `MILL_SMTP_FROM` together to enable verification links, email changes, password reset links, and invitation email verification. `MILL_SMTP_FROM` is a plain email address. `MILL_SMTP_PORT` defaults to 587; `MILL_SMTP_SECURE=false` requires STARTTLS for remote hosts, while `true` uses implicit TLS (usually port 465). Configure `MILL_SMTP_USER` and `MILL_SMTP_PASSWORD` together when authentication is required. Certificate validation stays enabled; only exact loopback SMTP hosts may use a plaintext development fixture.

Without SMTP, administrators share private invitation links and use the local account-recovery procedure described in [getting started](getting-started.md). An invitation issued with email verification enabled keeps that requirement if SMTP is later disabled; reissue a private invitation explicitly instead of weakening an existing link. Existing accounts start with unverified email facts; sign-in remains available, and verification is recorded only after actual email proof.

The Node service drains a PostgreSQL outbox every five seconds. Sensitive message bodies, links, and codes are encrypted with an authenticated key derived from `MILL_SECRET`; preserve this secret across restart, backup, and restore. Delivery uses bounded SMTP deadlines, a two-minute lease, and at most five attempts with delayed retries. Account/inviter authority and lease ownership are checked under targeted locks immediately before sending starts; network I/O holds no database locks. Cancellation before initiation prevents sending. Cancellation after initiation cannot recall an email, but invalidates its proof and prevents another attempt. Delivered, cancelled, exhausted, and expired messages lose their encrypted payload. Maintenance still expires payloads when SMTP is disabled. SMTP handoff is asynchronous: a successful request means queued, and a process interruption after SMTP acceptance can cause a duplicate email. All copies retain the same single-use proof.

Verification and email-change links expire after one hour. Invitation codes expire after ten minutes and allow five failed attempts; a successful code produces a ten-minute proof bound to the invitation and submitted name before final account creation. Email changes require recent browser identity proof, including a passkey when configured. Confirmation invalidates sessions and owned API/MCP grants. Password resets preserve passkeys; operator recovery can explicitly remove lost factors. Public resend/reset endpoints return the same acknowledgment for unknown, disabled, verified, and unverified addresses; uniform persistent address/email throttles and a 500 ms response floor limit probing. No account state is returned.

Environment files and full database backups need protected storage. Do not paste their contents into logs or screenshots.
