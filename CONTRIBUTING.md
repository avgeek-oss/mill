# Contributing

Read [AGENTS.md](AGENTS.md) and [the architecture](docs/architecture.md) before changing Mill. The task board is the product. Changes should work for people and agents without requiring private packages, cloud credentials, or another checkout.

## Local setup

Follow the [README development steps](README.md#develop). Use Node 24.16.0, pnpm 11.5.3, and PostgreSQL 17. Keep `pnpm-lock.yaml` in the change whenever a package changes. Commit source files, not `.env`, database dumps, dependencies, screenshots with private data, or generated build output.

## Verification

Use a disposable PostgreSQL database. Tests create and clear their fixture data; never point test configuration at a live workspace. The database URL used by tests must be provided explicitly.

```sh
pnpm verify
node tools/docs-check.mjs
node --test tools/*.test.mjs
pnpm exec playwright install chromium
pnpm test:browser
node tools/production-verify.mjs
```

`pnpm verify` covers formatting, lint, types, real PostgreSQL integration tests, production dependency advisories, and builds. Browser tests cover actual UI journeys. The production runner builds the image, creates an isolated Compose project, exercises setup and task persistence, verifies upgrade and full database restore, and rejects HIGH/CRITICAL image vulnerabilities with a pinned Trivy scanner. It removes only its own containers and volumes. These separate gates are all required in CI.

When editing UI, review the running routes in light and dark themes, on desktop and phone widths. Include long titles, empty states, permission errors, keyboard movement, and scrolled selects inside dialogs. Preserve the shared components' keyboard, focus, and touch behavior.

## Changes and reviews

Use a development branch and open a pull request with the problem, resulting behavior, and validation performed. Include a screenshot for a visible change and meaningful tests for new permissions, concurrency, persistence, or installation behavior. A test that repeats the implementation is not useful evidence.

Database migrations are ordered SQL files in `packages/database/migrations`. Add a new migration; do not modify one that has been applied in a verified installation. The migration runner locks the migration sequence and checks file hashes. Test fresh installation and upgrade whenever the schema changes.

Report security defects through [SECURITY.md](SECURITY.md), not a public issue. Contributors agree to the [code of conduct](CODE_OF_CONDUCT.md). Contributions are licensed under Apache-2.0.
