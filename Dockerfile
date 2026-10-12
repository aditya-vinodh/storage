# The storage-server image: the API server with its production dependencies.
# No VOLUME instruction: Railway rejects it. Mount a volume at /data when the
# server keeps SQLite or filesystem blobs there (docker-compose does).
FROM node:22-bookworm-slim AS build
WORKDIR /src
# better-sqlite3 compiles its native module on install.
RUN apt-get update \
  && apt-get install --yes --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@10.33.4
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm --filter @storage/server deploy --prod --legacy /out

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    STORAGE_HOST=0.0.0.0 \
    STORAGE_PORT=8787 \
    STORAGE_DATA_DIR=/data
WORKDIR /app
COPY --from=build /out ./
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 8787
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.STORAGE_PORT || 8787) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["node", "/app/dist/main.js"]
CMD ["serve"]
