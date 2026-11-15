import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { loadConfig } from '../src/server/config.js';
import { createEnvironment, serviceContext } from '../src/server/environment.js';
import { createApp } from '../src/server/app.js';
import { resolveRecipient } from '../src/server/policy.js';
import settingService from '../src/service/setting-service.js';

const resources = [];
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cloud-mail-domain-integration-'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><html><body>Domain integration</body></html>');
  const config = loadConfig({
    MAIL_DOMAINS: 'example.com', ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'domain-administrator-password',
    JWT_SECRET: 'domain-integration-secret-at-least-32-characters', DATA_ENCRYPTION_KEY: 'ab'.repeat(32),
    APP_URL: 'https://mail.example.com', DATA_DIR: join(root, 'data'), STATIC_DIR: root,
  });
  let env = await createEnvironment(config), app = createApp(env), token, csrf;
  env.mailReady = true;
  const resource = { root, env }; resources.push(resource);
  async function api(path, { method = 'GET', data, admin = true, authorization } = {}) {
    return app.request(`${config.app_url}/api${path}`, {
      method, headers: { 'content-type': 'application/json', 'accept-language': 'en',
        ...((authorization || (admin && token)) ? { authorization: authorization || token } : {}),
        ...(admin && csrf ? { 'x-csrf-token': csrf } : {}),
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
    token = (await legacy('/login', { method: 'POST', admin: false, data: { email: config.admin, password: config.admin_password } })).token;
    csrf = (await success('/admin/session')).csrfToken;
    return token;
  }
  async function restart(overrides = {}) {
    env.db.close();
    env = await createEnvironment({ ...config, ...overrides }); resource.env = env;
    env.mailReady = true; app = createApp(env); token = csrf = undefined;
    await login();
  }
  const addDomain = domain => success('/admin/domains', { method: 'POST', data: { domain } }, 201);
  const setDomain = (domain, data) => success(`/admin/domains/${domain}`, { method: 'PUT', data });
  const source = data => success('/admin/mailboxes', { method: 'POST', data }, 201);
  const batch = emails => success('/admin/mailboxes/batch', { method: 'POST', data: { emails } });
  const count = table => env.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
  function message(recipient, subject, accountId) {
    const account = env.db.prepare('SELECT account_id,user_id FROM account WHERE account_id=?').get(accountId);
    env.db.prepare(`INSERT INTO email(user_id,account_id,to_email,recipient,send_email,subject,text,type,is_del)
      VALUES(?,?,?,?,?,?,?,0,0)`).run(account.user_id, account.account_id, recipient, JSON.stringify([{ address: recipient }]), 'sender@outside.test', subject, subject);
  }
  const publicRead = async link => {
    const response = await app.request(`${link.jsonUrl}?limit=1`, {}, env), body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    return body.data;
  };
  await login();
  return { get env() { return env; }, config, api, success, legacy, login, restart, addDomain, setDomain, source, batch, count, message, publicRead };
}

afterEach(() => {
  for (const { root, env } of resources.splice(0)) {
    if (env.db.open) env.db.close();
    if (!resolve(root).startsWith(`${resolve(tmpdir())}${sep}`) || !basename(root).startsWith('cloud-mail-domain-integration-')) {
      throw new Error('Unexpected domain integration test directory.');
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe('managed domains across existing application flows', () => {
  it('refreshes suffix selectors immediately and keeps disabled domains available for login even within a cached settings context', async () => {
    const f = await fixture(), context = serviceContext(f.env);
    expect((await settingService.query(context)).domainList).toEqual(['@example.com']);
    await f.addDomain('public.example');
    await f.addDomain('second.example');
    await f.setDomain('public.example', { isDefault: true });
    const site = await f.legacy('/setting/websiteConfig', { admin: false });
    expect(site.domainList).toEqual(['@public.example', '@example.com', '@second.example']);
    expect(site.loginDomainList).toEqual(site.domainList);
    expect((await f.success('/admin/mailboxes/domains')).domains).toEqual(['public.example', 'example.com', 'second.example']);
    await f.setDomain('example.com', { enabled: false });
    const updated = await settingService.query(context);
    expect(updated.domainList).toEqual(['@public.example', '@second.example']);
    expect(updated.loginDomainList).toEqual(['@public.example', '@example.com', '@second.example']);
    expect((await f.legacy('/setting/websiteConfig', { admin: false })).domainList).toEqual(updated.domainList);
    expect((await f.success('/admin/mailboxes/domains')).domains).toEqual(['public.example', 'second.example']);
  });

  it('uses a newly added domain for main mailboxes, batches, inbox accounts, administrator-created users and public registration', async () => {
    const f = await fixture();
    await f.addDomain('public.example');
    const usersBefore = f.count('user');
    const main = await f.source({ email: 'main@public.example', createLocalAccount: true });
    const batch = await f.batch(['batch@public.example', 'batch+tag@public.example']);
    expect(batch).toMatchObject({ created: 2, existing: 0, failed: 0 });
    const inbox = await f.legacy('/account/add', { method: 'POST', data: { email: 'inbox@public.example' } });
    expect(inbox.email).toBe('inbox@public.example');
    expect(f.count('user')).toBe(usersBefore);
    expect(f.env.db.prepare('SELECT user_id FROM account WHERE account_id=?').get(main.localAccountId).user_id)
      .toBe(f.env.db.prepare('SELECT user_id FROM user WHERE email=?').get(f.env.admin).user_id);
    await f.legacy('/user/add', { method: 'POST', data: { email: 'managed-user@public.example', password: 'managed-password' } });
    await f.legacy('/register', { method: 'POST', admin: false, data: { email: 'registered@public.example', password: 'registration-password' } });
    const publicToken = await f.legacy('/public/genToken', { method: 'POST', admin: false,
      data: { email: f.env.admin, password: f.env.admin_password } });
    await f.legacy('/public/addUser', { method: 'POST', admin: false, authorization: publicToken.token,
      data: { list: [{ email: 'public-user@public.example', password: 'public-user-password' }] } });
    expect(f.count('user')).toBe(usersBefore + 3);
    for (const email of ['main', 'batch', 'batch+tag', 'inbox', 'managed-user', 'registered', 'public-user']) {
      expect(f.env.db.prepare('SELECT email FROM account WHERE email=?').get(`${email}@public.example`)).toBeDefined();
    }
  });

  it('blocks new addresses on a disabled domain while preserving old administrator login, both mailbox scopes and their public links', async () => {
    const f = await fixture();
    const local = await f.source({ email: 'local-old@example.com', createLocalAccount: true });
    const range = await f.source({ email: 'range@example.com', provider: 'mx', mxDomain: 'example.com' });
    const localLink = (await f.success('/admin/links', { method: 'POST', data: { mailboxId: local.id, recipients: ['local-child@example.com'] } }, 201)).items[0];
    const rangeLink = (await f.success('/admin/links', { method: 'POST', data: { mailboxId: range.id, recipients: ['range-child@example.com'] } }, 201)).items[0];
    const adminAccount = f.env.db.prepare('SELECT account_id FROM account WHERE email=?').get(f.env.admin);
    f.message(localLink.recipient, 'local retained mail', local.localAccountId);
    f.message(rangeLink.recipient, 'domain retained mail', adminAccount.account_id);
    const before = { user: f.count('user'), account: f.count('account'), source_mailbox: f.count('source_mailbox'), mail_link: f.count('mail_link') };
    await f.addDomain('public.example');
    await f.setDomain('public.example', { isDefault: true });
    await f.setDomain('example.com', { enabled: false });
    expect(await f.login()).toBeTypeOf('string');
    expect((await f.legacy('/my/loginUserInfo')).email).toBe('admin@example.com');
    for (const mailbox of [local, range]) {
      const edited = await f.success(`/admin/mailboxes/${mailbox.id}`, { method: 'PUT', data: { enabled: true, revision: mailbox.revision } });
      expect(edited).toMatchObject({ id: mailbox.id, email: mailbox.email, publicId: mailbox.publicId, revision: mailbox.revision + 1 });
    }
    expect((await f.publicRead(localLink)).items.map(item => item.subject)).toEqual(['local retained mail']);
    expect((await f.publicRead(rangeLink)).items.map(item => item.subject)).toEqual(['domain retained mail']);
    for (const data of [{ email: 'new-local@example.com', createLocalAccount: true }, { email: 'new-range@example.com', mxDomain: 'example.com' }]) {
      const response = await f.api('/admin/mailboxes', { method: 'POST', data });
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe('INVALID_MX_DOMAIN');
    }
    const repeated = await f.batch(['LOCAL-OLD@EXAMPLE.COM', 'range@example.com', 'brand-new@example.com']);
    expect(repeated).toMatchObject({ created: 0, existing: 2, failed: 1 });
    expect(repeated.items.map(item => item.status)).toEqual(['existing', 'existing', 'failed']);
    expect(repeated.items[2].error.code).toBe('INVALID_MX_DOMAIN');
    for (const path of ['/account/add', '/user/add', '/register']) {
      const response = await f.api(path, { method: 'POST', admin: path !== '/register', data: { email: 'rejected@example.com', password: 'rejected-password' } });
      expect((await response.json()).code).not.toBe(200);
    }
    for (const [table, count] of Object.entries(before)) expect(f.count(table), table).toBe(count);
    expect(f.env.db.prepare('SELECT account_id FROM account WHERE email=?').get('rejected@example.com')).toBeUndefined();
  });

  it('keeps persisted domains and administrator identities after a process restart instead of reseeding changed environment domains', async () => {
    const f = await fixture();
    const originalAdmin = f.env.db.prepare('SELECT user_id,email,password,salt FROM user WHERE email=?').get(f.env.admin);
    const originalAccount = f.env.db.prepare('SELECT * FROM account WHERE email=?').get(f.env.admin);
    await f.addDomain('public.example');
    await f.setDomain('public.example', { isDefault: true });
    await f.setDomain('example.com', { enabled: false });
    await f.source({ email: 'persisted@public.example', createLocalAccount: true });
    const users = f.count('user'), accounts = f.count('account');
    await f.restart({ domain: ['example.com', 'environment-only.example'] });
    expect(f.count('user')).toBe(users);
    expect(f.count('account')).toBe(accounts);
    expect(f.env.admin).toBe('admin@example.com');
    expect(f.env.db.prepare('SELECT user_id,email,password,salt FROM user WHERE user_id=?').get(originalAdmin.user_id)).toEqual(originalAdmin);
    expect(f.env.db.prepare('SELECT * FROM account WHERE account_id=?').get(originalAccount.account_id)).toEqual(originalAccount);
    const domains = await f.success('/admin/domains');
    expect(domains.defaultDomain).toBe('public.example');
    expect(domains.items.map(item => [item.domain, item.enabled])).toEqual([['public.example', true], ['example.com', false]]);
    expect(await f.success('/admin/mailboxes/domains')).toMatchObject({ domains: ['public.example'] });
    expect((await f.success('/admin/mailboxes')).items.map(item => item.email)).toContain('persisted@public.example');
    expect((await f.legacy('/setting/websiteConfig', { admin: false })).loginDomainList).toEqual(['@public.example', '@example.com']);
  });

  it('resolves newly configured domains and old disabled-domain recipients while refusing unconfigured destinations', async () => {
    const f = await fixture();
    const oldAccount = f.env.db.prepare('SELECT account_id FROM account WHERE email=?').get(f.env.admin);
    await f.addDomain('public.example');
    const created = await f.source({ email: 'receive@public.example', createLocalAccount: true });
    expect(resolveRecipient(f.env, 'RECEIVE@PUBLIC.EXAMPLE').account.account_id).toBe(created.localAccountId);
    expect(resolveRecipient(f.env, 'receive+tag@public.example').account.account_id).toBe(created.localAccountId);
    await f.setDomain('public.example', { isDefault: true });
    await f.setDomain('example.com', { enabled: false });
    expect(resolveRecipient(f.env, 'admin@example.com').account.account_id).toBe(oldAccount.account_id);
    expect(resolveRecipient(f.env, 'admin+tag@example.com').account.account_id).toBe(oldAccount.account_id);
    expect(resolveRecipient(f.env, 'receive@public.example').account.account_id).toBe(created.localAccountId);
    for (const recipient of ['admin@outside.example', 'receive@unconfigured.example', 'not-an-email']) {
      expect(() => resolveRecipient(f.env, recipient)).toThrow(expect.objectContaining({ responseCode: 550, message: '5.7.1 Relaying denied' }));
    }
    expect(() => resolveRecipient(f.env, 'missing@public.example')).toThrow(expect.objectContaining({ responseCode: 550, message: '5.1.1 Recipient not found' }));
  });
});
