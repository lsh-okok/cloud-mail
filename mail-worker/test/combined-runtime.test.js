import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/server/config.js';
import { startLmtpServer } from '../src/server/mail.js';
import { startPolicyServer } from '../src/server/policy.js';
import { startDomainMapServer } from '../src/server/domain-map.js';

const roots = [], servers = [];
const base = { MAIL_DOMAINS: 'example.com', JWT_SECRET: 'combined-runtime-secret-at-least-32-characters' };
const shell = process.platform === 'win32' ? 'bash.exe' : '/bin/sh';
const source = fileURLToPath(new URL('../../docker/app-entrypoint.sh', import.meta.url));

function entrypoint() {
  const root = mkdtempSync(join(tmpdir(), 'cloud-mail-combined-runtime-'));
  roots.push(root);
  mkdirSync(join(root, 'bin'));
  // Redirect image-only absolute commands into the isolated fixture. The shell
  // gate, environment and argument validation remain the production script.
  const script = readFileSync(source, 'utf8')
    .replaceAll('/usr/local/bin/mail-entrypoint', '"$COMBINED_TEST_ROOT/bin/mail-entrypoint"')
    .replaceAll('/usr/bin/supervisord', '"$COMBINED_TEST_ROOT/bin/supervisord"');
  writeFileSync(join(root, 'entrypoint.sh'), script);
  const mock = (name, body) => writeFileSync(join(root, 'bin', name), `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 });
  const recordSmtpAuth = 'printf "%s\\n" "${SMTP_USER-<unset>}" "${SMTP_PASSWORD-<unset>}" > "$COMBINED_TEST_ROOT/smtp-auth"';
  mock('chown', 'printf "chown\\n" >> "$COMBINED_TEST_ROOT/events"');
  mock('gosu', `${recordSmtpAuth}\nprintf "gosu:%s\\n" "$*" >> "$COMBINED_TEST_ROOT/events"`);
  mock('mail-entrypoint', `${recordSmtpAuth}\nprintf 'mail:%s:%s:%s:%s:%s:%s:%s:%s:%s\n' "$*" "$SMTP_HOST" "$SMTP_PORT" "$MAIL_INTERNAL_HOST" "$MAIL_NETWORK_SUBNET" "$LMTP_PORT" "$POLICY_PORT" "$DOMAIN_MAP_PORT" "$MAIL_ENABLED" >> "$COMBINED_TEST_ROOT/events"`);
  mock('supervisord', 'printf "supervisor:%s\\n" "$*" >> "$COMBINED_TEST_ROOT/events"');
  const readEvents = () => existsSync(join(root, 'events')) ? readFileSync(join(root, 'events'), 'utf8').trim().split('\n') : [];
  return {
    root, readEvents,
    readSmtpAuth: () => readFileSync(join(root, 'smtp-auth'), 'utf8').trimEnd().split('\n'),
    run(overrides = {}, args = ['node', 'mail-worker/server-dist/index.cjs']) {
      return spawnSync(shell, ['-c', `export PATH="$PWD/bin:$PATH" COMBINED_TEST_ROOT="$PWD" DATA_DIR="$PWD/data" OBJECTS_DIR="$PWD/data/objects"
exec sh ./entrypoint.sh "$@"`, 'sh', ...args], {
        cwd: root, encoding: 'utf8', timeout: 10000,
        env: { ...process.env, MAIL_ENABLED: '', NODE_ROLE: 'primary', SMTP_TLS_CERT_FILE: '', SMTP_TLS_KEY_FILE: '', ...overrides },
      });
    },
  };
}

afterEach(async () => {
  for (const server of servers.splice(0).reverse()) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  for (const root of roots.splice(0)) {
    if (!resolve(root).startsWith(`${resolve(tmpdir())}${sep}`) || !basename(root).startsWith('cloud-mail-combined-runtime-')) throw new Error('Unexpected runtime fixture root');
    rmSync(root, { recursive: true, force: true });
  }
});

describe('optional combined mail runtime', () => {
  it('requires an explicit true value and forbids mail-enabled read-only replicas', () => {
    expect(loadConfig(base).mail_enabled).toBe(false);
    expect(loadConfig({ ...base, MAIL_ENABLED: 'false' }).mail_enabled).toBe(false);
    expect(loadConfig({ ...base, MAIL_ENABLED: 'true' })).toMatchObject({
      mail_enabled: true, smtp: { host: '127.0.0.1', port: 587 },
      server: { lmtpHost: '127.0.0.1', policyHost: '127.0.0.1', domainMapHost: '127.0.0.1', trustedMailSubnet: '127.0.0.0/8' },
    });
    const externalSmtp = { SMTP_HOST: 'external-submission.example', SMTP_PORT: '465', SMTP_SECURE: 'true',
      SMTP_REQUIRE_TLS: 'true', SMTP_USER: 'external-user', SMTP_PASSWORD: 'external-secret' };
    for (const MAIL_ENABLED of ['', 'false']) {
      expect(loadConfig({ ...base, ...externalSmtp, MAIL_ENABLED }).smtp).toMatchObject({
        host: externalSmtp.SMTP_HOST, port: 465, secure: true, requireTLS: true,
        auth: { user: externalSmtp.SMTP_USER, pass: externalSmtp.SMTP_PASSWORD },
      });
    }
    expect(loadConfig({ ...base, ...externalSmtp, MAIL_ENABLED: 'true' }).smtp).not.toHaveProperty('auth');
    for (const value of ['yes', '1', 'TRUE', 'true\nfalse']) expect(() => loadConfig({ ...base, MAIL_ENABLED: value })).toThrow('MAIL_ENABLED');
    expect(() => loadConfig({ ...base, NODE_ROLE: 'replica', MAIL_ENABLED: 'true' })).toThrow(/replica/i);
    expect(() => loadConfig({ ...base, MAIL_ENABLED: 'true', MAIL_INTERNAL_HOST: '192.0.2.1' })).toThrow('MAIL_INTERNAL_HOST');
  });

  it('binds the actual LMTP, policy and domain-map listeners to loopback in combined mode', async () => {
    const env = loadConfig({ ...base, MAIL_ENABLED: 'true' });
    env.server = { ...env.server, lmtpPort: 0, policyPort: 0, domainMapPort: 0 };
    const lmtp = await startLmtpServer(env); servers.push(lmtp);
    const policy = await startPolicyServer(env); servers.push(policy);
    const domains = await startDomainMapServer(env); servers.push(domains);
    for (const server of [lmtp.server, policy, domains]) {
      expect(server.address()).toMatchObject({ address: '127.0.0.1', family: 'IPv4', port: expect.any(Number) });
      expect(server.address().port).toBeGreaterThan(0);
    }
  });

  it('runs the app as node without certificates or mail setup when mail is disabled or omitted', () => {
    for (const MAIL_ENABLED of ['', 'false']) {
      const f = entrypoint(), result = f.run({ MAIL_ENABLED, SMTP_USER: 'external-user', SMTP_PASSWORD: 'external-secret' });
      expect(result.status, result.stderr).toBe(0);
      expect(f.readEvents()).toEqual(['chown', 'gosu:node node mail-worker/server-dist/index.cjs']);
      expect(f.readSmtpAuth()).toEqual(['external-user', 'external-secret']);
      expect(existsSync(join(f.root, 'data', 'objects'))).toBe(true);
    }
  });

  it('configures the embedded MTA before supervision and overrides unsafe inherited internal endpoints', () => {
    const f = entrypoint();
    const result = f.run({ MAIL_ENABLED: 'true', SMTP_HOST: 'external-submission.example', SMTP_PORT: '465',
      SMTP_USER: 'external-user', SMTP_PASSWORD: 'external-secret',
      MAIL_INTERNAL_HOST: '0.0.0.0', MAIL_NETWORK_SUBNET: '0.0.0.0/0', LMTP_PORT: '1234', POLICY_PORT: '1235', DOMAIN_MAP_PORT: '1236' });
    expect(result.status, result.stderr).toBe(0);
    expect(f.readEvents()).toEqual([
      'chown', 'mail:--configure-only:127.0.0.1:587:127.0.0.1:127.0.0.0/8:2525:10040:10041:true',
      'supervisor:-c /etc/supervisor/supervisord.conf',
    ]);
    expect(f.readSmtpAuth()).toEqual(['<unset>', '<unset>']);
  });

  it('refuses invalid mode, replica enablement and a custom supervised command before starting mail', () => {
    for (const overrides of [{ MAIL_ENABLED: 'yes' }, { MAIL_ENABLED: 'true', NODE_ROLE: 'replica' }]) {
      const f = entrypoint(), result = f.run(overrides);
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/MAIL_ENABLED|replica/i);
      expect(f.readEvents()).toEqual([]);
      expect(existsSync(join(f.root, 'data'))).toBe(false);
    }
    const f = entrypoint(), result = f.run({ MAIL_ENABLED: 'true' }, ['node', 'mail-worker/server-dist/cli.cjs', 'backup']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('standard Cloud Mail server command');
    expect(f.readEvents()).toEqual(['chown']);
  });
});
