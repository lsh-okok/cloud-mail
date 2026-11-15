import { createHmac } from 'node:crypto';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/server/database.js';
import { BASELINE_SQL } from '../src/server/schema.js';
import { FOUNDATION_SCHEMA } from '../src/modules/shared/schema.js';
import { SOURCE_SCHEMA } from '../src/modules/mail-sources/schema.js';
import { LINK_SCHEMA } from '../src/modules/links/schema.js';
import { DOMAIN_SCHEMA } from '../src/modules/domains/schema.js';
import { configureFeatureRouter } from '../src/modules/shared/security.js';
import { activeDomains, knownDomains, normalizeDomain, initializeDomains, listDomains,
  createDomain, updateDomain, mountDomainRoutes } from '../src/modules/domains/service.js';

const databases = [];
function fixture({ domains = ['example.com'], legacy = false } = {}) {
  const db = createDatabase(':memory:'); databases.push(db);
  db.exec(BASELINE_SQL); db.exec(FOUNDATION_SCHEMA); db.exec(SOURCE_SCHEMA); db.exec(LINK_SCHEMA);
  if (!legacy) db.exec(DOMAIN_SCHEMA);
  const actorId = Number(db.prepare("INSERT INTO user(email,password,salt) VALUES('admin@example.com','fixture','fixture')").run().lastInsertRowid);
  const env = { db, domain: domains, admin: 'admin@example.com', jwt_secret: 'domain-test-secret-with-at-least-32-characters', app_url: 'https://mail.example.com' };
  if (!legacy) initializeDomains(env);
  return { env, db, actorId };
}

function jwt(env, userId) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ userId, token: 'domain-session', gen: 1 })).toString('base64url');
  const signature = createHmac('sha256', env.jwt_secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

async function apiFixture() {
  const f = fixture();
  f.env.kv = { get: async () => ({ tokens: ['domain-session'] }) };
  const app = mountDomainRoutes(configureFeatureRouter(new Hono()));
  const token = jwt(f.env, f.actorId);
  const session = await app.request(`${f.env.app_url}/admin/session`, { headers: { authorization: token } }, f.env);
  const csrf = (await session.json()).data.csrfToken;
  const api = (path, { method = 'GET', data, headers = {} } = {}) => app.request(`${f.env.app_url}${path}`, {
    method, headers: { 'content-type': 'application/json', authorization: token, 'x-csrf-token': csrf, origin: f.env.app_url, ...headers },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  }, f.env);
  return { ...f, api };
}

afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close(); });

