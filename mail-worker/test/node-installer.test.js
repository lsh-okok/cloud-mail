import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildNodeInstallScript } from '../src/modules/nodes/installer.js';

const roots = [];
const id = 'abcd-1234';
const options = { id, env: 'NODE_ROLE=replica\nNODE_ID=abcd-1234\nNODE_CREDENTIAL=private-test-value\n',
  port: 3001, bundleUrl: "https://primary.example.com/api/install/a'$(touch unexpected)?token=secret", bundleSha256: 'ab'.repeat(32) };
const shell = process.platform === 'win32' ? 'bash.exe' : '/bin/sh';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cloud mail installer ')); roots.push(root);
  mkdirSync(join(root, 'bin')); mkdirSync(join(root, 'home'));
  const mock = (name, contents) => writeFileSync(join(root, 'bin', name), '#!/bin/sh\nset -eu\n' + contents, { mode: 0o755 });
  mock('uname', "printf 'Linux\\n'\n");
  mock('docker', `printf '%s\\n' "$*" >> "$NODE_INSTALL_TEST_ROOT/docker.log"
case "$1" in
  info) exit 0 ;;
  image)
    if [ "$3" = --format ]; then
      [ -e "$NODE_INSTALL_TEST_ROOT/image-present" ] || exit 1
      cat "$NODE_INSTALL_TEST_ROOT/image-id"
    else
      case "$3" in
        sha256:*) [ -e "$NODE_INSTALL_TEST_ROOT/loaded-image" ] && [ ! -e "$NODE_INSTALL_TEST_ROOT/wrong-image" ] ;;
        *) [ -e "$NODE_INSTALL_TEST_ROOT/image-present" ] ;;
      esac
    fi ;;
  container)
    if [ "\${3:-}" = --format ]; then
      case "$4" in
        *State.Running*) if [ -e "$NODE_INSTALL_TEST_ROOT/stopped" ]; then printf false; else printf true; fi ;;
        *PortBindings*) cat "$NODE_INSTALL_TEST_ROOT/container-port" ;;
        *Image*) cat "$NODE_INSTALL_TEST_ROOT/container-image" ;;
        *) if [ -e "$NODE_INSTALL_TEST_ROOT/foreign-container" ]; then printf foreign; else printf abcd-1234; fi ;;
      esac
    else [ -e "$NODE_INSTALL_TEST_ROOT/container-present" ]; fi ;;
  build)
    touch "$NODE_INSTALL_TEST_ROOT/image-present"
    printf '%s' 'sha256:${'12'.repeat(32)}' > "$NODE_INSTALL_TEST_ROOT/image-id" ;;
  load) touch "$NODE_INSTALL_TEST_ROOT/loaded-image"; printf 'Loaded image: hidden-test-label\\n' ;;
  tag)
    touch "$NODE_INSTALL_TEST_ROOT/image-present"
    printf '%s' "$2" > "$NODE_INSTALL_TEST_ROOT/image-id" ;;
  run)
    touch "$NODE_INSTALL_TEST_ROOT/container-present"
    cp "$NODE_INSTALL_TEST_ROOT/image-id" "$NODE_INSTALL_TEST_ROOT/container-image"
    while [ "$#" -gt 0 ]; do
      if [ "$1" = -p ]; then shift; printf '%s' "\${1%:3000}" > "$NODE_INSTALL_TEST_ROOT/container-port"; fi
      shift
    done ;;
  start|volume) exit 0 ;;
  exec) [ ! -e "$NODE_INSTALL_TEST_ROOT/not-ready" ] ;;
  *) exit 2 ;;
esac
`);
  mock('curl', `printf '%s\\n' "$*" >> "$NODE_INSTALL_TEST_ROOT/curl.log"
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then shift; printf bundle > "$1"; fi
  shift
done
`);
  mock('sha256sum', `cat >/dev/null
[ ! -e "$NODE_INSTALL_TEST_ROOT/bad-hash" ]
`);
  mock('tar', `printf '%s\\n' "$*" >> "$NODE_INSTALL_TEST_ROOT/tar.log"
`);
  mock('sleep', 'exit 0\n');
  mock('date', `node_test_time=0
if [ -r "$NODE_INSTALL_TEST_ROOT/clock" ]; then node_test_time=$(cat "$NODE_INSTALL_TEST_ROOT/clock"); fi
printf '%s\\n' "$node_test_time"
printf '%s\\n' "$(( node_test_time + 5 ))" > "$NODE_INSTALL_TEST_ROOT/clock"
`);
  const execute = overrides => {
    writeFileSync(join(root, 'install.sh'), buildNodeInstallScript({ ...options, ...overrides }), { mode: 0o700 });
    return spawnSync(shell, ['-c', 'export PATH="$PWD/bin:$PATH" CLOUD_MAIL_NODE_INSTALL_DIR="$PWD/home/.cloud-mail/nodes/abcd-1234" NODE_INSTALL_TEST_ROOT="$PWD"; sh ./install.sh'],
      { cwd: root, encoding: 'utf8', timeout: 20000 });
  };
  return { root, execute, mark: name => writeFileSync(join(root, name), ''),
    config: join(root, 'home', '.cloud-mail', 'nodes', id, 'node.env'),
    log: () => readFileSync(join(root, 'docker.log'), 'utf8') };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('one-command node installer', () => {
  it('loads and verifies a prebuilt image without extraction or a network build, and reuses it safely', () => {
    const f = fixture(), bundleImageId = 'sha256:' + 'cd'.repeat(32);
    const result = f.execute({ bundleImageId });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('部署成功');
    expect(result.stdout + result.stderr).not.toContain('hidden-test-label');
    expect(f.log()).toContain('load --input ');
    expect(f.log()).toContain(`image inspect ${bundleImageId}`);
    expect(f.log()).toContain(`tag ${bundleImageId} cloud-mail-node:abcd-1234`);
    expect(f.log()).not.toMatch(/^build /m);
    expect(existsSync(join(f.root, 'tar.log'))).toBe(false);
    expect(f.log()).toContain('-p 3001:3000 -v cloud-mail-node-abcd-1234-data:/data');
    expect(readFileSync(f.config, 'utf8')).toBe(options.env);
    expect(f.execute({ bundleImageId }).status).toBe(0);
    expect(f.log().match(/^load /gm)).toHaveLength(1);
    expect(f.log().match(/^run /gm)).toHaveLength(1);
    expect(f.log()).toContain('start cloud-mail-node-abcd-1234');
  });

  it('refuses a prebuilt archive that does not contain the promised image', () => {
    const f = fixture(); f.mark('wrong-image');
    const result = f.execute({ bundleImageId: 'sha256:' + 'ef'.repeat(32) });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('安装包未包含预期镜像');
    expect(f.log()).toContain('load --input ');
    expect(f.log()).not.toMatch(/^(?:tag|run|volume|build) /m);
    expect(existsSync(join(f.root, 'tar.log'))).toBe(false);
  });

  it('refuses a different port before restarting an existing source-built node', () => {
    const f = fixture();
    expect(f.execute().status).toBe(0);
    const before = f.log();
    const changed = f.execute({ port: 3002 });
    expect(changed.status).toBe(1);
    expect(changed.stderr).toContain('已有节点使用端口 3001，本次指定 3002');
    expect(changed.stdout).not.toContain('部署成功');
    expect(f.log().slice(before.length)).not.toMatch(/^(?:start|run|load|tag|build) /m);
    expect(readFileSync(f.config, 'utf8')).toBe(options.env);
  });

  it('refuses a different prebuilt image before restarting an existing node', () => {
    const f = fixture(), bundleImageId = 'sha256:' + 'cd'.repeat(32);
    expect(f.execute({ bundleImageId }).status).toBe(0);
    const before = f.log();
    const changed = f.execute({ bundleImageId: 'sha256:' + 'ef'.repeat(32) });
    expect(changed.status).toBe(1);
    expect(changed.stderr).toContain('已有节点的镜像版本与发布包不同');
    expect(changed.stdout).not.toContain('部署成功');
    expect(f.log().slice(before.length)).not.toMatch(/^(?:start|run|load|tag|build) /m);
  });

  it('verifies a cached prebuilt image tag before creating a node', () => {
    const f = fixture(), bundleImageId = 'sha256:' + 'cd'.repeat(32);
    f.mark('image-present');
    writeFileSync(join(f.root, 'image-id'), 'sha256:' + 'ef'.repeat(32));
    const wrong = f.execute({ bundleImageId });
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain('同名镜像与发布包版本不一致');
    expect(f.log()).not.toMatch(/^(?:run|volume|load|tag|build) /m);
    expect(existsSync(join(f.root, 'curl.log'))).toBe(false);

    writeFileSync(join(f.root, 'image-id'), bundleImageId);
    const correct = f.execute({ bundleImageId });
    expect(correct.status, correct.stderr).toBe(0);
    expect(correct.stdout).toContain('部署成功');
    expect(f.log().match(/^run /gm)).toHaveLength(1);
    expect(f.log()).not.toMatch(/^(?:load|tag|build) /m);
    expect(existsSync(join(f.root, 'curl.log'))).toBe(false);
  });

  it('downloads, verifies, builds and starts with isolated data, and safely reuses the deployment', () => {
    const f = fixture(), result = f.execute();
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('部署成功');
    expect(readFileSync(f.config, 'utf8')).toBe(options.env);
    expect(f.log()).toContain('build --tag cloud-mail-node:abcd-1234');
    expect(f.log()).toContain('-p 3001:3000 -v cloud-mail-node-abcd-1234-data:/data');
    expect(f.log()).toContain('-e DATA_DIR=/data');
    expect(f.log()).toContain('-e APP_BASE_PATH=');
    expect(f.log()).toContain('health/ready');
    expect(existsSync(join(f.root, 'unexpected'))).toBe(false);
    expect(readFileSync(join(f.root, 'curl.log'), 'utf8')).toContain(options.bundleUrl);
    expect(f.execute().status).toBe(0);
    expect(f.log().match(/^run /gm)).toHaveLength(1);
    expect(f.log().match(/^build /gm)).toHaveLength(1);
    expect(f.log()).toContain('start cloud-mail-node-abcd-1234');
    expect(readFileSync(f.config, 'utf8')).toBe(options.env);
    expect(result.stdout + result.stderr).not.toContain('private-test-value');
  });

  it('refuses to replace existing secrets or take over a foreign container', () => {
    const f = fixture();
    expect(f.execute().status).toBe(0);
    const before = f.log();
    const changed = f.execute({ env: 'NODE_ID=abcd-1234\nNODE_CREDENTIAL=changed\n' });
    expect(changed.status).toBe(1);
    expect(changed.stderr).toContain('原配置和数据未修改');
    expect(readFileSync(f.config, 'utf8')).toBe(options.env);
    expect(f.log()).not.toContain('NODE_CREDENTIAL');
    expect(f.log().slice(before.length)).not.toContain('start ');
    f.mark('foreign-container');
    const foreign = f.execute();
    expect(foreign.status).toBe(1);
    expect(foreign.stderr).toContain('同名容器');
    expect(f.log()).not.toMatch(/\b(?:rm|stop)\b/);
  });

  it('stops before extraction and startup when bundle verification fails', () => {
    const f = fixture(); f.mark('bad-hash');
    const result = f.execute();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('安装包校验失败');
    expect(f.log()).not.toMatch(/^(?:build|run|volume) /m);
    expect(existsSync(join(f.root, 'tar.log'))).toBe(false);
  });

  it('reports incomplete synchronization without claiming success or removing the service', () => {
    const f = fixture(); f.mark('not-ready');
    const result = f.execute();
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain('部署成功');
    expect(result.stderr).toContain('服务和数据已保留');
    expect(f.log().match(/^exec /gm).length).toBeGreaterThan(1);
    expect(f.log().match(/^exec /gm).length).toBeLessThanOrEqual(36);
    expect(f.log()).not.toMatch(/\b(?:rm|stop)\b/);
  });

  it('rejects unsafe identifiers, invalid ports, hashes, and non-HTTP bundle URLs', () => {
    for (const invalid of [{ id: '../another' }, { id: '$(touch danger)' }, { port: 0 }, { port: '3001' },
      { bundleSha256: 'unchecked' }, { bundleUrl: 'file:///tmp/script' }, { bundleUrl: 'https://user:pass@example.com/' },
      { bundleImageId: '' }, { bundleImageId: null }, { bundleImageId: 'sha256:short' },
      { bundleImageId: 'sha256:' + 'AB'.repeat(32) }, { bundleImageId: 'cloud-mail:latest' }]) {
      expect(() => buildNodeInstallScript({ ...options, ...invalid })).toThrow();
    }
  });
});
