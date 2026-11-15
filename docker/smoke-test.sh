#!/bin/sh
# Linux integration test. Requires Docker Compose >= 2.24.4 and OpenSSL.
# It never uses the real .env, publishes ports, or removes existing volumes.
set -eu
command -v docker >/dev/null || { echo 'Docker is required' >&2; exit 1; }
command -v openssl >/dev/null || { echo 'OpenSSL is required' >&2; exit 1; }
docker compose version >/dev/null
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
smoke_tmp=$(mktemp -d "${TMPDIR:-/tmp}/cloud-mail-smoke.XXXXXX")
smoke_id="cloudmail-smoke-$(date +%s)-$$"
npm_network="${smoke_id}-npm"
mail_network="${smoke_id}-mail"
npm_created=0
mail_created=0
compose_ready=0
restore_volume="${smoke_id}-restore"
restore_created=0
dc() {
    docker compose --project-directory "$repo_dir" --env-file "$smoke_tmp/smoke.env" \
        --project-name "$smoke_id" -f "$repo_dir/docker-compose.yml" -f "$smoke_tmp/override.yml" "$@"
}
cleanup() {
    status=$?
    trap - EXIT HUP INT TERM
    if [ "$compose_ready" = 1 ]; then
        if [ "$status" -ne 0 ]; then dc logs --no-color --tail=200 app mail >&2 || true; fi
        if [ -d "$smoke_tmp/backup" ]; then
            # The backup CLI runs as container root; return ownership of this
            # invocation's temporary bind mount so a non-root CI user can remove it.
            dc run --rm --no-deps -T --entrypoint chown -v "$smoke_tmp/backup:/backup" \
                app -R "$(id -u):$(id -g)" /backup >/dev/null 2>&1 || true
        fi
        dc down --volumes --remove-orphans >/dev/null 2>&1 || true
    fi
    if [ "$npm_created" = 1 ]; then docker network rm "$npm_network" >/dev/null 2>&1 || true; fi
    if [ "$mail_created" = 1 ]; then docker network rm "$mail_network" >/dev/null 2>&1 || true; fi
    if [ "$restore_created" = 1 ]; then docker volume rm "$restore_volume" >/dev/null 2>&1 || true; fi
    # mktemp made this directory for this invocation; never derive it from user data.
    case "$smoke_tmp" in */cloud-mail-smoke.*) rm -rf -- "$smoke_tmp" || echo "Could not remove test directory: $smoke_tmp" >&2;; esac
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM
umask 077
mkdir -p "$smoke_tmp/certs/live/smoke"
cp "$repo_dir/docker/smoke/probe.cjs" "$smoke_tmp/probe.cjs"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
    -subj '/CN=mx.smoke.example' -addext 'subjectAltName=DNS:mx.smoke.example' \
    -keyout "$smoke_tmp/certs/live/smoke/privkey.pem" \
    -out "$smoke_tmp/certs/live/smoke/fullchain.pem" >/dev/null 2>&1
