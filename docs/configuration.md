# Configuration

Copy `.env.example` to `.env` and fill in the required secrets before running Compose. Compose reads `.env` automatically and expands the database URL's `${POSTGRES_PASSWORD}` placeholder. You can instead supply environment variables from a deployment platform or secret manager. Both images read their configuration at runtime; neither requires a baked-in `.env` file.

## Required settings and image selection

| Variable                   | Used by              | Purpose                                                                                                                                                                               |
| -------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`        | PostgreSQL / Compose | Required database password for the bundled PostgreSQL service. Use a random hexadecimal value to avoid URL-escaping errors.                                                           |
| `DATABASE_URL`             | API                  | Required PostgreSQL connection URL. The Compose example expands the configured password and uses private `postgres:5432`; an external provider can supply a complete URL.             |
| `MILL_SECRET`              | API                  | Required random secret with at least 32 characters. Recommend 64 hexadecimal characters. Keep private and preserve across restarts, upgrades and restores.                            |
| `MILL_BASE_URL`            | API                  | Required public HTTP(S) origin without path, query or credentials. Remote access requires HTTPS. Loopback HTTP is for local use.                                                      |
| `MILL_API_URL`             | UI                   | Required private API origin, for example `http://api:4321`. The UI serves static files and forwards requests to this address. No database URL or encryption secret belongs in the UI. |
| `MILL_VERSION`             | Compose              | Published release version for both images, without the `v` prefix. Keep API and UI versions aligned.                                                                                  |
| `MILL_API_IMAGE`           | Compose              | Optional full API image override, usually `ghcr.io/avgeek-oss/mill-api@sha256:...` from the release manifest.                                                                         |
| `MILL_WEB_IMAGE`           | Compose              | Optional full UI image override, usually `ghcr.io/avgeek-oss/mill-web@sha256:...` from the same release manifest.                                                                     |
| `MILL_PORT`                | Compose              | Published UI host port, default `4321`. UI container port is `4322`; API private port is `4321`.                                                                                      |
| `MILL_BIND_ADDRESS`        | Compose              | Published UI binding, default `127.0.0.1`. Keep private behind an HTTPS reverse proxy.                                                                                                |
| `ALLOW_INSECURE_LOCALHOST` | API                  | Explicit loopback HTTP exception for local MCP OAuth. Use `false` for a remote origin.                                                                                                |

`DATABASE_URL` is an actual URL when passed to the API. Compose expands the example's password placeholder; other deployment platforms may not interpolate placeholders. Supply a complete URL there and percent-encode special characters in its username or password.

## Runtime defaults

| Variable              | Purpose                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `PORT`                | Direct process port. Packaged API defaults to `4321`; packaged UI defaults to `4322`. Compose sets each explicitly. |
| `NODE_ENV`            | `development`, `test`, or `production`. Packaged services use production.                                           |
| `SOURCE_COMMIT`       | Image build metadata identifying the source revision. Operators do not need to set it.                              |
| `MILL_MIGRATIONS_DIR` | API migration directory override. The API image uses its packaged migrations; operators normally leave it unset.    |

The server rejects missing or invalid required configuration before it serves requests. It does not use a fallback production database or default credentials. A base URL change can invalidate passkey origin checks; read [operations](operations.md) before changing an established installation's URL.

For browser passkeys, use `localhost` during local development or an HTTPS DNS hostname in production. A loopback IP origin such as `http://127.0.0.1:4321` supports password sign-in and API testing, but browsers do not allow passkey registration with an IP address as the relying-party domain.

