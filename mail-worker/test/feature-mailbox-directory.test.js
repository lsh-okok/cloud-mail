import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { loadConfig } from '../src/server/config.js';
import { createEnvironment, serviceContext } from '../src/server/environment.js';
import { createApp } from '../src/server/app.js';
import accountService from '../src/service/account-service.js';

const resources = [];
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cloud-mail-directory-'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><html><body>Mailbox directory</body></html>');
  const config = loadConfig({
    MAIL_DOMAINS: 'example.com', ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'directory-administrator-password',
    JWT_SECRET: 'directory-test-jwt-secret-at-least-32-characters', DATA_ENCRYPTION_KEY: 'ab'.repeat(32),
    APP_URL: 'https://mail.example.com', DATA_DIR: join(root, 'data'), STATIC_DIR: root,
  });
  let env = await createEnvironment(config), app = createApp(env), token, csrf;
  env.mailReady = true;
  const resource = { root, env }; resources.push(resource);
  async function api(path, { method = 'GET', data, anonymous = false, authorization } = {}) {
    return app.request(`${config.app_url}/api${path}`, {
      method, headers: { 'content-type': 'application/json', 'accept-language': 'en',
        ...(authorization || (!anonymous && token) ? { authorization: authorization || token } : {}),
        ...(!anonymous && csrf ? { 'x-csrf-token': csrf } : {}),
        ...(['GET', 'HEAD'].includes(method) ? {} : { origin: config.app_url }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    }, env);
  }
  async function success(path, options, status = 200) {
    const response = await api(path, options), body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(status);
    return body.data;
  }
  async function legacy(path, options, code = 200) {
    const body = await (await api(path, options)).json();
    expect(body.code, body.message).toBe(code);
    return body.data;
  }
  async function login() {
    token = (await legacy('/login', { method: 'POST', anonymous: true,
      data: { email: config.admin, password: config.admin_password } })).token;
    csrf = (await success('/admin/session')).csrfToken;
  }
  async function restart() {
    env.db.close();
    env = await createEnvironment(config); resource.env = env;
    env.mailReady = true; app = createApp(env); token = csrf = undefined;
    await login();
  }
  function account(email, { userId = 1, status = 0, isDel = 0 } = {}) {
    return Number(env.db.prepare('INSERT INTO account(email,name,user_id,status,is_del) VALUES(?,?,?,?,?)')
      .run(email, email.split('@')[0], userId, status, isDel).lastInsertRowid);
  }
  function user(email, { status = 0, isDel = 0, administrator = false } = {}) {
    const id = Number(env.db.prepare('INSERT INTO user(email,password,salt,status,is_del) VALUES(?,?,?,?,?)')
      .run(email, 'unused', 'unused', status, isDel).lastInsertRowid);
    if (administrator) env.db.prepare('INSERT INTO site_administrator(user_id,granted_at,granted_by) VALUES(?,?,1)').run(id, Date.now());
    return id;
  }
  const source = data => success('/admin/mailboxes', { method: 'POST', data }, 201);
  const find = email => env.db.prepare("SELECT * FROM source_mailbox WHERE provider='mx' AND email=? COLLATE NOCASE").get(email);
  const count = table => env.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
  await login();
  return { get env() { return env; }, api, success, legacy, restart, account, user, source, find, count,
    publicRead: url => app.request(url, {}, env) };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const { root, env } of resources.splice(0)) {
    if (env.db.open) env.db.close();
    if (!resolve(root).startsWith(`${resolve(tmpdir())}${sep}`) || !basename(root).startsWith('cloud-mail-directory-')) {
      throw new Error('Unexpected mailbox directory test directory.');
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe('shared local mailbox directory', () => {
  it('associates an inbox-created administrator mailbox immediately and lists it through both APIs', async () => {
    const f = await fixture(), before = f.count('account');
    const inbox = await f.legacy('/account/add', { method: 'POST', data: { email: 'inbox-added@example.com' } });
    expect(f.find(inbox.email)).toMatchObject({ email: inbox.email, local_account_id: inbox.accountId, mx_domain: null, enabled: 1 });
    expect(f.count('account')).toBe(before + 1);
    const main = (await f.success(`/admin/mailboxes?email=${encodeURIComponent(inbox.email)}`)).items;
    expect(main).toHaveLength(1);
    expect(main[0]).toMatchObject({ email: inbox.email, localAccountId: inbox.accountId });
    const accounts = await f.legacy('/account/list?size=30');
    expect(accounts.map(item => item.accountId)).toContain(inbox.accountId);
    const fromMain = await f.source({ email: 'main-added@example.com', createLocalAccount: true });
    expect((await f.legacy('/account/list?size=30')).map(item => item.accountId)).toContain(fromMain.localAccountId);
  });

  it('backfills missing administrator inboxes while excluding unrelated and unavailable accounts', async () => {
    const f = await fixture();
    const oldId = f.account('historical@example.com');
    const secondAdmin = f.user('second@example.com', { administrator: true });
    const secondId = f.account('second-inbox@example.com', { userId: secondAdmin });
    const regular = f.user('regular@example.com');
    const blockedAdmin = f.user('blocked@example.com', { administrator: true, status: 1 });
    const deletedAdmin = f.user('deleted-admin@example.com', { administrator: true, isDel: 1 });
    for (const [email, options] of [
      ['regular-inbox@example.com', { userId: regular }], ['stopped@example.com', { status: 1 }],
      ['deleted@example.com', { isDel: 1 }], ['outside@unmanaged.example', {}],
      ['blocked-inbox@example.com', { userId: blockedAdmin }], ['deleted-admin-inbox@example.com', { userId: deletedAdmin }],
    ]) f.account(email, options);
    await f.success('/admin/mailboxes');
    expect(f.find('historical@example.com')).toMatchObject({ local_account_id: oldId });
    expect(f.find('second-inbox@example.com')).toMatchObject({ local_account_id: secondId });
    for (const email of ['regular-inbox@example.com', 'stopped@example.com', 'deleted@example.com',
      'outside@unmanaged.example', 'blocked-inbox@example.com', 'deleted-admin-inbox@example.com']) {
      expect(f.find(email), email).toBeUndefined();
    }
    const snapshots = ['source_mailbox', 'feature_audit', 'sync_event'].map(table => f.count(table));
    await f.success('/admin/mailboxes');
    expect(['source_mailbox', 'feature_audit', 'sync_event'].map(table => f.count(table))).toEqual(snapshots);
  });

  it('keeps ordinary registration and inbox creation outside the administrator source directory', async () => {
    const f = await fixture(), before = f.count('source_mailbox');
    const email = 'regular-api@example.com', password = 'ordinary-user-password';
    await f.legacy('/register', { method: 'POST', anonymous: true, data: { email, password } });
    const { token } = await f.legacy('/login', { method: 'POST', anonymous: true, data: { email, password } });
    const inbox = await f.legacy('/account/add', { method: 'POST', authorization: token,
      data: { email: 'regular-added@example.com' } });
    expect(inbox.email).toBe('regular-added@example.com');
    expect((await f.legacy('/account/list?size=30', { authorization: token })).map(item => item.email))
      .toEqual(expect.arrayContaining([email, inbox.email]));
    await f.success('/admin/mailboxes');
    expect(f.find(email)).toBeUndefined();
    expect(f.find(inbox.email)).toBeUndefined();
    expect(f.count('source_mailbox')).toBe(before);
  });

  it('backfills at startup without resetting existing policies, public identities, links or stored mail', async () => {
    const f = await fixture();
    expect(f.find('admin@example.com')).toMatchObject({ local_account_id: 1 });
    const local = await f.source({ email: 'existing@example.com', createLocalAccount: true });
    await f.success('/admin/links', { method: 'POST', data: { mailboxId: local.id, recipients: ['existing+child@example.com'] } }, 201);
    await f.success(`/admin/mailboxes/${local.id}`, { method: 'PUT', data: { revision: local.revision, enabled: false } });
    const domain = await f.source({ email: 'domain-scope@example.com', mxDomain: 'example.com' });
    const existingRows = [f.find(local.email), f.find(domain.email)];
    const links = f.env.db.prepare('SELECT * FROM mail_link ORDER BY id').all();
    f.env.db.prepare(`INSERT INTO email(account_id,user_id,to_email,send_email,subject,text)
      VALUES(?,1,?,'sender@outside.test','Keep this message','Original body')`).run(local.localAccountId, 'existing+child@example.com');
    const messages = f.env.db.prepare('SELECT * FROM email ORDER BY email_id').all();
    const historicalId = f.account('startup-legacy@example.com');
    await f.restart();
    expect(f.find('startup-legacy@example.com')).toMatchObject({ local_account_id: historicalId });
    const historical = f.find('startup-legacy@example.com');
    await f.success('/admin/mailboxes');
    await f.restart();
    expect(f.find('startup-legacy@example.com')).toEqual(historical);
    expect([f.find(local.email), f.find(domain.email)]).toEqual(existingRows);
    expect(f.env.db.prepare('SELECT * FROM mail_link ORDER BY id').all()).toEqual(links);
    expect(f.env.db.prepare('SELECT * FROM email ORDER BY email_id').all()).toEqual(messages);
    expect(f.env.db.prepare('SELECT 1 FROM account WHERE email=?').get(domain.email)).toBeUndefined();
  });

  it('can backfill a historical account on a stopped receiving domain while rejecting new accounts there', async () => {
    const f = await fixture();
    await f.success('/admin/domains', { method: 'POST', data: { domain: 'stopped.example' } }, 201);
    const id = f.account('historical@stopped.example');
    await f.success('/admin/domains/stopped.example', { method: 'PUT', data: { enabled: false } });
    await f.success('/admin/mailboxes');
    expect(f.find('historical@stopped.example')).toMatchObject({ local_account_id: id });
    const rejected = await (await f.api('/account/add', { method: 'POST', data: { email: 'new@stopped.example' } })).json();
    expect(rejected.code).not.toBe(200);
    expect(f.env.db.prepare('SELECT 1 FROM account WHERE email=?').get('new@stopped.example')).toBeUndefined();
    expect(f.find('new@stopped.example')).toBeUndefined();
    const response = await f.api('/admin/mailboxes', { method: 'POST', data: { email: 'new-main@stopped.example', createLocalAccount: true } });
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('INVALID_MX_DOMAIN');
  });

  it('rolls back an inbox account and its source together when recording the directory change fails', async () => {
    const f = await fixture();
    const counts = () => ['account', 'source_mailbox', 'feature_audit', 'sync_event'].map(table => f.count(table));
    const before = counts();
    f.env.db.exec(`CREATE TRIGGER prevent_directory_audit BEFORE INSERT ON feature_audit
      WHEN NEW.object_type='mailbox' BEGIN SELECT RAISE(ABORT,'directory-audit-failure'); END;`);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await f.api('/account/add', { method: 'POST', data: { email: 'rollback@example.com' } });
    const body = await response.json();
    expect(body.code).not.toBe(200);
    expect(counts()).toEqual(before);
    expect(f.env.db.prepare('SELECT 1 FROM account WHERE email=?').get('rollback@example.com')).toBeUndefined();
    expect(f.find('rollback@example.com')).toBeUndefined();
  });

  it('hides a deleted inbox from both lists, denies its public link and restores the original association', async () => {
    const f = await fixture();
    await f.legacy('/setting/set', { method: 'PUT', data: { syncDelete: 1 } });
    const source = await f.source({ email: 'restorable@example.com', createLocalAccount: true });
    const { items: [link] } = await f.success('/admin/links', { method: 'POST',
      data: { mailboxId: source.id, recipients: ['restorable+child@example.com'] } }, 201);
    const originalSource = f.find(source.email), originalLinks = f.env.db.prepare('SELECT * FROM mail_link WHERE mailbox_id=?').all(source.id);
    expect((await f.publicRead(link.jsonUrl)).status).toBe(200);
    await f.legacy(`/account/delete?accountId=${source.localAccountId}`, { method: 'DELETE' });
    expect((await f.legacy('/account/list?size=30')).map(item => item.accountId)).not.toContain(source.localAccountId);
    expect((await f.success(`/admin/mailboxes?email=${encodeURIComponent(source.email)}`)).items).toEqual([]);
    expect((await f.publicRead(link.jsonUrl)).status).toBe(404);
    expect(f.find(source.email)).toEqual(originalSource);
    await accountService.restoreByEmail(serviceContext(f.env), source.email);
    const restored = (await f.success(`/admin/mailboxes?email=${encodeURIComponent(source.email)}`)).items;
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ id: source.id, publicId: source.publicId, revision: source.revision, localAccountId: source.localAccountId });
    expect((await f.legacy('/account/list?size=30')).map(item => item.accountId)).toContain(source.localAccountId);
    expect((await f.publicRead(link.jsonUrl)).status).toBe(200);
    expect(f.find(source.email)).toEqual(originalSource);
    expect(f.env.db.prepare('SELECT * FROM mail_link WHERE mailbox_id=?').all(source.id)).toEqual(originalLinks);
  });

  it.each(['inbox', 'main'])('recreates a physically deleted mailbox through the %s entry with a fresh public identity', async entry => {
    const f = await fixture();
    const source = await f.source({ email: 'physical@example.com', createLocalAccount: true });
    const { items: [link] } = await f.success('/admin/links', { method: 'POST',
      data: { mailboxId: source.id, recipients: ['physical+child@example.com'] } }, 201);
    const original = f.find(source.email);
    expect((await f.publicRead(link.jsonUrl)).status).toBe(200);
    f.env.db.prepare('UPDATE account SET status=1 WHERE account_id=?').run(source.localAccountId);
    const query = `/admin/mailboxes?email=${encodeURIComponent(source.email)}`;
    expect((await f.success(query)).items).toEqual([expect.objectContaining({ id: source.id, localAccountStatus: 'disabled' })]);
    f.env.db.prepare('UPDATE account SET status=0 WHERE account_id=?').run(source.localAccountId);
    expect((await f.success(query)).items).toEqual([expect.objectContaining({ id: source.id, localAccountStatus: 'active' })]);
    await f.legacy(`/account/delete?accountId=${source.localAccountId}`, { method: 'DELETE' });
    expect(f.env.db.prepare('SELECT 1 FROM account WHERE account_id=?').get(source.localAccountId)).toBeUndefined();
    expect((await f.success(query)).items).toEqual([]);
    expect(f.find(source.email)).toEqual(original);
    expect((await f.publicRead(link.jsonUrl)).status).toBe(404);
    const replacementId = entry === 'inbox'
      ? (await f.legacy('/account/add', { method: 'POST', data: { email: source.email } })).accountId
      : (await f.source({ email: source.email, createLocalAccount: true })).localAccountId;
    expect(replacementId).not.toBe(source.localAccountId);
    const [replacement] = (await f.success(query)).items;
    expect(replacement).toMatchObject({ email: source.email, localAccountId: replacementId, localAccountStatus: 'active', enabled: true });
    expect(replacement.id).not.toBe(source.id);
    expect(replacement.publicId).not.toBe(source.publicId);
    expect((await f.legacy('/account/list?size=30')).map(item => item.accountId)).toContain(replacementId);
    expect(f.env.db.prepare('SELECT 1 FROM source_mailbox WHERE id=?').get(source.id)).toBeUndefined();
    expect(f.env.db.prepare('SELECT 1 FROM mail_link WHERE id=?').get(link.id)).toBeUndefined();
    const deletions = f.env.db.prepare('SELECT object_type,object_id,payload_json FROM sync_event WHERE object_id IN (?,?)')
      .all(source.id, link.id).filter(event => JSON.parse(event.payload_json).deleted === true);
    expect(deletions).toEqual(expect.arrayContaining([
      expect.objectContaining({ object_type: 'mailbox', object_id: source.id }),
      expect.objectContaining({ object_type: 'link', object_id: link.id }),
    ]));
    expect((await f.publicRead(link.jsonUrl)).status).toBe(404);
    expect((await f.publicRead(link.pageUrl)).status).toBe(404);
  });

  it('normalizes addresses consistently and rejects malformed local parts without partial accounts', async () => {
    const f = await fixture();
    const inbox = await f.legacy('/account/add', { method: 'POST', data: { email: ' Normalized@EXAMPLE.COM ' } });
    expect(inbox.email).toBe('normalized@example.com');
    expect(f.find('normalized@example.com')).toMatchObject({ email: 'normalized@example.com', local_account_id: inbox.accountId });
    expect((await f.success('/admin/mailboxes?email=normalized%40example.com')).items)
      .toEqual([expect.objectContaining({ email: 'normalized@example.com', localAccountId: inbox.accountId })]);
    expect((await f.legacy('/account/list?size=30')).map(item => item.email)).toContain('normalized@example.com');
    const main = await f.source({ email: ' Normalized-Main@EXAMPLE.COM ', createLocalAccount: true });
    expect(main.email).toBe('normalized-main@example.com');
    const before = ['account', 'source_mailbox'].map(table => f.count(table));
    const invalid = await (await f.api('/account/add', { method: 'POST', data: { email: 'a..b@example.com' } })).json();
    expect(invalid.code).not.toBe(200);
    const invalidMain = await f.api('/admin/mailboxes', { method: 'POST', data: { email: 'a..b@example.com', createLocalAccount: true } });
    expect(invalidMain.status).toBe(400);
    expect(['account', 'source_mailbox'].map(table => f.count(table))).toEqual(before);
    expect(f.env.db.prepare('SELECT 1 FROM account WHERE email=?').get('a..b@example.com')).toBeUndefined();
    expect(f.find('a..b@example.com')).toBeUndefined();
  });

  it('restores the retired source and its links if recreating its replacement fails', async () => {
    const f = await fixture();
    const source = await f.source({ email: 'replacement-failure@example.com', createLocalAccount: true });
    const { items: [link] } = await f.success('/admin/links', { method: 'POST',
      data: { mailboxId: source.id, recipients: ['replacement-failure+child@example.com'] } }, 201);
    await f.legacy(`/account/delete?accountId=${source.localAccountId}`, { method: 'DELETE' });
    const originalSource = f.find(source.email), originalLinks = f.env.db.prepare('SELECT * FROM mail_link WHERE mailbox_id=?').all(source.id);
    const counts = () => ['account', 'source_mailbox', 'mail_link', 'feature_audit', 'sync_event'].map(table => f.count(table));
    const before = counts();
    f.env.db.exec(`CREATE TRIGGER prevent_replacement_creation BEFORE INSERT ON feature_audit
      WHEN NEW.action='mailbox.create' BEGIN SELECT RAISE(ABORT,'replacement-create-failure'); END;`);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await f.api('/account/add', { method: 'POST', data: { email: source.email } });
    expect((await response.json()).code).not.toBe(200);
    expect(counts()).toEqual(before);
    expect(f.find(source.email)).toEqual(originalSource);
    expect(f.env.db.prepare('SELECT * FROM mail_link WHERE mailbox_id=?').all(source.id)).toEqual(originalLinks);
    expect(f.env.db.prepare('SELECT 1 FROM account WHERE email=?').get(source.email)).toBeUndefined();
    expect((await f.publicRead(link.jsonUrl)).status).toBe(404);
  });
});
