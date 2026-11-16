#!/usr/bin/env bash
# Linux CI integration test against an already-published official SHA image.
# Unlike smoke-test.sh, this isolated installer test temporarily publishes :25.
set -euo pipefail
umask 077

fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ $# == 1 && $1 =~ ^ghcr\.io/lsh-okok/cloud-mail:sha-[0-9a-f]{40}$ ]] || fail 'Usage: sudo bash docker/installer-smoke.sh ghcr.io/lsh-okok/cloud-mail:sha-COMMIT'
[[ $(id -u) == 0 && $(uname -s) == Linux ]] || fail 'Run this integration test as root on an isolated Linux runner.'
for smoke_tool in docker openssl ss curl awk sed sha256sum mktemp; do
    command -v "$smoke_tool" >/dev/null || fail "Missing prerequisite: $smoke_tool"
done
docker info >/dev/null
smoke_docker_host=${DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}')}
[[ $smoke_docker_host == unix:///* ]] || fail 'This integration test requires the local Unix socket Docker Engine.'
[[ -z $(ss -H -ltn 'sport = :25') ]] || fail 'Port 25 is occupied; no test resources were created.'

smoke_image=$1
smoke_repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
smoke_id="cloudmail-installer-$(openssl rand -hex 8)"
smoke_name=$smoke_id
smoke_network="$smoke_id-npm"
smoke_alias="$smoke_id-proxy"
smoke_label='com.cloud-mail.installer-smoke'
smoke_instance=''
smoke_install_started=false
smoke_network_started=false
smoke_tmp=$(mktemp -d /tmp/cloud-mail-installer-smoke.XXXXXXXX)
printf '%s\n' "$smoke_id" > "$smoke_tmp/.smoke-owner"
smoke_install="$smoke_tmp/installation"
smoke_volumes=("$smoke_name-data" "$smoke_name-mail-spool" "$smoke_name-dkim" "$smoke_name-mail-logs")
smoke_containers=("$smoke_name" "$smoke_name-before-unified" "$smoke_name-mail" "$smoke_name-mail-before-unified")

cleanup() {
    local result=$? resource owner cleanup_failed=false
    trap - EXIT INT HUP TERM
    # An interrupted first install can create its labelled volume before writing
    # .install-state. Its random name was checked absent before installation.
    if [[ $smoke_install_started == true && -z $smoke_instance ]]; then
        owner=$(docker volume inspect --format '{{index .Labels "cloud-mail.installation-id"}}' "${smoke_volumes[0]}" 2>/dev/null) || owner=''
        if [[ $owner =~ ^[0-9a-f]{32}$ ]]; then smoke_instance=$owner; fi
    fi
    if [[ $smoke_install_started == true ]]; then
        for resource in "${smoke_containers[@]}"; do
            docker container inspect "$resource" >/dev/null 2>&1 || continue
            owner=$(docker container inspect --format '{{index .Config.Labels "cloud-mail.installation-id"}}' "$resource") || owner=''
            if [[ ! $smoke_instance =~ ^[0-9a-f]{32}$ || $owner != "$smoke_instance" ]]; then
                printf 'Preserving container with unexpected ownership: %s\n' "$resource" >&2
                cleanup_failed=true
                continue
            fi
            if (( result != 0 )); then
                docker logs --tail 120 "$resource" >&2 || true
                docker container inspect --format '{{json .State.Health}}' "$resource" >&2 || true
            fi
            docker rm -f "$resource" >/dev/null || cleanup_failed=true
        done
        for resource in "${smoke_volumes[@]}"; do
            docker volume inspect "$resource" >/dev/null 2>&1 || continue
            owner=$(docker volume inspect --format '{{index .Labels "cloud-mail.installation-id"}}' "$resource") || owner=''
            if [[ ! $smoke_instance =~ ^[0-9a-f]{32}$ || $owner != "$smoke_instance" ]]; then
                printf 'Preserving volume with unexpected ownership: %s\n' "$resource" >&2
                cleanup_failed=true
                continue
            fi
            docker volume rm "$resource" >/dev/null || cleanup_failed=true
        done
    fi
    if [[ $smoke_network_started == true ]] && docker network inspect "$smoke_network" >/dev/null 2>&1; then
        owner=$(docker network inspect --format "{{index .Labels \"$smoke_label\"}}" "$smoke_network") || owner=''
        if [[ $owner == "$smoke_id" ]]; then
            docker network rm "$smoke_network" >/dev/null || cleanup_failed=true
        else
            printf 'Preserving network with unexpected ownership: %s\n' "$smoke_network" >&2
            cleanup_failed=true
        fi
    fi
    # Only this invocation's fixed-prefix mktemp directory may be removed.
    if [[ $cleanup_failed == false && $smoke_tmp =~ ^/tmp/cloud-mail-installer-smoke\.[a-zA-Z0-9]{8}$ && ! -L $smoke_tmp && -f $smoke_tmp/.smoke-owner && ! -L $smoke_tmp/.smoke-owner && $(cat "$smoke_tmp/.smoke-owner") == "$smoke_id" ]]; then
        rm -rf -- "$smoke_tmp"
    else
        printf 'Preserving test directory for inspection: %s\n' "$smoke_tmp" >&2
        cleanup_failed=true
    fi
    if [[ $cleanup_failed == true && $result == 0 ]]; then result=1; fi
    exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' HUP TERM

for smoke_resource in "${smoke_containers[@]}"; do
    if docker container inspect "$smoke_resource" >/dev/null 2>&1; then fail "Random test container name already exists: $smoke_resource"; fi
done
for smoke_resource in "${smoke_volumes[@]}"; do
    if docker volume inspect "$smoke_resource" >/dev/null 2>&1; then fail "Random test volume name already exists: $smoke_resource"; fi
done
if docker network inspect "$smoke_network" >/dev/null 2>&1; then fail "Random test network name already exists: $smoke_network"; fi
smoke_port=''
for ((smoke_attempt=0; smoke_attempt<50; smoke_attempt++)); do
    smoke_candidate=$((20000 + RANDOM % 30000))
    if [[ -z $(ss -H -ltn "sport = :$smoke_candidate") ]]; then smoke_port=$smoke_candidate; break; fi
done
[[ -n $smoke_port ]] || fail 'Could not find an unused management port.'
smoke_url="http://127.0.0.1:$smoke_port"
smoke_primary_args=(--dir "$smoke_install" --name "$smoke_name" --host 127.0.0.1 --port "$smoke_port"
    --app-url "$smoke_url" --mail-domain smoke.example --admin-email admin@smoke.example --image "$smoke_image")

read_state() {
    [[ $(awk -v key="$1=" 'index($0,key)==1 {n++} END {print n+0}' "$smoke_install/.install-state") == 1 ]] || fail "Missing or duplicate installation state: $1"
    sed -n "s/^$1=//p" "$smoke_install/.install-state"
}
run_installer() {
    local stage=$1
    shift
    if ! bash "$@" > "$smoke_tmp/$stage.log" 2>&1; then
        cat "$smoke_tmp/$stage.log" >&2
        fail "Installer failed during $stage"
    fi
}
file_sha() { sha256sum "$1" | awk '{print $1}'; }
container_id() { docker container inspect --format '{{.Id}}' "$smoke_name"; }
dkim_sha() { docker exec "$smoke_name" sha256sum /etc/opendkim/keys/smoke.example/mail.private | awk '{print $1}'; }
assert_one_container() {
    local names
    names=$(docker ps -a --filter "label=cloud-mail.installation-id=$smoke_instance" --format '{{.Names}}')
    [[ $names == "$smoke_name" ]] || fail "Expected exactly the one combined installation container; found: $names"
}
wait_healthy() {
    local health attempt
    for ((attempt=0; attempt<90; attempt++)); do
        health=$(docker container inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$smoke_name")
        if [[ $health == healthy ]]; then return; fi
        if [[ $health == exited || $health == dead ]]; then break; fi
        sleep 2
    done
    fail 'Timed out waiting for Docker container health.'
}

smoke_install_started=true
run_installer primary "$smoke_repo/docker/install-primary.sh" "${smoke_primary_args[@]}"
smoke_instance=$(read_state INSTANCE_ID)
[[ $smoke_instance =~ ^[0-9a-f]{32}$ && $(read_state FORMAT) == 2 ]] || fail 'Management installation did not record its expected identity and format.'
[[ ! -e $smoke_tmp/certs ]] || fail 'The management-only installation unexpectedly required certificates.'
wait_healthy
curl --silent --show-error --fail --connect-timeout 5 --max-time 10 "$smoke_url/health/ready" >/dev/null
docker exec --user node -i "$smoke_name" node - "$smoke_id" <<'NODE'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
assert.equal(process.env.MAIL_ENABLED, 'false');
assert.ok(!process.env.SMTP_TLS_CERT_FILE && !process.env.SMTP_TLS_KEY_FILE);
assert.equal(fs.existsSync('/certs'), false);
fs.writeFileSync('/data/installer-smoke-marker', process.argv[2]);
const socket = net.connect(25, '127.0.0.1');
socket.setTimeout(2000, () => { socket.destroy(); throw Error('Unexpected SMTP listener timeout in management mode'); });
socket.once('connect', () => { socket.destroy(); throw Error('Management mode started an SMTP listener'); });
socket.once('error', error => assert.equal(error.code, 'ECONNREFUSED'));
NODE

smoke_network_started=true
docker network create --label "$smoke_label=$smoke_id" "$smoke_network" >/dev/null
docker network connect --alias "$smoke_alias" "$smoke_network" "$smoke_name"
# Exercise fields that a hand-written docker-run migration could accidentally drop.
docker update --memory 768m --memory-swap 1g --cpus 1.25 --pids-limit 256 "$smoke_name" >/dev/null
docker container inspect "$smoke_name" > "$smoke_tmp/before.json"
smoke_original_id=$(container_id)
smoke_primary_sha=$(file_sha "$smoke_install/primary.env")
printf '%s\n' 'Management-only installation is healthy without certificates; migration fixture is ready.'

mkdir -p "$smoke_tmp/certs/live/smoke"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj '/CN=mx.smoke.example' \
    -addext 'subjectAltName=DNS:mx.smoke.example' -keyout "$smoke_tmp/certs/live/smoke/privkey.pem" \
    -out "$smoke_tmp/certs/live/smoke/fullchain.pem" >/dev/null 2>&1
smoke_mail_args=(--dir "$smoke_install" --cert-root "$smoke_tmp/certs" --cert-name smoke --image "$smoke_image")
run_installer enable "$smoke_repo/docker/enable-mail.sh" "${smoke_mail_args[@]}"
[[ $(read_state FORMAT) == 3 && $(read_state INSTANCE_ID) == "$smoke_instance" ]] || fail 'Migration did not retain the installation identity and write format 3.'
[[ $(read_state SOURCE_VALUE) == "$smoke_image" && $(read_state IMAGE_REVISION) == "${smoke_image##*:sha-}" ]] || fail 'Migration did not retain the requested SHA image provenance.'
[[ $(file_sha "$smoke_install/primary.env") == "$smoke_primary_sha" ]] || fail 'Migration changed the original management configuration.'
[[ $(file_sha "$smoke_install/mail.env") == "$(read_state MAIL_ENV_SHA256)" ]] || fail 'Migration did not record the combined runtime configuration checksum.'
smoke_combined_id=$(container_id)
[[ $smoke_combined_id != "$smoke_original_id" ]] || fail 'Migration did not recreate the application through the Engine API.'
assert_one_container
wait_healthy
curl --silent --show-error --fail --connect-timeout 5 --max-time 10 "$smoke_url/health/ready" >/dev/null
docker exec "$smoke_name" /usr/local/bin/cloud-mail-healthcheck
docker exec "$smoke_name" postfix status
docker cp "$smoke_tmp/before.json" "$smoke_name:/tmp/cloud-mail-installer-before.json" >/dev/null
docker container inspect "$smoke_name" | docker exec -i "$smoke_name" node -e '
const assert = require("node:assert/strict"), fs = require("node:fs");
const before = JSON.parse(fs.readFileSync("/tmp/cloud-mail-installer-before.json"))[0];
const after = JSON.parse(fs.readFileSync(0))[0];
const [name, network, alias, certRoot, marker] = process.argv.slice(1);
const env = Object.fromEntries(after.Config.Env.map(item => { const at=item.indexOf("="); return [item.slice(0,at),item.slice(at+1)]; }));
assert.equal(after.Name, "/"+name);
assert.equal(env.MAIL_ENABLED, "true");
assert.equal(env.SMTP_HOST, "127.0.0.1");
assert.equal(env.MAIL_INTERNAL_HOST, "127.0.0.1");
assert.equal(after.Config.StopTimeout, 120);
assert.equal(before.HostConfig.Memory, 805306368);
assert.equal(before.HostConfig.MemorySwap, 1073741824);
assert.equal(before.HostConfig.NanoCpus, 1250000000);
assert.equal(before.HostConfig.PidsLimit, 256);
for (const key of ["Memory","MemorySwap","NanoCpus","PidsLimit","RestartPolicy","SecurityOpt","LogConfig","NetworkMode"]) {
    assert.deepEqual(after.HostConfig[key], before.HostConfig[key], "HostConfig changed: "+key);
}
assert.deepEqual(after.HostConfig.PortBindings["3000/tcp"], before.HostConfig.PortBindings["3000/tcp"]);
assert.deepEqual(Object.keys(after.HostConfig.PortBindings).sort(), ["25/tcp","3000/tcp"]);
assert.ok(after.HostConfig.PortBindings["25/tcp"].some(binding => binding.HostPort === "25"));
assert.deepEqual(Object.keys(after.NetworkSettings.Networks).sort(), Object.keys(before.NetworkSettings.Networks).sort());
for (const [key, value] of Object.entries(before.NetworkSettings.Networks)) {
    assert.deepEqual(after.NetworkSettings.Networks[key].Aliases, value.Aliases, "Network aliases changed: "+key);
}
assert.ok(after.NetworkSettings.Networks[network].Aliases.includes(alias));
assert.equal(after.Mounts.find(m => m.Destination === "/data").Name, before.Mounts.find(m => m.Destination === "/data").Name);
for (const [target, suffix] of [["/var/spool/postfix","-mail-spool"],["/etc/opendkim/keys","-dkim"],["/var/log/postfix","-mail-logs"]]) {
    assert.ok(after.Mounts.some(m => m.Type === "volume" && m.Destination === target && m.Name === name+suffix));
}
assert.ok(after.Mounts.some(m => m.Destination === "/certs" && m.Source === certRoot && m.RW === false));
assert.equal(fs.readFileSync("/data/installer-smoke-marker", "utf8"), marker);
' "$smoke_name" "$smoke_network" "$smoke_alias" "$smoke_tmp/certs" "$smoke_id"
for smoke_resource in "${smoke_volumes[@]}"; do
    [[ $(docker volume inspect --format '{{index .Labels "cloud-mail.installation-id"}}' "$smoke_resource") == "$smoke_instance" ]] || fail "Installation volume identity changed: $smoke_resource"
done
docker cp "$smoke_repo/docker/smoke/probe.cjs" "$smoke_name:/tmp/cloud-mail-installer-probe.cjs" >/dev/null
docker exec "$smoke_name" node /tmp/cloud-mail-installer-probe.cjs combined-runtime
docker exec "$smoke_name" node /tmp/cloud-mail-installer-probe.cjs health
printf '%s\n' 'Engine API migration preserved data, HTTP binding, network aliases and resource limits; combined mail is healthy.'

smoke_dkim_sha=$(dkim_sha)
smoke_state_sha=$(file_sha "$smoke_install/.install-state")
smoke_mail_sha=$(file_sha "$smoke_install/mail.env")
[[ $smoke_dkim_sha =~ ^[0-9a-f]{64}$ ]] || fail 'No DKIM private key was generated.'
run_installer enable-again "$smoke_repo/docker/enable-mail.sh" "${smoke_mail_args[@]}"
run_installer primary-again "$smoke_repo/docker/install-primary.sh" "${smoke_primary_args[@]}"
[[ $(container_id) == "$smoke_combined_id" ]] || fail 'Repeated installation replaced the combined container.'
[[ $(read_state FORMAT) == 3 && $(file_sha "$smoke_install/.install-state") == "$smoke_state_sha" ]] || fail 'Repeated installation changed format 3 state.'
[[ $(file_sha "$smoke_install/primary.env") == "$smoke_primary_sha" && $(file_sha "$smoke_install/mail.env") == "$smoke_mail_sha" ]] || fail 'Repeated installation changed the saved configuration.'
[[ $(dkim_sha) == "$smoke_dkim_sha" ]] || fail 'Repeated installation regenerated the DKIM key.'
assert_one_container
docker exec "$smoke_name" /usr/local/bin/cloud-mail-healthcheck
curl --silent --show-error --fail --connect-timeout 5 --max-time 10 "$smoke_url/health/ready" >/dev/null
printf '%s\n' 'Repeated enable/install retained the container ID, format 3 state, configuration and DKIM key.'
printf '%s\n' 'One-click installer smoke test passed.'
