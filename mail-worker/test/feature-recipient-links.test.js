import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { loadConfig } from '../src/server/config.js';
import { createEnvironment } from '../src/server/environment.js';
import { createApp } from '../src/server/app.js';
import * as sourceService from '../src/modules/mail-sources/service.js';

const resources = [];
async function fixture({ prefix = '' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cloud-mail-recipient-links-'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><html><body>Recipient application</body></html>');
  const config = loadConfig({
    MAIL_DOMAINS: 'example.com', ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'recipient-administrator-password',
    JWT_SECRET: 'recipient-test-jwt-secret-at-least-32-characters', DATA_ENCRYPTION_KEY: 'ab'.repeat(32),
    APP_URL: 'https://mail.example.com', APP_BASE_PATH: prefix, DATA_DIR: join(root, 'data'), STATIC_DIR: root,
  });
  const env = await createEnvironment(config);
  env.mailReady = true;
  resources.push({ root, env });
  const app = createApp(env);
  let token, csrf;
  async function api(path, { method = 'GET', data, admin = true } = {}) {
    return app.request(`https://mail.example.com${prefix}/api${path}`, {
      method, headers: { 'content-type': 'application/json', 'accept-language': 'en',
        ...(admin && token ? { authorization: token } : {}), ...(admin && csrf ? { 'x-csrf-token': csrf } : {}),
        ...(method === 'GET' || method === 'HEAD' ? {} : { origin: 'https://mail.example.com' }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    }, env);
  }
  const login = await (await api('/login', { method: 'POST', admin: false, data: { email: config.admin, password: config.admin_password } })).json();
  expect(login.code, login.message).toBe(200);
  token = login.data.token;
  const session = await api('/admin/session');
  expect(session.status).toBe(200);
  csrf = (await session.json()).data.csrfToken;
  async function success(path, options, status = 200) {
    const response = await api(path, options), body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(status);
    return body.data;
  }
  async function source(data = {}) {
    return success('/admin/mailboxes', { method: 'POST', data: { email: 'a@example.com', provider: 'mx', mxDomain: 'example.com', ...data } }, 201);
  }
  async function links(mailboxId, recipients, data = {}) {
    return success('/admin/links', { method: 'POST', data: { mailboxId, recipients, ...data } }, 201);
  }
  function message(recipient, subject, { from = 'sender@shop.example', headerTo = recipient, text = subject, accountId } = {}) {
    const account = env.db.prepare('SELECT account_id,user_id FROM account WHERE email=?').get(env.admin);
    return Number(env.db.prepare(`INSERT INTO email(user_id,account_id,to_email,recipient,send_email,subject,text,type,is_del)
      VALUES(?,?,?,?,?,?,?,0,0)`).run(account.user_id, accountId || account.account_id, recipient, JSON.stringify([{ address: headerTo }]), from, subject, text).lastInsertRowid);
  }
  function raw(url, init) { return app.request(url, init, env); }
  async function mail(link, search = '?limit=1') {
    const response = await raw(link.jsonUrl + search);
    return { response, body: await response.json() };
  }
  return { root, env, app, api, success, source, links, message, raw, mail, prefix };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const { root, env } of resources.splice(0)) {
    if (env.db.open) env.db.close();
    if (!resolve(root).startsWith(`${resolve(tmpdir())}${sep}`) || !basename(root).startsWith('cloud-mail-recipient-links-')) throw new Error('Unexpected recipient test directory.');
    rmSync(root, { recursive: true, force: true });
  }
});

