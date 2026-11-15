import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const roots = [];
const installer = readFileSync(fileURLToPath(new URL('../../docker/install-node.sh', import.meta.url)), 'utf8');
const repository = 'ghcr.io/lsh-okok/cloud-mail', imageRef = `${repository}:main`;
const imageId = `sha256:${'ab'.repeat(32)}`, digest = `sha256:${'cd'.repeat(32)}`, revision = 'ef'.repeat(20);
const pinnedImage = `${repository}@${digest}`;
const credential = 'x'.repeat(43), installToken = 't'.repeat(43), primary = 'https://primary.example.com/mail';
const config = `# Keep private.\nNODE_ROLE=replica\nNODE_ID=abcd-1234\nNODE_CREDENTIAL=${credential}\nNODE_PRIMARY_URL=${primary}\nNODE_ALLOW_INSECURE_HTTP=false\nJWT_SECRET=${'a'.repeat(64)}\nDATA_ENCRYPTION_KEY=${'b'.repeat(64)}\nDATA_DIR=./data-node-abcd-1234\nAPP_URL=http://localhost:3001\nPORT=3000\nAPP_BASE_PATH=\n`;
const shell = process.platform === 'win32' ? 'bash.exe' : '/bin/sh';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cloud mail registry ')); roots.push(root);
  mkdirSync(join(root, 'bin')); writeFileSync(join(root, 'install.sh'), installer);
  const write = (name, value = '') => writeFileSync(join(root, name), value);
  const read = name => readFileSync(join(root, name), 'utf8');
  const writeConfig = (options = {}) => write('server-config', ((options.env ?? config) + `INSTALL_PORT=${options.port ?? '3001'}\n${options.metadata ?? `INSTALL_IMAGE_REF=${options.imageRef ?? imageRef}\n`}`).replaceAll('\n', '\r\n'));
  writeConfig(); write('image-id', imageId); write('digest', digest); write('revision', revision);
  write('repo-digests', `${pinnedImage}\n`); write('architecture', 'x86_64\n');
  const mock = (name, body) => writeFileSync(join(root, 'bin', name), `#!/bin/sh\nset -eu\n${body}`, { mode: 0o755 });
  mock('uname', `case "$1" in -s) printf 'Linux\\n' ;; -m) cat "$NODE_INSTALL_TEST_ROOT/architecture" ;; *) exit 99 ;; esac\n`);
  for (const command of ['wget', 'apt-get', 'dnf', 'tar']) mock(command, `printf '%s\\n' '${command}' >> "$NODE_INSTALL_TEST_ROOT/unexpected.log"\nexit 97\n`);
  mock('curl', `node_output=''
node_url=''
while [ "$#" -gt 0 ]; do
  case "$1" in --output) shift; node_output=$1 ;; *) node_url=$1 ;; esac
  shift
done
printf '%s\\n' "$node_url" >> "$NODE_INSTALL_TEST_ROOT/download.log"
case "$node_url" in
  */config.env)
    if [ -f "$NODE_INSTALL_TEST_ROOT/fail-config" ]; then printf 'EXTRA=$(touch download-executed)\\n' > "$node_output"; exit 22; fi
    cp "$NODE_INSTALL_TEST_ROOT/server-config" "$node_output" ;;
  *) exit 98 ;;
esac
`);
  mock('docker', `printf '%s\\n' "$*" >> "$NODE_INSTALL_TEST_ROOT/docker.log"
case "$1" in
  info) exit 0 ;;
  pull)
    if [ -f "$NODE_INSTALL_TEST_ROOT/fail-pull" ]; then printf 'denied: anonymous package access forbidden\\n' >&2; exit 1; fi
    printf 'Digest: %s\\n' "$(cat "$NODE_INSTALL_TEST_ROOT/digest")"
    touch "$NODE_INSTALL_TEST_ROOT/pulled" ;;
  image)
    [ "$2" = inspect ] && [ "$3" = --format ] || exit 98
    [ -f "$NODE_INSTALL_TEST_ROOT/pulled" ] || exit 1
    case "$4" in
      *RepoDigests*) cat "$NODE_INSTALL_TEST_ROOT/repo-digests" ;;
      *revision*) cat "$NODE_INSTALL_TEST_ROOT/revision" ;;
      '{{.Id}}') cat "$NODE_INSTALL_TEST_ROOT/image-id" ;;
      *) exit 98 ;;
    esac ;;
  container)
    [ -f "$NODE_INSTALL_TEST_ROOT/container-present" ] || exit 1
    if [ "\${3:-}" = --format ]; then
      case "$4" in
        *PortBindings*) cat "$NODE_INSTALL_TEST_ROOT/container-port" ;;
        *State.Running*) printf true ;;
        *cloud-mail.node-id*) cat "$NODE_INSTALL_TEST_ROOT/container-node-id" ;;
        *cloud-mail.image-digest*) cat "$NODE_INSTALL_TEST_ROOT/container-digest" ;;
        *cloud-mail.env-sha256*) cat "$NODE_INSTALL_TEST_ROOT/container-env-sha256" ;;
        *Mounts*) cat "$NODE_INSTALL_TEST_ROOT/container-mount" ;;
        *Config.Env*) cat "$NODE_INSTALL_TEST_ROOT/container-env" ;;
        '{{.Image}}') cat "$NODE_INSTALL_TEST_ROOT/container-image" ;;
        *) exit 98 ;;
      esac
    fi ;;
  volume)
    case "$2" in inspect) [ -f "$NODE_INSTALL_TEST_ROOT/volume-present" ] ;; create) touch "$NODE_INSTALL_TEST_ROOT/volume-present" ;; *) exit 98 ;; esac ;;
  run)
    cp "$NODE_INSTALL_TEST_ROOT/image-id" "$NODE_INSTALL_TEST_ROOT/container-image"
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -p) shift; printf '%s' "\${1%:3000}" > "$NODE_INSTALL_TEST_ROOT/container-port" ;;
        -v) shift; printf 'volume:%s' "\${1%:/data}" > "$NODE_INSTALL_TEST_ROOT/container-mount" ;;
        --label)
          shift
          case "$1" in
            cloud-mail.node-id=*) printf '%s' "\${1#*=}" > "$NODE_INSTALL_TEST_ROOT/container-node-id" ;;
            cloud-mail.image-digest=*) printf '%s' "\${1#*=}" > "$NODE_INSTALL_TEST_ROOT/container-digest" ;;
            cloud-mail.env-sha256=*) printf '%s' "\${1#*=}" > "$NODE_INSTALL_TEST_ROOT/container-env-sha256" ;;
          esac ;;
        --env-file) shift; sed 's@^DATA_DIR=.*@DATA_DIR=/data@' "$1" > "$NODE_INSTALL_TEST_ROOT/container-env" ;;
      esac
      shift
    done
    touch "$NODE_INSTALL_TEST_ROOT/container-present" ;;
  start|exec) exit 0 ;;
  *) exit 98 ;;
esac
`);
  const execute = (options = {}) => {
    if (typeof options === 'string') options = { port: options };
    const args = ['--primary-url', options.primary ?? primary, '--install-token', options.token ?? installToken];
    if (options.port !== undefined) args.push('--port', options.port);
    if (options.allowHttp) args.push('--allow-insecure-http');
    return spawnSync(shell, ['-c', 'export PATH="$PWD/bin:$PATH" NODE_INSTALL_TEST_ROOT="$PWD" CLOUD_MAIL_NODE_INSTALL_DIR="$PWD/installed"; sh ./install.sh "$@"', 'fixture', ...(options.args ?? args)], { cwd: root, encoding: 'utf8', timeout: 20000 });
  };
  return { root, execute, writeConfig, write, read, mark: name => write(name), log: () => existsSync(join(root, 'docker.log')) ? read('docker.log') : '', installed: () => read('installed/node.env'), state: () => read('installed/.install-state') };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('registry node installer', () => {
  it('pulls main once, verifies official RepoDigest and revision, and launches the immutable image', () => {
    const f = fixture();
    f.write('repo-digests', `${repository}@sha256:${'99'.repeat(32)}\n${pinnedImage}\n`);
    const first = f.execute();
    expect(first.error).toBeUndefined(); expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain('部署成功'); expect(f.installed()).toBe(config);
    expect(f.log().match(/^pull /gm)).toHaveLength(1); expect(f.log()).toContain(`pull ${imageRef}`);
    expect(f.log()).toContain(`image inspect --format {{range .RepoDigests}}{{println .}}{{end}} ${pinnedImage}`);
    expect(f.log()).toContain(`-p 3001:3000 -v cloud-mail-node-abcd-1234-data:/data ${pinnedImage}`);
    expect(f.log()).not.toMatch(/^(?:build|load|tag) /m);
    expect(f.state()).toContain(`IMAGE_REF=${imageRef}\nIMAGE_DIGEST=${pinnedImage}\nIMAGE_ID=${imageId}\nREVISION=${revision}\n`);
    expect(f.state()).toContain(`ENV_SHA256=${createHash('sha256').update(config).digest('hex')}\n`);
    expect(existsSync(join(f.root, 'unexpected.log'))).toBe(false);
    expect(f.read('download.log')).toBe(`${primary}/api/node-install/${installToken}/config.env\n`);
    for (const secret of [credential, installToken]) expect(first.stdout + first.stderr + f.log() + f.state()).not.toContain(secret);
  });

  it('keeps the original image and data when main advances or becomes unavailable', () => {
    const f = fixture(); expect(f.execute().status).toBe(0);
    const state = f.state(), before = f.log();
    f.write('image-id', `sha256:${'11'.repeat(32)}`); f.write('digest', `sha256:${'22'.repeat(32)}`); f.write('revision', '33'.repeat(20)); f.mark('fail-pull');
    const repeated = f.execute(); expect(repeated.status, repeated.stderr).toBe(0);
    expect(f.state()).toBe(state); expect(f.installed()).toBe(config);
    expect(f.log().slice(before.length)).toContain('start cloud-mail-node-abcd-1234');
    expect(f.log().slice(before.length)).not.toMatch(/^(?:pull|image|run|volume create) /m);
    expect(f.log().match(/^run /gm)).toHaveLength(1);
  });

  it('starts a legacy node without claiming it came from the registry', () => {
    const f = fixture(); expect(f.execute().status).toBe(0); rmSync(join(f.root, 'installed/.install-state'));
    f.write('container-image', `sha256:${'77'.repeat(32)}`); const before = f.log(), result = f.execute();
    expect(result.status, result.stderr).toBe(0);
    expect(f.state()).toContain(`SOURCE_MODE=legacy\nIMAGE_REF=\nIMAGE_DIGEST=\nIMAGE_ID=sha256:${'77'.repeat(32)}\nREVISION=\n`);
    expect(f.log().slice(before.length)).toContain('start cloud-mail-node-abcd-1234');
    expect(f.log().slice(before.length)).not.toMatch(/^(?:pull|image|run|volume create) /m);
    expect(f.execute().status).toBe(0);
  });

  it('never falls back to cached images or writes configuration after a failed pull', () => {
    const f = fixture(); f.mark('fail-pull'); f.mark('pulled'); const result = f.execute();
    expect(result.status).toBe(1); expect(result.stderr).toContain('不会使用旧缓存镜像');
    expect(f.log()).not.toMatch(/^(?:image|build|load|run|volume create) /m);
    for (const file of ['installed/node.env', 'installed/.install-state', 'installed/.install-lock']) expect(existsSync(join(f.root, file))).toBe(false);
  });

  it('supports an explicit port without changing the pinned image', () => {
    const f = fixture(), result = f.execute('13001'); expect(result.status, result.stderr).toBe(0);
    expect(f.log()).toContain(`-p 13001:3000 -v cloud-mail-node-abcd-1234-data:/data ${pinnedImage}`);
    expect(f.state()).toContain('HTTP_PORT=13001\n'); expect(f.execute('13001').status).toBe(0);
  });

  it('stops before Docker when configuration download fails', () => {
    const f = fixture(); f.mark('fail-config'); const result = f.execute();
    expect(result.status).toBe(1); expect(result.stderr).toContain('接入配置下载失败'); expect(f.log()).toBe('');
    for (const file of ['installed', 'download-executed']) expect(existsSync(join(f.root, file))).toBe(false);
  });

  it('requires explicit HTTP permission and binds configuration to the requested primary', () => {
    const f = fixture(), httpPrimary = 'http://192.168.31.111:3000';
    f.writeConfig({ env: config.replace(primary, httpPrimary).replace('HTTP=false', 'HTTP=true') });
    expect(f.execute({ primary: httpPrimary }).stderr).toContain('--allow-insecure-http'); expect(f.log()).toBe('');
    const accepted = f.execute({ primary: httpPrimary, allowHttp: true }); expect(accepted.status, accepted.stderr).toBe(0);
    const other = fixture(); other.writeConfig({ env: config.replace(primary, 'https://other.example.com') });
    expect(other.execute().stderr).toContain('主节点地址与命令不一致'); expect(other.log()).toBe('');
  });

  it('treats dotenv and state values as data, not shell commands', () => {
    const f = fixture(), extra = 'EXTRA=$(touch shell-executed)\nANOTHER=`touch backtick-executed`\n';
    f.writeConfig({ env: config + extra }); expect(f.execute().status).toBe(0); expect(f.installed()).toBe(config + extra);
    f.write('installed/.install-state', f.state().replace('SOURCE_MODE=registry', 'SOURCE_MODE=$(touch state-executed)')); expect(f.execute().status).toBe(1);
    for (const marker of ['shell-executed', 'backtick-executed', 'state-executed']) expect(existsSync(join(f.root, marker))).toBe(false);
  });

  it.each([
      ['container-port', '3002', '已有节点使用端口'],
      ['container-image', `sha256:${'44'.repeat(32)}`, '镜像与部署记录不同'],
      ['container-node-id', 'another-node', '其他服务占用'],
      ['container-digest', `${repository}@sha256:${'55'.repeat(32)}`, '标签与部署记录不同'],
      ['container-env-sha256', '66'.repeat(32), '标签与部署记录不同'],
      ['container-mount', 'volume:unrelated-data', '数据卷挂载不一致'],
      ['container-env', config.replace(credential, 'y'.repeat(43)), '容器的接入配置'],
    ])('protects existing %s without restarting', (file, value, message) => {
      const f = fixture(); expect(f.execute().status).toBe(0); const before = f.log(); f.write(file, value);
      const changed = f.execute(); expect(changed.status, changed.stderr).toBe(1); expect(changed.stderr).toContain(message);
      expect(f.log().slice(before.length)).not.toMatch(/^(?:start|run|pull|volume create) /m);
  }, 30000);

  it('refuses a requested port that differs from the saved deployment', () => {
    const f = fixture(); expect(f.execute().status).toBe(0); expect(f.execute('3002').stderr).toContain('配置或端口不一致');
  });

  it('preserves credentials and checks local configuration against the recorded checksum', () => {
    const f = fixture(); expect(f.execute().status).toBe(0); const before = f.log(), state = f.state();
    f.writeConfig({ env: config.replace(credential, 'y'.repeat(43)) }); const changed = f.execute();
    expect(changed.status).toBe(1); expect(changed.stderr).toContain('原配置和数据未修改'); expect(f.installed()).toBe(config); expect(f.state()).toBe(state);
    expect(f.log().slice(before.length)).not.toMatch(/^(?:start|run|pull) /m);
    f.write('installed/node.env', config.replace(credential, 'y'.repeat(43))); expect(f.execute().stderr).toContain('部署记录与本次配置');
  });

  it.each([['container-present', '容器缺失'], ['volume-present', '数据卷缺失']])('refuses missing %s', (file, message) => {
    const f = fixture(); expect(f.execute().status).toBe(0); rmSync(join(f.root, file)); expect(f.execute().stderr).toContain(message);
  }, 30000);

  it('refuses unknown preexisting data without pulling an image', () => {
    const occupied = fixture(); occupied.mark('volume-present'); expect(occupied.execute().stderr).toContain('同名数据卷已存在'); expect(occupied.log()).not.toMatch(/^(?:pull|run|volume create) /m);
  });

  it('rejects invalid digests, mismatched RepoDigests and missing Git revisions before creating resources', () => {
    for (const [file, value, message] of [
      ['digest', 'sha256:invalid', '镜像拉取摘要'],
      ['repo-digests', `ghcr.io/other/cloud-mail@${digest}\n`, 'RepoDigest 不匹配'],
      ['repo-digests', `${repository}@sha256:${'12'.repeat(32)}\n`, 'RepoDigest 不匹配'],
      ['image-id', 'sha256:invalid', '镜像的 ID 无效'],
      ['revision', '', 'Git 提交版本'], ['revision', 'not-a-commit', 'Git 提交版本'],
    ]) {
      const f = fixture(); f.write(file, value); const result = f.execute(); expect(result.status).toBe(1); expect(result.stderr).toContain(message);
      expect(f.log()).not.toMatch(/^(?:run|volume create) /m); expect(existsSync(join(f.root, 'installed/node.env'))).toBe(false);
    }
  }, 30000);

  it('accepts only the official main ref and rejects bundle/source configuration', () => {
    const f = fixture();
    for (const alternate of ['ghcr.io/other/cloud-mail:main', `${repository}:latest`, `${repository}:sha-${revision}`, pinnedImage, `${imageRef};touch ref-executed`, '']) {
      f.writeConfig({ imageRef: alternate }); const result = f.execute(); expect(result.status).toBe(1); expect(result.stderr).toContain('必须使用官方镜像');
    }
    f.writeConfig({ metadata: `INSTALL_BUNDLE_SHA256=${'00'.repeat(32)}\nINSTALL_BUNDLE_IMAGE_ID=${imageId}\n` }); expect(f.execute().status).toBe(1); expect(f.log()).toBe('');
    expect(existsSync(join(f.root, 'ref-executed'))).toBe(false);
  });

  it('rejects unsupported architectures before contacting the primary or Docker', () => {
    const f = fixture(); f.write('architecture', 'aarch64\n'); const result = f.execute(); expect(result.status).toBe(1); expect(result.stderr).toContain('amd64'); expect(f.log()).toBe(''); expect(existsSync(join(f.root, 'download.log'))).toBe(false);
  });

  it('rejects invalid parameters and malformed or duplicated configuration fields before Docker access', () => {
    const f = fixture();
    for (const options of [{ token: 'invalid' }, { primary: 'https://user:pass@example.com' }, { port: '65536' }]) expect(f.execute(options).status).toBe(1);
    expect(f.execute({ args: ['--help'] }).status).toBe(0);
    for (const invalid of [{ env: config.replace('NODE_ID=abcd-1234', 'NODE_ID=../../other') }, { env: config.replace(credential, 'invalid') }, { env: config + 'NODE_ID=duplicate\n' }, { env: config + 'not dotenv\n' }, { metadata: `INSTALL_IMAGE_REF=${imageRef}\nINSTALL_IMAGE_REF=${imageRef}\n` }]) {
      f.writeConfig(invalid); expect(f.execute().status).toBe(1);
    }
    expect(f.log()).toBe('');
  }, 30000);
});
