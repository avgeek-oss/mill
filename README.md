# Mill

Mill is a self-hosted task list for teams, created by Avgeek, Inc. It runs an API image and a UI image connected to PostgreSQL. You own the data; everyday task management needs no LLM key or paid service.

Create boards and work in a task list with six fixed statuses: Backlog, Todo, In Progress, In Review, Done, and Won't Do. Boards appear alphabetically. Tasks have Task or Bug types, stable identifiers, Markdown descriptions, optional assignees, priorities, start and due dates, threaded comments, activity, and optional image/PDF attachments. Team members use Admin, Member, or Viewer access.

Personal and team API keys have explicit Read-only, Edit, or Administrative permissions for REST. Personal keys remain bounded by their owner's active membership and current role; administrators issue team keys against the team policy. MCP clients connect only through OAuth with approved read, write, or administrative scopes and the person's current board access.

![Mill task list with sample tasks, statuses, assignees and filters](docs/assets/screenshots/release-v1/board-light.png)

Use a version from [Mill releases](https://github.com/avgeek-oss/mill/releases). Each release publishes matching public API and UI images. See the [release verification checklist](docs/publishing-checklist.md) for maintainer requirements.

## Install

You need Docker with Compose v2. Download `docker-compose.yml` and `.env.example` from the same [published release](https://github.com/avgeek-oss/mill/releases), put them in an empty directory, and copy `.env.example` to `.env`.

If you prefer the terminal:

```sh
mkdir mill
cd mill
release_tag=v1.0.6 # choose a published release
curl --fail --location --output docker-compose.yml "https://raw.githubusercontent.com/avgeek-oss/mill/$release_tag/docker-compose.yml"
curl --fail --location --output .env.example "https://raw.githubusercontent.com/avgeek-oss/mill/$release_tag/.env.example"
cp .env.example .env
chmod 600 .env
```

Set these four values in `.env`:

```dotenv
DATABASE_URL=postgres://user:password@your-database-host:5432/mill
MILL_SECRET=<a random secret of at least 32 characters>
MILL_WEB_URL=http://localhost:4322
MILL_API_URL=http://localhost:4321
```

Use a dedicated PostgreSQL database and its connection URL. Generate `MILL_SECRET` with a password manager or `openssl rand -hex 32`, and preserve it across upgrades and restores. For remote access, use your final HTTPS UI and API origins.

```sh
docker compose --project-name mill up --detach --wait
```

Compose pulls `ghcr.io/avgeek-oss/mill-api` and `ghcr.io/avgeek-oss/mill-web` at the release version already written in the Compose file. Both services publish separate loopback ports. The browser calls the public API origin directly; expose each service with its own HTTPS hostname.

Read the installation setup secret from `docker compose --project-name mill logs api`, then open [localhost:4322](http://localhost:4322), enter the secret and create your workspace and first administrator, and [make your first board](docs/boards.md). There is no default account or password. The published images need no GitHub login, npm credentials, Git, Node.js, or source build.

If you want Compose to run PostgreSQL too, download `docker-compose.postgres.yml` from the same release and follow the [bundled PostgreSQL instructions](docs/installation/docker-compose.md#choose-your-database). Your existing or managed PostgreSQL instance works directly with the default Compose file.

Images and PDFs appear below the task description. **Upload attachment** opens a dialog with a file chooser and drop area. Dropping a file onto the task page also opens the dialog and starts uploading. To enable this, configure optional private S3-compatible storage through [configuration](docs/configuration.md#s3-source). Ordinary task management works without a bucket.

Keep `.env` private and preserve `MILL_SECRET` with your database backups. See [installation](docs/installation.md) for HTTPS hosting and deployment-platform configuration.

An optional in-app assistant can read boards and tasks and propose changes for approval. Configure a model credential only on the API to enable it; see [configuration](docs/configuration.md#optional-in-app-assistant). Human task ownership and permissions remain the same.

For Towbar, follow [the installation guide](docs/installation/towbar.md) for copyable API, UI and PostgreSQL manifests. The examples use packaged images with separate public UI and API origins.

## Develop

The toolchain is Node.js 26 and pnpm 11.5.3. Dependencies are open source and available from npmjs.org; there is no dependency on another Avgeek checkout. Follow the [package registry setup](docs/package-registry.md) before installing dependencies.

```sh
npm install --global pnpm@11.5.3
pnpm install --frozen-lockfile
node tools/init-env.mjs
docker compose --project-name mill --env-file .env --file docker-compose.yml --file docker-compose.postgres.yml --file tools/compose-development.yml up --detach --wait postgres
pnpm migrate
MILL_WEB_URL=http://localhost:4322 MILL_API_URL=http://localhost:4321 pnpm dev
```

Run `pnpm dev:web` in a second terminal for the frontend development server at [localhost:4322](http://localhost:4322). The frontend uses a runtime API origin of `http://localhost:4321`; the API trusts browser requests from `http://localhost:4322`. If `.env` already exists, keep it and skip `init-env`.

After completing setup, preload representative local data with your administrator's email:

```sh
pnpm fixtures --admin-email you@example.test
```

This adds Product, Engineering, Website and an empty Ideas board, 44 tasks across all six statuses and five priorities, three sample members, comments, activity and unread mention notifications. Tasks include bugs, assignments, Markdown descriptions, start dates and overdue/upcoming due dates. Dates are relative to the first run. Sample members use non-deliverable `example.test` addresses and random passwords; keep using your own account to sign in.

The command requires loopback database, API and UI hosts and refuses production mode. It runs in one transaction, preserves existing records and skips previously seeded boards on subsequent runs, including any edits you make to their tasks. Run it explicitly for each new local database; ordinary app startup does not insert sample data.

Run `pnpm test:quick` for fast Node checks of frontend helpers, configuration and date formatting. See the [development notes](CONTRIBUTING.md) for the complete `pnpm verify` and `pnpm verify:production` gates and manual UI review. CI requires the `verify` and `production` gates.

Run `pnpm docs:dev` to preview the documentation from the repository's `docs` root.

## Documentation

Read the [Mill website and documentation](https://www.mill.fyi) or use the guides in this repository.

- [Overview](docs/overview.md), [installation](docs/installation.md), [configuration](docs/configuration.md), and [first board](docs/boards.md)
- [Task lists and filters](docs/task-lists.md), [task details and discussion](docs/task-details.md), [task attachments](docs/task-attachments.md), and [notifications](docs/notifications.md)
- [Personal and team API keys](docs/api-keys.md), [MCP connections](docs/mcp-connections.md), [MCP tool reference](https://www.mill.fyi/mcp-reference/overview), [API reference](https://www.mill.fyi/api-reference/overview), and [access security](docs/authentication.md#external-credential-boundaries)
- [Operations](docs/operations.md), [backup and recovery](docs/backup.md), and [upgrades](docs/upgrades.md)
- [Troubleshooting](docs/troubleshooting.md), [security reporting](docs/security.md), and [changelog](https://github.com/avgeek-oss/mill/releases)
- [Development notes](CONTRIBUTING.md), [security reports](SECURITY.md), and [code of conduct](CODE_OF_CONDUCT.md). Public contributions are not accepted; feedback and issues are welcome in this repository.

## License

Mill uses the [Apache License 2.0](LICENSE). [NOTICE](NOTICE) records adapted code and third-party attribution. The current UI uses open-source components, fonts, and icons.
