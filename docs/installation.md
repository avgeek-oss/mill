# Installation

Mill needs Docker with the Compose v2 plugin, Git, and Node.js 24 to generate configuration. The production image builds the frontend and server together. PostgreSQL is the only required backing service.

## Local installation

```sh
git clone https://github.com/avgeek-oss/mill.git
cd mill
npm login --scope=@avgeek-oss --registry=https://npm.pkg.github.com --auth-type=legacy
node tools/init-env.mjs
node tools/with-package-token.mjs docker compose --project-name mill --env-file .env up --build --detach --wait
docker compose --project-name mill --env-file .env ps
curl --fail http://localhost:4321/health/ready
```

Open [localhost:4321](http://localhost:4321). Create a workspace, your name, email, and a strong password. The first account becomes an administrator. There is no default login, and later attempts to repeat setup are rejected.

Use your GitHub username and a classic personal access token with `read:packages` at the npm login prompt. The frontend's public shared design system is hosted in GitHub Packages, which requires authentication even for public npm packages. The wrapper uses your stored login or `NODE_AUTH_TOKEN` and sends it as a BuildKit secret. Registry credentials are needed only while building from source; they do not enter the running application. See [package registry setup](package-registry.md).

The generator creates `.env` with owner-only permissions. It refuses to overwrite an existing file. Mill's database volume belongs to the `mill` Compose project, so use `--project-name mill` consistently. `down` stops and removes containers; it leaves the database volume in place. `down --volumes` permanently removes it.

## Install a published image

After a release is published, its `mill-images.json` asset records an immutable `ghcr.io/avgeek-oss/mill@sha256:…` reference for the combined web/API service. Check out the matching release tag for Compose, migrations, and backup tools. Authenticate to GHCR with a GitHub account that has access to this private package, then set `MILL_IMAGE` in `.env` to the manifest's digest reference. Run `docker compose --project-name mill --env-file .env pull mill` followed by `docker compose --project-name mill --env-file .env up --no-build --detach --wait`. The running image needs no npm package token. Keep a compatible `NODE_AUTH_TOKEN` in the shell if Compose requires its build-secret declaration while reading the file.

Check the image reference against the release asset and the tag before starting or upgrading. The release workflow installs that same digest on native AMD64 and ARM64 runners, including a database restore and restart exercise.

## Remote access

Point a DNS name you own to the server, then configure an HTTPS reverse proxy. Generate the Mill configuration with that public origin:

```sh
node tools/init-env.mjs --base-url https://tasks.example.com
node tools/with-package-token.mjs docker compose --project-name mill --env-file .env up --build --detach --wait
```

Keep `MILL_BIND_ADDRESS=127.0.0.1` when the reverse proxy runs on the same host. Mill's URL must match the browser's origin; it is used for cookies, passkeys, links, and OAuth checks. HTTP OAuth access is restricted to explicit loopback development.

Related reverse-proxy configuration:

```caddyfile
# /etc/caddy/Caddyfile
tasks.example.com {
    reverse_proxy 127.0.0.1:4321
}
```

Use a current, supported Caddy release and follow its service setup instructions. The proxy must preserve the host and support streaming HTTP at `/mcp`. Do not cache `/api`, `/mcp`, or OAuth responses. PostgreSQL has no host port in the production Compose file.

Set `MILL_TRUSTED_PROXY_IPS` to the reverse proxy's exact peer IP as Mill sees it, then recreate the service. This lets rate limits use the real client IP. The default trusts no forwarded IP headers. For a host proxy using the published port, inspect the `mill_default` Docker network's gateway and verify that is the proxy peer. Do not trust arbitrary public clients or a whole address range. See [configuration](configuration.md).

If your reverse proxy runs in a separate container, connect it to the Mill Compose network and proxy to `mill:4321`. You can remove Mill's published port in a Compose override. Do not expose PostgreSQL or bind unencrypted Mill HTTP to a public address.

## First checks

Sign in, create a board and task, and reload. Check [readiness](operations.md), then take your first [backup](backup.md). Save an encrypted copy of `.env` alongside your recovery plan. Preserve the same `MILL_SECRET` to restore protected values and retry records.

Before upgrades, read [upgrades](upgrades.md). For configuration options see [configuration](configuration.md), and for common installation errors see [troubleshooting](troubleshooting.md).
