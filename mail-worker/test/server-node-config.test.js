import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/server/config.js';
import { createEnvironment } from '../src/server/environment.js';
import { createApp } from '../src/server/app.js';

const roots = [], databases = [];
const base = { JWT_SECRET: 'independent-node-secret-that-is-at-least-32-chars', DATA_ENCRYPTION_KEY: 'ab'.repeat(32),
  NODE_ROLE: 'replica', NODE_PRIMARY_URL: 'https://primary.example.com/mail', NODE_ID: 'test-node', NODE_CREDENTIAL: 'c'.repeat(43) };
async function fixture(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cloud-mail-node-config-')); roots.push(root);
  const config = loadConfig({ ...base, DATA_DIR: root, ...overrides });
  const env = await createEnvironment(config); databases.push(env.db);
  return { env, config, root };
}
afterEach(async () => {
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('node deployment configuration and persistent role isolation', () => {
  it('requires node credentials and independent encryption, and rejects accidental LAN cleartext', () => {
    expect(loadConfig(base)).toMatchObject({ node_role: 'replica', node_primary_url: 'https://primary.example.com/mail', admin: '', admin_password: undefined });
    expect(() => loadConfig({ ...base, DATA_ENCRYPTION_KEY: '' })).toThrow('DATA_ENCRYPTION_KEY');
    expect(() => loadConfig({ ...base, NODE_CREDENTIAL: '' })).toThrow('NODE_CREDENTIAL');
    expect(() => loadConfig({ ...base, NODE_ROLE: 'other' })).toThrow('NODE_ROLE');
    expect(() => loadConfig({ ...base, NODE_PRIMARY_URL: 'http://192.168.31.111:3000' })).toThrow('HTTPS');
    expect(loadConfig({ ...base, NODE_PRIMARY_URL: 'http://192.168.31.111:3000', NODE_ALLOW_INSECURE_HTTP: 'true' }).node_allow_insecure_http).toBe(true);
    expect(loadConfig({ ...base, NODE_PRIMARY_URL: 'http://127.0.0.1:3000' }).node_allow_insecure_http).toBe(false);
    for (const url of ['https://user:pass@example.com', 'https://example.com/?token=secret', 'https://example.com/#fragment']) {
      expect(() => loadConfig({ ...base, NODE_PRIMARY_URL: url })).toThrow('NODE_PRIMARY_URL');
    }
    expect(() => loadConfig({ ...base, VERIFICATION_SMTP_ALLOW_CIDRS: '127.0.0.1/33' })).toThrow('VERIFICATION_SMTP_ALLOW_CIDRS');
    expect(loadConfig({ ...base, VERIFICATION_SMTP_ALLOW_CIDRS: '127.0.0.1,172.30.89.0/24' }).verificationSmtpAllowCidrs).toEqual(['127.0.0.1', '172.30.89.0/24']);
  });
  it('automatically discovers a public IP by default and accepts only a valid optional public address override', () => {
    expect(loadConfig(base).node_public_ip).toBeNull();
    expect(loadConfig({ ...base, NODE_PUBLIC_IP: '3.107.15.37' }).node_public_ip).toBe('3.107.15.37');
    expect(loadConfig({ ...base, NODE_PUBLIC_IP: '2001:4860:4860::8888' }).node_public_ip).toBe('2001:4860:4860::8888');
    for (const value of ['172.17.0.1', '127.0.0.1', '169.254.169.254', '::ffff:10.0.0.1', '2606:4700::1111%eth0', 'public.example.com']) {
      expect(() => loadConfig({ ...base, NODE_PUBLIC_IP: value })).toThrow('NODE_PUBLIC_IP');
    }
  });
  it('does not bootstrap administrator accounts and keeps readiness closed before synchronization', async () => {
    const { env } = await fixture();
    expect(env.db.prepare('SELECT count(*) AS n FROM user').get().n).toBe(0);
    expect(env.db.prepare('SELECT count(*) AS n FROM account').get().n).toBe(0);
    const app = createApp(env);
    const request = path => app.request(`http://localhost${path}`, undefined, { ...env });
    expect((await request('/health/live')).status).toBe(200);
    expect((await request('/health/ready')).status).toBe(503);
    expect((await request('/api/login')).status).toBe(403);
    expect((await request('/api/admin/verification/tasks')).status).toBe(403);
    env.nodeState.ready = true; env.nodeState.lastSuccessAt = Date.now();
    expect((await request('/health/ready')).status).toBe(200);
    env.nodeState.denied = true;
    expect((await request('/health/ready')).status).toBe(503);
  });
  it('refuses to reuse an existing primary database as a replica or reverse a replica role', async () => {
    const { env, root } = await fixture({ NODE_ROLE: 'primary', MAIL_DOMAINS: 'example.com', ADMIN_PASSWORD: 'local-test-password-123' });
    env.db.close();
    await expect(createEnvironment(loadConfig({ ...base, DATA_DIR: root }))).rejects.toThrow('NODE_ROLE');
    const replica = await fixture(); replica.env.db.close();
    await expect(createEnvironment(loadConfig({ ...base, NODE_ROLE: 'primary', MAIL_DOMAINS: 'example.com', DATA_DIR: replica.root }))).rejects.toThrow('NODE_ROLE');
  });
});