describe('administrator receiving domains', () => {
  it('seeds normalized domains once, deduplicates IDN names and puts the configured default first', () => {
    const { env, db } = fixture({ domains: [' Z.Example.com ', 'BÜCHER.example', 'z.example.com', 'xn--bcher-kva.example', 'a.example.com'] });
    expect(activeDomains(env)).toEqual(['z.example.com', 'a.example.com', 'xn--bcher-kva.example']);
    expect(listDomains(env)).toMatchObject({ defaultDomain: 'z.example.com', items: [
      { domain: 'z.example.com', isDefault: true }, { domain: 'a.example.com', isDefault: false }, { domain: 'xn--bcher-kva.example', isDefault: false },
    ] });
    expect(db.prepare('SELECT count(*) AS n FROM feature_audit').get().n).toBe(0);
  });

  it('uses persisted domains after restart even when the original environment changes', () => {
    const { env } = fixture();
    createDomain(env, { domain: 'public.example' });
    updateDomain(env, 'public.example', { isDefault: true });
    updateDomain(env, 'example.com', { enabled: false });
    env.domain = ['different.example'];
    expect(initializeDomains(env)).toEqual(['public.example']);
    expect(activeDomains(env)).toEqual(['public.example']);
    expect(knownDomains(env)).toEqual(['public.example', 'example.com']);
    env.domain = null;
    expect(initializeDomains(env)).toEqual(['public.example']);
  });

  it('creates a normalized enabled domain and records only bounded domain audit metadata', () => {
    const { env, db, actorId } = fixture();
    const created = createDomain(env, { domain: ' BÜCHER.example ' }, { actorId, requestId: 'domain-request' });
    expect(created).toMatchObject({ domain: 'xn--bcher-kva.example', enabled: true, isDefault: false, accountCount: 0, mailboxCount: 0 });
    expect(created.createdAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(db.prepare('SELECT actor_id,action,object_type,object_id,request_id FROM feature_audit').get())
      .toEqual({ actor_id: actorId, action: 'domain.create', object_type: 'domain', object_id: 'xn--bcher-kva.example', request_id: 'domain-request' });
    for (const domain of ['BÜCHER.example', 'XN--BCHER-KVA.EXAMPLE']) {
      expect(() => createDomain(env, { domain })).toThrow(expect.objectContaining({ status: 409, code: 'DOMAIN_EXISTS' }));
    }
    expect(db.prepare('SELECT count(*) AS n FROM feature_audit').get().n).toBe(1);
  });

  it.each(['', null, 123, 'user@example.com', 'https://example.com', 'example.com/path', 'example.com:25', '*.example.com',
    '127.0.0.1', '127.1', '2130706433', '[::1]', '::1', 'localhost', '.example.com', 'example.com.', 'a..example', '-a.example',
    'a-.example', 'under_score.example', 'a b.example', 'a\\b.example', 'a.example?x', 'a.example#x', 'a\u0000.example', '%65xample.com',
    `${'a'.repeat(64)}.example`, `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}`])
  ('rejects invalid domain %j', domain => {
    expect(() => normalizeDomain(domain)).toThrow(expect.objectContaining({ status: 400, code: 'INVALID_DOMAIN' }));
  });

  it('caps all stored domains at 100, including disabled domains', () => {
    const { env, db } = fixture({ domains: Array.from({ length: 100 }, (_, i) => `d${i}.example`) });
    updateDomain(env, 'd1.example', { enabled: false });
    expect(() => createDomain(env, { domain: 'overflow.example' })).toThrow(expect.objectContaining({ status: 409, code: 'DOMAIN_LIMIT' }));
    expect(db.prepare('SELECT count(*) AS n FROM mail_domain').get().n).toBe(100);
    expect(activeDomains(env)).toHaveLength(99);
    expect(knownDomains(env)).toHaveLength(100);
  });

  it('rejects excessive or invalid initial configuration without seeding a partial table', () => {
    const { env, db } = fixture({ legacy: true }); db.exec(DOMAIN_SCHEMA);
    env.domain = ['example.com', 'bad@domain.example'];
    expect(() => initializeDomains(env)).toThrow(expect.objectContaining({ code: 'INVALID_DOMAIN' }));
    expect(db.prepare('SELECT count(*) AS n FROM mail_domain').get().n).toBe(0);
    env.domain = Array.from({ length: 101 }, (_, i) => `d${i}.example`);
    expect(() => initializeDomains(env)).toThrow(expect.objectContaining({ code: 'DOMAIN_LIMIT' }));
    expect(db.prepare('SELECT count(*) AS n FROM mail_domain').get().n).toBe(0);
  });

  it('switches defaults atomically and requires an enabled default to remain', () => {
    const { env, db } = fixture({ domains: ['example.com', 'new.example'] });
    for (const data of [{ enabled: false }, { isDefault: false }, { enabled: false, isDefault: false }]) {
      expect(() => updateDomain(env, 'example.com', data)).toThrow(expect.objectContaining({ status: 409 }));
    }
    updateDomain(env, 'new.example', { enabled: false });
    expect(() => updateDomain(env, 'new.example', { isDefault: true })).toThrow(expect.objectContaining({ status: 409 }));
    expect(updateDomain(env, 'NEW.EXAMPLE', { enabled: true, isDefault: true })).toMatchObject({ enabled: true, isDefault: true });
    expect(activeDomains(env)).toEqual(['new.example', 'example.com']);
    expect(db.prepare('SELECT count(*) AS n FROM mail_domain WHERE is_default=1').get().n).toBe(1);
    updateDomain(env, 'example.com', { enabled: false });
    expect(activeDomains(env)).toEqual(['new.example']);
    expect(() => updateDomain(env, 'new.example', { enabled: false })).toThrow(expect.objectContaining({ status: 409 }));
  });

  it('preserves existing identities and links when disabling a domain and reports exact historical usage counts', () => {
    const { env, db, actorId } = fixture({ domains: ['example.com', 'new.example'] });
    const account = Number(db.prepare("INSERT INTO account(email,user_id,status,is_del) VALUES('Local@EXAMPLE.COM',?,1,1)").run(actorId).lastInsertRowid);
    db.prepare("INSERT INTO account(email,user_id) VALUES('other@sub.example.com',?)").run(actorId);
    db.prepare(`INSERT INTO source_mailbox(id,email,provider,public_id,local_account_id,created_at,updated_at)
      VALUES('old-mailbox','Local@EXAMPLE.COM','mx','public0001',?,123,456)`).run(account);
    db.prepare(`INSERT INTO mail_link(id,mailbox_id,recipient,token_digest,token_encrypted,created_at)
      VALUES('old-link','old-mailbox','child@example.com','digest','ciphertext',789)`).run();
    const tables = ['user', 'account', 'source_mailbox', 'mail_link'];
    const before = Object.fromEntries(tables.map(table => [table, db.prepare(`SELECT * FROM ${table}`).all()]));
    updateDomain(env, 'new.example', { isDefault: true });
    const result = updateDomain(env, 'example.com', { enabled: false });
    expect(result).toMatchObject({ enabled: false, accountCount: 1, mailboxCount: 1 });
    expect(activeDomains(env)).toEqual(['new.example']);
    expect(knownDomains(env)).toContain('example.com');
    for (const table of tables) expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual(before[table]);
  });

  it('rolls back both creation and a default switch if audit persistence fails', () => {
    const { env, db } = fixture({ domains: ['example.com', 'new.example'] });
    const before = listDomains(env);
    db.exec("CREATE TRIGGER block_domain_audit BEFORE INSERT ON feature_audit BEGIN SELECT RAISE(ABORT,'domain audit failure'); END");
    expect(() => createDomain(env, { domain: 'third.example' })).toThrow('domain audit failure');
    expect(() => updateDomain(env, 'new.example', { isDefault: true })).toThrow('domain audit failure');
    expect(listDomains(env)).toEqual(before);
    expect(db.prepare('SELECT count(*) AS n FROM feature_audit').get().n).toBe(0);
  });

  it('falls back only for legacy databases and never hides database errors or an empty authoritative table', () => {
    const { env, db } = fixture({ domains: JSON.stringify([' Z.Example.com ', 'a.example']), legacy: true });
    expect(activeDomains(env)).toEqual(['z.example.com', 'a.example']);
    expect(knownDomains(env)).toEqual(['z.example.com', 'a.example']);
    db.exec(DOMAIN_SCHEMA);
    expect(activeDomains(env)).toEqual([]);
    expect(knownDomains(env)).toEqual([]);
    db.close();
    expect(() => activeDomains(env)).toThrow();
    expect(() => knownDomains(env)).toThrow();
  });

  it('refuses direct administration on replicas', () => {
    const { env } = fixture(); env.node_role = 'replica';
    for (const operation of [() => listDomains(env), () => createDomain(env, { domain: 'new.example' }), () => updateDomain(env, 'example.com', { enabled: true })]) {
      expect(operation).toThrow(expect.objectContaining({ status: 403, code: 'PRIMARY_ONLY' }));
    }
    expect(knownDomains(env)).toEqual(['example.com']);
  });

  it('exposes the management API behind administrator auth and CSRF with strict bodies and no delete or rename', async () => {
    const { api, db, env } = await apiFixture();
    expect((await api('/admin/domains')).status).toBe(200);
    for (const headers of [{ authorization: '' }, { 'x-csrf-token': '' }, { origin: 'https://evil.example' }]) {
      const response = await api('/admin/domains', { method: 'POST', data: { domain: 'public.example' }, headers });
      expect(response.status).toBe(headers.authorization === '' ? 401 : 403);
    }
    const normalId = Number(db.prepare("INSERT INTO user(email,password,salt) VALUES('user@example.com','fixture','fixture')").run().lastInsertRowid);
    expect((await api('/admin/domains', { headers: { authorization: jwt(env, normalId) } })).status).toBe(403);
    const created = await api('/admin/domains', { method: 'POST', data: { domain: 'Public.Example' } });
    expect(created.status).toBe(201);
    expect((await created.json()).data).toMatchObject({ domain: 'public.example', enabled: true });
    const updated = await api('/admin/domains/public.example', { method: 'PUT', data: { isDefault: true } });
    expect(updated.status).toBe(200);
    expect((await updated.json()).data.isDefault).toBe(true);
    expect((await api('/admin/domains/public.example', { method: 'PUT', data: { domain: 'renamed.example' } })).status).toBe(400);
    for (const data of [{}, { enabled: 0 }, { isDefault: 'true' }]) {
      expect((await api('/admin/domains/public.example', { method: 'PUT', data })).status).toBe(400);
    }
    expect((await api('/admin/domains/missing.example', { method: 'PUT', data: { enabled: false } })).status).toBe(404);
    expect((await api('/admin/domains/public.example', { method: 'DELETE' })).status).toBe(404);
    expect(db.prepare('SELECT count(*) AS n FROM mail_domain').get().n).toBe(2);
  });
});
