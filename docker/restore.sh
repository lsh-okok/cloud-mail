#!/bin/sh
# Restores into EMPTY Compose volumes; never deletes existing application data.
set -eu
umask 077
backup_dir=${1:?Usage: sh docker/restore.sh /absolute/path/to/backup}
case "$backup_dir" in /*) ;; *) echo 'Backup path must be absolute' >&2; exit 1;; esac
for part in COMPLETE app mail-spool.tar.gz dkim-keys.tar.gz mail-logs.tar.gz; do
    test -e "$backup_dir/$part" || { echo "Missing backup component: $part" >&2; exit 1; }
done
test -f "$backup_dir/app/manifest.json" && test -f "$backup_dir/app/cloud-mail.sqlite" && test -d "$backup_dir/app/objects" || {
    echo 'Application backup must contain manifest.json, cloud-mail.sqlite and objects/' >&2
    exit 1
}
test -f .env || { echo 'Restore config.env as .env and adjust NPM paths/network first' >&2; exit 1; }
docker compose config --quiet
docker compose stop mail app
docker compose run --rm --no-deps -T --entrypoint sh app -c \
    'test -z "$(find /data -mindepth 1 -maxdepth 1 -print -quit)"' || {
    echo 'Application volume is not empty. Use a fresh COMPOSE_PROJECT_NAME; existing data has been preserved.' >&2
    exit 1
}
docker compose run --rm --no-deps -T --entrypoint sh mail -c \
    'test -z "$(find /var/spool/postfix -mindepth 1 -maxdepth 1 -print -quit)" && test -z "$(find /etc/opendkim/keys -mindepth 1 -maxdepth 1 -print -quit)" && test -z "$(find /var/log/postfix -mindepth 1 -maxdepth 1 -print -quit)"' || {
    echo 'Mail spool, DKIM or log volume is not empty. Restore only into new volumes.' >&2
    exit 1
}
docker compose run --rm --no-deps -T --entrypoint sh \
    -v "$backup_dir/app:/backup:ro" app -c \
    'node mail-worker/server-dist/cli.cjs restore /backup && chown -R node:node /data'
docker compose run --rm --no-deps -T --entrypoint tar mail \
    -C /var/spool/postfix -xzf - < "$backup_dir/mail-spool.tar.gz"
docker compose run --rm --no-deps -T --entrypoint tar mail \
    -C /etc/opendkim/keys -xzf - < "$backup_dir/dkim-keys.tar.gz"
docker compose run --rm --no-deps -T --entrypoint tar mail \
    -C /var/log/postfix -xzf - < "$backup_dir/mail-logs.tar.gz"
docker compose up -d app mail
echo 'Restore completed. Check docker compose ps, logs, DNS and external delivery before switching production traffic.'
