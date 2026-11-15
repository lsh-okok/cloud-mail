import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/server/config.js';
import { createEnvironment } from '../src/server/environment.js';
import { createApp } from '../src/server/app.js';
import { acquireDataLock } from '../src/server/lock.js';
import { backupData, restoreData } from '../src/server/backup.js';
import { startScheduler } from '../src/server/scheduler.js';
import userService from '../src/service/user-service.js';
import verifyRecordService from '../src/service/verify-record-service.js';
import emailService from '../src/service/email-service.js';
import oauthService from '../src/service/oauth-service.js';
import analysisService from '../src/service/analysis-service.js';

const directories = [], databases = [], locks = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'cloud-mail-runtime-'));
  directories.push(directory);
  const config = loadConfig({
    MAIL_DOMAINS: 'Example.com,example.com', MAIL_HOST: 'mx.example.com',
    ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'initial-test-password',
    JWT_SECRET: 'a-test-secret-at-least-32-characters-long', APP_URL: 'http://localhost:3000',
    DATA_DIR: join(directory, 'data'), STATIC_DIR: join(directory, 'frontend'),
  });
  const env = await createEnvironment(config);
  await mkdir(config.staticDir);
  databases.push(env.db);
  return { directory, config, env };
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const release of locks.splice(0)) await release();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('server runtime configuration and HTTP entry', () => {
  it('validates deployment configuration before opening the database', () => {
    const base = { MAIL_DOMAINS: 'example.com', JWT_SECRET: 's'.repeat(32) };
    expect(loadConfig(base).domain).toEqual(['example.com']);
    expect(() => loadConfig({ ...base, MAIL_DOMAINS: 'example.com\nrelay_domains = evil.test' })).toThrow();
    expect(() => loadConfig({ ...base, JWT_SECRET: 'short' })).toThrow('JWT_SECRET');
    expect(() => loadConfig({ ...base, JWT_SECRET: ' '.repeat(40) })).toThrow('JWT_SECRET');
    expect(() => loadConfig({ ...base, JWT_SECRET: 'REPLACE_WITH_AT_LEAST_32_RANDOM_CHARACTERS' })).toThrow('JWT_SECRET');
    expect(() => loadConfig({ ...base, ADMIN_EMAIL: 'admin@other.test' })).toThrow('ADMIN_EMAIL');
    expect(() => loadConfig({ ...base, PORT: 'NaN' })).toThrow('PORT');
    expect(() => loadConfig({ ...base, MAX_MESSAGE_BYTES: '-1' })).toThrow('MAX_MESSAGE_BYTES');
  });
  it('serves health, preserves API boundaries, and reads persisted objects', async () => {
    const { env } = await fixture();
    const app = createApp(env);
    const request = (path, init) => app.request(`http://localhost${path}`, init, env);
    expect(await (await request('/api/health')).json()).toMatchObject({ status: 'ok', database: 'sqlite' });
    expect((await request('/api/init/any-secret')).status).toBe(404);
    expect((await request('/api/missing')).status).toBe(200); // Existing API error envelope uses HTTP 200.
    expect((await (await request('/api/missing')).json()).code).toBe(401);
    await env.storage.put('attachments/test.txt', 'persistent attachment', { contentType: 'text/plain' });
    expect(await (await request('/attachments/test.txt')).text()).toBe('persistent attachment');
    expect((await request('/assets/missing.js')).status).toBe(404);
    const site = await (await request('/api/setting/websiteConfig')).json();
    expect(site.code).toBe(200);
    expect(JSON.stringify(site)).not.toContain(env.jwt_secret);
    expect(JSON.stringify(site)).not.toContain('initial-test-password');
  });
  it('uses the actual socket address when proxy trust is disabled', async () => {
    const { env } = await fixture();
    env.trust_proxy = false;
    const response = await createApp(env).request('http://localhost/api/login', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': '203.0.113.77' },
      body: JSON.stringify({ email: env.admin, password: 'initial-test-password' }),
    }, { ...env, remote_address: '198.51.100.44' });
    expect((await response.json()).code).toBe(200);
    expect(env.db.prepare('SELECT active_ip FROM user WHERE email = ?').get(env.admin).active_ip).toBe('198.51.100.44');
  });
});

describe('single process and consistent backup/restore', () => {
  it('refuses a second writer and refuses maintenance while the app holds its lock', async () => {
    const { config, directory } = await fixture();
    const release = await acquireDataLock(config.sqlitePath); locks.push(release);
    await expect(acquireDataLock(config.sqlitePath)).rejects.toThrow('in use');
    await expect(backupData(config, join(directory, 'backup'))).rejects.toThrow('in use');
  });
  it('restores SQLite, sessions, and attachment bytes together without overwriting its source', async () => {
    const { config, directory, env } = await fixture();
    await env.kv.put('auth:test', 'saved-session');
    await env.storage.put('attachments/file.txt', 'saved attachment', { contentType: 'text/plain' });
    env.db.close();
    const backup = join(directory, 'backup');
    await backupData(config, backup);
    expect(JSON.parse(await readFile(join(backup, 'manifest.json'), 'utf8')).format).toBe(1);
    await expect(backupData(config, backup)).rejects.toThrow('already exists');
    const changed = await createEnvironment(config); databases.push(changed.db);
    await changed.kv.put('auth:test', 'changed');
    await changed.storage.put('attachments/file.txt', 'changed attachment');
    changed.db.close();
    await restoreData(config, backup);
    const restored = await createEnvironment(config); databases.push(restored.db);
    expect(await restored.kv.get('auth:test')).toBe('saved-session');
    expect(await (await restored.storage.get('attachments/file.txt')).text()).toBe('saved attachment');
    expect((await readdir(config.dataDir)).some(name => name.includes('.pre-restore-'))).toBe(true);
    await writeFile(join(backup, 'manifest.json'), '{"format":99}');
    await expect(restoreData(config, backup)).rejects.toThrow('Unsupported backup');
    expect(await restored.kv.get('auth:test')).toBe('saved-session');
  });
});

describe('UTC maintenance', () => {
  it('catches up a missed UTC day once and avoids overlapping or repeated jobs', async () => {
    const { env } = await fixture();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-12T09:15:00Z'));
    const reset = vi.spyOn(userService, 'resetDaySendCount').mockResolvedValue();
    vi.spyOn(verifyRecordService, 'clearRecord').mockResolvedValue();
    vi.spyOn(emailService, 'completeReceiveAll').mockResolvedValue();
    const clean = vi.spyOn(emailService, 'autoClean').mockResolvedValue();
    vi.spyOn(oauthService, 'clearNoBindOathUser').mockResolvedValue();
    vi.spyOn(analysisService, 'refreshEchartsCache').mockResolvedValue();
    const scheduler = startScheduler(env);
    try {
      await Promise.all([scheduler.tick(), scheduler.tick()]);
      await scheduler.tick();
      expect(reset).toHaveBeenCalledTimes(1);
      expect(clean).toHaveBeenCalledTimes(1);
      expect(reset).toHaveBeenCalledWith(expect.anything(), true);
      vi.setSystemTime(new Date('2026-11-13T07:15:00Z'));
      await scheduler.tick();
      expect(reset).toHaveBeenCalledTimes(2);
      expect(clean).toHaveBeenCalledTimes(2);
    } finally { await scheduler.close(); }
  });
});
