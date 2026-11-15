import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const roots = [];
const shell = process.platform === 'win32' ? 'bash.exe' : '/bin/bash';
const installerPath = fileURLToPath(new URL('../../docker/install-primary.sh', import.meta.url));
const imageId = `sha256:${'ab'.repeat(32)}`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cloud mail primary ')); roots.push(root);
  mkdirSync(join(root, 'bin'));
  mkdirSync(join(root, 'source', 'mail-worker'), { recursive: true });
  mkdirSync(join(root, 'source', 'mail-worker', 'src', 'server'), { recursive: true });
  mkdirSync(join(root, 'source', 'mail-vue'), { recursive: true });
  mkdirSync(join(root, 'source', 'docker'), { recursive: true });
  writeFileSync(join(root, 'source', 'Dockerfile'), 'FROM scratch\n');
  writeFileSync(join(root, 'source', 'mail-worker', 'package.json'), '{"name":"mail-worker"}\n');
  writeFileSync(join(root, 'source', 'mail-worker', 'src', 'server', 'index.js'), 'export {};\n');
  writeFileSync(join(root, 'source', 'mail-vue', 'package.json'), '{"name":"mail-vue"}\n');
  writeFileSync(join(root, 'source', 'docker', 'app-entrypoint.sh'), '#!/bin/sh\n');
  const packed = spawnSync(shell, ['-c', 'tar -czf bundle.tar.gz -C source .'], { cwd: root, encoding: 'utf8' });
  expect(packed.status, packed.stderr).toBe(0);
  const archive = readFileSync(join(root, 'bundle.tar.gz'));
  const hash = createHash('sha256').update(archive).digest('hex');
  const installer = readFileSync(installerPath, 'utf8')
    .replace(/^primary_source_url=.*$/m, "primary_source_url='https://fixture.example/cloud-mail.tar.gz'")
    .replace(/^primary_source_sha256=.*$/m, `primary_source_sha256='${hash}'`);
  writeFileSync(join(root, 'install.sh'), installer);
  const mock = (name, contents) => writeFileSync(join(root, 'bin', name), `#!/bin/sh\nset -eu\n${contents}`, { mode: 0o755 });
  mock('id', "printf '0\\n'\n");
  mock('uname', "printf 'Linux\\n'\n");
  mock('ss', 'exit 0\n');
  mock('sleep', 'exit 0\n');
  mock('date', `primary_test_time=0
if [ -f "$PRIMARY_INSTALL_TEST_ROOT/clock" ]; then primary_test_time=$(cat "$PRIMARY_INSTALL_TEST_ROOT/clock"); fi
printf '%s\\n' "$primary_test_time"
printf '%s\\n' "$(( primary_test_time + 20 ))" > "$PRIMARY_INSTALL_TEST_ROOT/clock"
`);
  mock('curl', `primary_test_output=''
while [ "$#" -gt 0 ]; do
  case "$1" in --output|-o) shift; primary_test_output=$1 ;; https://*) printf '%s\\n' "$1" >> "$PRIMARY_INSTALL_TEST_ROOT/download.log" ;; esac
  shift
done
[ -n "$primary_test_output" ] || exit 98
if [ -f "$PRIMARY_INSTALL_TEST_ROOT/bad-archive" ]; then printf corrupted > "$primary_test_output"; else cp "$PRIMARY_INSTALL_TEST_ROOT/bundle.tar.gz" "$primary_test_output"; fi
`);
  for (const command of ['wget', 'apt-get', 'dnf']) {
    mock(command, `printf '%s\\n' '${command}' >> "$PRIMARY_INSTALL_TEST_ROOT/unexpected.log"\nexit 97\n`);
  }
  mock('docker', `printf '%s\\n' "$*" >> "$PRIMARY_INSTALL_TEST_ROOT/docker.log"
case "$1" in
  info) exit 0 ;;
  ps) exit 0 ;;
  image)
    primary_test_image=''
    for primary_test_arg in "$@"; do primary_test_image=$primary_test_arg; done
    case "$primary_test_image" in
      example/cloud-mail:release) printf '%s\\n' '${imageId}' ;;
      *) [ -f "$PRIMARY_INSTALL_TEST_ROOT/image-present" ] && printf '%s\\n' '${imageId}' ;;
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
  build) touch "$PRIMARY_INSTALL_TEST_ROOT/image-present" ;;
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
    mark: name => writeFileSync(join(root, name), ''),
    log: () => existsSync(join(root, 'docker.log')) ? readFileSync(join(root, 'docker.log'), 'utf8') : '',
    env: () => Object.fromEntries(config().split(/\r?\n/).filter(line => /^[A-Z_]+=/.test(line)).map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; })),
  };
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('primary node installer', () => {
  it('downloads and verifies the source, creates independent primary credentials and keeps them on repeat', () => {
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
    expect(f.log().match(/^build /gm)).toHaveLength(1);
    expect(f.log().match(/^run /gm)).toHaveLength(1);
    expect(f.log()).toContain('start installer-test');
    expect(readFileSync(join(f.root, 'download.log'), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(existsSync(join(f.root, 'unexpected.log'))).toBe(false);
  });

  it('uses an existing application image without downloading source or building it', () => {
    const f = fixture(), result = f.execute(['--image', 'example/cloud-mail:release']);
    expect(result.status, result.stderr).toBe(0);
    expect(f.log()).not.toMatch(/^build /m);
    expect(existsSync(join(f.root, 'download.log'))).toBe(false);
    expect(f.log()).toContain('example/cloud-mail:release');
    expect(f.env().NODE_ROLE).toBe('primary');
  });

  it('refuses a corrupted source archive before build or container startup', () => {
    const f = fixture(); f.mark('bad-archive');
    const result = f.execute();
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/校验|摘要/);
    expect(f.log()).not.toMatch(/^(?:build|run|volume create) /m);
    expect(existsSync(join(f.root, 'installed', 'primary.env'))).toBe(false);
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
    const result = f.execute(['--image', 'example/cloud-mail:release']);
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain(f.env().ADMIN_PASSWORD);
    expect(result.stdout + result.stderr).toMatch(/未就绪|未通过|超时/);
    expect(f.log()).not.toMatch(/^(?:rm|stop) /m);
    expect(existsSync(join(f.root, 'installed', 'primary.env'))).toBe(true);
  });

  it('rejects invalid parameters without creating services', () => {
    const f = fixture();
    for (const args of [['--port', '0'], ['--port', '65536'], ['--name', '../unsafe'], ['--mail-domain', 'bad domain'], ['--app-url', 'file:///tmp/unsafe']]) {
      expect(f.execute(args).status).toBe(1);
    }
    expect(f.execute(['--help']).status).toBe(0);
    expect(f.log()).not.toMatch(/^(?:build|run|start|volume create) /m);
  });
});