it('creates an inbox account and main source atomically through prefix and domain input', async () => {
  const { env, success, api } = await fixture();
  expect(await success('/admin/mailboxes/domains')).toEqual({ domains: ['example.com'], minEmailPrefix: 1 });
  const source = await success('/admin/mailboxes', { method: 'POST', data: {
    email: 'new-main@example.com', provider: 'mx', createLocalAccount: true,
  } }, 201);
  const account = env.db.prepare('SELECT * FROM account WHERE email=?').get('new-main@example.com');
  expect(account).toMatchObject({ account_id: source.localAccountId, user_id: 1, status: 0, is_del: 0 });
  expect(source.mxDomain).toBeNull();
  const response = await api('/admin/mailboxes', { method: 'POST', data: { email: source.email, createLocalAccount: true } });
  expect(response.status).toBe(409);
  expect(env.db.prepare('SELECT count(*) AS n FROM account WHERE email=?').get(source.email).n).toBe(1);
  const before = env.db.prepare('SELECT count(*) AS n FROM account').get().n;
  const bad = await api('/admin/mailboxes', { method: 'POST', data: { email: 'partial@example.com', provider: 'outlook', createLocalAccount: true } });
  expect(bad.status).toBe(400);
  expect(env.db.prepare('SELECT count(*) AS n FROM account').get().n).toBe(before);
  env.db.prepare("UPDATE setting SET min_email_prefix=5,email_prefix_filter='forbidden'").run();
  for (const email of ['abc@example.com', 'forbidden-address@example.com', 'main@other.test', 'unowned+tag@example.com']) {
    expect((await api('/admin/mailboxes', { method: 'POST', data: { email, createLocalAccount: true } })).status).toBeGreaterThanOrEqual(400);
  }
  expect(env.db.prepare('SELECT count(*) AS n FROM account').get().n).toBe(before);
});

