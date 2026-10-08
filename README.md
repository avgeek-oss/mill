# Mill

Mill is a self-hosted task list for teams, created by Avgeek, Inc. It runs one web/API service and PostgreSQL. You own the data; everyday task management needs no LLM key or paid service.

Create boards and work in a task list with six fixed statuses: Backlog, Todo, In Progress, In Review, Done, and Won't Do. Boards appear alphabetically. Tasks have Task or Bug types, stable identifiers, Markdown descriptions, optional assignees, priorities, start and due dates, comments, and activity. Team members use Admin, Member, or Viewer access.

Personal and team API keys have explicit Read-only, Edit, or Administrative permissions for REST and MCP. Personal keys remain bounded by their owner's active membership and current role; administrators issue team keys against the team policy. MCP clients can also connect through OAuth with approved read/write scopes and optional board limits.

The proposed release is `v1.0.1`. See the [release verification checklist](docs/publishing-checklist.md) for maintainer requirements. Release results belong to the reviewed pull request and its CI artifacts; publication and deployment require their applicable authorization.

The staged image publisher produces the combined web/API image at `ghcr.io/avgeek-oss/mill`. It runs only when dispatched for an existing stable tag on current `main`, verifies exact-commit CI, and publishes a GitHub release after native AMD64 and ARM64 registry-image installation checks pass. The repository and GHCR package remain private; see [installation](docs/installation.md) for authenticated digest-pinned pulls after publication.

## Install locally

Install Docker with Compose v2, Git, and Node.js 24. Clone the repository into a directory you control, then run:

```sh
git clone https://github.com/avgeek-oss/mill.git
cd mill
npm login --scope=@avgeek-oss --registry=https://npm.pkg.github.com --auth-type=legacy
node tools/init-env.mjs
node tools/with-package-token.mjs docker compose --project-name mill --env-file .env up --build --detach --wait
```

Open [localhost:4321](http://localhost:4321), create your workspace and first administrator, and [make your first board](docs/getting-started.md). The setup form is available only until the first administrator exists. Mill has no default account or password.

The source build downloads the public `@avgeek-oss/design-system` package from GitHub Packages. At the login prompt, use your GitHub username and a classic personal access token with `read:packages` as the password. GitHub requires authentication for public npm packages too. [Package registry setup](docs/package-registry.md) covers local credentials and CI; running a built Mill image needs no registry token.

The generated `.env` contains private keys and the database password. Keep it out of Git and save an encrypted copy with your database backups. Stop the services with `docker compose --project-name mill --env-file .env down`. Data stays in the project volume unless you explicitly remove it.

For remote access, configure an HTTPS reverse proxy and use [the production installation guide](docs/installation.md). Do not expose the local HTTP installation on the internet.

## Develop

The toolchain is Node.js 24.16.0 and pnpm 11.5.3. Dependencies are open source and available from npm or GitHub Packages; there is no dependency on another Avgeek checkout. Authenticate to GitHub Packages as described above before installing.

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

## Documentation

- [Overview](docs/overview.md), [installation](docs/installation.md), [configuration](docs/configuration.md), and [first board](docs/getting-started.md)
- [Team, tasks, and permissions](docs/workflows.md)
- [REST API and MCP](docs/clients.md), [API reference](docs/api.md), and [access security](docs/authentication.md#external-credential-boundaries)
- [Operations](docs/operations.md), [backup and recovery](docs/backup.md), and [upgrades](docs/upgrades.md)
- [Troubleshooting](docs/troubleshooting.md), [security reporting](docs/security.md), and [v1 release notes](docs/release-notes.md)
- [Contributing](CONTRIBUTING.md), [security reports](SECURITY.md), and [code of conduct](CODE_OF_CONDUCT.md)

## License

Mill uses the [Apache License 2.0](LICENSE). [NOTICE](NOTICE) records adapted code and third-party attribution. The current UI uses open-source components, fonts, and icons.
