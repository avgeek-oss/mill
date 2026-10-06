---
title: "Configuration"
description: "Required and optional environment settings."
---

Start with `node tools/init-env.mjs`; the repository’s `.env.example` documents the same configuration without secrets. Compose reads `.env` explicitly through `--env-file .env`. Development commands read it through Node's `--env-file` option.

| Variable                   | Purpose                                                                                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`        | PostgreSQL password used by Compose. Use the generated hexadecimal value to avoid URL-escaping errors.                                                               |
| `DATABASE_URL`             | Required server/migration PostgreSQL URL. Production Compose constructs an internal URL; local development uses loopback port 55432.                                 |
| `MILL_SECRET`              | Required secret with at least 32 characters for protected authentication values. Generate randomly, keep private, and preserve it across restarts/upgrades/restores. |
| `MILL_BASE_URL`            | Required public HTTP(S) origin, without path/query/credentials. Remote access requires HTTPS. Loopback HTTP is allowed for development.                              |
| `MILL_PORT`                | Compose host port, default 4321. Container port remains 4321.                                                                                                        |
| `MILL_BIND_ADDRESS`        | Compose binding, default 127.0.0.1. Keep private behind a reverse proxy.                                                                                             |
| `PORT`                     | Server port for direct Node execution, default 4321. Compose fixes it to 4321.                                                                                       |
| `NODE_ENV`                 | `development`, `test`, or `production`. Compose uses production.                                                                                                     |
| `ALLOW_INSECURE_LOCALHOST` | Explicit loopback HTTP exception for local MCP OAuth development. Never use it for a remote origin.                                                                  |
| `MILL_IMAGE`               | Local or immutable reviewed image reference used by Compose, default `mill:local`.                                                                                   |
| `SOURCE_COMMIT`            | Build metadata identifying the image's source revision.                                                                                                              |
| `MILL_MIGRATIONS_DIR`      | Override for the migration directory. The image uses `/app/packages/database/migrations`; operators normally do not change it.                                       |

The server rejects missing or invalid required configuration before it serves requests. It does not use a fallback production database or default credentials. A base URL change can invalidate passkey origin checks; read [operations](/operations) before changing an established installation's URL.

For browser passkeys, use `localhost` during local development or an HTTPS DNS hostname in production. A loopback IP origin such as `http://127.0.0.1:4321` supports password sign-in and API testing, but browsers do not allow passkey registration with an IP address as the relying-party domain.

`MILL_TRUSTED_PROXY_IPS` is an optional comma-separated list of exact proxy peer IP addresses as seen by the Node service. The default is empty. Mill accepts a forwarded client IP only from one of these peers; arbitrary `X-Forwarded-For` headers from untrusted clients do not bypass rate limits. A host proxy connecting through Docker's published port may appear as the bridge gateway, while a proxy on the Compose network appears as its container address. Use the actual peer address and keep the HTTP service reachable only through the trusted proxy.

`MILL_WEB_DIR` optionally changes the static frontend directory for direct Node execution. The packaged image already uses the correct `apps/web/dist` path; operators normally leave it unset.

Password hashing and verification share a bounded queue. `MILL_PASSWORD_VERIFY_CONCURRENCY` defaults to 2 and accepts 1–8 concurrent operations. `MILL_PASSWORD_VERIFY_QUEUE_LIMIT` defaults to 16 and accepts 0–100 waiting operations; 0 rejects work whenever all operation slots are occupied. Excess requests return `503 AUTHENTICATION_BUSY` with `Retry-After: 1`, before starting expensive password work. Keep concurrency low on small installations. Authentication throttles persist in PostgreSQL and return the remaining window through `Retry-After`; successful complete sign-in clears the account bucket while address throttling remains in place.

## Notifications

Mill v1 uses in-app assignment and mention notifications; task email notifications are excluded. The account/invitation email provider is currently unavailable. Administrators share private invitation links and use the local account-recovery procedure described in [getting started](/getting-started).

Environment files and full database backups need protected storage. Do not paste their contents into logs or screenshots.

## In the app

### Team settings: General

<Tabs>
  <Tab title="Desktop">
    <Frame>
      <div className="mill-guide-screenshot">
        <div className="mill-product-light">
          <img
            src="/assets/screenshots/release-v1/team-light.png"
            alt="Team settings: General in Mill."
            width="1280"
            height="900"
            loading="lazy"
          />
        </div>
        <div className="mill-product-dark">
          <img
            src="/assets/screenshots/release-v1/team-dark.png"
            alt="Team settings: General in Mill."
            width="1280"
            height="900"
            loading="lazy"
          />
        </div>
      </div>
    </Frame>
  </Tab>
  <Tab title="Mobile">
    <Frame>
      <div className="mill-guide-screenshot mill-guide-screenshot-mobile">
        <div className="mill-product-light">
          <img
            src="/assets/screenshots/release-v1/team-mobile-light.png"
            alt="Team settings: General in Mill."
            width="390"
            height="844"
            loading="lazy"
          />
        </div>
        <div className="mill-product-dark">
          <img
            src="/assets/screenshots/release-v1/team-mobile-dark.png"
            alt="Team settings: General in Mill."
            width="390"
            height="844"
            loading="lazy"
          />
        </div>
      </div>
    </Frame>
  </Tab>
</Tabs>
