import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const roots = [];
const shell = process.platform === 'win32' ? 'bash.exe' : '/bin/bash';
const installerPath = fileURLToPath(new URL('../../docker/install-primary.sh', import.meta.url));
const imageId = `sha256:${'ab'.repeat(32)}`;
const imageDigest = `ghcr.io/lsh-okok/cloud-mail@sha256:${'cd'.repeat(32)}`;
const revision = 'ef'.repeat(20);
const imageRef = 'ghcr.io/lsh-okok/cloud-mail:main';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cloud mail primary ')); roots.push(root);
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'install.sh'), readFileSync(installerPath, 'utf8'));
  const mock = (name, contents) => writeFileSync(join(root, 'bin', name), `#!/bin/sh\nset -eu\n${contents}`, { mode: 0o755 });
  mock('id', "printf '0\\n'\n");
  mock('uname', `if [ "\${1:-}" = -m ]; then
  if [ -f "$PRIMARY_INSTALL_TEST_ROOT/unsupported-arch" ]; then printf aarch64; else printf x86_64; fi
else printf Linux; fi\n`);
  mock('ss', 'exit 0\n');
  mock('sleep', 'exit 0\n');
  mock('date', `primary_test_time=0
if [ -f "$PRIMARY_INSTALL_TEST_ROOT/clock" ]; then primary_test_time=$(cat "$PRIMARY_INSTALL_TEST_ROOT/clock"); fi
printf '%s\\n' "$primary_test_time"
printf '%s\\n' "$(( primary_test_time + 20 ))" > "$PRIMARY_INSTALL_TEST_ROOT/clock"
`);
  for (const command of ['curl', 'wget', 'apt-get', 'dnf']) {
    mock(command, `printf '%s\\n' '${command}' >> "$PRIMARY_INSTALL_TEST_ROOT/unexpected.log"\nexit 97\n`);
  }
  mock('docker', `printf '%s\\n' "$*" >> "$PRIMARY_INSTALL_TEST_ROOT/docker.log"
case "$1" in
  info) exit 0 ;;
  ps) exit 0 ;;
  pull)
    [ ! -f "$PRIMARY_INSTALL_TEST_ROOT/pull-failed" ] || exit 1
    touch "$PRIMARY_INSTALL_TEST_ROOT/image-present"
    if [ -f "$PRIMARY_INSTALL_TEST_ROOT/invalid-pull-digest" ]; then printf 'Digest: invalid\\n'; else printf 'Digest: sha256:cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd\\n'; fi ;;
  image)
    [ -f "$PRIMARY_INSTALL_TEST_ROOT/image-present" ] || exit 1
    case "$4" in
      *RepoDigests*)
        if [ -f "$PRIMARY_INSTALL_TEST_ROOT/historical-digest" ]; then printf 'ghcr.io/lsh-okok/cloud-mail@sha256:1111111111111111111111111111111111111111111111111111111111111111\\n'; fi
        [ -f "$PRIMARY_INSTALL_TEST_ROOT/missing-digest" ] || printf '%s\\n' '${imageDigest}' ;;
      *image.revision*) if [ -f "$PRIMARY_INSTALL_TEST_ROOT/bad-revision" ]; then printf unknown; else printf '%s\\n' '${revision}'; fi ;;
      *image.source*) if [ -f "$PRIMARY_INSTALL_TEST_ROOT/wrong-source" ]; then printf https://example.com/untrusted; else printf 'https://github.com/lsh-okok/cloud-mail\\n'; fi ;;
      *Id*) printf '%s\\n' '${imageId}' ;;
      *) exit 98 ;;
    esac ;;
  container)
    [ -f "$PRIMARY_INSTALL_TEST_ROOT/container-present" ] || exit 1
    if [ "\${3:-}" = --format ]; then
      case "$4" in
        *installation-id*) cat "$PRIMARY_INSTALL_TEST_ROOT/container-id" ;;
        *cloud-mail.role*) printf primary ;;
        *PortBindings*) printf '13010\\n' ;;
        *Mounts*) if [ -f "$PRIMARY_INSTALL_TEST_ROOT/wrong-mount" ]; then printf 'bind:/other/data'; else printf 'volume:installer-test-data'; fi ;;
        *State.Running*) printf true ;;
        *Image*) printf '%s\\n' '${imageId}' ;;
        *) exit 98 ;;
      esac
    fi ;;
  volume)
    case "$2" in
      inspect)
        [ -f "$PRIMARY_INSTALL_TEST_ROOT/volume-present" ] || exit 1
        if [ "\${3:-}" = --format ]; then
          if [ -f "$PRIMARY_INSTALL_TEST_ROOT/wrong-volume-identity" ]; then printf replaced-volume; else cat "$PRIMARY_INSTALL_TEST_ROOT/volume-id"; fi
        fi ;;
      create)
        while [ "$#" -gt 0 ]; do
          case "$1" in --label) shift; case "$1" in cloud-mail.installation-id=*) printf '%s' "\${1#*=}" > "$PRIMARY_INSTALL_TEST_ROOT/volume-id" ;; esac ;; esac
          shift
        done
        touch "$PRIMARY_INSTALL_TEST_ROOT/volume-present"
        printf 'installer-test-data\\n' ;;
      *) exit 98 ;;
    esac ;;
  build|load) exit 98 ;;
  run)
    while [ "$#" -gt 0 ]; do
      case "$1" in --label) shift; case "$1" in cloud-mail.installation-id=*) printf '%s' "\${1#*=}" > "$PRIMARY_INSTALL_TEST_ROOT/container-id" ;; esac ;; esac
      shift
    done
    touch "$PRIMARY_INSTALL_TEST_ROOT/container-present"
    printf 'fixture-container-id\\n' ;;
  start) exit 0 ;;
  exec) [ ! -f "$PRIMARY_INSTALL_TEST_ROOT/not-ready" ] ;;
  logs) printf 'fixture log\\n' ;;
  *) exit 98 ;;
esac
`);
  const execute = (args = []) => spawnSync(shell,
    ['-c', 'export PATH="$PWD/bin:$PATH" PRIMARY_INSTALL_TEST_ROOT="$PWD"; bash ./install.sh --dir "$PWD/installed" --name installer-test --host 203.0.113.10 --port 13010 "$@"', 'fixture', ...args],
    { cwd: root, encoding: 'utf8', timeout: 20000 });
  const config = () => readFileSync(join(root, 'installed', 'primary.env'), 'utf8');
  return { root, execute, config,
    state: () => readFileSync(join(root, 'installed', '.install-state'), 'utf8'),
    mark: name => writeFileSync(join(root, name), ''),
    log: () => existsSync(join(root, 'docker.log')) ? readFileSync(join(root, 'docker.log'), 'utf8') : '',
    env: () => Object.fromEntries(config().split(/\r?\n/).filter(line => /^[A-Z_]+=/.test(line)).map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; })),
  };
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('primary node installer', () => {
  it('pulls the official main image, pins its digest and keeps credentials and version on repeat', () => {
    const f = fixture(), first = f.execute();
    expect(first.error).toBeUndefined();
    expect(first.status, first.stderr).toBe(0);
    const env = f.env(), before = f.config();
    expect(env.NODE_ROLE).toBe('primary');
    expect(env.APP_URL).toBe('http://203.0.113.10:13010');
    expect(env.ADMIN_EMAIL).toBe('admin@cloudmail.test');
    expect(env.JWT_SECRET).toMatch(/^[0-9a-f]{64}$/);
    expect(env.DATA_ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(env.JWT_SECRET).not.toBe(env.DATA_ENCRYPTION_KEY);
    expect(env.ADMIN_PASSWORD.length).toBeGreaterThanOrEqual(32);
    expect(first.stdout).toContain(env.ADMIN_PASSWORD);
    expect(first.stdout).toMatch(/MX.*未启用|未启用.*MX/);
    expect(f.log()).toContain('--env-file ');
    expect(f.log()).toContain('-p 13010:3000');
    expect(f.log()).toContain('installer-test-data:/data');
    expect(f.execute().status).toBe(0);
    expect(f.config()).toBe(before);
    expect(f.log().match(/^pull /gm)).toHaveLength(1);
    expect(f.log()).not.toMatch(/^(?:build|load) /m);
    expect(f.log()).toContain(`pull ${imageRef}`);
    expect(f.log().split('\n').filter(line => line.startsWith('image inspect ')).every(line => line.endsWith(imageDigest))).toBe(true);
    expect(f.log()).toMatch(new RegExp(`^run .* ${imageDigest}$`, 'm'));
    expect(f.state()).toContain(`SOURCE_VALUE=${imageRef}`);
    expect(f.state()).toContain(`IMAGE_DIGEST=${imageDigest}`);
    expect(f.state()).toContain(`IMAGE_REVISION=${revision}`);
    expect(first.stdout).toContain(imageDigest);
    expect(first.stdout).toContain(revision);
    expect(f.log().match(/^run /gm)).toHaveLength(1);
    expect(f.log()).toContain('start installer-test');
    expect(existsSync(join(f.root, 'unexpected.log'))).toBe(false);
  });

  it.each([imageDigest, `ghcr.io/lsh-okok/cloud-mail:sha-${revision}`])('pulls an explicitly pinned official version: %s', image => {
    const f = fixture(), result = f.execute(['--image', image]);
    expect(result.status, result.stderr).toBe(0);
    expect(f.log()).toContain(`pull ${image}`);
    expect(f.log()).not.toMatch(/^(?:build|load) /m);
    expect(f.state()).toContain(`IMAGE_DIGEST=${imageDigest}`);
    expect(f.env().NODE_ROLE).toBe('primary');
  });

  it('restarts a legacy source installation without changing its image or treating install as upgrade', () => {
    const f = fixture(); expect(f.execute().status).toBe(0);
    const before = f.config();
    writeFileSync(join(f.root, 'installed', '.install-state'), f.state()
      .replace('FORMAT=2', 'FORMAT=1').replace('SOURCE_MODE=registry', 'SOURCE_MODE=archive')
      .replace(/^IMAGE_(?:DIGEST|REVISION)=.*\n/gm, ''));
    const beforeLog = f.log();
    const repeated = f.execute();
    expect(repeated.status, repeated.stderr).toBe(0);
    expect(f.config()).toBe(before);
    expect(f.log().slice(beforeLog.length)).toContain('start installer-test');
    expect(f.log().slice(beforeLog.length)).not.toMatch(/^(?:pull|run|build|load) /m);
    const changed = f.execute(['--image', imageDigest]);
    expect(changed.status).toBe(1);
    expect(changed.stdout + changed.stderr).toContain('不执行升级');
    expect(f.config()).toBe(before);
  });

  it.each(['pull-failed', 'invalid-pull-digest', 'missing-digest', 'bad-revision', 'wrong-source'])('refuses incomplete or unverifiable registry images before creating data: %s', marker => {
    const f = fixture(); f.mark(marker);
    // A cached image must never rescue a failed pull.
    f.mark('image-present');
    const result = f.execute();
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/拉取失败|摘要|提交记录/);
    expect(f.log()).not.toMatch(/^(?:build|run|volume create) /m);
    expect(existsSync(join(f.root, 'installed', 'primary.env'))).toBe(false);
  });

  it('uses this pull digest even when image metadata includes an older digest for the repository', () => {
    const f = fixture(); f.mark('historical-digest');
    const result = f.execute();
    expect(result.status, result.stderr).toBe(0);
    expect(f.state()).toContain(`IMAGE_DIGEST=${imageDigest}`);
  });

  it.each([
    `ghcr.io/lsh-okok/cloud-mail@sha256:${'11'.repeat(32)}`,
    `ghcr.io/lsh-okok/cloud-mail:sha-${'22'.repeat(20)}`,
  ])('rejects a resolved version that differs from the requested immutable version: %s', image => {
    const f = fixture(), result = f.execute(['--image', image]);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('不一致');
    expect(f.log()).not.toMatch(/^(?:run|volume create) /m);
  });

  it('refuses unsupported CPU architectures before pulling an image', () => {
    const f = fixture(); f.mark('unsupported-arch');
    const result = f.execute();
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('amd64');
    expect(f.log()).not.toMatch(/^(?:pull|run|volume create) /m);
  });

  it('does not take over existing containers, data volumes or a nonempty directory', () => {
    for (const mark of ['container-present', 'volume-present']) {
      const f = fixture(); f.mark(mark);
      const result = f.execute();
      expect(result.status).toBe(1);
      expect(f.log()).not.toMatch(/^(?:build|run|start|volume create) /m);
    }
    const f = fixture(); mkdirSync(join(f.root, 'installed'));
    writeFileSync(join(f.root, 'installed', 'existing-file'), 'keep');
    expect(f.execute().status).toBe(1);
    expect(readFileSync(join(f.root, 'installed', 'existing-file'), 'utf8')).toBe('keep');
    expect(f.log()).not.toMatch(/^(?:build|run|start|volume create) /m);
  });

  it('rejects changed configuration without restarting the installed service', () => {
    const f = fixture(); expect(f.execute().status).toBe(0);
    const before = f.config(), beforeLog = f.log();
    const result = f.execute(['--port', '13011']);
    expect(result.status).toBe(1);
    expect(f.config()).toBe(before);
    expect(f.log().slice(beforeLog.length)).not.toMatch(/^(?:start|run|build) /m);
  });

  it.each(['wrong-mount', 'wrong-volume-identity'])('refuses to restart when installed data ownership changes: %s', marker => {
    const f = fixture(); expect(f.execute().status).toBe(0);
    const before = f.config(), beforeLog = f.log();
    f.mark(marker);
    const result = f.execute();
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/数据挂载|数据卷身份/);
    expect(f.config()).toBe(before);
    expect(f.log().slice(beforeLog.length)).not.toMatch(/^(?:start|run|build|volume create) /m);
  });

  it('reports readiness failure without printing success or initial credentials', () => {
    const f = fixture(); f.mark('not-ready');
    const result = f.execute();
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain(f.env().ADMIN_PASSWORD);
    expect(result.stdout + result.stderr).toMatch(/未就绪|未通过|超时/);
    expect(f.log()).not.toMatch(/^(?:rm|stop) /m);
    expect(existsSync(join(f.root, 'installed', 'primary.env'))).toBe(true);
  });

  it('rejects invalid parameters without creating services', () => {
    const f = fixture();
    for (const args of [['--port', '0'], ['--port', '65536'], ['--name', '../unsafe'], ['--mail-domain', 'bad domain'], ['--app-url', 'file:///tmp/unsafe'], ['--image', 'example/cloud-mail:release'], ['--image', 'ghcr.io/lsh-okok/cloud-mail:latest'], ['--source-dir', '/tmp/source']]) {
      expect(f.execute(args).status).toBe(1);
    }
    expect(f.execute(['--help']).status).toBe(0);
    expect(f.log()).not.toMatch(/^(?:build|run|start|volume create) /m);
  });
});
