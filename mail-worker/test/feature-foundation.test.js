import { afterEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { createDatabase } from '../src/server/database.js';
import { BASELINE_SQL } from '../src/server/schema.js';
import { createKV } from '../src/server/kv.js';
import jwtUtils from '../src/utils/jwt-utils.js';
import constant from '../src/const/constant.js';
import KvConst from '../src/const/kv-const.js';
import { FOUNDATION_SCHEMA } from '../src/modules/shared/schema.js';
import { configureFeatureRouter } from '../src/modules/shared/security.js';
import { mountSettingsRoutes } from '../src/modules/shared/settings.js';
import { FeatureError, strictJson } from '../src/modules/shared/errors.js';
import { createSecretVault } from '../src/modules/shared/secrets.js';

const databases = [];
async function fixture() {
  const db = createDatabase(':memory:');
  databases.push(db);
  db.exec(BASELINE_SQL);
  db.exec(FOUNDATION_SCHEMA);
  db.exec('CREATE TABLE server_kv(key TEXT PRIMARY KEY,value BLOB NOT NULL,metadata TEXT,expiration INTEGER);');
  db.exec(`CREATE TABLE sync_event(cursor INTEGER PRIMARY KEY AUTOINCREMENT,object_type TEXT,object_id TEXT,revision INTEGER,payload_json TEXT,created_at INTEGER);`);
  const env = { db, kv: createKV(db), admin: 'admin@example.com', app_url: 'https://mail.example.com', jwt_secret: 'test-jwt-secret-with-at-least-32-characters' };
  db.prepare('INSERT INTO user(user_id,email,password,salt) VALUES (?,?,?,?)').run(1, env.admin, 'unused', 'unused');
  db.prepare('INSERT INTO user(user_id,email,password,salt) VALUES (?,?,?,?)').run(2, 'user@example.com', 'unused', 'unused');
  const router = mountSettingsRoutes(configureFeatureRouter(new Hono()));
  router.post('/admin/json', async c => c.json({ data: await strictJson(c, ['value'], { maxBytes: 100 }) }));
  router.get('/admin/crash', () => { throw new Error('SENSITIVE-DO-NOT-EXPOSE'); });
  router.get('/public/failure', () => { throw new FeatureError(410, 'EXPIRED', 'This link has expired.'); });
  async function issue(userId = 1) {
    const sessionToken = `test-session-${userId}`;
    await env.kv.put(KvConst.AUTH_INFO + userId, JSON.stringify({ tokens: [sessionToken], user: { userId, email: userId === 1 ? env.admin : 'user@example.com' } }));
    const jwt = await jwtUtils.generateToken({ env }, { userId, token: sessionToken, gen: constant.AUTH_GEN });
    const response = await router.request('https://mail.example.com/admin/session', { headers: { authorization: jwt } }, env);
    const body = await response.json();
    return { jwt, csrf: body.data?.csrfToken };
  }
  function request(path, { jwt, csrf, method = 'GET', data, headers = {}, body } = {}) {
    return router.request(`https://mail.example.com${path}`, {
      method, headers: { ...(jwt ? { authorization: jwt } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}),
        ...(data === undefined && body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }), ...(body === undefined ? {} : { body }),
    }, env);
  }
  return { db, env, issue, request };
}

afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close(); });

