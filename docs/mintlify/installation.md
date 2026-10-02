---
title: "Installation"
description: "Install Mill with Docker Compose and PostgreSQL."
---

Mill needs Docker with the Compose v2 plugin, Git, and Node.js 24 to generate configuration. The production image builds the frontend and server together. PostgreSQL is the only required backing service.

## Local installation

```sh
git clone https://github.com/avgeek-inc/mill.git
cd mill
node tools/init-env.mjs
docker compose --project-name mill --env-file .env up --build --detach --wait
docker compose --project-name mill --env-file .env ps
curl --fail http://localhost:4321/health/ready
```

Open [localhost:4321](http://localhost:4321). Create a workspace, your name, email, and a strong password. The first account becomes an administrator. There is no default login, and later attempts to repeat setup are rejected.

The generator creates `.env` with owner-only permissions. It refuses to overwrite an existing file. Mill's database volume belongs to the `mill` Compose project, so use `--project-name mill` consistently. `down` stops and removes containers; it leaves the database volume in place. `down --volumes` permanently removes it.

## Remote access

Point a DNS name you own to the server, then configure an HTTPS reverse proxy. Generate the Mill configuration with that public origin:

```sh
node tools/init-env.mjs --base-url https://tasks.example.com
docker compose --project-name mill --env-file .env up --build --detach --wait
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

Set `MILL_TRUSTED_PROXY_IPS` to the reverse proxy's exact peer IP as Mill sees it, then recreate the service. This lets rate limits use the real client IP. The default trusts no forwarded IP headers. For a host proxy using the published port, inspect the `mill_default` Docker network's gateway and verify that is the proxy peer. Do not trust arbitrary public clients or a whole address range. See [configuration](/configuration).

If your reverse proxy runs in a separate container, connect it to the Mill Compose network and proxy to `mill:4321`. You can remove Mill's published port in a Compose override. Do not expose PostgreSQL or bind unencrypted Mill HTTP to a public address.

## First checks

Sign in, create a board and task, and reload. Check [readiness](/operations), then take your first [backup](/backup). Save an encrypted copy of `.env` alongside your recovery plan. The same `MILL_SECRET` is needed to decrypt authenticators and other protected values after a full restore.

Before upgrades, read [upgrades](/upgrades). For configuration options see [configuration](/configuration), and for common installation errors see [troubleshooting](/troubleshooting).
