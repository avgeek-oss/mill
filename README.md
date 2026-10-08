# Mill

Mill is a self-hosted task list for teams, created by Avgeek, Inc. It runs PostgreSQL, an API image, and a UI image. You own the data; everyday task management needs no LLM key or paid service.

Create boards and work in a task list with six fixed statuses: Backlog, Todo, In Progress, In Review, Done, and Won't Do. Boards appear alphabetically. Tasks have Task or Bug types, stable identifiers, Markdown descriptions, optional assignees, priorities, start and due dates, comments, and activity. Team members use Admin, Member, or Viewer access.

Personal and team API keys have explicit Read-only, Edit, or Administrative permissions for REST and MCP. Personal keys remain bounded by their owner's active membership and current role; administrators issue team keys against the team policy. MCP clients can also connect through OAuth with approved read/write scopes and optional board limits.

![Mill task list with sample tasks, statuses, assignees and filters](docs/assets/screenshots/release-v1/board-light.png)

The proposed release is `v1.0.1`. See the [release verification checklist](docs/publishing-checklist.md) for maintainer requirements. Use a published release for an installation; a proposed tag is not a published image.

## Install

You need Docker with Compose v2. Download `docker-compose.yml` and `.env.example` from the same [published release](https://github.com/avgeek-oss/mill/releases), put them in an empty directory, and copy `.env.example` to `.env`.

If you prefer the terminal:

```sh
mkdir mill
cd mill
release_tag=v1.0.1 # choose a published release
curl --fail --location --output docker-compose.yml "https://raw.githubusercontent.com/avgeek-oss/mill/$release_tag/docker-compose.yml"
curl --fail --location --output .env.example "https://raw.githubusercontent.com/avgeek-oss/mill/$release_tag/.env.example"
cp .env.example .env
chmod 600 .env
```

In `.env`, fill in `POSTGRES_PASSWORD` and `MILL_SECRET` with different random values. Use 64 hexadecimal characters for each; a password manager or `openssl rand -hex 32` can generate them. Set `MILL_VERSION` to the release you downloaded, without the `v` prefix. Leave the local URL and port defaults for your first installation.

```sh
docker compose --project-name mill up --detach --wait
```

Compose pulls `ghcr.io/avgeek-oss/mill-api` and `ghcr.io/avgeek-oss/mill-web` at the same version and starts PostgreSQL. Only the UI publishes a host port; it forwards API, authentication and MCP requests privately to the API.

Open [localhost:4321](http://localhost:4321), create your workspace and first administrator, and [make your first board](docs/getting-started.md). There is no default account or password. The published images need no GitHub login, npm credentials, Git, Node.js, or source build.

Keep `.env` private and preserve `MILL_SECRET` with your database backups. `docker compose --project-name mill down` stops the containers and keeps the database volume. See [installation](docs/installation.md) for HTTPS hosting, deployment-platform environment variables and optional digest pinning.

## Develop

The toolchain is Node.js 24.16.0 and pnpm 11.5.3. Dependencies are open source and available from npm or GitHub Packages; there is no dependency on another Avgeek checkout. Follow the [contributor package registry setup](docs/package-registry.md) before installing dependencies.

```sh
npm install --global pnpm@11.5.3
node tools/with-package-token.mjs pnpm install --frozen-lockfile
node tools/init-env.mjs
docker compose --project-name mill --env-file .env --file docker-compose.yml --file tools/compose-development.yml up --detach --wait postgres
pnpm migrate
MILL_BASE_URL=http://localhost:4322 pnpm dev
```

Run `pnpm dev:web` in a second terminal for the frontend development server at [localhost:4322](http://localhost:4322). The frontend proxies API requests to port 4321. The `MILL_BASE_URL` override above lets the API trust browser requests from the development frontend. If `.env` already exists, keep it and skip `init-env`.

Run `pnpm test:quick` for fast Node checks of frontend helpers, configuration and date formatting. See [contributing](CONTRIBUTING.md) for the complete `pnpm verify` and `pnpm verify:production` gates and manual UI review. CI requires the `verify` and `production` gates.

Run `pnpm docs:dev` to preview the documentation from the repository's `docs` root.

## Documentation

Read the [Mill website and documentation](https://www.mill.fyi) or use the guides in this repository.

- [Overview](docs/overview.md), [installation](docs/installation.md), [configuration](docs/configuration.md), and [first board](docs/getting-started.md)
- [Task lists and filters](docs/task-lists.md), [task details and discussion](docs/task-details.md), and [notifications](docs/notifications.md)
- [Team, tasks, and permissions](docs/workflows.md)
- [Personal and team API keys](docs/api-keys.md), [MCP connections](docs/mcp-connections.md), and [REST API and MCP](docs/clients.md), [API reference](docs/api.md), and [access security](docs/authentication.md#external-credential-boundaries)
- [Operations](docs/operations.md), [backup and recovery](docs/backup.md), and [upgrades](docs/upgrades.md)
- [Troubleshooting](docs/troubleshooting.md), [security reporting](docs/security.md), and [v1 release notes](docs/release-notes.md)
- [Contributing](CONTRIBUTING.md), [security reports](SECURITY.md), and [code of conduct](CODE_OF_CONDUCT.md)

## License

Mill uses the [Apache License 2.0](LICENSE). [NOTICE](NOTICE) records adapted code and third-party attribution. The current UI uses open-source components, fonts, and icons.
