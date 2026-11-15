#!/bin/sh
set -eu
postfix status >/dev/null 2>&1 || {
    echo 'Postfix master is not running' >&2
    postfix status >&2 || true
    exit 1
}
pgrep -x opendkim >/dev/null || { echo 'OpenDKIM process is not running' >&2; exit 1; }
nc -z -w 2 127.0.0.1 25 || { echo 'SMTP port 25 is not listening' >&2; exit 1; }
nc -z -w 2 127.0.0.1 587 || { echo 'Internal submission port 587 is not listening' >&2; exit 1; }
