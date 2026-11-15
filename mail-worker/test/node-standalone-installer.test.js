import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const roots = [];
const installer = readFileSync(fileURLToPath(new URL('../../docker/install-node.sh', import.meta.url)), 'utf8');
const imageId = `sha256:${'ab'.repeat(32)}`;
const credential = 'x'.repeat(43), installToken = 't'.repeat(43);
const primary = 'https://primary.example.com/mail';
const config = `NODE_ROLE=replica\nNODE_ID=abcd-1234\nNODE_CREDENTIAL=${credential}\nNODE_PRIMARY_URL=${primary}\nNODE_ALLOW_INSECURE_HTTP=false\nJWT_SECRET=${'a'.repeat(64)}\nDATA_ENCRYPTION_KEY=${'b'.repeat(64)}\n`;
const shell = process.platform === 'win32' ? 'bash.exe' : '/bin/sh';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cloud mail generic ')); roots.push(root);
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'install.sh'), installer);
  const archive = Buffer.from('fixture node bundle');
  writeFileSync(join(root, 'bundle'), archive);
  const sha256 = createHash('sha256').update(archive).digest('hex');
  const writeConfig = (options = {}) => {
    const env = options.env ?? config;
    const contents = env + `INSTALL_PORT=${options.port ?? '3001'}\nINSTALL_BUNDLE_SHA256=${options.sha256 ?? sha256}\nINSTALL_BUNDLE_IMAGE_ID=${options.imageId ?? imageId}\n`;
    writeFileSync(join(root, 'server-config'), contents.replaceAll('\n', '\r\n'));
  };
  writeConfig();
  writeFileSync(join(root, 'image-id'), imageId);
  const mock = (name, body) => writeFileSync(join(root, 'bin', name), `#!/bin/sh\nset -eu\n${body}`, { mode: 0o755 });
  mock('uname', "printf 'Linux\\n'\n");
  for (const command of ['wget', 'apt-get', 'dnf']) {
    mock(command, `printf '%s\\n' '${command}' >> "$NODE_INSTALL_TEST_ROOT/unexpected.log"\nexit 97\n`);
  }
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
  */bundle) cp "$NODE_INSTALL_TEST_ROOT/bundle" "$node_output" ;;
  *) exit 98 ;;
esac
`);
  mock('tar', `printf '%s\\n' "$*" >> "$NODE_INSTALL_TEST_ROOT/tar.log"\n`);
  mock('docker', `printf '%s\\n' "$*" >> "$NODE_INSTALL_TEST_ROOT/docker.log"
case "$1" in
  info) exit 0 ;;
  image)
    if [ "$3" = --format ]; then
      [ -f "$NODE_INSTALL_TEST_ROOT/tagged-id" ] || exit 1
      cat "$NODE_INSTALL_TEST_ROOT/tagged-id"
    else
      [ -f "$NODE_INSTALL_TEST_ROOT/loaded-id" ] && [ "$3" = "$(cat "$NODE_INSTALL_TEST_ROOT/loaded-id")" ]
    fi ;;
  container)
    [ -f "$NODE_INSTALL_TEST_ROOT/container-present" ] || exit 1
    if [ "\${3:-}" = --format ]; then
      case "$4" in
        *PortBindings*) cat "$NODE_INSTALL_TEST_ROOT/container-port" ;;
        *State.Running*) printf true ;;
        *cloud-mail.node-id*) printf abcd-1234 ;;
        *Image*) cat "$NODE_INSTALL_TEST_ROOT/container-image" ;;
        *) exit 2 ;;
      esac
    fi ;;
  load) cp "$NODE_INSTALL_TEST_ROOT/image-id" "$NODE_INSTALL_TEST_ROOT/loaded-id" ;;
  tag) printf '%s' "$2" > "$NODE_INSTALL_TEST_ROOT/tagged-id" ;;
  build) cp "$NODE_INSTALL_TEST_ROOT/image-id" "$NODE_INSTALL_TEST_ROOT/tagged-id" ;;
  run)
    cp "$NODE_INSTALL_TEST_ROOT/tagged-id" "$NODE_INSTALL_TEST_ROOT/container-image"
    while [ "$#" -gt 0 ]; do
      if [ "$1" = -p ]; then shift; printf '%s' "\${1%:3000}" > "$NODE_INSTALL_TEST_ROOT/container-port"; fi
      shift
    done
    touch "$NODE_INSTALL_TEST_ROOT/container-present" ;;
  start|volume|exec) exit 0 ;;
  *) exit 98 ;;
