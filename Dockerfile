# syntax=docker/dockerfile:1.7
FROM node:24.16.0-alpine@sha256:21f403ab171f2dc89bad4dd69d7721bfd15f084ccb46cdd225f31f2bc59b5c9a AS base

FROM base AS build
WORKDIR /build
RUN npm install --global pnpm@11.5.3
COPY . .
RUN --mount=type=secret,id=npm_token,required=true \
    --mount=type=tmpfs,target=/run/npm-config \
    --mount=type=cache,id=mill-pnpm,target=/pnpm/store,sharing=locked \
    printf '//npm.pkg.github.com/:_authToken=%s\n' "$(cat /run/secrets/npm_token)" > /run/npm-config/npmrc \
    && NPM_CONFIG_USERCONFIG=/run/npm-config/npmrc pnpm install --frozen-lockfile --store-dir /pnpm/store
RUN pnpm build
RUN --mount=type=cache,id=mill-pnpm,target=/pnpm/store,sharing=locked \
    pnpm --filter mill deploy --prod --legacy --offline --store-dir /pnpm/store /prod/mill

FROM base AS runtime
ARG SOURCE_COMMIT=development
ARG RELEASE_VERSION=development
LABEL org.opencontainers.image.title="Mill" \
      org.opencontainers.image.description="Self-hosted task board for teams" \
      org.opencontainers.image.source="https://github.com/avgeek-oss/mill" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.revision="${SOURCE_COMMIT}" \
      org.opencontainers.image.version="${RELEASE_VERSION}"
WORKDIR /app
ENV NODE_ENV=production PORT=4321 \
    MILL_MIGRATIONS_DIR=/app/packages/database/migrations
RUN apk upgrade --no-cache \
    && rm -rf /usr/local/lib/node_modules/npm /opt/yarn-* \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=build --chown=node:node /prod/mill/node_modules ./node_modules
COPY --from=build --chown=node:node /build/package.json ./package.json
COPY --from=build --chown=node:node /build/dist ./dist
COPY --from=build --chown=node:node /build/apps/web/dist ./apps/web/dist
COPY --from=build --chown=node:node /build/packages/database/migrations ./packages/database/migrations
COPY --chown=node:node LICENSE NOTICE ./
USER node
EXPOSE 4321
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=12 \
    CMD node -e "fetch('http://127.0.0.1:4321/health/ready',{signal:AbortSignal.timeout(4000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/apps/api/src/index.js"]
