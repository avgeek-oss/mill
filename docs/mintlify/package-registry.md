---
title: "Package registry setup"
description: "Authenticate source builds to GitHub Packages."
---

Mill uses the published, open-source `@avgeek-oss/design-system@1.2.1` package. The repository's `.npmrc` maps only the `@avgeek-oss` scope to GitHub Packages; other dependencies come from npm. No sibling checkout or unpublished library source is required.

GitHub Packages requires authentication to install public npm packages. Use a GitHub classic personal access token with `read:packages`, following [GitHub's npm registry authentication guide](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry#authenticating-to-github-packages).

## Local development and source builds

Log in once with your GitHub username and the token as the password:

```sh
npm login --scope=@avgeek-oss --registry=https://npm.pkg.github.com --auth-type=legacy
node tools/with-package-token.mjs pnpm install --frozen-lockfile
```

npm stores that login in your user `.npmrc`, outside the repository. The wrapper also accepts `NODE_AUTH_TOKEN` from a secret manager or `NPM_CONFIG_USERCONFIG` pointing to a user configuration file. It creates an owner-only temporary npm configuration for the child command and removes it when the command finishes. Keep credentials outside the checkout and never commit them.

For a Docker source build, use the same wrapper:

```sh
node tools/init-env.mjs
node tools/with-package-token.mjs docker compose --project-name mill --env-file .env up --build --detach --wait
```

Compose sends `NODE_AUTH_TOKEN` as the `npm_token` build secret. The Dockerfile creates the npm configuration in a temporary filesystem only during dependency installation. It does not use a token build argument or runtime environment variable. The running image needs no registry authentication. See [Docker's build secret documentation](https://docs.docker.com/build/building/secrets/).

For a direct Docker build, run:

```sh
node tools/with-package-token.mjs docker build --secret id=npm_token,env=NODE_AUTH_TOKEN --tag mill:local .
```

The production verification runner resolves the same credentials automatically:

```sh
node tools/production-verify.mjs
```

## Continuous integration

The verify and browser jobs configure `actions/setup-node` for the scoped registry and pass the job's `GITHUB_TOKEN` to the install step as `NODE_AUTH_TOKEN`. Production and private artifact builds pass it to BuildKit. Workflows request `packages:read`, and reusable workflow callers preserve that permission.

The shared package's **Manage Actions access** settings must grant `avgeek-oss/mill` read access. Adding the permission to a workflow does not grant access to a different repository's package by itself. A package maintainer must configure that grant; see [GitHub's package access guidance](https://docs.github.com/en/packages/learn-github-packages/configuring-a-packages-access-control-and-visibility#ensuring-workflow-access-to-your-package).

An authentication or access failure should fail installation. Do not copy the library into Mill, disable the install gate, or commit a replacement token. CI does not publish the design system or require package write permission.
