import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareNodeDeployment } from '../src/modules/nodes/deployment.js';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const installerUrl = 'https://raw.githubusercontent.com/lsh-okok/ok-email-scripts/main/cloud-mail-node/install-node.sh';
const defaultOptions = { primaryUrl: 'https://primary.example.com/mail', port: 3001 };
function execute({ downloadExit = 0, installExit = 0, options = defaultOptions, wrapper = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cloud mail command ')); roots.push(root);
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin', 'curl'), `#!/bin/sh
set -eu
while [ "$#" -gt 0 ]; do
  case "$1" in https://*) printf '%s' "$1" > "$NODE_COMMAND_TEST_ROOT/download-url" ;; esac
  if [ "$1" = -o ]; then shift; node_test_output=$1; fi
  shift
done
cat > "$node_test_output" <<'NODE_TEST_INSTALLER'
printf installed > "$NODE_COMMAND_TEST_ROOT/installed"
printf '%s\\n' "$@" > "$NODE_COMMAND_TEST_ROOT/installed-args"
exit ${installExit}
NODE_TEST_INSTALLER
printf '%s' "$node_test_output" > "$NODE_COMMAND_TEST_ROOT/download-path"
exit ${downloadExit}
`, { mode: 0o755 });
  const deployment = prepareNodeDeployment({}, { id: 'command-test', connectionEnv: 'NODE_ROLE=replica\nNODE_CREDENTIAL=private-test-value\n',
    options });
  writeFileSync(join(root, 'wrapper.sh'), deployment.result.script);
  const shell = process.platform === 'win32' ? 'bash.exe' : '/bin/sh';
  const result = spawnSync(shell, ['-c', `export PATH="$PWD/bin:$PATH" NODE_COMMAND_TEST_ROOT="$PWD"; ${wrapper ? 'sh ./wrapper.sh' : deployment.result.command}`],
    { cwd: root, encoding: 'utf8', timeout: 10000 });
  return { root, result, deployment: deployment.result,
    args: () => readFileSync(join(root, 'installed-args'), 'utf8').trimEnd().split('\n') };
}

describe('deployment bootstrap command', () => {
  it('runs the fully downloaded installer and returns its exit status', () => {
    const { root, result, deployment, args } = execute({ installExit: 23 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(23);
    expect(readFileSync(join(root, 'installed'), 'utf8')).toBe('installed');
    expect(readFileSync(join(root, 'download-url'), 'utf8')).toBe(installerUrl);
    expect(args()).toEqual(['--primary-url', defaultOptions.primaryUrl, '--install-token', expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), '--port', '3001']);
    expect(deployment.command).not.toContain('private-test-value');
    expect(deployment.script).not.toContain('private-test-value');
    expect(deployment.command).toMatch(/^curl -fsSL /);
    expect(deployment.command).toContain("-o 'install-node.sh' && sh 'install-node.sh' ");
    expect(readFileSync(join(root, 'download-path'), 'utf8')).toBe('install-node.sh');
    expect(existsSync(join(root, 'install-node.sh'))).toBe(true);
  });

  it('does not execute a partial download or report success after a network failure', () => {
    const { root, result } = execute({ downloadExit: 7 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(7);
    expect(existsSync(join(root, 'installed'))).toBe(false);
    expect(existsSync(join(root, 'install-node.sh'))).toBe(true);
  });

  it('passes explicit trusted HTTP consent and a custom port to the shared installer', () => {
    const options = { primaryUrl: 'http://192.168.31.111:3000/cloud', port: 13001, allowInsecureHttp: true };
    const { result, args } = execute({ options });
    expect(result.status, result.stderr).toBe(0);
    expect(args()).toEqual(['--primary-url', options.primaryUrl, '--install-token', expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), '--port', '13001', '--allow-insecure-http']);
  });

  it('quotes argument values without evaluating shell substitutions, including through the compatibility wrapper', () => {
    const options = { primaryUrl: "https://primary.example.com/a'$(touch unexpected)", port: 3010 };
    const { root, result, args, deployment } = execute({ options, wrapper: true });
    expect(result.status, result.stderr).toBe(0);
    expect(args()[1]).toBe(options.primaryUrl);
    expect(args()[5]).toBe('3010');
    expect(existsSync(join(root, 'unexpected'))).toBe(false);
    expect(deployment.script).toBe(`#!/bin/sh\nset -eu\n${deployment.command}\n`);
    expect(deployment.localCommand).toMatch(/^sudo sh 'install-node.sh' /);
  });
});