`MILL_TRUSTED_PROXY_IPS` is an optional comma-separated list of exact proxy peer IP addresses as seen by the Node service. The default is empty. Mill accepts a forwarded client IP only from one of these peers; arbitrary `X-Forwarded-For` headers from untrusted clients do not bypass rate limits. The API's immediate peer is normally the UI proxy, not the public browser or host HTTPS proxy. By default the UI replaces incoming forwarded client IPs with its socket peer, and the API ignores forwarded IPs. To use the real client address behind a controlled HTTPS proxy, set `MILL_WEB_TRUSTED_PROXY_IPS` to the exact HTTPS proxy peer addresses seen by the UI, and `MILL_TRUSTED_PROXY_IPS` to the UI peer addresses seen by the API. The UI accepts the last forwarded address only from a trusted peer. Do not trust arbitrary public clients or broad address ranges. Keep both API and database private.

The UI image includes the built frontend and never needs access to database credentials. The API image includes the server and migrations. Environment changes take effect when you recreate the affected service with `docker compose --project-name mill up --detach --wait`; a container restart alone keeps its old environment.

Password hashing and verification share a bounded queue. `MILL_PASSWORD_VERIFY_CONCURRENCY` defaults to 2 and accepts 1–8 concurrent operations. `MILL_PASSWORD_VERIFY_QUEUE_LIMIT` defaults to 16 and accepts 0–100 waiting operations; 0 rejects work whenever all operation slots are occupied. Excess requests return `503 AUTHENTICATION_BUSY` with `Retry-After: 1`, before starting expensive password work. Keep concurrency low on small installations. Authentication throttles persist in PostgreSQL and return the remaining window through `Retry-After`; successful complete sign-in clears the account bucket while address throttling remains in place.

## Notifications

Mill v1 uses in-app assignment and mention notifications; task email notifications are excluded. Identity and invitation email is optional. Configure `MILL_SMTP_HOST` and `MILL_SMTP_FROM` together to enable verification links, email changes, password reset links, and invitation email verification. `MILL_SMTP_FROM` is a plain email address. `MILL_SMTP_PORT` defaults to 587; `MILL_SMTP_SECURE=false` requires STARTTLS for remote hosts, while `true` uses implicit TLS (usually port 465). Configure `MILL_SMTP_USER` and `MILL_SMTP_PASSWORD` together when authentication is required. Certificate validation stays enabled; only exact loopback SMTP hosts may use a plaintext development fixture.

Without SMTP, administrators share private invitation links and use the local account-recovery procedure described in [getting started](getting-started.md). An invitation issued with email verification enabled keeps that requirement if SMTP is later disabled; reissue a private invitation explicitly instead of weakening an existing link. Existing accounts start with unverified email facts; sign-in remains available, and verification is recorded only after actual email proof.

The Node service drains a PostgreSQL outbox every five seconds. Sensitive message bodies, links, and codes are encrypted with an authenticated key derived from `MILL_SECRET`; preserve this secret across restart, backup, and restore. Delivery uses bounded SMTP deadlines, a two-minute lease, and at most five attempts with delayed retries. Account/inviter authority and lease ownership are checked under targeted locks immediately before sending starts; network I/O holds no database locks. Cancellation before initiation prevents sending. Cancellation after initiation cannot recall an email, but invalidates its proof and prevents another attempt. Delivered, cancelled, exhausted, and expired messages lose their encrypted payload. Maintenance still expires payloads when SMTP is disabled. SMTP handoff is asynchronous: a successful request means queued, and a process interruption after SMTP acceptance can cause a duplicate email. All copies retain the same single-use proof.

Verification and email-change links expire after one hour. Invitation codes expire after ten minutes and allow five failed attempts; a successful code produces a ten-minute proof bound to the invitation and submitted name before final account creation. Email changes require recent browser identity proof, including a passkey when configured. Confirmation invalidates sessions and owned API/MCP grants. Password resets preserve passkeys; operator recovery can explicitly remove lost factors. Public resend/reset endpoints return the same acknowledgment for unknown, disabled, verified, and unverified addresses; uniform persistent address/email throttles and a 500 ms response floor limit probing. No account state is returned.

Environment files and full database backups need protected storage. Do not paste their contents into logs or screenshots.
