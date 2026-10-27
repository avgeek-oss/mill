# Docker Compose

Install Mill with Docker Compose. These steps include PostgreSQL; you can also use an existing database.

## Before you start

You need Docker with Compose v2. For remote access, prepare two HTTPS domains under the same site: one for Mill and one for its API. A reverse proxy routes each domain to its container.

For a local installation, use `http://localhost:4322` for the UI and `http://localhost:4321` for the API instead.

## 1. Download the installation files

Create a directory and download all three files from the same [published release](https://github.com/avgeek-oss/mill/releases):

```sh
mkdir mill
cd mill
release_tag=v1.0.6
curl --fail --location --output docker-compose.yml "https://raw.githubusercontent.com/avgeek-oss/mill/$release_tag/docker-compose.yml"
curl --fail --location --output docker-compose.postgres.yml "https://raw.githubusercontent.com/avgeek-oss/mill/$release_tag/docker-compose.postgres.yml"
curl --fail --location --output .env.example "https://raw.githubusercontent.com/avgeek-oss/mill/$release_tag/.env.example"
cp .env.example .env
chmod 600 .env
```

Choose another published tag to install a different version. The Compose file already selects matching public API and UI images; no GitHub login, registry token, Node.js or source build is needed.

## 2. Set your domains and secrets

Run this command twice to generate separate values for the application secret and database password:

```sh
openssl rand -hex 32
```

Open `.env` and set these values:

```dotenv
MILL_WEB_URL=https://tasks.example.com
MILL_API_URL=https://tasks-api.example.com
MILL_SECRET=REPLACE_WITH_GENERATED_APPLICATION_SECRET
POSTGRES_PASSWORD=REPLACE_WITH_GENERATED_DATABASE_PASSWORD
DATABASE_URL=postgres://mill:REPLACE_WITH_GENERATED_DATABASE_PASSWORD@postgres:5432/mill
```

Use the same generated database password in `POSTGRES_PASSWORD` and `DATABASE_URL`. Hexadecimal passwords from the command above need no URL encoding. If you use another password format, percent-encode special characters in the connection URL.

Keep `.env` private. Preserve `MILL_SECRET` across upgrades and restores, and store an encrypted copy with your backup records.

## 3. Start Mill

```sh
docker compose --project-name mill -f docker-compose.yml -f docker-compose.postgres.yml up --detach --wait
```

Compose pulls the images and starts PostgreSQL, API and UI. The API applies its packaged database migrations automatically. PostgreSQL data lives in a persistent Docker volume and has no published port.

Use the same project name and both `-f` options for subsequent commands. `down` leaves the database volume intact; `down --volumes` permanently removes it.

## 4. Route your domains

For remote access, configure a reverse proxy on the Docker host:

| Public domain           | Forward to              |
| ----------------------- | ----------------------- |
| `tasks.example.com`     | `http://127.0.0.1:4322` |
| `tasks-api.example.com` | `http://127.0.0.1:4321` |

Enable HTTPS for both domains and set their DNS records to your server. For example, with Caddy:

```caddyfile
tasks.example.com {
    reverse_proxy 127.0.0.1:4322
}
tasks-api.example.com {
    reverse_proxy 127.0.0.1:4321
}
```

Forward the entire API origin, including `/api`, `/mcp`, `/oauth`, `/.well-known` and `/health`. Preserve streaming responses and avoid caching API, OAuth or MCP responses. The UI's no-store `/runtime-config.js` supplies the public API origin to browsers.

Set the final origins before people register passkeys or connect MCP clients. See [Configuration](../configuration.md#required-settings) before changing an established installation's URLs.

## 5. Create your team

Find the line labelled `Mill installation setup secret` in the API startup log:

```sh
docker compose --project-name mill -f docker-compose.yml -f docker-compose.postgres.yml logs api
```

Open your Mill URL, enter that setup secret, and create your team and first administrator. The setup secret is separate from `MILL_SECRET`; do not enter the application secret in the form. Keep the setup secret and startup logs private.

There is no default account. The first administrator is email-verified automatically and signed in. Setup closes after the workspace is created; existing installations keep their sign-in flow.

Check readiness on the Docker host:

```sh
curl --fail http://localhost:4321/health/ready
curl --fail http://localhost:4322/health/ready
```

Then verify sign-in and task creation through your public HTTPS URLs. Continue with [your first board and task](../boards.md), [Configuration](../configuration.md) for email or attachments, and [Backup and recovery](../backup.md).

## Choose your database

The steps above use bundled PostgreSQL. To use an existing or managed database, omit the PostgreSQL overlay.

Use a dedicated PostgreSQL database reachable from the API container. Put its full connection URL in `DATABASE_URL`, including any required TLS settings. The database user must be able to create and modify Mill's tables. `localhost` inside a container refers to that container, not the Docker host.

Set `MILL_SECRET`, `MILL_WEB_URL` and `MILL_API_URL` as above. Omit `POSTGRES_PASSWORD` and start without the PostgreSQL overlay:

```sh
docker compose --project-name mill up --detach --wait
```

Continue with domain routing and team setup above. Use the same command without the overlay when managing this installation.

## Pin images by digest

For immutable image references, use the API and UI image digests published with your chosen release. Replace both Compose `image` values with those digest-pinned references. Keep the pair from the same release and record them with your installation settings.

Read [Upgrades](../upgrades.md) before changing versions. [Troubleshooting](../troubleshooting.md) covers startup, sign-in and connectivity problems; [Package registry setup](../package-registry.md) describes building from source.