describe('one main mailbox and independent child recipient links', () => {
  it('delivers only the child envelope recipient even when all messages share one account and headers are forged', async () => {
    const f = await fixture(), source = await f.source();
    const created = await f.links(source.id, ['a1@example.com', 'a2@example.com', 'a3@example.com']);
    const originals = created.items;
    f.message('a1@example.com', 'a1-secret');
    f.message('a2@example.com', 'a2-secret', { headerTo: 'a1@example.com' });
    f.message('a3@example.com', 'a3-secret', { headerTo: 'a1@example.com' });
    f.message('a11@example.com', 'similar-address-secret', { headerTo: 'a1@example.com' });
    for (const link of originals) {
      const { response, body } = await f.mail(link);
      expect(response.status, JSON.stringify(body)).toBe(200);
      expect(body.data.recipient).toBe(link.recipient);
      expect(body.data.items).toHaveLength(1);
      expect(body.data.items[0].subject).toBe(`${link.recipient.split('@')[0]}-secret`);
      expect(JSON.stringify(body)).not.toContain('similar-address-secret');
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(new Set(originals.map(link => link.pageUrl)).size).toBe(3);
    expect(new Set(originals.map(link => link.mailboxId))).toEqual(new Set([source.id]));
  });

  it('keeps plus recipients isolated from their base mailbox and from another plus suffix', async () => {
    const f = await fixture(), source = await f.source();
    const { items } = await f.links(source.id, ['base@example.com', 'base+x@example.com', 'base+y@example.com']);
    for (const link of items) f.message(link.recipient, `private-${link.recipient}`);
    for (const link of items) {
      const { response, body } = await f.mail(link);
      expect(response.status).toBe(200);
      expect(body.data.items.map(message => message.subject)).toEqual([`private-${link.recipient}`]);
    }
  });

  it('distinguishes a main account scope from an entire domain while excluding main and sibling messages', async () => {
    const f = await fixture(), domainSource = await f.source();
    const main = f.env.db.prepare('SELECT account_id,user_id FROM account WHERE email=?').get(f.env.admin);
    const otherId = Number(f.env.db.prepare('INSERT INTO account(email,name,user_id) VALUES(?,?,?)')
      .run('other@example.com', 'Other local mailbox', main.user_id).lastInsertRowid);
    const accountSource = (await f.success(`/admin/mailboxes?email=${encodeURIComponent(f.env.admin)}`)).items[0];
    expect(accountSource).toMatchObject({ localAccountId: main.account_id, mxDomain: null });
    const domainLink = (await f.links(domainSource.id, ['a1@example.com'])).items[0];
    const accountLink = (await f.links(accountSource.id, ['a1@example.com'])).items[0];
    f.message('a1@example.com', 'child-delivered-to-main-A', { accountId: main.account_id });
    f.message('a1@example.com', 'same-child-in-other-storage-account', { accountId: otherId });
    f.message(f.env.admin, 'parent-private-message', { accountId: main.account_id });
    f.message('a2@example.com', 'sibling-private-message', { accountId: main.account_id });
    expect((await f.mail(accountLink)).body.data.items.map(item => item.subject)).toEqual(['child-delivered-to-main-A']);
    expect((await f.mail(domainLink)).body.data.items.map(item => item.subject)).toEqual(['same-child-in-other-storage-account']);
    for (const link of [domainLink, accountLink]) {
      const result = JSON.stringify((await f.mail(link)).body);
      expect(result).not.toContain('parent-private-message');
      expect(result).not.toContain('sibling-private-message');
    }
  });

  it('checks underlying local account and user status even when a prior public result is cached', async () => {
    const f = await fixture();
    const main = f.env.db.prepare('SELECT account_id,user_id FROM account WHERE email=?').get(f.env.admin);
    const source = (await f.success(`/admin/mailboxes?email=${encodeURIComponent(f.env.admin)}`)).items[0];
    expect(source).toMatchObject({ localAccountId: main.account_id, mxDomain: null });
    const { items: [link] } = await f.links(source.id, ['a1@example.com']);
    for (let i = 0; i < 4; i++) f.message('a1@example.com', `cached-main-account-secret-${i}`);
    expect((await f.mail(link)).response.status).toBe(200);
    const cursor = (await f.mail(link, '?limit=2')).body.data.nextCursor;
    expect(cursor).toBeTruthy();
    f.env.db.prepare('UPDATE account SET status=1 WHERE account_id=?').run(main.account_id);
    for (const suffix of ['?limit=1', `?limit=2&cursor=${encodeURIComponent(cursor)}`]) {
      const result = await f.mail(link, suffix);
      expect(result.response.status).toBe(404);
      expect(JSON.stringify(result.body)).not.toContain('cached-main-account-secret');
    }
    expect((await f.raw(link.pageUrl)).status).toBe(404);
    f.env.db.prepare('UPDATE account SET status=0 WHERE account_id=?').run(main.account_id);
    expect((await f.mail(link)).response.status).toBe(200);
    f.env.db.prepare('UPDATE user SET status=1 WHERE user_id=?').run(main.user_id);
    for (const suffix of ['?limit=1', `?limit=2&cursor=${encodeURIComponent(cursor)}`]) {
      const result = await f.mail(link, suffix);
      expect(result.response.status).toBe(404);
      expect(JSON.stringify(result.body)).not.toContain('cached-main-account-secret');
    }
    expect((await f.raw(link.pageUrl)).status).toBe(404);
  });

  it('makes token and explicit full recipient paths enforce the same scope as the generated short path', async () => {
    const f = await fixture(), source = await f.source();
    const { items: [link] } = await f.links(source.id, ['a1@example.com']);
    f.message('a1@example.com', 'right-message'); f.message('a2@example.com', 'other-message');
    const row = f.env.db.prepare('SELECT token_encrypted FROM mail_link WHERE id=?').get(link.id);
    const token = f.env.secretVault.decrypt(row.token_encrypted, `mail-link:${link.id}`);
    const urls = [link.jsonUrl, `https://mail.example.com/api/mailboxes/${token}/messages`,
      `https://mail.example.com/api/mailboxes/p0/${source.publicId}/${encodeURIComponent('a1@example.com')}/messages`];
    for (const url of urls) {
      const response = await f.raw(url + '?limit=1');
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.data.recipient).toBe('a1@example.com');
      expect(body.data.items[0].subject).toBe('right-message');
    }
    expect((await f.raw(`https://mail.example.com/m/${token}`)).status).toBe(200);
    expect((await f.raw(`https://mail.example.com/show/p0/${source.publicId}/${encodeURIComponent('a1@example.com')}`)).status).toBe(200);
  });

  it('returns empty success, 404 for unknown/disabled sources, and 410 for expired links at every public entry', async () => {
    const f = await fixture(), source = await f.source();
    const { items: [link] } = await f.links(source.id, ['a1@example.com']);
    expect((await f.mail(link)).body.data.items).toEqual([]);
    expect((await f.raw('https://mail.example.com/api/mailboxes/not-a-token/messages')).status).toBe(404);
    const row = f.env.db.prepare('SELECT token_encrypted FROM mail_link WHERE id=?').get(link.id);
    const token = f.env.secretVault.decrypt(row.token_encrypted, `mail-link:${link.id}`);
    await f.success(`/admin/links/${link.id}`, { method: 'PUT', data: { revision: link.revision, expiresAt: '2020-01-01T00:00:00Z' } });
    for (const url of [link.jsonUrl, `https://mail.example.com/api/mailboxes/${token}/messages`, link.pageUrl, `https://mail.example.com/m/${token}`]) expect((await f.raw(url)).status).toBe(410);
    await f.success(`/admin/mailboxes/${source.id}`, { method: 'PUT', data: { revision: source.revision, enabled: false } });
    expect((await f.mail(link)).response.status).toBe(404);
  });

  it('reuses existing links without rotating their token or resetting their expiry', async () => {
    const f = await fixture(), source = await f.source();
    const first = await f.links(source.id, ['a1@example.com'], { expiresAt: '2031-01-01T00:00:00Z' });
    const stored = f.env.db.prepare('SELECT * FROM mail_link WHERE id=?').get(first.items[0].id);
    const repeated = await f.links(source.id, [' A1@EXAMPLE.COM ', 'a1@example.com'], { expiresAt: '2035-01-01T00:00:00Z' });
    expect(repeated.created).toBe(0); expect(repeated.reused).toBe(1);
    expect(repeated.items[0]).toEqual(first.items[0]);
    const after = f.env.db.prepare('SELECT * FROM mail_link WHERE id=?').get(first.items[0].id);
    expect(after.token_encrypted).toBe(stored.token_encrypted);
    expect(after.token_digest).toBe(stored.token_digest);
    expect(after.expires_at).toBe(stored.expires_at);
  });
});

