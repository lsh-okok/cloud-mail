#!/bin/sh
set -eu
umask 027
MAIL_ENABLED=${MAIL_ENABLED:-false}
case "$MAIL_ENABLED" in true|false) ;; *) echo 'MAIL_ENABLED must be true or false' >&2; exit 1;; esac
if [ "${NODE_ROLE:-primary}" = replica ] && [ "$MAIL_ENABLED" = true ]; then
    echo 'A read-only replica cannot enable the mail service' >&2
    exit 1
fi
mkdir -p "${DATA_DIR:-/data}" "${OBJECTS_DIR:-/data/objects}"
chown node:node "${DATA_DIR:-/data}" "${OBJECTS_DIR:-/data/objects}"
if [ "$MAIL_ENABLED" = true ]; then
    # The combined runtime never trusts another container to submit or deliver mail.
    export MAIL_ENABLED SMTP_HOST=127.0.0.1 SMTP_PORT=587 SMTP_SECURE=false SMTP_REQUIRE_TLS=false
    unset SMTP_USER SMTP_PASSWORD
    export MAIL_INTERNAL_HOST=127.0.0.1 MAIL_NETWORK_SUBNET=127.0.0.0/8
    export LMTP_PORT=2525 POLICY_PORT=10040 DOMAIN_MAP_PORT=10041
    if [ "$#" -ne 2 ] || [ "$1" != node ] || [ "$2" != mail-worker/server-dist/index.cjs ]; then
        echo 'MAIL_ENABLED requires the standard Cloud Mail server command; use --entrypoint for maintenance' >&2
        exit 1
    fi
    /usr/local/bin/mail-entrypoint --configure-only
    exec /usr/bin/supervisord -c /etc/supervisor/supervisord.conf
fi
exec gosu node "$@"
