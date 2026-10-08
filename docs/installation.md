# Installation

Mill needs **PostgreSQL, an API image and a UI image**. Use an existing PostgreSQL database or let Compose run one for you. The default Compose file runs only the API and UI; it needs three environment values. You do not need Git, Node.js, a package-registry token or a source build.

The first public release is proposed as `v1.0.1`. Choose a release only after its GitHub release and both public images have been published.

## 1. Download the installation files

Choose a version from [Mill releases](https://github.com/avgeek-oss/mill/releases). Download `docker-compose.yml` and `.env.example` from that release's source tag into an empty directory. You can use your browser or these commands:

```sh
mkdir mill
cd mill
release_tag=v1.0.1 # choose a published release
curl --fail --location --output docker-compose.yml "https://raw.githubusercontent.com/avgeek-oss/mill/$release_tag/docker-compose.yml"
curl --fail --location --output .env.example "https://raw.githubusercontent.com/avgeek-oss/mill/$release_tag/.env.example"
cp .env.example .env
chmod 600 .env
```

Keep these files together and run the remaining commands from this directory. Compose reads `.env` automatically; `--env-file /path/to/your.env` is available if you store it elsewhere. Image versions are already set in the release's Compose file.

## 2. Set three environment values

Edit `.env`:

```dotenv
DATABASE_URL=postgres://user:password@your-database-host:5432/mill
MILL_SECRET=<a random secret of at least 32 characters>
MILL_BASE_URL=http://localhost:4321
```

Use a dedicated PostgreSQL database with a user that can create and modify its tables. Supply the provider's complete connection URL, including any required TLS parameters. Percent-encode special characters in a URL's username or password. The database host must be reachable from the API container; `localhost` inside that container refers to the container itself.

Generate `MILL_SECRET` with a password manager or `openssl rand -hex 32`. Keep it private and preserve it across upgrades and restores: Mill uses it to protect authentication data. Leave `MILL_BASE_URL` as shown for local use, or use your final HTTPS origin for remote access.

## 3. Start Mill

```sh
docker compose --project-name mill up --detach --wait
```

Compose pulls both versioned images and waits for the API and UI to become healthy. The API applies its packaged database migrations automatically. Open [localhost:4321](http://localhost:4321) and create your workspace, name, email and password. The first account becomes an administrator; there is no default login. The setup form closes after that first account is created.

Check the running services and the complete UI-to-API path:

```sh
docker compose --project-name mill ps
curl --fail http://localhost:4321/health/ready
```

Continue with [your first board and task](getting-started.md). No GitHub login or npm token is needed to pull public release images. Only the UI publishes a host port; it forwards authentication, API and streaming MCP requests privately to the API. The API holds the database URL and application secret; the UI has neither.

## Optional: run PostgreSQL with Compose

If you do not have a database, download `docker-compose.postgres.yml` from the same release:

```sh
curl --fail --location --output docker-compose.postgres.yml "https://raw.githubusercontent.com/avgeek-oss/mill/$release_tag/docker-compose.postgres.yml"
```

Generate a separate database password with `openssl rand -hex 32`. Add `POSTGRES_PASSWORD` to `.env` and use the same value in `DATABASE_URL`:

```dotenv
POSTGRES_PASSWORD=<your generated database password>
DATABASE_URL=postgres://mill:<the same database password>@postgres:5432/mill
```

Keep the existing `MILL_SECRET` and `MILL_BASE_URL` values. Start all three services with the optional overlay:

```sh
docker compose --project-name mill -f docker-compose.yml -f docker-compose.postgres.yml up --detach --wait
```

Use both `-f` options for subsequent commands on this installation. The overlay creates persistent PostgreSQL storage, waits for database readiness before starting the API, and publishes no database port. Use `--project-name mill` consistently so Compose reuses the same volume. `down` stops the containers and leaves the volume intact; `down --volumes` permanently removes it.

## Host Mill with HTTPS

Set `MILL_BASE_URL` to the exact browser origin, for example `https://tasks.example.com`, and recreate the services using your installation's Compose command. The default UI port binds to `127.0.0.1:4321`, ready for a reverse proxy on the same host. For example, a Caddy configuration can use:

```caddyfile
tasks.example.com {
    reverse_proxy 127.0.0.1:4321
}
```

A proxy on the Compose network can use `web:4322` instead. Preserve the public host, support streaming HTTP at `/mcp`, and do not cache `/api`, `/mcp` or OAuth responses. Keep the database and API private. To change the local port or bind address, edit the web service's `ports` entry in Compose and keep `MILL_BASE_URL` aligned with the browser URL.

The public origin is used for cookies, passkeys, links and OAuth. Set it correctly before people register passkeys; changing it later requires a recovery plan. Remote access requires HTTPS. Local HTTP OAuth works automatically only when `MILL_BASE_URL` is an exact loopback origin; no extra switch is needed.

## Use a deployment platform

Images read runtime environment variables directly. A platform or secret manager can supply them without an `.env` file:

| Service | Image                                   | Runtime configuration                                                                         |
| ------- | --------------------------------------- | --------------------------------------------------------------------------------------------- |
| API     | `ghcr.io/avgeek-oss/mill-api:<version>` | `DATABASE_URL`, `MILL_SECRET`, `MILL_BASE_URL`. Private port `4321`.                          |
| UI      | `ghcr.io/avgeek-oss/mill-web:<version>` | `MILL_API_URL` only if the private API origin differs from `http://api:4321`. UI port `4322`. |

Use your PostgreSQL instance's connection URL as `DATABASE_URL`. Keep the API and UI at the same release version, and route the public HTTPS hostname to the UI. Optional email and advanced proxy settings are covered in [configuration](configuration.md).

## Optional: pin images by digest

If your deployment policy requires immutable references, download `mill-images.json` from the matching GitHub release. Replace the two services' `image` fields in Compose with its `images.api` and `images.web` values:

```yaml
services:
  api:
    image: ghcr.io/avgeek-oss/mill-api@sha256:<api digest from the manifest>
  web:
    image: ghcr.io/avgeek-oss/mill-web@sha256:<web digest from the manifest>
```

These are image references, not application environment variables. Keep both images from the same release and retain the manifest with your installation records.

## Protect your installation

Take a [first backup](backup.md), keep an encrypted copy of the environment settings, and preserve the original `MILL_SECRET`. Before changing versions, read [upgrades](upgrades.md). [Troubleshooting](troubleshooting.md) covers startup, authentication and connectivity issues. Source builds are for contributors; see [package registry setup](package-registry.md).