describe('feature administrator boundary', () => {
  it('rejects guests, ordinary users, revoked sessions and cached administrators disabled in the database', async () => {
    const { db, env, issue, request } = await fixture();
    expect((await request('/admin/settings')).status).toBe(401);
    const regular = await issue(2);
    expect((await request('/admin/settings', regular)).status).toBe(403);
    const admin = await issue();
    expect((await request('/admin/settings', admin)).status).toBe(200);
    db.prepare('UPDATE user SET status = 1 WHERE user_id = 1').run();
    expect((await request('/admin/settings', admin)).status).toBe(401);
    db.prepare('UPDATE user SET status = 0 WHERE user_id = 1').run();
    await env.kv.delete(KvConst.AUTH_INFO + 1);
    expect((await request('/admin/settings', admin)).status).toBe(401);
  });

  it('requires the matching session CSRF token and rejects cross-site origin and fetch metadata', async () => {
    const { issue, request, env } = await fixture();
    const admin = await issue();
    const data = { publicBaseUrl: 'https://public.example.com/mail', timeZone: 'Asia/Shanghai', revision: 1 };
    expect((await request('/admin/settings', { jwt: admin.jwt, method: 'PUT', data })).status).toBe(403);
    expect((await request('/admin/settings', { ...admin, csrf: 'wrong-token', method: 'PUT', data })).status).toBe(403);
    expect((await request('/admin/settings', { ...admin, method: 'PUT', data, headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await request('/admin/settings', { ...admin, method: 'PUT', data, headers: { 'sec-fetch-site': 'same-site' } })).status).toBe(403);
    env.nodeRole = 'replica';
    expect((await request('/admin/settings', admin)).status).toBe(403);
    env.nodeRole = 'primary';
    const saved = await request('/admin/settings', { ...admin, method: 'PUT', data, headers: { origin: env.app_url, 'sec-fetch-site': 'same-origin' } });
    expect(saved.status).toBe(200);
    expect(saved.headers.get('cache-control')).toBe('no-store');
    expect(saved.headers.get('access-control-allow-origin')).toBeNull();
    expect(await saved.json()).toMatchObject({ data: { publicBaseUrl: data.publicBaseUrl, revision: 2 } });
  });

  it('returns real status codes and hides unexpected failures and sensitive details', async () => {
    const { issue, request } = await fixture();
    const admin = await issue();
    const crash = await request('/admin/crash', admin);
    expect(crash.status).toBe(500);
    expect(await crash.text()).not.toContain('SENSITIVE');
    const expired = await request('/public/failure');
    expect(expired.status).toBe(410);
    expect(await expired.json()).toMatchObject({ error: { code: 'EXPIRED', requestId: expect.any(String) } });
    expect((await request('/admin/missing', admin)).status).toBe(404);
  });
});

describe('feature settings and bounded input', () => {
  it('atomically writes settings, audit and sync event and rejects stale forms without partial updates', async () => {
    const { db, issue, request } = await fixture();
    const admin = await issue();
    const data = { publicBaseUrl: 'https://public.example.com/mail/', timeZone: 'Asia/Shanghai', revision: 1 };
    expect((await request('/admin/settings', { ...admin, method: 'PUT', data })).status).toBe(200);
    expect((await request('/admin/settings', { ...admin, method: 'PUT', data: { ...data, timeZone: 'UTC' } })).status).toBe(409);
    expect(db.prepare('SELECT time_zone, revision FROM feature_settings').get()).toEqual({ time_zone: 'Asia/Shanghai', revision: 2 });
    expect(db.prepare('SELECT count(*) count FROM feature_audit').get().count).toBe(1);
    expect(db.prepare('SELECT count(*) count FROM sync_event').get().count).toBe(1);
    db.exec(`CREATE TRIGGER reject_audit BEFORE INSERT ON feature_audit BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);
    expect((await request('/admin/settings', { ...admin, method: 'PUT', data: { ...data, revision: 2 } })).status).toBe(500);
    expect(db.prepare('SELECT revision FROM feature_settings').get().revision).toBe(2);
    expect(db.prepare('SELECT count(*) count FROM sync_event').get().count).toBe(1);
  });

  it('rejects unsupported fields, invalid JSON, oversized bodies, unsafe URLs and invalid time zones', async () => {
    const { issue, request } = await fixture();
    const admin = await issue();
    const data = { publicBaseUrl: 'https://public.example.com/mail', timeZone: 'Asia/Shanghai', revision: 1 };
    for (const invalid of [
      { ...data, extra: 'ignored would be unsafe' },
      { ...data, publicBaseUrl: 'https://user:secret@public.example.com' },
      { ...data, publicBaseUrl: 'http://public.example.com' },
      { ...data, publicBaseUrl: 'https://public.example.com/?secret=value' },
      { ...data, timeZone: 'Invalid/Timezone' },
      { ...data, revision: 0 },
    ]) expect((await request('/admin/settings', { ...admin, method: 'PUT', data: invalid })).status).toBe(400);
    expect((await request('/admin/json', { ...admin, method: 'POST', body: '{"value":1}garbage' })).status).toBe(400);
    expect((await request('/admin/json', { ...admin, method: 'POST', body: '[]' })).status).toBe(400);
    expect((await request('/admin/json', { ...admin, method: 'POST', data: { value: 'x'.repeat(100) } })).status).toBe(413);
    expect((await request('/admin/json', { ...admin, method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415);
  });
});

describe('authenticated credential vault', () => {
  it('encrypts credentials with object binding, rejects tampering and supports controlled key rotation', () => {
    const oldKey = '11'.repeat(32), newKey = '22'.repeat(32);
    const original = createSecretVault({ old: oldKey });
    const aad = 'source-mailbox:source-1:credentials';
    const encrypted = original.encrypt('private-provider-credential', aad);
    expect(encrypted).not.toContain('private-provider-credential');
    expect(original.decrypt(encrypted, aad)).toBe('private-provider-credential');
    expect(() => original.decrypt(encrypted, 'source-mailbox:source-2:credentials')).toThrow('protected credential');
    const changed = JSON.parse(encrypted);
    changed.ciphertext = (changed.ciphertext[0] === 'A' ? 'B' : 'A') + changed.ciphertext.slice(1);
    expect(() => original.decrypt(JSON.stringify(changed), aad)).toThrow('protected credential');
    const rotated = createSecretVault({ old: oldKey, next: newKey }, { activeKeyId: 'next' });
    expect(rotated.decrypt(encrypted, aad)).toBe('private-provider-credential');
    const replacement = rotated.encrypt(rotated.decrypt(encrypted, aad), aad);
    expect(JSON.parse(replacement).keyId).toBe('next');
    expect(createSecretVault({ next: newKey }).decrypt(replacement, aad)).toBe('private-provider-credential');
    expect(() => createSecretVault({ next: newKey }).decrypt(encrypted, aad)).toThrow('protected credential');
    expect(rotated.digest('code', 'card-lookup', 'old')).toBe(original.digest('code', 'card-lookup'));
    expect(rotated.digest('code', 'node-lookup', 'old')).not.toBe(original.digest('code', 'card-lookup'));
  });

  it('requires valid independent data keys without making existing applications require one', () => {
    expect(createSecretVault(undefined)).toBeNull();
    expect(createSecretVault({})).toBeNull();
    expect(() => createSecretVault({ v1: 'short' })).toThrow('32 bytes');
    expect(() => createSecretVault({ v1: '11'.repeat(32) }, { activeKeyId: 'missing' })).toThrow('active data key');
  });
});
