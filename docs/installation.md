# Installation

Mill needs Docker with the Compose v2 plugin, Git, Node.js 24, `curl`, and `jq`. A published image contains the frontend and server together. PostgreSQL is the only required backing service.

## Install a published image

Choose a tag from [Mill releases](https://github.com/avgeek-oss/mill/releases) that has a `mill-images.json` asset. The proposed `v1.0.1` tag is usable only after publication. The manifest names the image by immutable digest; keep it with your installation records. Use the matching tag for Compose and maintenance scripts.

```sh
git clone https://github.com/avgeek-oss/mill.git
cd mill
release_tag=v1.0.1 # replace with the published release tag
git checkout "$release_tag"
curl --fail --location --output mill-images.json "https://github.com/avgeek-oss/mill/releases/download/$release_tag/mill-images.json"
test "$(jq -r .version mill-images.json)" = "$release_tag"
test "$(jq -r .commit mill-images.json)" = "$(git rev-parse HEAD)"
jq -e '.platforms == ["linux/amd64", "linux/arm64"] and (.image | test("^ghcr[.]io/avgeek-oss/mill@sha256:[0-9a-f]{64}$"))' mill-images.json
image="$(jq -r .image mill-images.json)"
anonymous_config="$(mktemp -d)"
DOCKER_CONFIG="$anonymous_config" docker manifest inspect "$image" >/dev/null
rmdir "$anonymous_config"
node tools/init-env.mjs --image "$image"
docker compose --project-name mill --env-file .env pull mill
docker compose --project-name mill --env-file .env up --no-build --detach --wait
docker compose --project-name mill --env-file .env ps
curl --fail http://localhost:4321/health/ready
```

Open [localhost:4321](http://localhost:4321). Create a workspace, your name, email, and a strong password. The first account becomes an administrator. There is no default login, and later attempts to repeat setup are rejected.

The image pull needs no GitHub login when the GHCR package is public. If the anonymous manifest check fails, the release is not ready for this installation path; the package owner must make the GHCR package public and rerun release verification. No npm token is needed to run the published image. Contributors building from source should follow [package registry setup](package-registry.md).

The generator creates `.env` with owner-only permissions. It refuses to overwrite an existing file. Mill's database volume belongs to the `mill` Compose project, so use `--project-name mill` consistently. `down` stops and removes containers; it leaves the database volume in place. `down --volumes` permanently removes it.

The release workflow installs that same digest on native AMD64 and ARM64 runners, including a database restore and restart exercise. It must pass before the release is published.

## Remote access

Point a DNS name you own to the server, then configure an HTTPS reverse proxy. For a new remote installation, follow the published-image steps through the `image` assignment, then generate configuration with your public origin and start the same digest:

```sh
node tools/init-env.mjs --base-url https://tasks.example.com --image "$image"
docker compose --project-name mill --env-file .env pull mill
docker compose --project-name mill --env-file .env up --no-build --detach --wait
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
