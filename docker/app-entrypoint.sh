#!/bin/sh
set -eu
umask 027
mkdir -p "${DATA_DIR:-/data}" "${OBJECTS_DIR:-/data/objects}"
chown node:node "${DATA_DIR:-/data}" "${OBJECTS_DIR:-/data/objects}"
exec gosu node "$@"
