import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const roots = [];
const instance = 'ab'.repeat(16);
const digest = `sha256:${'cd'.repeat(32)}`;
const image = `ghcr.io/lsh-okok/cloud-mail@${digest}`;
const revision = 'ef'.repeat(20);
const publicKey = `MIIB${'Ab0+/'.repeat(65)}AQAB`;
const txtContent = `v=DKIM1; h=sha256; k=rsa; p=${publicKey}`;
const shell = process.platform === 'win32' ? 'bash.exe' : '/bin/bash';
const source = fileURLToPath(new URL('../../docker/enable-mail.sh', import.meta.url));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cloud-mail-gateway-test-')); roots.push(root);
  for (const dir of ['bin', 'installed', 'certs/live/npm-1']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'enable-mail.sh'), readFileSync(source, 'utf8'));
  writeFileSync(join(root, 'certs/live/npm-1/fullchain.pem'), 'fixture public certificate');
  writeFileSync(join(root, 'certs/live/npm-1/privkey.pem'), 'fixture private key');
  writeFileSync(join(root, 'mail-domains'), 'example.com');
  writeFileSync(join(root, 'dkim-record'), `mail._domainkey IN TXT (
  "v=DKIM1; h=sha256; k=rsa; "
  "p=${publicKey.slice(0, 120)}"
  "${publicKey.slice(120)}"
) ; DKIM comment with "quoted text" that is not part of the key
; "another comment"
`);
  const mock = (name, code) => writeFileSync(join(root, 'bin', name), `#!/bin/sh\nset -eu\n${code}`, { mode: 0o755 });
  mock('id', "printf '0\\n'");
  mock('uname', 'case "${1:-}" in -m) printf x86_64 ;; *) printf Linux ;; esac');
  mock('ss', '[ ! -f "$MAIL_ENABLE_TEST_ROOT/port-busy" ] || printf LISTEN');
  mock('sleep', 'exit 0');
  mock('date', `n=0; [ ! -f "$MAIL_ENABLE_TEST_ROOT/clock" ] || n=$(cat "$MAIL_ENABLE_TEST_ROOT/clock")
printf '%s\\n' "$n"; printf '%s\\n' "$(( n + 20 ))" > "$MAIL_ENABLE_TEST_ROOT/clock"`);
  mock('openssl', `case "$*" in
  *-checkend*) [ ! -f "$MAIL_ENABLE_TEST_ROOT/bad-cert" ] ;;
  *) printf fixture-key ;;
esac`);
  mock('docker', `printf '%s\\n' "$*" >> "$MAIL_ENABLE_TEST_ROOT/docker.log"
case "$1" in
  info) exit 0 ;;
  container)
    case "\${5:-$3}" in
      npm) printf '%s/certs' "$MAIL_ENABLE_TEST_ROOT" ;;
      test-primary-mail)
        [ -f "$MAIL_ENABLE_TEST_ROOT/gateway-present" ] || exit 1
        case "\${4:-}" in
          *installation-id*) if [ -f "$MAIL_ENABLE_TEST_ROOT/foreign-gateway" ]; then printf other; else printf '${instance}'; fi ;;
          *cloud-mail.role*) printf mta ;; *PortBindings*) printf 25 ;;
        esac ;;
      test-primary)
        case "$4" in
          *Mounts*) if [ -f "$MAIL_ENABLE_TEST_ROOT/wrong-app-mount" ]; then printf bind:/other; else printf volume:test-primary-data; fi ;;
          *State.Running*) printf true ;;
          *Aliases*) [ ! -f "$MAIL_ENABLE_TEST_ROOT/app-attached" ] || printf app ;;
        esac ;;
      *) exit 1 ;;
    esac ;;
  volume)
    case "$2" in
      inspect)
        if [ "$#" -eq 3 ]; then [ -f "$MAIL_ENABLE_TEST_ROOT/vol-$3" ]; exit; fi
        case "$5" in
          test-primary-data) if [ -f "$MAIL_ENABLE_TEST_ROOT/wrong-owner" ]; then printf other; else printf '${instance}'; fi ;;
          *) if [ -f "$MAIL_ENABLE_TEST_ROOT/foreign-volume" ]; then printf other; else printf '${instance}'; fi ;;
        esac ;;
      create) for v in "$@"; do last=$v; done; touch "$MAIL_ENABLE_TEST_ROOT/vol-$last" ;;
      *) exit 98 ;;
    esac ;;
  network)
    case "$2" in
      inspect)
        [ -f "$MAIL_ENABLE_TEST_ROOT/network-present" ] || exit 1
        case "\${4:-}" in
          *installation-id*) if [ -f "$MAIL_ENABLE_TEST_ROOT/foreign-network" ]; then printf other; else printf '${instance}'; fi ;;
          *Subnet*) printf 172.30.89.0/24 ;;
          *Containers*) if [ -f "$MAIL_ENABLE_TEST_ROOT/foreign-peer" ]; then printf another-project; else printf test-primary; fi ;;
        esac ;;
      create) touch "$MAIL_ENABLE_TEST_ROOT/network-present" ;;
      connect) touch "$MAIL_ENABLE_TEST_ROOT/app-attached" ;;
      disconnect) rm -f "$MAIL_ENABLE_TEST_ROOT/app-attached" ;;
      *) exit 98 ;;
    esac ;;
  pull)
    [ ! -f "$MAIL_ENABLE_TEST_ROOT/pull-failed" ] || exit 1
    printf 'Digest: ${digest}\\n' ;;
  image)
    case "$4" in
      *RepoDigests*) printf '${image}\\n' ;;
      *image.source*) printf https://github.com/lsh-okok/cloud-mail ;;
      *io.cloud-mail.component*) if [ -f "$MAIL_ENABLE_TEST_ROOT/wrong-component" ]; then printf app; else printf mta; fi ;;
      *image.revision*) printf '${revision}' ;;
      *) exit 98 ;;
    esac ;;
  exec)
    if [ "$2" = test-primary ]; then
      case "$6" in NODE_ROLE) printf primary ;; MAIL_HOST) printf mx.example.com ;; MAIL_DOMAINS) cat "$MAIL_ENABLE_TEST_ROOT/mail-domains" ;; MAIL_NETWORK_SUBNET) printf 172.30.89.0/24 ;; *) exit 98 ;; esac
    elif [ "$3" = cat ]; then cat "$MAIL_ENABLE_TEST_ROOT/dkim-record";
    else [ ! -f "$MAIL_ENABLE_TEST_ROOT/not-ready" ]; fi ;;
  run) touch "$MAIL_ENABLE_TEST_ROOT/gateway-present" ;;
  stop|rm) [ "\${3:-}" = 60 ] || [ "$2" = test-primary-mail ] || exit 98 ;;
  *) exit 98 ;;
esac`);
  return { root,
    mark: name => writeFileSync(join(root, name), ''),
    log: () => existsSync(join(root, 'docker.log')) ? readFileSync(join(root, 'docker.log'), 'utf8') : '',
    execute: (args = []) => spawnSync(shell, ['-c', `export PATH="$PWD/bin:$PATH" MAIL_ENABLE_TEST_ROOT="$PWD"
if [ ! -f installed/.install-state ]; then
  printf 'INSTALL_DIR=%s/installed\\nCONTAINER_NAME=test-primary\\nINSTANCE_ID=${instance}\\n' "$PWD" > installed/.install-state
fi
bash ./enable-mail.sh --dir "$PWD/installed" "$@"`, 'fixture', ...args], { cwd: root, encoding: 'utf8', timeout: 20000 }),
  };
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('mail gateway for standalone primary', () => {
  it('starts a pinned gateway on public 25, connects the existing application and outputs only the DKIM public record', () => {
    const f = fixture(), result = f.execute();
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(f.log()).toContain('pull ghcr.io/lsh-okok/cloud-mail:mta-main');
    expect(f.log()).toContain('network connect --alias app test-primary-mail-network test-primary');
    expect(f.log()).toMatch(new RegExp(`run .*--name test-primary-mail .* ${image}$`, 'm'));
    expect(f.log()).toContain('-p 0.0.0.0:25:25');
    expect(f.log()).toContain('target=/certs,readonly');
    expect(f.log()).not.toMatch(/-p (?:587|2525|10040|10041)|^stop |^rm |volume rm|network prune|build /m);
    expect(result.stdout).toContain('公网收信服务已启动');
    expect(result.stdout).toContain(`名称：mail._domainkey\n完整名称：mail._domainkey.example.com\n内容：\n${txtContent}\n`);
    expect(result.stdout).not.toMatch(/IN TXT|quoted text|another comment/);
    expect(result.stdout).not.toContain('fixture private key');
  });

  it('shows complete single-line Cloudflare values without certificate lookup, image pulls or service changes', () => {
    const f = fixture();
    for (const marker of ['gateway-present', 'bad-cert', 'pull-failed', 'port-busy']) f.mark(marker);
    const result = f.execute(['--show-dkim']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`内容：\n${txtContent}\n`);
    expect(result.stdout).not.toMatch(/公网收信服务已启动|["()]/);
    expect(f.log().trim().split('\n').every(line => /^(?:info|container inspect|volume inspect|exec)\b/.test(line))).toBe(true);
    expect(f.log()).not.toMatch(/\bnpm\b|MAIL_HOST|MAIL_NETWORK_SUBNET|mail-healthcheck|\.private/);
  });

  it('prints a separate ready-to-paste record for each domain', () => {
    const f = fixture(); f.mark('gateway-present');
    writeFileSync(join(f.root, 'mail-domains'), 'example.com,example.net');
    const result = f.execute(['--show-dkim']);
    expect(result.status, result.stderr).toBe(0);
    for (const domain of ['example.com', 'example.net']) {
      expect(result.stdout).toContain(`域名：${domain}\n类型：TXT\n名称：mail._domainkey\n完整名称：mail._domainkey.${domain}\n内容：\n${txtContent}\n`);
      expect(f.log()).toContain(`cat /etc/opendkim/keys/${domain}/mail.txt`);
    }
  });

  it('also accepts the single-fragment TXT form', () => {
    const f = fixture(); f.mark('gateway-present');
    writeFileSync(join(f.root, 'dkim-record'), `mail._domainkey IN TXT "${txtContent}"\r\n`);
    const result = f.execute(['--show-dkim']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`内容：\n${txtContent}\n`);
  });

  it.each([
    'mail._domainkey IN TXT ( "v=DKIM1; k=rsa; " )',
    'mail._domainkey IN TXT "v=DKIM1; k=rsa; p=broken key"',
    'mail._domainkey IN TXT "v=DKIM1; k=rsa; p=unterminated',
  ])('rejects malformed TXT records instead of displaying an incomplete key: %s', record => {
    const f = fixture(); f.mark('gateway-present');
    writeFileSync(join(f.root, 'dkim-record'), record);
    const result = f.execute(['--show-dkim']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('DKIM 公钥格式无效');
    expect(result.stdout).not.toContain('内容：');
  });

  it('reports missing public records without restarting services', () => {
    const f = fixture(); f.mark('gateway-present');
    rmSync(join(f.root, 'dkim-record'));
    const result = f.execute(['--show-dkim']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('无法读取 example.com 的 DKIM 公钥');
    expect(f.log()).not.toMatch(/^(?:pull|run|stop|rm|network|volume create) /m);
  });

  it.each(['absent', 'foreign'])('does not read keys from a missing or foreign gateway: %s', gateway => {
    const f = fixture();
    if (gateway === 'foreign') { f.mark('gateway-present'); f.mark('foreign-gateway'); }
    const result = f.execute(['--show-dkim']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(gateway === 'absent' ? '尚未找到本实例的邮件容器' : '同名邮件容器属于其他安装');
    expect(f.log()).not.toContain('cat /etc/opendkim/keys/');
    expect(f.log()).not.toMatch(/^(?:pull|run|stop|rm|network|volume create) /m);
  });

  it('repeats without restarting the application or deleting queue and DKIM volumes', () => {
    const f = fixture(); expect(f.execute().status).toBe(0);
    const before = f.log(), repeated = f.execute();
    expect(repeated.status, repeated.stderr).toBe(0);
    const changes = f.log().slice(before.length);
    expect(changes).toContain('stop -t 60 test-primary-mail');
    expect(changes).toContain('rm test-primary-mail');
    expect(changes).not.toMatch(/^stop -t 60 test-primary$|volume rm|^network connect /m);
  });

  it.each(['bad-cert', 'pull-failed', 'wrong-component', 'wrong-owner', 'wrong-app-mount', 'port-busy'])('fails before changing resources when preflight fails: %s', marker => {
    const f = fixture(); f.mark(marker);
    const result = f.execute();
    expect(result.status).toBe(1);
    expect(f.log()).not.toMatch(/^(?:run|stop|rm|volume create|network create|network connect) /m);
  });

  it.each(['foreign-network', 'foreign-peer'])('does not connect to another project network: %s', marker => {
    const f = fixture(); f.mark('network-present'); f.mark(marker);
    const result = f.execute();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(marker === 'foreign-network' ? '同名邮件网络属于其他安装' : '邮件网络还连接了其他容器');
    expect(f.log()).not.toMatch(/^(?:run|stop|rm|volume create|network create|network connect) /m);
  });

  it('does not take over another project volume', () => {
    const f = fixture(); f.mark('vol-test-primary-dkim'); f.mark('foreign-volume');
    expect(f.execute().status).toBe(1);
    expect(f.log()).not.toMatch(/^(?:run|stop|rm|volume create|network create|network connect) /m);
  });

  it('reports readiness failure without a success message and preserves the application', () => {
    const f = fixture(); f.mark('not-ready'); const result = f.execute();
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('公网收信服务已启动');
    expect(result.stderr).toContain('尚未就绪');
    expect(f.log()).not.toMatch(/^stop |^rm |volume rm/m);
  });
});