esac
`);
  const execute = (options = {}) => {
    if (typeof options === 'string') options = { port: options };
    const args = ['--primary-url', options.primary ?? primary, '--install-token', options.token ?? installToken];
    if (options.port !== undefined) args.push('--port', options.port);
    if (options.allowHttp) args.push('--allow-insecure-http');
    return spawnSync(shell,
      ['-c', 'export PATH="$PWD/bin:$PATH" NODE_INSTALL_TEST_ROOT="$PWD" CLOUD_MAIL_NODE_INSTALL_DIR="$PWD/installed"; sh ./install.sh "$@"', 'fixture', ...(options.args ?? args)],
      { cwd: root, encoding: 'utf8', timeout: 20000 });
  };
  return { root, execute, writeConfig,
    mark: name => writeFileSync(join(root, name), ''),
    log: () => existsSync(join(root, 'docker.log')) ? readFileSync(join(root, 'docker.log'), 'utf8') : '',
    installed: () => readFileSync(join(root, 'installed', 'node.env'), 'utf8'),
  };
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('generic node installer', () => {
  it('downloads configuration and prebuilt image using the token, strips install metadata and safely repeats', () => {
    const f = fixture(), first = f.execute();
    expect(first.error).toBeUndefined();
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain('部署成功');
    expect(f.installed()).toBe(config);
    expect(f.execute().status).toBe(0);
    expect(f.log().match(/^load /gm)).toHaveLength(1);
    expect(f.log().match(/^run /gm)).toHaveLength(1);
    expect(f.log()).toContain('start cloud-mail-node-abcd-1234');
    expect(f.log()).toContain('-p 3001:3000 -v cloud-mail-node-abcd-1234-data:/data');
    expect(f.log()).not.toMatch(/^(?:build|pull) /m);
    expect(existsSync(join(f.root, 'tar.log'))).toBe(false);
    expect(existsSync(join(f.root, 'unexpected.log'))).toBe(false);
    const downloads = readFileSync(join(f.root, 'download.log'), 'utf8');
    expect(downloads.match(/\/config.env/g)).toHaveLength(2);
    expect(downloads.match(/\/bundle/g)).toHaveLength(1);
    expect(downloads).toContain(`${primary}/api/node-install/${installToken}/config.env`);
    expect(first.stdout + first.stderr + f.log()).not.toContain(credential);
    expect(first.stdout + first.stderr + f.log()).not.toContain(installToken);
  });

  it('builds a verified source bundle when the configuration has no image ID', () => {
    const f = fixture(); f.writeConfig({ imageId: '' });
    const result = f.execute('13001');
    expect(result.status, result.stderr).toBe(0);
    expect(f.log()).toContain('build --tag cloud-mail-node:abcd-1234');
    expect(f.log()).toContain('-p 13001:3000');
    expect(f.log()).not.toMatch(/^load /m);
    expect(readFileSync(join(f.root, 'tar.log'), 'utf8')).toContain('-xzf ');
  });

  it('fails before Docker and persistent configuration when configuration download is incomplete', () => {
    const f = fixture(); f.mark('fail-config');
    const result = f.execute();
    expect(result.status).toBe(1); expect(result.stderr).toContain('接入配置下载失败');
    expect(f.log()).toBe('');
    expect(existsSync(join(f.root, 'installed'))).toBe(false);
    expect(existsSync(join(f.root, 'download-executed'))).toBe(false);
  });

  it('requires explicit HTTP permission and binds the downloaded configuration to the requested primary', () => {
    const f = fixture(), httpPrimary = 'http://192.168.31.111:3000';
    f.writeConfig({ env: config.replace(primary, httpPrimary).replace('HTTP=false', 'HTTP=true') });
    const noPermission = f.execute({ primary: httpPrimary });
    expect(noPermission.status).toBe(1); expect(noPermission.stderr).toContain('--allow-insecure-http');
    expect(f.log()).toBe('');
    const accepted = f.execute({ primary: httpPrimary, allowHttp: true });
    expect(accepted.status, accepted.stderr).toBe(0);
    const other = fixture(); other.writeConfig({ env: config.replace(primary, 'https://other.example.com') });
    const mismatch = other.execute();
    expect(mismatch.status).toBe(1); expect(mismatch.stderr).toContain('主节点地址与命令不一致');
    expect(other.log()).toBe('');
  });

  it('treats dotenv values as literal data rather than executing shell substitutions', () => {
    const f = fixture(), extra = 'EXTRA=$(touch shell-executed)\nANOTHER=`touch backtick-executed`\n';
    f.writeConfig({ env: config + extra });
    const result = f.execute();
    expect(result.status, result.stderr).toBe(0);
    expect(f.installed()).toBe(config + extra);
    expect(existsSync(join(f.root, 'shell-executed'))).toBe(false);
    expect(existsSync(join(f.root, 'backtick-executed'))).toBe(false);
  });

  it('refuses changed ports or image versions without restarting the existing node', () => {
    const f = fixture(); expect(f.execute().status).toBe(0);
    const before = f.log();
    const port = f.execute('3002');
    expect(port.status).toBe(1); expect(port.stderr).toContain('已有节点使用端口 3001');
    f.writeConfig({ imageId: `sha256:${'cd'.repeat(32)}` });
    const version = f.execute();
    expect(version.status).toBe(1); expect(version.stderr).toContain('镜像版本与安装包不同');
    expect(f.log().slice(before.length)).not.toMatch(/^(?:start|run|load|tag) /m);
  });

  it('preserves installed credentials when a different configuration is returned', () => {
    const f = fixture(); expect(f.execute().status).toBe(0);
    const before = f.log();
    f.writeConfig({ env: config.replace(credential, 'y'.repeat(43)) });
    const changed = f.execute();
    expect(changed.status).toBe(1); expect(changed.stderr).toContain('原配置和数据未修改');
    expect(f.installed()).toBe(config);
    expect(f.log().slice(before.length)).not.toMatch(/^(?:start|run|load|tag) /m);
  });

  it('rejects corrupted bundles before importing or creating a container', () => {
    const f = fixture(); writeFileSync(join(f.root, 'bundle'), 'corrupted');
    const result = f.execute();
    expect(result.status).toBe(1); expect(result.stderr).toContain('安装包校验失败');
    expect(f.log()).not.toMatch(/^(?:load|tag|volume|run) /m);
  });

  it('rejects an existing tag or downloaded archive with the wrong image ID', () => {
    const f = fixture(); writeFileSync(join(f.root, 'tagged-id'), `sha256:${'ef'.repeat(32)}`);
    const tag = f.execute();
    expect(tag.status).toBe(1); expect(tag.stderr).toContain('同名镜像与安装包版本不一致');
    expect(f.log()).not.toMatch(/^(?:load|tag|volume|run) /m);
    const other = fixture(); writeFileSync(join(other.root, 'image-id'), `sha256:${'ef'.repeat(32)}`);
    const archive = other.execute();
    expect(archive.status).toBe(1); expect(archive.stderr).toContain('安装包未包含预期镜像');
    expect(other.log()).not.toMatch(/^(?:tag|volume|run) /m);
  });

  it('rejects invalid parameters and malformed or duplicated configuration fields before Docker access', () => {
    const f = fixture();
    for (const options of [{ token: 'invalid' }, { primary: 'https://user:pass@example.com' }, { port: '65536' }]) {
      expect(f.execute(options).status).toBe(1);
    }
    expect(f.execute({ args: ['--help'] }).status).toBe(0);
    for (const invalid of [
      { env: config.replace('NODE_ID=abcd-1234', 'NODE_ID=../../other') },
      { env: config.replace(credential, 'invalid') },
      { env: config + 'NODE_ID=duplicate\n' },
      { sha256: 'not-a-sha256' },
      { imageId: 'sha256:invalid' },
    ]) {
      f.writeConfig(invalid);
      expect(f.execute().status).toBe(1);
    }
    expect(f.log()).toBe('');
  }, 30000);
});