describe('platform, transaction and pagination boundaries', () => {
  it('rejects invalid calendar dates and non-string platform values without clearing a policy or changing transactional data', async () => {
    const f = await fixture(), source = await f.source();
    const platform = await f.success('/admin/platforms', { method: 'POST', data: { name: 'Shop', emails: ['sender@shop.example'] } }, 201);
    const { items: [link] } = await f.links(source.id, ['a1@example.com'], { platformId: platform.id, expiresAt: '2031-01-01T00:00:00Z' });
    const before = f.env.db.prepare('SELECT * FROM mail_link ORDER BY id').all();
    const eventCount = f.env.db.prepare('SELECT count(*) count FROM sync_event').get().count;
    const auditCount = f.env.db.prepare('SELECT count(*) count FROM feature_audit').get().count;
    for (const invalid of [false, 0]) {
      const put = await f.api(`/admin/links/${link.id}`, { method: 'PUT', data: { revision: link.revision, platformId: invalid } });
      expect(put.status).toBe(400);
      const batch = await f.api('/admin/links/batch', { method: 'POST', data: { ids: [link.id], action: 'platform', value: invalid } });
      expect(batch.status).toBe(400);
      const create = await f.api('/admin/links', { method: 'POST', data: { mailboxId: source.id, recipients: ['new@example.com'], platformId: invalid } });
      expect(create.status).toBe(400);
    }
    for (const invalid of ['2031-02-31T12:00:00Z', '2031-02-29T12:00:00+08:00', '2031-04-31T12:00:00Z', '2031-01-01T24:00:00Z']) {
      expect((await f.api(`/admin/links/${link.id}`, { method: 'PUT', data: { revision: link.revision, expiresAt: invalid } })).status).toBe(400);
      expect((await f.api('/admin/links/batch', { method: 'POST', data: { ids: [link.id], action: 'expiry', value: invalid } })).status).toBe(400);
    }
    expect(f.env.db.prepare('SELECT * FROM mail_link ORDER BY id').all()).toEqual(before);
    expect(f.env.db.prepare('SELECT count(*) count FROM sync_event').get().count).toBe(eventCount);
    expect(f.env.db.prepare('SELECT count(*) count FROM feature_audit').get().count).toBe(auditCount);
    const valid = await f.success(`/admin/links/${link.id}`, { method: 'PUT', data: { revision: link.revision, expiresAt: '2032-02-29T12:00:00+08:00' } });
    expect(valid.expiresAt).toBe('2032-02-29T04:00:00.000Z');
  });

  it('filters before choosing latest and cannot loosen a platform-bound link by rewriting its path', async () => {
    const f = await fixture(), source = await f.source();
    const platform = await f.success('/admin/platforms', { method: 'POST', data: { name: 'Shop', emails: [], domains: ['shop.example'], keywords: ['code'] } }, 201);
    const { items: [link] } = await f.links(source.id, ['a1@example.com'], { platformId: platform.id });
    f.message('a1@example.com', 'code intended', { from: 'sender@sub.shop.example' });
    f.message('a1@example.com', 'code suffix attack', { from: 'sender@evilshop.example' });
    f.message('a1@example.com', 'unrelated newsletter', { from: 'sender@shop.example' });
    f.message('a2@example.com', 'code other child', { from: 'sender@shop.example' });
    expect((await f.mail(link)).body.data.items[0].subject).toBe('code intended');
    const widened = link.jsonUrl.replace(/\/mailboxes\/[^/]+\//, '/mailboxes/p0/');
    expect((await f.raw(widened + '?limit=1')).status).toBe(404);
    expect((await f.raw(link.jsonUrl + '?limit=1&recipient=a2@example.com')).status).toBe(400);
    const unknown = link.jsonUrl.replace(/\/mailboxes\/[^/]+\//, `/mailboxes/unknown~${randomUUID()}/`);
    expect((await f.raw(unknown)).status).toBe(404);
    const renamed = await f.success(`/admin/platforms/${platform.id}`, { method: 'PUT', data: { revision: platform.revision, name: 'Renamed', emails: [], domains: ['shop.example'], keywords: ['code'] } });
    expect(renamed.id).toBe(platform.id);
    expect((await f.mail(link)).body.data.items[0].subject).toBe('code intended');
  });

  it('rolls back a mixed-invalid or uniqueness-conflicting batch including its sync events and audits', async () => {
    const f = await fixture(), source = await f.source();
    const platform = await f.success('/admin/platforms', { method: 'POST', data: { name: 'Shop', emails: ['sender@shop.example'] } }, 201);
    const plain = await f.links(source.id, ['a1@example.com']);
    const bound = await f.links(source.id, ['a1@example.com'], { platformId: platform.id });
    const before = f.env.db.prepare('SELECT id,platform_id,expires_at,revision FROM mail_link ORDER BY id').all();
    const events = f.env.db.prepare('SELECT count(*) count FROM sync_event').get().count;
    const audit = f.env.db.prepare('SELECT count(*) count FROM feature_audit').get().count;
    const missing = await f.api('/admin/links/batch', { method: 'POST', data: { ids: [plain.items[0].id, randomUUID()], action: 'expiry', value: '2033-01-01T00:00:00Z' } });
    expect(missing.status).toBe(404);
    const conflict = await f.api('/admin/links/batch', { method: 'POST', data: { ids: [plain.items[0].id, bound.items[0].id], action: 'platform', value: platform.id } });
    expect(conflict.status).toBe(409);
    expect(f.env.db.prepare('SELECT id,platform_id,expires_at,revision FROM mail_link ORDER BY id').all()).toEqual(before);
    expect(f.env.db.prepare('SELECT count(*) count FROM sync_event').get().count).toBe(events);
    expect(f.env.db.prepare('SELECT count(*) count FROM feature_audit').get().count).toBe(audit);
  });

  it('does not count HEAD or unknown links, and records identified page/JSON GETs atomically', async () => {
    const f = await fixture(), source = await f.source();
    const { items: [link] } = await f.links(source.id, ['a1@example.com']);
    expect((await f.raw(link.pageUrl, { method: 'HEAD' })).status).toBe(200);
    expect((await f.raw(link.jsonUrl + '?limit=1', { method: 'HEAD' })).status).toBe(200);
    expect(f.env.db.prepare('SELECT * FROM link_access WHERE link_id=?').get(link.id)).toBeUndefined();
    await f.raw(link.pageUrl); await f.mail(link);
    await f.raw('https://mail.example.com/api/mailboxes/aaaaaaaaaaaaaaaaaaaaaaaa/messages');
    expect(f.env.db.prepare('SELECT page_visits,json_visits FROM link_access WHERE link_id=?').get(link.id)).toEqual({ page_visits: 1, json_visits: 1 });
  });

  it('keeps repeated cursor results stable and rejects an old cursor after a policy revision', async () => {
    const f = await fixture(), source = await f.source();
    const platform = await f.success('/admin/platforms', { method: 'POST', data: { name: 'Shop', emails: ['sender@shop.example'] } }, 201);
    const { items: [link] } = await f.links(source.id, ['a1@example.com'], { platformId: platform.id });
    for (let i = 0; i < 5; i++) f.message('a1@example.com', `message-${i}`);
    const first = await f.mail(link, '?limit=2');
    expect(first.body.data.hasMore).toBe(true);
    const cursor = first.body.data.nextCursor;
    const next = await f.mail(link, `?limit=2&cursor=${encodeURIComponent(cursor)}`);
    f.message('a1@example.com', 'new-after-snapshot');
    expect((await f.mail(link, `?limit=2&cursor=${encodeURIComponent(cursor)}`)).body).toEqual(next.body);
    await f.success(`/admin/platforms/${platform.id}`, { method: 'PUT', data: { revision: platform.revision, name: 'Shop', emails: ['different@shop.example'] } });
    const stale = await f.mail(link, `?limit=2&cursor=${encodeURIComponent(cursor)}`);
    expect(stale.response.status).toBe(400);
    expect(stale.body.error.code).toBe('CURSOR_EXPIRED');
  });

  it('refuses cached bodies and old cursor pages when the link reaches its absolute expiry', async () => {
    const f = await fixture(), source = await f.source();
    const expiresAt = new Date(Date.now() + 60000).toISOString();
    const { items: [link] } = await f.links(source.id, ['a1@example.com'], { expiresAt });
    for (let i = 0; i < 4; i++) f.message('a1@example.com', `expires-with-link-${i}`);
    const cursor = (await f.mail(link, '?limit=2')).body.data.nextCursor;
    expect(cursor).toBeTruthy();
    expect((await f.mail(link)).response.status).toBe(200);
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(expiresAt) + 1);
    for (const suffix of ['?limit=1', `?limit=2&cursor=${encodeURIComponent(cursor)}`]) {
      const result = await f.mail(link, suffix);
      expect(result.response.status).toBe(410);
      expect(JSON.stringify(result.body)).not.toContain('expires-with-link');
    }
    expect((await f.raw(link.pageUrl)).status).toBe(410);
  });

  it('rejects a reclaimed thirty-minute cursor without returning its stored message bodies', async () => {
    const f = await fixture(), source = await f.source();
    const { items: [link] } = await f.links(source.id, ['a1@example.com']);
    for (let i = 0; i < 4; i++) f.message('a1@example.com', `old-snapshot-secret-${i}`);
    const cursor = (await f.mail(link, '?limit=2')).body.data.nextCursor;
    expect(cursor).toBeTruthy();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31 * 60 * 1000);
    const stale = await f.mail(link, `?limit=2&cursor=${encodeURIComponent(cursor)}`);
    expect(stale.response.status).toBe(400);
    expect(stale.body.error.code).toBe('CURSOR_EXPIRED');
    expect(JSON.stringify(stale.body)).not.toContain('old-snapshot-secret');
  });

  it('exports all matching results independently of the current page and confines URL search to its main mailbox', async () => {
    const f = await fixture(), source = await f.source();
    const { items } = await f.links(source.id, Array.from({ length: 25 }, (_, i) => `child${i}@example.com`));
    const other = await f.source({ email: 'other@example.com' });
    await f.links(other.id, ['child1@example.com']);
    const page = await f.success(`/admin/links?mailboxId=${source.id}&pageSize=20`);
    expect(page.items).toHaveLength(20); expect(page.total).toBe(25);
    const exported = await f.api(`/admin/links/export?mailboxId=${source.id}`);
    expect(exported.status).toBe(200);
    expect((await exported.text()).trim().split('\n')).toHaveLength(25);
    const located = await f.success(`/admin/links?q=${encodeURIComponent(items.find(item => item.recipient === 'child1@example.com').pageUrl)}`);
    expect(located.total).toBe(1); expect(located.items[0].mailboxId).toBe(source.id);
    expect((await f.api('/admin/links/selection')).status).toBe(400);
  });
});

