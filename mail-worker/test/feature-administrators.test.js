import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase } from '../src/server/database.js';
import { migrateDatabase, bootstrapAdmin } from '../src/server/migrations.js';
import { createKV } from '../src/server/kv.js';
import jwtUtils from '../src/utils/jwt-utils.js';
import constant from '../src/const/constant.js';
import KvConst from '../src/const/kv-const.js';
import cryptoUtils from '../src/utils/crypto-utils.js';
import starService from '../src/service/star-service.js';
import { configureFeatureRouter } from '../src/modules/shared/security.js';
import { loadConfig } from '../src/server/config.js';
import { createEnvironment } from '../src/server/environment.js';
import { createApp } from '../src/server/app.js';
import { isAdministrator, isSuperAdmin, setAdministrator, listAdministrators,
  mountAdministratorRoutes } from '../src/modules/administrators/service.js';

const databases = [], directories = [];
async function fixture() {
  const db = createDatabase(':memory:'); databases.push(db); migrateDatabase(db);
  const env = { db, kv: createKV(db), admin: 'admin@example.com', admin_password: 'initial-administrator-password',
    app_url: 'https://mail.example.com', jwt_secret: 'administrator-test-secret-at-least-32-characters' };
  const original = await bootstrapAdmin(env);
  const addUser = (email, values = {}) => {
    const userId = Number(db.prepare('INSERT INTO user(email,password,salt,status,is_del) VALUES(?,?,?,?,?)')
      .run(email, 'unused', 'unused', values.status ?? 0, values.isDel ?? 0).lastInsertRowid);
    db.prepare('INSERT INTO account(email,user_id) VALUES(?,?)').run(email, userId);
    return userId;
  };
  const secondId = addUser('second@example.com'), regularId = addUser('regular@example.com');
  const router = mountAdministratorRoutes(configureFeatureRouter(new Hono()));
  async function issue(userId = original.userId) {
    const sessionToken = `administrator-session-${userId}`;
    const user = db.prepare('SELECT email FROM user WHERE user_id=?').get(userId);
    await env.kv.put(KvConst.AUTH_INFO + userId, JSON.stringify({ tokens: [sessionToken], user: { userId, email: user.email } }));
    const token = await jwtUtils.generateToken({ env }, { userId, token: sessionToken, gen: constant.AUTH_GEN });
    const response = await router.request(`${env.app_url}/admin/session`, { headers: { authorization: token } }, env);
    const body = await response.json();
    return { token, csrf: body.data?.csrfToken };
  }
  function request(userId, { token, csrf, data = { enabled: true }, origin = env.app_url, method = 'PUT' } = {}) {
    return router.request(`${env.app_url}/admin/users/${userId}/administrator`, {
      method, headers: { 'content-type': 'application/json', ...(token ? { authorization: token } : {}),
        ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(origin ? { origin } : {}) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    }, env);
  }
  return { db, env, router, rootId: original.userId, secondId, regularId, addUser, issue, request,
    set: (userId, enabled, actorId = original.userId) => setAdministrator(env, userId, { enabled }, { actorId, requestId: 'administrator-test' }) };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) if (db.open) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function integrationFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'cloud-mail-administrators-')); directories.push(directory);
  const config = loadConfig({ MAIL_DOMAINS: 'example.com', ADMIN_EMAIL: 'admin@example.com',
    ADMIN_PASSWORD: 'administrator-integration-password', JWT_SECRET: 'administrator-integration-secret-at-least-32-characters',
    APP_URL: 'https://mail.example.com', DATA_DIR: join(directory, 'data'), STATIC_DIR: directory });
  const env = await createEnvironment(config); databases.push(env.db); env.mailReady = true;
  const app = createApp(env);
  let rootToken;
  const request = (path, { method = 'GET', data, token = rootToken, csrf } = {}) => app.request(`${config.app_url}/api${path}`, {
    method, headers: { 'content-type': 'application/json', 'accept-language': 'en', origin: config.app_url,
      ...(token ? { authorization: token } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  }, env);
  const legacy = async (path, options = {}, code = 200) => {
    const response = await request(path, options), body = await response.json();
    expect(response.status).toBe(200);
    expect(body.code, JSON.stringify(body)).toBe(code);
    return body.data;
  };
  const login = async (email = config.admin, password = config.admin_password) =>
    (await legacy('/login', { method: 'POST', token: null, data: { email, password } })).token;
  rootToken = await login();
  const feature = async (path, { token = rootToken, method = 'GET', data } = {}) => {
    let csrf;
    if (!['GET', 'HEAD'].includes(method)) {
      const session = await request('/admin/session', { token });
      csrf = (await session.json()).data?.csrfToken;
    }
    return request(path, { token, method, data, csrf });
  };
  const addUser = async (email, type = 1) => {
    await legacy('/user/add', { method: 'POST', data: { email, type, password: 'integration-user-password' } });
    return env.db.prepare('SELECT user_id FROM user WHERE email=?').get(email).user_id;
  };
  const rootId = env.db.prepare('SELECT user_id FROM user WHERE email=?').get(config.admin).user_id;
  return { env, config, rootId, rootToken, request, legacy, login, feature, addUser };
}

describe('persistent super administrator membership', () => {
  it('seeds only the initial administrator and never grants by ordinary role or arbitrary user data', async () => {
    const f = await fixture();
    expect(isSuperAdmin(f.env, f.rootId)).toBe(true);
    expect(isSuperAdmin(f.env, { userId: f.secondId, email: f.env.admin, type: 0 })).toBe(false);
    f.db.prepare('UPDATE user SET type=0 WHERE user_id=?').run(f.secondId);
    expect(isSuperAdmin(f.env, f.secondId)).toBe(false);
    expect(listAdministrators(f.env, { actorId: f.rootId }).items.map(item => item.userId)).toEqual([f.rootId]);
    expect((await bootstrapAdmin(f.env)).created).toBe(false);
    expect(f.db.prepare('SELECT count(*) AS n FROM site_administrator').get().n).toBe(1);
  });

  it('does not recreate or regrant the configured account after transferring administrator access', async () => {
    const f = await fixture();
    f.set(f.secondId, true);
    f.set(f.rootId, false, f.secondId);
    await bootstrapAdmin(f.env);
    expect(isAdministrator(f.env, f.rootId)).toBe(false);
    f.db.prepare('DELETE FROM user WHERE user_id=?').run(f.rootId);
    expect((await bootstrapAdmin(f.env)).userId).toBe(f.secondId);
    expect(f.db.prepare('SELECT 1 FROM user WHERE email=?').get(f.env.admin)).toBeUndefined();
    await bootstrapAdmin({ ...f.env, admin: 'changed-config@example.com' });
    expect(f.db.prepare('SELECT 1 FROM user WHERE email=?').get('changed-config@example.com')).toBeUndefined();
    expect(isSuperAdmin(f.env, f.secondId)).toBe(true);
  });

  it('preserves an explicit initialization marker even if all memberships are absent', async () => {
    const f = await fixture();
    f.db.prepare('DELETE FROM site_administrator').run();
    await bootstrapAdmin(f.env);
    expect(f.db.prepare('SELECT count(*) AS n FROM site_administrator').get().n).toBe(0);
    expect(isSuperAdmin(f.env, f.rootId)).toBe(false);
  });

  it('invalidates target sessions on changes and revokes old global integration tokens atomically', async () => {
    const f = await fixture();
    await f.issue(f.secondId);
    await f.env.kv.put(KvConst.PUBLIC_KEY, 'global-integration-token');
    expect(f.set(f.secondId, true).changed).toBe(true);
    expect(await f.env.kv.get(KvConst.AUTH_INFO + f.secondId)).toBeNull();
    expect(await f.env.kv.get(KvConst.PUBLIC_KEY)).toBe('global-integration-token');
    const promoted = await f.issue(f.secondId);
    expect(promoted.csrf).toBeTypeOf('string');
    expect(f.set(f.secondId, true).changed).toBe(false);
    expect(await f.env.kv.get(KvConst.AUTH_INFO + f.secondId)).not.toBeNull();
    f.set(f.secondId, false);
    expect(await f.env.kv.get(KvConst.AUTH_INFO + f.secondId)).toBeNull();
    expect(await f.env.kv.get(KvConst.PUBLIC_KEY)).toBeNull();
    expect(f.db.prepare('SELECT action FROM feature_audit ORDER BY id').all().map(row => row.action))
      .toEqual(['administrator.grant', 'administrator.revoke']);
  });

  it('rejects granting inactive or deleted users and protects the final active administrator', async () => {
    const f = await fixture();
    for (const userId of [f.addUser('disabled@example.com', { status: 1 }), f.addUser('deleted@example.com', { isDel: 1 })]) {
      expect(() => f.set(userId, true)).toThrow(expect.objectContaining({ code: 'USER_UNAVAILABLE' }));
    }
    expect(() => f.set(99999, true)).toThrow(expect.objectContaining({ code: 'USER_NOT_FOUND' }));
    expect(() => f.set(f.rootId, false)).toThrow(expect.objectContaining({ code: 'LAST_ADMINISTRATOR' }));
    f.set(f.secondId, true);
    f.db.prepare('UPDATE user SET status=1 WHERE user_id=?').run(f.secondId);
    expect(isAdministrator(f.env, f.secondId)).toBe(true);
    expect(isSuperAdmin(f.env, f.secondId)).toBe(false);
    expect(() => f.set(f.rootId, false)).toThrow(expect.objectContaining({ code: 'LAST_ADMINISTRATOR' }));
    f.db.prepare('UPDATE user SET status=0 WHERE user_id=?').run(f.secondId);
    f.set(f.rootId, false, f.secondId);
    expect(() => f.set(f.secondId, false, f.secondId)).toThrow(expect.objectContaining({ code: 'LAST_ADMINISTRATOR' }));
    expect(() => f.set(f.regularId, true, f.rootId)).toThrow(expect.objectContaining({ code: 'ADMIN_REQUIRED' }));
  });

  it('rolls back administrator access, sessions and global tokens when audit persistence fails', async () => {
    const f = await fixture();
    f.set(f.secondId, true);
    await f.issue(f.secondId);
    await f.env.kv.put(KvConst.PUBLIC_KEY, 'retained-integration-token');
    f.db.exec("CREATE TRIGGER reject_administrator_audit BEFORE INSERT ON feature_audit BEGIN SELECT RAISE(ABORT,'audit unavailable'); END");
    expect(() => f.set(f.secondId, false)).toThrow('audit unavailable');
    expect(isSuperAdmin(f.env, f.secondId)).toBe(true);
    expect(await f.env.kv.get(KvConst.AUTH_INFO + f.secondId)).not.toBeNull();
    expect(await f.env.kv.get(KvConst.PUBLIC_KEY)).toBe('retained-integration-token');
    expect(() => f.set(f.regularId, true)).toThrow('audit unavailable');
    expect(isAdministrator(f.env, f.regularId)).toBe(false);
  });

  it('requires a usable login mailbox when granting or retaining the final administrator', async () => {
    const f = await fixture();
    f.db.prepare('DELETE FROM account WHERE user_id=?').run(f.secondId);
    expect(() => f.set(f.secondId, true)).toThrow(expect.objectContaining({ code: 'USER_UNAVAILABLE' }));
    f.db.prepare('INSERT INTO account(email,user_id,status) VALUES(?,?,1)').run('second@example.com', f.secondId);
    expect(() => f.set(f.secondId, true)).toThrow(expect.objectContaining({ code: 'USER_UNAVAILABLE' }));
    f.db.prepare('UPDATE account SET status=0 WHERE user_id=?').run(f.secondId);
    f.set(f.secondId, true);
    f.db.prepare('UPDATE account SET is_del=1 WHERE user_id=?').run(f.secondId);
    expect(() => f.set(f.rootId, false)).toThrow(expect.objectContaining({ code: 'LAST_ADMINISTRATOR' }));
    expect(listAdministrators(f.env, { actorId: f.rootId }).items.find(item => item.userId === f.secondId).active).toBe(false);
    expect(f.set(f.secondId, false).changed).toBe(true);
  });

  it('requires super administrator authentication, matching origin and session CSRF for the API', async () => {
    const f = await fixture(), root = await f.issue(), regular = await f.issue(f.regularId);
    expect((await f.request(f.secondId)).status).toBe(401);
    expect((await f.request(f.secondId, regular)).status).toBe(403);
    expect((await f.request(f.secondId, { ...root, csrf: undefined })).status).toBe(403);
    expect((await f.request(f.secondId, { ...root, origin: 'https://evil.example' })).status).toBe(403);
    expect((await f.request(f.secondId, { ...root, data: { enabled: 'true' } })).status).toBe(400);
    expect((await f.request(f.secondId, { ...root, data: { enabled: true, type: 0 } })).status).toBe(400);
    const granted = await f.request(f.secondId, root);
    expect(granted.status).toBe(200);
    expect(await granted.json()).toMatchObject({ data: { userId: f.secondId, isAdministrator: true, changed: true } });
    const promoted = await f.issue(f.secondId);
    expect((await f.request(f.regularId, promoted)).status).toBe(200);
    expect((await f.request(f.secondId, { ...root, data: { enabled: false } })).status).toBe(200);
    expect((await f.request(f.regularId, promoted)).status).toBe(401);
  });

  it('rejects a request whose administrator was revoked while its JSON body was being read', async () => {
    const f = await fixture(), root = await f.issue();
    f.set(f.secondId, true);
    let bodyController, started;
    const bodyStarted = new Promise(resolve => { started = resolve; });
    const body = new ReadableStream({
      start(controller) { bodyController = controller; },
      pull() { started(); },
    }, { highWaterMark: 0 });
    const pending = f.router.request(new Request(`${f.env.app_url}/admin/users/${f.regularId}/administrator`, {
      method: 'PUT', duplex: 'half', body, headers: { 'content-type': 'application/json',
        authorization: root.token, 'x-csrf-token': root.csrf, origin: f.env.app_url },
    }), {}, f.env);
    await bodyStarted;
    f.set(f.rootId, false, f.secondId);
    bodyController.enqueue(new TextEncoder().encode(JSON.stringify({ enabled: true })));
    bodyController.close();
    const response = await pending;
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('ADMIN_REQUIRED');
    expect(isAdministrator(f.env, f.regularId)).toBe(false);
  });

  it('fails closed on replicas and only uses configured-email fallback before the administrator migration', async () => {
    const f = await fixture();
    expect(isSuperAdmin({ ...f.env, node_role: 'replica' }, f.rootId)).toBe(false);
    expect(() => setAdministrator({ ...f.env, node_role: 'replica' }, f.secondId, { enabled: true }, { actorId: f.rootId }))
      .toThrow(expect.objectContaining({ code: 'PRIMARY_ONLY' }));
    f.db.exec('DROP TABLE site_administrator');
    expect(isSuperAdmin(f.env, f.rootId)).toBe(true);
    expect(isSuperAdmin(f.env, f.secondId)).toBe(false);
  });
});

describe('super administrator protection across legacy application routes', () => {
  it('blocks delegated user-management permissions from modifying administrator identities and login mailboxes', async () => {
    const f = await integrationFixture();
    const roleId = Number(f.env.db.prepare("INSERT INTO role(name,account_count) VALUES('Delegated user manager',10)").run().lastInsertRowid);
    const insertPermission = f.env.db.prepare('INSERT INTO role_perm(role_id,perm_id) VALUES(?,?)');
    for (const permission of [5, 7, 8, 9, 10, 11, 22, 23, 24]) insertPermission.run(roleId, permission);
    await f.addUser('delegated@example.com', roleId);
    const delegated = await f.login('delegated@example.com', 'integration-user-password');
    const before = f.env.db.prepare('SELECT * FROM user WHERE user_id=?').get(f.rootId);
    const account = f.env.db.prepare('SELECT account_id FROM account WHERE user_id=?').get(f.rootId);
    await f.legacy('/user/setPwd', { token: delegated, method: 'PUT', data: { userId: f.rootId, password: 'attacker-password' } }, 403);
    for (const [path, method, data] of [
      ['/user/setStatus', 'PUT', { userId: f.rootId, status: 1 }],
      ['/user/setType', 'PUT', { userId: f.rootId, type: roleId }],
      [`/user/delete?userIds=${f.rootId}`, 'DELETE'],
      [`/user/deleteAccount?accountId=${account.account_id}`, 'DELETE'],
    ]) {
      await f.legacy(path, { token: delegated, method, data }, 409);
    }
    expect(f.env.db.prepare('SELECT * FROM user WHERE user_id=?').get(f.rootId)).toEqual(before);
    expect(f.env.db.prepare('SELECT 1 FROM account WHERE account_id=?').get(account.account_id)).toBeDefined();
    expect((await f.feature(`/admin/users/${f.rootId}/administrator`, { token: delegated, method: 'PUT', data: { enabled: false } })).status).toBe(403);
  });

  it('blocks direct administrator deletion, disable and role changes, and rejects ordinary role zero as an administrator grant', async () => {
    const f = await integrationFixture(), ordinaryId = await f.addUser('ordinary@example.com');
    for (const [path, method, data] of [
      ['/my/delete', 'DELETE'],
      [`/user/delete?userIds=${f.rootId}`, 'DELETE'],
      ['/user/setStatus', 'PUT', { userId: f.rootId, status: 1 }],
      ['/user/setType', 'PUT', { userId: f.rootId, type: 1 }],
    ]) {
      await f.legacy(path, { method, data }, 409);
    }
    const account = f.env.db.prepare('SELECT account_id FROM account WHERE user_id=?').get(f.rootId);
    await f.legacy(`/user/deleteAccount?accountId=${account.account_id}`, { method: 'DELETE' }, 409);
    const response = await f.request('/user/setType', { method: 'PUT', data: { userId: ordinaryId, type: 0 } });
    expect((await response.json()).code).not.toBe(200);
    expect(isAdministrator(f.env, ordinaryId)).toBe(false);
    expect(f.env.db.prepare('SELECT type FROM user WHERE user_id=?').get(ordinaryId).type).toBe(1);
    expect(isSuperAdmin(f.env, f.rootId)).toBe(true);
  });

  it('grants full access after a fresh login and removes it from both API generations immediately after revocation', async () => {
    const f = await integrationFixture(), secondId = await f.addUser('new-admin@example.com');
    const oldToken = await f.login('new-admin@example.com', 'integration-user-password');
    expect((await f.feature('/admin/mailboxes', { token: oldToken })).status).toBe(403);
    expect((await f.feature(`/admin/users/${secondId}/administrator`, { method: 'PUT', data: { enabled: true } })).status).toBe(200);
    await f.legacy('/my/loginUserInfo', { token: oldToken }, 401);
    const promoted = await f.login('new-admin@example.com', 'integration-user-password');
    expect((await f.legacy('/my/loginUserInfo', { token: promoted })).permKeys).toEqual(['*']);
    const created = await f.feature('/admin/mailboxes', { token: promoted, method: 'POST',
      data: { email: 'owned-by-new-admin@example.com', createLocalAccount: true } });
    expect(created.status).toBe(201);
    const mailbox = (await created.json()).data;
    expect(f.env.db.prepare('SELECT user_id FROM account WHERE account_id=?').get(mailbox.localAccountId).user_id).toBe(secondId);
    expect((await f.feature('/admin/mailboxes', { token: promoted })).status).toBe(200);
    expect((await f.feature(`/admin/users/${secondId}/administrator`, { method: 'PUT', data: { enabled: false } })).status).toBe(200);
    expect((await f.feature('/admin/mailboxes', { token: promoted })).status).toBe(401);
    await f.legacy('/my/loginUserInfo', { token: promoted }, 401);
    const demoted = await f.login('new-admin@example.com', 'integration-user-password');
    expect((await f.feature('/admin/mailboxes', { token: demoted })).status).toBe(403);
    expect((await f.legacy('/my/loginUserInfo', { token: demoted })).permKeys).not.toContain('*');
  });

  it('rechecks delegated password-change authority after hashing when the target becomes an administrator', async () => {
    const f = await integrationFixture();
    const roleId = Number(f.env.db.prepare("INSERT INTO role(name,account_count) VALUES('Delegated password manager',10)").run().lastInsertRowid);
    f.env.db.prepare('INSERT INTO role_perm(role_id,perm_id) VALUES(?,8)').run(roleId);
    await f.addUser('password-manager@example.com', roleId);
    const targetId = await f.addUser('promoted-during-password-change@example.com');
    const delegated = await f.login('password-manager@example.com', 'integration-user-password');
    const before = f.env.db.prepare('SELECT password,salt FROM user WHERE user_id=?').get(targetId);
    let started, resume;
    const hashing = new Promise(resolve => { started = resolve; });
    const released = new Promise(resolve => { resume = resolve; });
    const originalHash = cryptoUtils.hashPassword;
    vi.spyOn(cryptoUtils, 'hashPassword').mockImplementationOnce(async password => {
      started(); await released; return originalHash.call(cryptoUtils, password);
    });
    const pending = f.request('/user/setPwd', { token: delegated, method: 'PUT', data: { userId: targetId, password: 'attacker-race-password' } });
    await hashing;
    setAdministrator(f.env, targetId, { enabled: true }, { actorId: f.rootId });
    resume();
    expect((await (await pending).json()).code).toBe(403);
    expect(f.env.db.prepare('SELECT password,salt FROM user WHERE user_id=?').get(targetId)).toEqual(before);
  });

  it('does not recreate a global integration token when its issuer is revoked during password verification', async () => {
    const f = await integrationFixture(), replacementId = await f.addUser('replacement@example.com');
    setAdministrator(f.env, replacementId, { enabled: true }, { actorId: f.rootId });
    await f.env.kv.put(KvConst.PUBLIC_KEY, 'previous-integration-token');
    let started, resume;
    const verifying = new Promise(resolve => { started = resolve; });
    const released = new Promise(resolve => { resume = resolve; });
    const originalVerify = cryptoUtils.verifyPassword;
    vi.spyOn(cryptoUtils, 'verifyPassword').mockImplementationOnce(async (...args) => {
      started(); await released; return originalVerify.call(cryptoUtils, ...args);
    });
    const pending = f.request('/public/genToken', { token: null, method: 'POST',
      data: { email: f.config.admin, password: f.config.admin_password } });
    await verifying;
    setAdministrator(f.env, f.rootId, { enabled: false }, { actorId: replacementId });
    resume();
    expect((await (await pending).json()).code).toBe(403);
    expect(await f.env.kv.get(KvConst.PUBLIC_KEY)).toBeNull();
    expect(isSuperAdmin(f.env, replacementId)).toBe(true);
  });

  it('prevents restoring or promoting an identity while asynchronous physical-deletion cleanup is pending', async () => {
    const f = await integrationFixture(), targetId = await f.addUser('delete-during-cleanup@example.com');
    await f.login('delete-during-cleanup@example.com', 'integration-user-password');
    let started, resume;
    const cleaning = new Promise(resolve => { started = resolve; });
    const released = new Promise(resolve => { resume = resolve; });
    const originalCleanup = starService.removeByUserIds;
    vi.spyOn(starService, 'removeByUserIds').mockImplementationOnce(async (...args) => {
      started(); await released; return originalCleanup.call(starService, ...args);
    });
    const pending = f.request(`/user/delete?userIds=${targetId}`, { method: 'DELETE' });
    await cleaning;
    expect(f.env.db.prepare('SELECT 1 FROM user WHERE user_id=?').get(targetId)).toBeUndefined();
    expect(await f.env.kv.get(KvConst.AUTH_INFO + targetId)).toBeNull();
    const restoration = await f.request('/user/restore', { method: 'PUT', data: { userId: targetId } });
    expect((await restoration.json()).code).toBe(404);
    expect((await f.feature(`/admin/users/${targetId}/administrator`, { method: 'PUT', data: { enabled: true } })).status).toBe(404);
    expect(isAdministrator(f.env, targetId)).toBe(false);
    resume();
    expect((await (await pending).json()).code).toBe(200);
    expect(f.env.db.prepare('SELECT 1 FROM account WHERE user_id=?').get(targetId)).toBeUndefined();
    expect(f.env.db.prepare('SELECT user_id FROM site_administrator').all()).toEqual([{ user_id: f.rootId }]);
  });
});