docker network create --label "com.cloud-mail.smoke=$smoke_id" "$npm_network" >/dev/null
npm_created=1
docker network create --label "com.cloud-mail.smoke=$smoke_id" "$mail_network" >/dev/null
mail_created=1
mail_subnet=$(docker network inspect "$mail_network" --format '{{(index .IPAM.Config 0).Subnet}}')
# Export synthetic values as well: exported production variables otherwise take
# precedence over --env-file during Compose interpolation.
export COMPOSE_PROJECT_NAME="$smoke_id" APP_URL=https://web.smoke.example
export MAIL_HOST=mx.smoke.example MAIL_DOMAINS=smoke.example ADMIN_EMAIL=admin@smoke.example
export ADMIN_PASSWORD="$(openssl rand -hex 24)" JWT_SECRET="$(openssl rand -hex 32)"
export NPM_NETWORK="$npm_network" NPM_CERT_ROOT="$smoke_tmp/certs"
export SMTP_TLS_CERT_FILE=/certs/live/smoke/fullchain.pem SMTP_TLS_KEY_FILE=/certs/live/smoke/privkey.pem
export MAIL_NETWORK_SUBNET="$mail_subnet" DKIM_SELECTOR=mail MAX_MESSAGE_BYTES=26214400 TZ=UTC
export SMTP_BIND_ADDRESS=127.0.0.1 MAIL_LOG_MAX_BYTES=104857600 MAIL_LOG_KEEP=7
cat > "$smoke_tmp/smoke.env" <<EOF
COMPOSE_PROJECT_NAME=$smoke_id
APP_URL=https://web.smoke.example
MAIL_HOST=mx.smoke.example
MAIL_DOMAINS=smoke.example
ADMIN_EMAIL=admin@smoke.example
ADMIN_PASSWORD=$ADMIN_PASSWORD
JWT_SECRET=$JWT_SECRET
NPM_NETWORK=$npm_network
NPM_CERT_ROOT=$smoke_tmp/certs
SMTP_TLS_CERT_FILE=/certs/live/smoke/fullchain.pem
SMTP_TLS_KEY_FILE=/certs/live/smoke/privkey.pem
MAIL_NETWORK_SUBNET=$mail_subnet
DKIM_SELECTOR=mail
MAX_MESSAGE_BYTES=26214400
TZ=UTC
EOF
cat > "$smoke_tmp/override.yml" <<EOF
services:
  app:
    image: cloud-mail-app:$smoke_id
    volumes:
      - type: bind
        source: $smoke_tmp
        target: /smoke
        read_only: true
  mail:
    image: cloud-mail-mta:$smoke_id
    ports: !reset []
networks:
  mail_internal: !override
    external: true
    name: $mail_network
EOF
dc config --quiet
compose_ready=1
dc build
dc up -d

