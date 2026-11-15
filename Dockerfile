# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@11 --activate
WORKDIR /app
ENV CI=true
COPY mail-worker/package.json mail-worker/pnpm-lock.yaml mail-worker/pnpm-workspace.yaml ./mail-worker/
COPY mail-vue/package.json mail-vue/pnpm-lock.yaml mail-vue/pnpm-workspace.yaml ./mail-vue/
RUN pnpm --dir mail-worker install --frozen-lockfile \
    && pnpm --dir mail-vue install --frozen-lockfile
COPY mail-worker ./mail-worker
COPY mail-vue ./mail-vue
COPY Dockerfile ./Dockerfile
COPY docker/app-entrypoint.sh ./docker/app-entrypoint.sh
ARG APP_BASE_PATH=""
RUN pnpm --dir mail-worker run build \
    && APP_BASE_PATH="$APP_BASE_PATH" VITE_BASE_URL=/api VITE_OUT_DIR=../mail-worker/dist VITE_PWA_NAME="Cloud Mail" pnpm --dir mail-vue run build \
    && pnpm --dir mail-worker prune --prod

FROM node:24-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates gosu tini \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data \
    SQLITE_PATH=/data/cloud-mail.sqlite OBJECTS_DIR=/data/objects
WORKDIR /app
COPY --from=build /app/mail-worker/server-dist ./mail-worker/server-dist
COPY --from=build /app/mail-worker/node_modules ./mail-worker/node_modules
COPY --from=build /app/mail-worker/dist ./mail-worker/dist
COPY docker/app-entrypoint.sh /usr/local/bin/cloud-mail-entrypoint
RUN chmod 755 /usr/local/bin/cloud-mail-entrypoint
EXPOSE 3000 2525 10040
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+(process.env.APP_BASE_PATH||'').replace(/\/$/,'')+'/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["tini", "--", "/usr/local/bin/cloud-mail-entrypoint"]
CMD ["node", "mail-worker/server-dist/index.cjs"]
