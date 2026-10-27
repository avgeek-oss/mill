# Package registry

Mill uses public npm packages, including `@avgeek-oss/design-system` and `@avgeek-oss/mintlify-docs`. Source installation and Docker builds require no package-registry credentials.

## Local installation

Use Node.js 26 and pnpm 11.5.3:

```bash
pnpm install --frozen-lockfile
```

The repository maps the `@avgeek-oss` scope to `https://registry.npmjs.org`. Older checkouts used GitHub Packages. Update the scope and dependency lockfile when migrating those checkouts. Keep any unrelated private-package configuration separate.

## Source Docker builds

The default Compose file uses published images. Contributors can build the API and UI from the reviewed checkout with the source overlay:

```bash
docker compose --project-name mill --env-file .env --file docker-compose.yml --file docker-compose.postgres.yml --file tools/compose-source.yml up --build --detach --wait
```

Omit the PostgreSQL overlay when supplying an external database. Individual targets can also be built directly:

```bash
docker build --target api --tag mill-api:local .
docker build --target web --tag mill-web:local .
```

## Continuous integration

Dependency installation and release-image builds use npmjs.org without a registry token. GitHub authentication remains for publishing and pulling GHCR container images. The source and production verification gates remain required.