wait_healthy() {
    service=$1
    attempts=0
    while [ "$attempts" -lt 90 ]; do
        container=$(dc ps --all -q "$service")
        if [ -n "$container" ]; then
            health=$(docker inspect "$container" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')
            if [ "$health" = healthy ]; then return 0; fi
            if [ "$health" = exited ] || [ "$health" = dead ]; then break; fi
        fi
        attempts=$((attempts + 1))
        sleep 2
    done
    echo "Timed out waiting for healthy $service" >&2
    if [ -n "$container" ]; then
        docker inspect "$container" --format '{{json .State.Health}}' >&2 || true
    fi
    return 1
}
probe() { dc exec -T app node /smoke/probe.cjs "$@"; }
wait_stored() {
    subject=$1
    attempts=0
    while [ "$attempts" -lt 45 ]; do
        if probe stored "$subject" >/dev/null 2>&1; then return 0; fi
        attempts=$((attempts + 1))
        sleep 2
    done
    probe stored "$subject"
}
wait_probe() {
    mode=$1
    attempts=0
    while [ "$attempts" -lt 45 ]; do
        if probe "$mode" >/dev/null 2>&1; then return 0; fi
        attempts=$((attempts + 1))
        sleep 2
    done
    probe "$mode"
}
queue_has() { dc exec -T mail postqueue -j | grep -F "$1" >/dev/null; }
wait_healthy app
wait_healthy mail
probe health
probe tls
probe relay
probe unknown

# Renew both files atomically within their mounted directory, as NPM does.
# Publishing key first deliberately exposes a brief mismatch; maintenance must
# wait for the matching certificate instead of loading a broken pair.
mkdir -p "$smoke_tmp/renewal"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
    -subj '/CN=mx.smoke.example' -addext 'subjectAltName=DNS:mx.smoke.example' \
    -keyout "$smoke_tmp/renewal/privkey.pem" \
    -out "$smoke_tmp/renewal/fullchain.pem" >/dev/null 2>&1
mv "$smoke_tmp/renewal/privkey.pem" "$smoke_tmp/certs/live/smoke/privkey.pem"
mv "$smoke_tmp/renewal/fullchain.pem" "$smoke_tmp/certs/live/smoke/fullchain.pem"
attempts=0
renewed=0
while [ "$attempts" -lt 45 ]; do
    if probe tls >/dev/null 2>&1 \
        && dc logs --no-color --tail=100 mail 2>&1 | grep -F 'Reloaded Postfix after an NPM certificate change' >/dev/null; then
        renewed=1
        break
    fi
    attempts=$((attempts + 1))
    sleep 2
done
test "$renewed" = 1 || { echo 'Postfix did not reload the renewed SMTP certificate' >&2; probe tls; exit 1; }
echo 'Certificate renewal watcher reloaded Postfix and the new certificate verified'

inbound_subject="smoke-inbound-$smoke_id"
probe message "$inbound_subject" >/dev/null
wait_stored "$inbound_subject"
echo 'SMTP policy, LMTP, SQLite and attachment metadata/download passed'

# Deliver synthetic external recipients only to our private SMTP sink. Pause
# remote transport first so the API's durable MIME can be inspected before
# Postfix reports terminal recipient outcomes and the app releases that copy.
dc exec -d app node /smoke/probe.cjs sink
wait_probe sink-ready
dc exec -T mail postconf -e 'relayhost = [app]:2526'
dc exec -T mail postconf -e 'defer_transports = smtp'
dc exec -T mail postfix reload
sleep 2
probe api-send "smoke-outbound-$smoke_id"
dc exec -T mail postconf -e 'defer_transports ='
dc exec -T mail postfix reload
dc exec -T mail postqueue -f
wait_probe outbound-initial
probe sink-release
dc exec -T mail postqueue -f
wait_probe outbound-final
echo 'API outbox, DKIM, Bcc privacy and per-recipient SMTP delivery states passed'

# Accept mail into Postfix while the app is healthy but postpone LMTP delivery.
dc exec -T mail postconf -e 'defer_transports = lmtp'
dc exec -T mail postfix reload
sleep 2
queued_subject="smoke-queued-$smoke_id"
queue_id=$(probe submission "$queued_subject")
queue_has "$queue_id"
probe absent "$queued_subject"
dc exec -T mail postcat -q "$queue_id" | grep -F 'DKIM-Signature:' >/dev/null
echo 'Internal SMTP submission produced a DKIM signature'
dc stop -t 20 app
# The public listener must defer new local RCPTs while policy lookup is down.
dc run --rm --no-deps -T --entrypoint node app /smoke/probe.cjs unavailable
# Recreate the MTA, proving its accepted queue is in the persistent volume.
dc up -d --no-deps --force-recreate mail
wait_healthy mail
queue_has "$queue_id"
dc start app
wait_healthy app
dc exec -T mail postqueue -f
wait_stored "$queued_subject"
echo 'Accepted Postfix queue survived app downtime and MTA recreation'

dc restart app
wait_healthy app
probe stored "$inbound_subject"
probe stored "$queued_subject"
echo 'SQLite messages survived app restart without duplicate delivery'

# Exercise the same backup mount shape as backup.sh: CLI creates the absent
# /backup/app child, then restores it into a separate, newly-created data volume.
dc stop mail app
mkdir -p "$smoke_tmp/backup"
dc run --rm --no-deps -T --entrypoint node -v "$smoke_tmp/backup:/backup" app \
    mail-worker/server-dist/cli.cjs backup /backup/app
docker volume create --label "com.cloud-mail.smoke=$smoke_id" "$restore_volume" >/dev/null
restore_created=1
dc run --rm --no-deps -T --entrypoint sh \
    -v "$smoke_tmp/backup/app:/backup:ro" -v "$restore_volume:/data" app -c \
    'node mail-worker/server-dist/cli.cjs restore /backup && node /smoke/probe.cjs stored-offline "$1" && node /smoke/probe.cjs stored-offline "$2"' \
    sh "$inbound_subject" "$queued_subject"
echo 'Stopped-app backup restored both messages and attachment bytes into a fresh data volume'
echo 'Docker mail smoke test passed'
