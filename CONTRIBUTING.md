# Contributing

Read [AGENTS.md](AGENTS.md) and [the architecture](docs/architecture.md) before changing Mill. The task board is the product. Changes should work for people and connected clients without requiring private packages or another checkout. Source builds require [GitHub Packages authentication](docs/package-registry.md) for the public shared design system; the running application needs no registry credentials.

## Local setup

Follow the [README development steps](README.md#develop). Use Node 24.16.0, pnpm 11.5.3, and PostgreSQL 17. Keep `pnpm-lock.yaml` in the change whenever a package changes. Commit source files, not `.env`, database dumps, dependencies, screenshots with private data, or generated build output.

## Verification

For quick feedback on frontend helpers, configuration and date formatting, run:

```sh
pnpm test:quick
```

These selected Node tests do not need a running browser or database. Before submitting a change, run the complete source and production checks:

```sh
pnpm verify
pnpm verify:production
```

Use a disposable PostgreSQL database for `pnpm verify` and provide its `DATABASE_URL` explicitly. Tests create and clear fixture data; never point them at a live workspace. The full check covers documentation links, tooling tests, formatting, lint, types, real PostgreSQL integration tests, production dependency advisories and builds. The quick tests do not replace this check.

The production runner builds the image, creates an isolated Compose project, exercises setup and persistence, checks migrations and complete database restore, and rejects HIGH/CRITICAL image vulnerabilities with a pinned Trivy scanner. It removes only its own containers and volumes. CI requires the `verify` and `production` gates for the reviewed revision.

The production runner accepts `NODE_AUTH_TOKEN` or your stored GitHub Packages npm login. It passes the credential to BuildKit as a build secret and redacts it from saved evidence. CI uses `GITHUB_TOKEN` with `packages:read`; the shared package must grant the Mill repository Actions access. See [package registry setup](docs/package-registry.md#continuous-integration).

When editing UI, manually review the running routes in light and dark themes, on desktop and phone widths. Include long titles, empty states, permission errors, keyboard movement, and scrolled selects inside dialogs. Preserve the shared components' keyboard, focus, and touch behavior.

## Documentation

Edit the maintained guides in `docs/`, the homepage in `docs/home.mdx`, and its styles in `docs/home.css`. Run `pnpm docs:build` to regenerate the Mintlify site, then `pnpm docs:dev` to review it at `http://localhost:4174`. Generated pages in `docs/mintlify` are replaced by the build.

For documentation images after a visible application change, use the optional [manual screenshot refresh workflow](docs/screenshot-refresh.md). `pnpm docs:screenshots` refreshes every application section from an isolated example workspace; `pnpm docs:screenshots --docs-url http://localhost:4174` also captures every documentation page. Review the desktop and mobile images in both themes before including them in the docs.

## Changes and reviews

Use a development branch and open a pull request with the problem, resulting behavior, and validation performed. Include a screenshot for a visible change and meaningful tests for new permissions, concurrency, persistence, or installation behavior. A test that repeats the implementation is not useful evidence.

Database migrations are ordered SQL files in `packages/database/migrations`. Add a new migration; do not modify one that has been applied in a verified installation. The migration runner locks the migration sequence and checks file hashes. Test fresh installation and upgrade whenever the schema changes.

Report security defects through [SECURITY.md](SECURITY.md), not a public issue. Contributors agree to the [code of conduct](CODE_OF_CONDUCT.md). Contributions are licensed under Apache-2.0.