describe('MX domain scope, live revocation and prefixed routes', () => {
  it('advertises only MX and rejects external providers at the administrator API boundary', async () => {
    const f = await fixture(), source = await f.source();
    const before = f.env.db.prepare('SELECT * FROM source_mailbox ORDER BY id').all();
    expect((await f.success('/admin/mailboxes')).capabilities).toEqual({ providers: ['mx'], linkEncryption: true });
    for (const provider of ['outlook', 'icloud']) {
      const rejected = await f.api('/admin/mailboxes', { method: 'POST', data: { email: `main@${provider}.com`, provider } });
      expect(rejected.status).toBe(400);
      expect((await f.api(`/admin/mailboxes?provider=${provider}`)).status).toBe(400);
      expect((await f.api(`/admin/mailboxes/${source.id}`, { method: 'PUT', data: { revision: source.revision, provider } })).status).toBe(400);
    }
    expect(f.env.db.prepare('SELECT * FROM source_mailbox ORDER BY id').all()).toEqual(before);
    expect(f.env.db.prepare('SELECT revision FROM source_mailbox WHERE id=?').get(source.id).revision).toBe(source.revision);
    f.env.secretVault = null;
    expect((await f.success('/admin/mailboxes')).capabilities).toEqual({ providers: ['mx'], linkEncryption: false });
    const noKey = await f.api('/admin/links', { method: 'POST', data: { mailboxId: source.id, recipients: ['a1@example.com'] } });
    expect(noKey.status).toBe(503);
    expect((await noKey.json()).error.code).toBe('ENCRYPTION_NOT_CONFIGURED');
  });

  it('preserves legacy external records but excludes them from management and all public reading', async () => {
    const f = await fixture(), source = await f.source();
    const { items: [link] } = await f.links(source.id, ['a1@example.com']);
    f.message('a1@example.com', 'legacy-external-private-content');
    expect((await f.mail(link)).response.status).toBe(200);
    const stored = f.env.db.prepare('SELECT * FROM mail_link WHERE id=?').get(link.id);
    const token = f.env.secretVault.decrypt(stored.token_encrypted, `mail-link:${link.id}`);
    f.env.db.prepare("UPDATE source_mailbox SET provider='outlook' WHERE id=?").run(source.id);
    expect((await f.success(`/admin/mailboxes?email=${encodeURIComponent(source.email)}`)).total).toBe(0);
    expect((await f.success('/admin/links')).total).toBe(0);
    expect(await (await f.api('/admin/links/export')).text()).toBe('');
    for (const url of [link.pageUrl, link.jsonUrl, `https://mail.example.com/m/${token}`, `https://mail.example.com/api/mailboxes/${token}/messages`]) {
      const result = await f.raw(url);
      expect(result.status).toBe(404);
      expect(await result.text()).not.toContain('legacy-external-private-content');
    }
    expect((await f.api('/admin/links', { method: 'POST', data: { mailboxId: source.id, recipients: ['a2@example.com'] } })).status).toBe(404);
    expect(f.env.db.prepare('SELECT provider FROM source_mailbox WHERE id=?').get(source.id).provider).toBe('outlook');
    expect(f.env.db.prepare('SELECT * FROM mail_link WHERE id=?').get(link.id)).toEqual(stored);
  });

  it('rejects a batch containing an invalid child address without leaving links, events or audits', async () => {
    const f = await fixture(), source = await f.source();
    const events = f.env.db.prepare('SELECT count(*) count FROM sync_event').get().count;
    const audits = f.env.db.prepare('SELECT count(*) count FROM feature_audit').get().count;
    const rejected = await f.api('/admin/links', { method: 'POST', data: {
      mailboxId: source.id, recipients: ['same@example.com', 'invalid-child-address'],
    } });
    expect(rejected.status).toBe(400);
    expect((await rejected.json()).error.code).toBe('INVALID_RECIPIENT');
    expect(f.env.db.prepare('SELECT count(*) count FROM mail_link').get().count).toBe(0);
    expect(f.env.db.prepare('SELECT count(*) count FROM sync_event').get().count).toBe(events);
    expect(f.env.db.prepare('SELECT count(*) count FROM feature_audit').get().count).toBe(audits);
    expect((await f.raw(`https://mail.example.com/api/mailboxes/p0/${source.publicId}/same/messages`)).status).toBe(404);
  });

  it('never returns an in-flight local read result after the source is disabled', async () => {
    const f = await fixture(), source = await f.source();
    const { items: [link] } = await f.links(source.id, ['a1@example.com']);
    f.message('a1@example.com', 'revoked-local-recipient-content');
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    const blocked = new Promise(resolve => { release = resolve; });
    const read = sourceService.readSourceMessages;
    vi.spyOn(sourceService, 'readSourceMessages').mockImplementation(async (...args) => {
      const result = await read(...args);
      enter(); await blocked;
      return result;
    });
    const pending = f.mail(link);
    await entered;
    await f.success(`/admin/mailboxes/${source.id}`, { method: 'PUT', data: { revision: source.revision, enabled: false } });
    release();
    const result = await pending;
    expect(result.response.status).toBe(404);
    expect(JSON.stringify(result.body)).not.toContain('revoked-local-recipient-content');
  });

  it('includes the deployment prefix in copied URLs and serves a dotted child route directly', async () => {
    const f = await fixture({ prefix: '/mail' }), source = await f.source();
    const { items: [link] } = await f.links(source.id, ['john.smith@example.com']);
    expect(link.pageUrl).toContain('/mail/show/'); expect(link.jsonUrl).toContain('/mail/api/mailboxes/');
    f.message('john.smith@example.com', 'dotted child message');
    const page = await f.raw(link.pageUrl);
    expect(page.status).toBe(200); expect(await page.text()).toContain('Recipient application');
    expect((await f.mail(link)).body.data.items[0].subject).toBe('dotted child message');
    expect((await f.raw(link.jsonUrl.replace('/mail/api/', '/api/'))).status).toBe(404);
  });
});
