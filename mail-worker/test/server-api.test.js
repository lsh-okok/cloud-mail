import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { loadConfig } from '../src/server/config.js';
import { createEnvironment } from '../src/server/environment.js';
import { createApp } from '../src/server/app.js';

const resources = [];
async function fixture() {
	const root = mkdtempSync(join(tmpdir(), 'cloud-mail-api-'));
	const config = loadConfig({
		MAIL_DOMAINS: 'example.com', MAIL_HOST: 'mail.example.com', ADMIN_EMAIL: 'admin@example.com',
		ADMIN_PASSWORD: 'administrator-password-123', JWT_SECRET: 'test-jwt-secret-with-at-least-32-characters',
		APP_URL: 'https://mail.example.com', DATA_DIR: root, STATIC_DIR: root,
	});
	const env = await createEnvironment(config);
	resources.push({ root, env });
	const app = createApp(env);
	async function request(path, { method = 'GET', token, data } = {}) {
		const response = await app.request(`https://mail.example.com/api${path}`, {
			method,
			headers: { 'content-type': 'application/json', 'accept-language': 'en', ...(token ? { Authorization: token } : {}) },
			...(data === undefined ? {} : { body: JSON.stringify(data) }),
		}, env);
		return response.json();
	}
	async function login(email = config.admin, password = config.admin_password) {
		const result = await request('/login', { method: 'POST', data: { email, password } });
		expect(result.code, result.message).toBe(200);
		return result.data.token;
	}
	const token = await login();
	return { env, request, login, token };
}
afterEach(() => {
	for (const { root, env } of resources.splice(0)) {
		if (env.db.open) env.db.close();
		if (!resolve(root).startsWith(`${resolve(tmpdir())}${sep}`) || !basename(root).startsWith('cloud-mail-api-')) throw new Error('Unexpected API test directory.');
		rmSync(root, { recursive: true, force: true });
	}
});

