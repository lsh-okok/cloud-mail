import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { loadConfig } from '../src/server/config.js';
import { createEnvironment } from '../src/server/environment.js';
import { createApp } from '../src/server/app.js';
import jwtUtils from '../src/utils/jwt-utils.js';
import constant from '../src/const/constant.js';
import KvConst from '../src/const/kv-const.js';

const resources = [];
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cloud-mail-batch-mailboxes-'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><html><body>Mailbox application</body></html>');
  const config = loadConfig({
    MAIL_DOMAINS: 'example.com', ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'batch-administrator-password',
    JWT_SECRET: 'batch-test-jwt-secret-at-least-32-characters', DATA_ENCRYPTION_KEY: 'ab'.repeat(32),
    APP_URL: 'https://mail.example.com', DATA_DIR: join(root, 'data'), STATIC_DIR: root,
  });
  const env = await createEnvironment(config);
  env.mailReady = true;
  resources.push({ root, env });
  const app = createApp(env);
  let token, csrf;
  async function api(path, { method = 'GET', data, admin = true, headers = {}, body } = {}) {
    return app.request(`${config.app_url}/api${path}`, {
      method, headers: { 'content-type': 'application/json', 'accept-language': 'en',
        ...(admin && token ? { authorization: token } : {}), ...(admin && csrf ? { 'x-csrf-token': csrf } : {}),
        ...(method === 'GET' || method === 'HEAD' ? {} : { origin: config.app_url }), ...headers },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }), ...(body === undefined ? {} : { body }),
    }, env);
  }
  const login = await (await api('/login', { method: 'POST', admin: false,
    data: { email: config.admin, password: config.admin_password } })).json();
  expect(login.code, login.message).toBe(200);
  token = login.data.token;
  csrf = (await (await api('/admin/session')).json()).data.csrfToken;
  async function success(path, options, status = 200) {
    const response = await api(path, options), payload = await response.json();
    expect(response.status, JSON.stringify(payload)).toBe(status);
    return payload.data;
  }
  const batch = emails => success('/admin/mailboxes/batch', { method: 'POST', data: { emails } });
  const source = data => success('/admin/mailboxes', { method: 'POST', data }, 201);
  const count = table => env.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
  const counts = () => Object.fromEntries(['user', 'account', 'source_mailbox', 'feature_audit', 'sync_event', 'mail_link'].map(table => [table, count(table)]));
  function account(email, values = {}) {
    const userId = values.userId || env.db.prepare('SELECT user_id FROM user WHERE email=?').get(env.admin).user_id;
    return Number(env.db.prepare('INSERT INTO account(email,name,user_id,status,is_del) VALUES(?,?,?,?,?)')
      .run(email, email.split('@')[0], userId, values.status || 0, values.isDel || 0).lastInsertRowid);
  }
  function user(email) {
    return Number(env.db.prepare('INSERT INTO user(email,password,salt) VALUES(?,?,?)').run(email, 'unused', 'unused').lastInsertRowid);
  }
  return { env, api, success, batch, source, counts, count, account, user };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const { root, env } of resources.splice(0)) {
    if (env.db.open) env.db.close();
    if (!resolve(root).startsWith(`${resolve(tmpdir())}${sep}`) || !basename(root).startsWith('cloud-mail-batch-mailboxes-')) {
      throw new Error('Unexpected batch mailbox test directory.');
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe('exact main mailbox lookup', () => {
  it('matches only the normalized full address and combines the email and text filters', async () => {
    const f = await fixture();
    const target = await f.source({ email: 'target@example.com', createLocalAccount: true });
    await f.source({ email: 'prefix-target@example.com', createLocalAccount: true });
    await f.source({ email: 'target-suffix@example.com', createLocalAccount: true });
    const exact = await f.success(`/admin/mailboxes?email=${encodeURIComponent(' TARGET@EXAMPLE.COM ')}`);
    expect(exact.total).toBe(1);
    expect(exact.items.map(item => item.id)).toEqual([target.id]);
    const combined = await f.success(`/admin/mailboxes?email=${encodeURIComponent(target.email)}&q=TARGET`);
    expect(combined.items.map(item => item.id)).toEqual([target.id]);
    const excluded = await f.success(`/admin/mailboxes?email=${encodeURIComponent(target.email)}&q=prefix`);
    expect(excluded).toMatchObject({ items: [], total: 0 });
    const missing = await f.success('/admin/mailboxes?email=missing%40example.com');
    expect(missing).toMatchObject({ items: [], total: 0 });
    const defaultSearch = await f.success('/admin/mailboxes?q=target');
    expect(defaultSearch.total).toBe(3);
    expect(defaultSearch.items).toHaveLength(3);
  });

  it('normalizes an IDNA domain and rejects empty, malformed and overlong email queries', async () => {
    const f = await fixture();
    f.env.domain.push('xn--bcher-kva.example');
    const target = await f.source({ email: 'match@xn--bcher-kva.example', mxDomain: 'xn--bcher-kva.example' });
    const exact = await f.success(`/admin/mailboxes?email=${encodeURIComponent('MATCH@BÜCHER.EXAMPLE')}`);
    expect(exact.total).toBe(1);
    expect(exact.items.map(item => item.id)).toEqual([target.id]);
    for (const email of ['', 'target', 'target@@example.com', 'a..b@example.com', `${'a'.repeat(65)}@example.com`]) {
      const response = await f.api(`/admin/mailboxes?email=${encodeURIComponent(email)}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: 'INVALID_MAILBOX_EMAIL' } });
    }
  });
});

describe('batch local mailbox creation', () => {
  it('creates only administrator mailboxes, isolates validation failures, deduplicates and safely retries', async () => {
    const f = await fixture();
    f.env.db.prepare("UPDATE setting SET min_email_prefix=3,email_prefix_filter='forbidden'").run();
    const before = f.counts();
    const result = await f.batch([' New@example.com ', 'NEW@EXAMPLE.COM', 'invalid', 'short@other.test',
      'forbidden@example.com', 'a@example.com', 'base+tag@example.com', 'base@example.com']);
    expect(result).toMatchObject({ created: 3, existing: 0, failed: 4 });
    expect(result.items.map(item => item.email)).toEqual(['new@example.com', 'invalid', 'short@other.test',
      'forbidden@example.com', 'a@example.com', 'base+tag@example.com', 'base@example.com']);
    expect(result.items.map(item => item.status)).toEqual(['created', 'failed', 'failed', 'failed', 'failed', 'created', 'created']);
    expect(result.items.filter(item => item.status === 'failed').map(item => item.error.code)).toEqual([
      'INVALID_MAILBOX_EMAIL', 'INVALID_MX_DOMAIN', 'PREFIX_BLOCKED', 'PREFIX_TOO_SHORT',
    ]);
    for (const item of result.items.filter(item => item.status === 'created')) {
      expect(item.mailboxId).toEqual(expect.any(String));
      const source = f.env.db.prepare('SELECT * FROM source_mailbox WHERE id=?').get(item.mailboxId);
      const owner = f.env.db.prepare('SELECT user_id,email,status,is_del FROM account WHERE account_id=?').get(source.local_account_id);
      expect(source).toMatchObject({ email: item.email, mx_domain: null, enabled: 1 });
      expect(owner).toEqual({ user_id: 1, email: item.email, status: 0, is_del: 0 });
    }
    expect(f.counts()).toEqual({ ...before, account: before.account + 3, source_mailbox: before.source_mailbox + 3,
      feature_audit: before.feature_audit + 3, sync_event: before.sync_event + 3 });
    const after = f.counts();
    const repeated = await f.batch(['NEW@example.com', 'base+tag@example.com', 'base@example.com']);
    expect(repeated).toMatchObject({ created: 0, existing: 3, failed: 0 });
    expect(repeated.items.map(item => item.mailboxId)).toEqual(result.items.filter(item => item.status === 'created').map(item => item.mailboxId));
    expect(f.counts()).toEqual(after);
  });

  it('associates an existing owned inbox account without creating another account or a user', async () => {
    const f = await fixture(), accountId = f.account('owned@example.com'), before = f.counts();
    const result = await f.batch(['owned@example.com']);
    expect(result).toMatchObject({ created: 1, existing: 0, failed: 0 });
    expect(f.env.db.prepare('SELECT local_account_id FROM source_mailbox WHERE id=?').get(result.items[0].mailboxId))
      .toEqual({ local_account_id: accountId });
    expect(f.counts()).toMatchObject({ user: before.user, account: before.account, source_mailbox: before.source_mailbox + 1 });
  });

  it('leaves existing disabled sources, public identities, scopes and links unchanged and creates no orphan for domain sources', async () => {
    const f = await fixture();
    const local = await f.source({ email: 'owned@example.com', createLocalAccount: true });
    await f.success('/admin/links', { method: 'POST', data: { mailboxId: local.id, recipients: ['owned+child@example.com'] } }, 201);
    await f.success(`/admin/mailboxes/${local.id}`, { method: 'PUT', data: { revision: local.revision, enabled: false } });
    const domain = await f.source({ email: 'domain@example.com', mxDomain: 'example.com' });
    const rows = f.env.db.prepare('SELECT * FROM source_mailbox ORDER BY id').all();
    const links = f.env.db.prepare('SELECT * FROM mail_link').all();
    const before = f.counts();
    const result = await f.batch(['OWNED@example.com', 'domain@example.com']);
    expect(result).toMatchObject({ created: 0, existing: 2, failed: 0 });
    expect(result.items.map(item => item.mailboxId)).toEqual([local.id, domain.id]);
    expect(f.env.db.prepare('SELECT * FROM source_mailbox ORDER BY id').all()).toEqual(rows);
    expect(f.env.db.prepare('SELECT * FROM mail_link').all()).toEqual(links);
    expect(f.env.db.prepare('SELECT * FROM account WHERE email=?').get(domain.email)).toBeUndefined();
    expect(f.counts()).toEqual(before);
  });

  it('rejects foreign, disabled and deleted local accounts even when a main source already exists', async () => {
    const f = await fixture(), otherUser = f.user('other-user@example.com');
    const foreign = f.account('foreign@example.com', { userId: otherUser });
    const disabled = f.account('disabled@example.com'), deleted = f.account('deleted@example.com');
    for (const [email, id] of [['foreign@example.com', foreign], ['disabled@example.com', disabled], ['deleted@example.com', deleted]]) {
      await f.source({ email, localAccountId: id });
    }
    f.env.db.prepare('UPDATE account SET status=1 WHERE account_id=?').run(disabled);
    f.env.db.prepare('UPDATE account SET is_del=1 WHERE account_id=?').run(deleted);
    f.account('foreign-domain@example.com', { userId: otherUser });
    await f.source({ email: 'foreign-domain@example.com', mxDomain: 'example.com' });
    const before = f.counts();
    const result = await f.batch(['foreign@example.com', 'disabled@example.com', 'deleted@example.com', 'foreign-domain@example.com', 'fresh@example.com']);
    expect(result).toMatchObject({ created: 1, existing: 0, failed: 4 });
    expect(result.items.slice(0, 4).every(item => item.status === 'failed' && item.error.code === 'LOCAL_ACCOUNT_UNAVAILABLE')).toBe(true);
    expect(f.counts()).toEqual({ ...before, account: before.account + 1, source_mailbox: before.source_mailbox + 1,
      feature_audit: before.feature_audit + 1, sync_event: before.sync_event + 1 });
  });

  it('rolls back every new account, source, audit and event in a request when an internal write fails', async () => {
    const f = await fixture(), before = f.counts();
    f.env.db.exec(`CREATE TRIGGER fail_batch_audit BEFORE INSERT ON feature_audit
      WHEN (SELECT email FROM source_mailbox WHERE id=NEW.object_id)='fail@example.com'
      BEGIN SELECT RAISE(ABORT,'batch-audit-private-failure'); END;`);
    const response = await f.api('/admin/mailboxes/batch', { method: 'POST', data: { emails: ['first@example.com', 'fail@example.com'] } });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('batch-audit-private-failure');
    expect(f.counts()).toEqual(before);
    expect(f.env.db.prepare("SELECT * FROM account WHERE email IN ('first@example.com','fail@example.com')").all()).toEqual([]);
  });

  it('bounds raw list size, validates structural input before writes and reports bad address strings per item', async () => {
    const f = await fixture(), before = f.counts();
    for (const data of [{}, { emails: null }, { emails: 'one@example.com' }, { emails: [] },
      { emails: ['one@example.com', 1] }, { emails: [null] }, { emails: Array(101).fill('one@example.com') },
      { emails: ['one@example.com'], actorId: 1 }, { emails: ['one@example.com'], createLocalAccount: true }]) {
      expect((await f.api('/admin/mailboxes/batch', { method: 'POST', data })).status).toBe(400);
      expect(f.counts()).toEqual(before);
    }
    expect((await f.api('/admin/mailboxes/batch', { method: 'POST', data: { emails: ['x'.repeat(65536)] } })).status).toBe(413);
    expect((await f.api('/admin/mailboxes/batch', { method: 'POST', body: '{"emails":[]' })).status).toBe(400);
    expect((await f.api('/admin/mailboxes/batch', { method: 'POST', data: { emails: ['one@example.com'] },
      headers: { 'content-type': 'text/plain' } })).status).toBe(415);
    expect(f.counts()).toEqual(before);
    const result = await f.batch(['', 'invalid..prefix@example.com', 'one@example.com']);
    expect(result).toMatchObject({ created: 1, existing: 0, failed: 2 });
    expect(result.items.slice(0, 2).every(item => item.error.code === 'INVALID_MAILBOX_EMAIL')).toBe(true);
  });

  it('accepts the full 100 item request limit while preserving all address results', async () => {
    const f = await fixture(), emails = Array.from({ length: 100 }, (_, index) => `batch${index}@example.com`);
    const result = await f.batch(emails);
    expect(result).toMatchObject({ created: 100, existing: 0, failed: 0 });
    expect(result.items.map(item => item.email)).toEqual(emails);
    expect(f.count('user')).toBe(1);
    expect(f.count('account')).toBe(101);
  });

  it('requires the active site administrator, matching CSRF token, same origin and primary node', async () => {
    const f = await fixture(), data = { emails: ['private@example.com'] }, before = f.counts();
    expect((await f.api('/admin/mailboxes/batch', { method: 'POST', data, admin: false })).status).toBe(401);
    for (const headers of [{ 'x-csrf-token': '' }, { 'x-csrf-token': 'wrong' }, { origin: 'https://evil.example' }]) {
      expect((await f.api('/admin/mailboxes/batch', { method: 'POST', data, headers })).status).toBe(403);
    }
    const userId = f.user('normal@example.com'), sessionToken = 'normal-user-session';
    await f.env.kv.put(KvConst.AUTH_INFO + userId, JSON.stringify({ tokens: [sessionToken] }));
    const token = await jwtUtils.generateToken({ env: f.env }, { userId, token: sessionToken, gen: constant.AUTH_GEN });
    expect((await f.api('/admin/mailboxes/batch', { method: 'POST', data, headers: { authorization: token } })).status).toBe(403);
    f.env.node_role = 'replica';
    expect((await f.api('/admin/mailboxes/batch', { method: 'POST', data })).status).toBe(403);
    f.env.node_role = 'primary';
    f.env.db.prepare('UPDATE user SET status=1 WHERE user_id=1').run();
    expect((await f.api('/admin/mailboxes/batch', { method: 'POST', data })).status).toBe(401);
    expect(f.counts()).toEqual({ ...before, user: before.user + 1 });
  });
});
