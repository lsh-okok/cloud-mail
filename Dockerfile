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
ARG APP_BASE_PATH=""
RUN pnpm --dir mail-worker run build \
    && APP_BASE_PATH="$APP_BASE_PATH" VITE_BASE_URL=/api VITE_OUT_DIR=../mail-worker/dist VITE_PWA_NAME="Cloud Mail" pnpm --dir mail-vue run build \
    && pnpm --dir mail-worker prune --prod

FROM node:24-bookworm-slim AS runtime
ARG VCS_REF=unknown
LABEL org.opencontainers.image.source="https://github.com/lsh-okok/cloud-mail" \
    org.opencontainers.image.revision=$VCS_REF \
    io.cloud-mail.component=combined \
    io.cloud-mail.mail-capable=true
RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       ca-certificates gosu tini postfix opendkim opendkim-tools openssl supervisor netcat-openbsd procps \
    && find /var/spool/postfix -mindepth 1 -delete \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data \
    SQLITE_PATH=/data/cloud-mail.sqlite OBJECTS_DIR=/data/objects MAIL_ENABLED=false
WORKDIR /app
COPY --from=build /app/mail-worker/server-dist ./mail-worker/server-dist
COPY --from=build /app/mail-worker/node_modules ./mail-worker/node_modules
COPY --from=build /app/mail-worker/dist ./mail-worker/dist
COPY docker/app-entrypoint.sh /usr/local/bin/cloud-mail-entrypoint
COPY docker/healthcheck.sh /usr/local/bin/cloud-mail-healthcheck
COPY docker/supervisord.conf /etc/supervisor/supervisord.conf
COPY docker/supervisor-events.py /usr/local/bin/cloud-mail-supervisor-events
COPY docker/mail/entrypoint.sh /usr/local/bin/mail-entrypoint
COPY docker/mail/healthcheck.sh /usr/local/bin/mail-healthcheck
COPY docker/mail/maintenance.sh /usr/local/bin/mail-maintenance
RUN chmod 755 /usr/local/bin/cloud-mail-* /usr/local/bin/mail-*
EXPOSE 3000 25
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD ["/usr/local/bin/cloud-mail-healthcheck"]
ENTRYPOINT ["tini", "--", "/usr/local/bin/cloud-mail-entrypoint"]
CMD ["node", "mail-worker/server-dist/index.cjs"]