describe('server API with SQLite and local storage', () => {
	it('logs in, returns the administrator account, and invalidates a logged-out session', async () => {
		const { request, token } = await fixture();
		const current = await request('/my/loginUserInfo', { token });
		expect(current.code).toBe(200);
		expect(current.data.email).toBe('admin@example.com');
		expect(current.data.permKeys).toEqual(['*']);
		expect((await request('/logout', { token, method: 'DELETE' })).code).toBe(200);
		expect((await request('/my/loginUserInfo', { token })).code).toBe(401);
	});

	it('round trips the complete settings form without losing credentials or changing deployment capabilities', async () => {
		const { env, request, token } = await fixture();
		const credentials = {
			siteKey: 'site-key-kept-intact', secretKey: 'turnstile-secret-kept-intact',
			s3AccessKey: 's3-access-key-kept-intact', s3SecretKey: 's3-secret-key-kept-intact',
			tgBotToken: 'telegram-bot-token-kept-intact', resendTokens: { 'example.com': 'legacy-provider-token-kept-intact' },
		};
		expect((await request('/setting/set', { token, method: 'PUT', data: credentials })).code).toBe(200);
		const queried = await request('/setting/query', { token });
		expect(queried.code, queried.message).toBe(200);
		expect(queried.data.secretKey).not.toBe(credentials.secretKey);
		expect(queried.data.resendTokens['example.com']).not.toBe(credentials.resendTokens['example.com']);
		// The settings view submits all queried fields after removing masked credentials.
		const form = { ...queried.data };
		for (const field of Object.keys(credentials)) delete form[field];
		Object.assign(form, {
			title: 'Self-hosted mailbox', emailPrefixFilter: ['admin', 'postmaster'], aiCodeFilter: ['sender@example.com'],
			mailProvider: 'untrusted-provider', mailHost: 'spoofed.example.com', aiAvailable: true,
			domainList: ['@spoofed.example.com'], storageType: 'S3', hasR2: true, hasCfEmail: true, aiCode: 0,
		});
		const saved = await request('/setting/set', { token, method: 'PUT', data: form });
		expect(saved.code, saved.message).toBe(200);
		const updated = await request('/setting/query', { token });
		expect(updated.code, updated.message).toBe(200);
		expect(updated.data).toMatchObject({
			title: 'Self-hosted mailbox', emailPrefixFilter: ['admin', 'postmaster'], aiCodeFilter: 'sender@example.com',
			mailProvider: 'postfix', mailHost: env.server.hostname, aiAvailable: false,
			domainList: ['@example.com'], storageType: 'LOCAL', hasR2: false, hasCfEmail: false, aiCode: 1,
		});
		const stored = env.db.prepare('SELECT site_key, secret_key, s3_access_key, s3_secret_key, tg_bot_token, resend_tokens FROM setting').get();
		expect(stored).toEqual({
			site_key: credentials.siteKey, secret_key: credentials.secretKey,
			s3_access_key: credentials.s3AccessKey, s3_secret_key: credentials.s3SecretKey,
			tg_bot_token: credentials.tgBotToken, resend_tokens: JSON.stringify(credentials.resendTokens),
		});
	});

	it('creates an alias and searches, marks, stars and deletes the owner’s mail', async () => {
		const { env, request, token } = await fixture();
		const added = await request('/account/add', { token, method: 'POST', data: { email: 'alias@example.com' } });
		expect(added.code, added.message).toBe(200);
		const accountId = added.data.accountId;
		expect((await request('/account/setName', { token, method: 'PUT', data: { accountId, name: 'Alias' } })).code).toBe(200);
		const accounts = await request('/account/list?size=30', { token });
		expect(accounts.data.find(account => account.accountId === accountId).name).toBe('Alias');
		const userId = env.db.prepare('SELECT user_id FROM user WHERE email = ?').get('admin@example.com').user_id;
		const inserted = env.db.prepare(`INSERT INTO email (user_id, account_id, subject, content, text, send_email, to_email)
			VALUES (?, ?, ?, ?, ?, ?, ?)`).run(userId, accountId, 'SQLite verification', '<p>hello</p>', 'hello', 'sender@outside.test', 'alias@example.com');
		const emailId = Number(inserted.lastInsertRowid);
		const list = await request(`/email/list?accountId=${accountId}&type=0&size=20&text=SQLite&searchType=subject`, { token });
		expect(list.code, list.message).toBe(200);
		expect(list.data.total).toBe(1);
		expect(list.data.list[0].emailId).toBe(emailId);
		expect((await request('/email/read', { token, method: 'PUT', data: { emailIds: [emailId] } })).code).toBe(200);
		expect(env.db.prepare('SELECT unread FROM email WHERE email_id = ?').get(emailId).unread).toBe(1);
		expect((await request('/star/add', { token, method: 'POST', data: { emailId } })).code).toBe(200);
		const starred = await request('/star/list?size=20', { token });
		expect(starred.data.list[0].emailId).toBe(emailId);
		expect((await request(`/star/cancel?emailId=${emailId}`, { token, method: 'DELETE' })).code).toBe(200);
		expect((await request('/star/list?size=20', { token })).data.list).toHaveLength(0);
		expect((await request(`/email/delete?emailIds=${emailId}`, { token, method: 'DELETE' })).code).toBe(200);
		expect((await request(`/email/list?accountId=${accountId}&type=0&size=20`, { token })).data.list).toHaveLength(0);
	});

	it('applies role permissions and account limits and isolates another user’s mailbox', async () => {
		const { env, request, token, login } = await fixture();
		const created = await request('/role/add', {
			token, method: 'POST', data: {
				name: 'Limited mailbox', key: 'limited', description: 'API test', permIds: [2, 3, 22, 23, 24],
				banEmail: [], availDomain: ['example.com'], sendType: 'ban', sendCount: 0, accountCount: 1,
			},
		});
		expect(created.code, created.message).toBe(200);
		const roles = await request('/role/list', { token });
		const roleId = roles.data.find(role => role.name === 'Limited mailbox').roleId;
		expect((await request('/role/tree', { token })).data.length).toBeGreaterThan(0);
		expect((await request('/user/add', { token, method: 'POST', data: { email: 'limited@example.com', password: 'limited-password', type: roleId } })).code).toBe(200);
		const limited = await login('limited@example.com', 'limited-password');
		expect((await request('/role/list', { token: limited })).code).toBe(403);
		expect((await request('/account/add', { token: limited, method: 'POST', data: { email: 'excess@example.com' } })).code).toBe(403);
		const adminAccount = env.db.prepare('SELECT * FROM account WHERE email = ?').get('admin@example.com');
		const otherMail = env.db.prepare('INSERT INTO email (user_id, account_id, subject) VALUES (?, ?, ?)').run(adminAccount.user_id, adminAccount.account_id, 'Private');
		const result = await request(`/email/list?accountId=${adminAccount.account_id}&type=0&size=20&allReceive=1`, { token: limited });
		expect(result.code).toBe(200);
		expect(result.data.list).toHaveLength(0);
		expect((await request('/star/add', { token: limited, method: 'POST', data: { emailId: Number(otherMail.lastInsertRowid) } })).code).not.toBe(200);
	});

	it('protects batch user creation with the administrator API token and rolls back duplicates', async () => {
		const { env, request, token } = await fixture();
		const generated = await request('/public/genToken', { method: 'POST', data: { email: env.admin, password: env.admin_password } });
		expect(generated.code, generated.message).toBe(200);
		const publicToken = generated.data.token;
		const list = [{ email: 'batch-one@example.com', password: 'batch-password' }, { email: 'batch-two@example.com', password: 'batch-password' }];
		expect((await request('/public/addUser', { method: 'POST', data: { list } })).code).toBe(401);
		expect((await request('/public/addUser', { method: 'POST', token: publicToken, data: { list } })).code).toBe(200);
		const users = await request('/user/list?size=20&num=1', { token });
		expect(users.code, users.message).toBe(200);
		expect(users.data.total).toBe(3);
		const duplicate = await request('/public/addUser', { method: 'POST', token: publicToken, data: { list: [
			{ email: 'should-rollback@example.com', password: 'batch-password' },
			{ email: 'BATCH-ONE@example.com', password: 'batch-password' },
		] } });
		expect(duplicate.code).not.toBe(200);
		expect(env.db.prepare('SELECT user_id FROM user WHERE email = ?').get('should-rollback@example.com')).toBeUndefined();
	});

	it('enforces invitation availability during registration and restores uses on database failure', async () => {
		const { env, request, token, login } = await fixture();
		expect((await request('/setting/set', { token, method: 'PUT', data: { regKey: 0 } })).code).toBe(200);
		expect((await request('/regKey/add', { token, method: 'POST', data: { code: 'ONE-USE', roleId: 1, count: 1, expireTime: '2030-12-31 23:59:59' } })).code).toBe(200);
		const registered = await request('/register', { method: 'POST', data: { email: 'invited@example.com', password: 'invite-password', code: 'ONE-USE' } });
		expect(registered.code, registered.message).toBe(200);
		expect(await login('invited@example.com', 'invite-password')).toBeTypeOf('string');
		expect(env.db.prepare('SELECT count FROM reg_key WHERE code = ?').get('ONE-USE').count).toBe(0);
		expect((await request('/register', { method: 'POST', data: { email: 'second@example.com', password: 'invite-password', code: 'ONE-USE' } })).code).not.toBe(200);
		env.db.prepare('UPDATE reg_key SET count = 1 WHERE code = ?').run('ONE-USE');
		env.db.prepare('INSERT INTO user (email, password, salt) VALUES (?, ?, ?)').run('orphan@example.com', 'fixture', 'fixture');
		expect((await request('/register', { method: 'POST', data: { email: 'orphan@example.com', password: 'invite-password', code: 'ONE-USE' } })).code).not.toBe(200);
		expect(env.db.prepare('SELECT count FROM reg_key WHERE code = ?').get('ONE-USE').count).toBe(1);
	});
});
