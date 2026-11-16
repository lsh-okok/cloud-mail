#!/bin/sh
# Run from the repository root: sh docker/backup.sh /absolute/path/to/new-backup
set -eu
umask 077
backup_dir=${1:?Usage: sh docker/backup.sh /absolute/path/to/new-backup}
case "$backup_dir" in /*) ;; *) echo 'Backup path must be absolute' >&2; exit 1;; esac
test ! -e "$backup_dir" || { echo 'Backup destination already exists; choose a new directory' >&2; exit 1; }
test -f .env || { echo 'Run this script from the repository root with a configured .env' >&2; exit 1; }
docker compose config --quiet
mkdir -p "$backup_dir"
cp .env "$backup_dir/config.env"
docker compose stop app
resume() { docker compose up -d app; }
trap resume EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
docker compose run --rm --no-deps -T --entrypoint node \
    -v "$backup_dir:/backup" app \
    mail-worker/server-dist/cli.cjs backup /backup/app
docker compose run --rm --no-deps -T --entrypoint tar app \
    -C /var/spool/postfix -czf - . > "$backup_dir/mail-spool.tar.gz"
docker compose run --rm --no-deps -T --entrypoint tar app \
    -C /etc/opendkim/keys -czf - . > "$backup_dir/dkim-keys.tar.gz"
docker compose run --rm --no-deps -T --entrypoint tar app \
    -C /var/log/postfix -czf - . > "$backup_dir/mail-logs.tar.gz"
docker compose images --format json > "$backup_dir/images.json"
printf 'Cloud Mail backup completed at %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$backup_dir/COMPLETE"
echo "Backup created: $backup_dir"
