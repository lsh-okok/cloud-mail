FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
    && apt-get install -y --no-install-recommends postfix opendkim opendkim-tools openssl ca-certificates supervisor netcat-openbsd procps \
    && find /var/spool/postfix -mindepth 1 -delete \
    && rm -rf /var/lib/apt/lists/*
COPY entrypoint.sh /usr/local/bin/mail-entrypoint
COPY healthcheck.sh /usr/local/bin/mail-healthcheck
COPY maintenance.sh /usr/local/bin/mail-maintenance
COPY supervisord.conf /etc/supervisor/conf.d/mail.conf
RUN chmod 755 /usr/local/bin/mail-*
EXPOSE 25 587
ENTRYPOINT ["/usr/local/bin/mail-entrypoint"]
