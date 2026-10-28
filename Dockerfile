FROM node:24-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS dependencies
RUN npm install --global pnpm@12.10.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM dependencies AS build
COPY . .
RUN HAULPATH_BUILD_STANDALONE=1 pnpm run build

FROM base AS runtime
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000 HAULPATH_DB_PATH=/app/data/haulpath.sqlite
RUN apt-get update \
    && apt-get install --no-install-recommends --yes sqlite3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public
COPY --chown=node:node scripts/docker ./scripts/docker
RUN mkdir -p /app/data /app/.next/cache \
    && chown node:node /app/data /app/.next/cache
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=3 CMD ["node", "scripts/docker/healthcheck.mjs"]
CMD ["node", "server.js"]
