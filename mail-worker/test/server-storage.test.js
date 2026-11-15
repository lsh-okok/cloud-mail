import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { createDatabase, executeBatch } from '../src/server/database.js';
import { bootstrapAdmin, migrateDatabase } from '../src/server/migrations.js';
import { initializeDomains } from '../src/modules/domains/service.js';
import { createKV } from '../src/server/kv.js';
import { createStorage } from '../src/server/storage.js';
import cryptoUtils from '../src/utils/crypto-utils.js';
import email from '../src/entity/email.js';
import account from '../src/entity/account.js';
import user from '../src/entity/user.js';
import setting from '../src/entity/setting.js';
import { att } from '../src/entity/att.js';
import { oauth } from '../src/entity/oauth.js';
import role from '../src/entity/role.js';
import perm from '../src/entity/perm.js';
import rolePerm from '../src/entity/role-perm.js';
import { star } from '../src/entity/star.js';
import verifyRecord from '../src/entity/verify-record.js';
import attService from '../src/service/att-service.js';
import publicService from '../src/service/public-service.js';
import analysisDao from '../src/dao/analysis-dao.js';

const diskFault = vi.hoisted(() => ({ failNextSync: false }));
vi.mock('node:fs/promises', async importOriginal => {
	const original = await importOriginal();
	return {
		...original,
		async open(...arguments_) {
			const handle = await original.open(...arguments_);
			const sync = handle.sync.bind(handle);
			handle.sync = async () => {
				if (diskFault.failNextSync && arguments_[1] === 'wx') {
					diskFault.failNextSync = false;
					throw Object.assign(new Error('Simulated disk sync failure'), { code: 'EIO' });
				}
				return sync();
			};
			return handle;
		},
	};
});

const databases = [];
const directories = [];
function temporaryDirectory() {
	const root = mkdtempSync(join(tmpdir(), 'cloud-mail-storage-'));
	directories.push(root);
	return root;
}
function database(path = ':memory:') {
	const db = createDatabase(path);
	databases.push(db);
	migrateDatabase(db);
	return db;
}
function context(db, storage) {
	initializeDomains({ db, domain: ['example.com'] });
	const cached = {};
	return {
		env: { db, orm: drizzle(db), storage, domain: ['example.com'] },
		get: name => name === 'setting' ? cached : undefined,
		req: { header: () => "Example browser's user agent" },
	};
}
afterEach(() => {
	diskFault.failNextSync = false;
	for (const db of databases.splice(0)) if (db.open) db.close();
	for (const root of directories.splice(0)) {
		if (!resolve(root).startsWith(`${resolve(tmpdir())}${sep}`) || !basename(root).startsWith('cloud-mail-storage-')) throw new Error('Unexpected test directory.');
		rmSync(root, { recursive: true, force: true });
	}
});

describe('SQLite persistence and migrations', () => {
	it('creates every ORM column and preserves data and preferences on restart', async () => {
		const path = join(temporaryDirectory(), 'nested', 'mail.sqlite');
		let db = database(path);
		for (const table of [email, account, user, setting, att, oauth, role, perm, rolePerm, star, verifyRecord]) {
			const config = getTableConfig(table);
			const columns = new Set(db.prepare(`PRAGMA table_info("${config.name}")`).all().map(column => column.name));
			for (const column of config.columns) expect(columns.has(column.name), `${config.name}.${column.name}`).toBe(true);
		}
		db.prepare('UPDATE setting SET title = ?').run('My mailbox');
		db.prepare('INSERT INTO email (account_id, user_id, unread) VALUES (1, 1, 1)').run();
		const kv = createKV(db);
		await kv.put('session', JSON.stringify({ userId: 42 }));
		db.close();
		db = database(path);
		expect(db.prepare('SELECT title FROM setting').get().title).toBe('My mailbox');
		expect(db.prepare('SELECT unread FROM email').get().unread).toBe(1);
  expect(db.prepare('SELECT version,name FROM schema_migrations ORDER BY version').all()).toEqual([
    { version: 1, name: 'cloud-mail-v3.5-baseline' },
    { version: 2, name: 'persistent-kv' },
    { version: 3, name: 'recipient-links-and-source-mailboxes' },
    { version: 4, name: 'mailbox-verification-and-readonly-nodes' },
    { version: 5, name: 'managed-mail-domains' },
    { version: 6, name: 'persistent-site-administrators' },
    { version: 7, name: 'remove-registration-key-permissions' },
  ]);
		expect(await createKV(db).get('session', 'json')).toEqual({ userId: 42 });
		expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
		expect(db.pragma('synchronous', { simple: true })).toBe(2);
	});

	it('keeps case-insensitive uniqueness and rolls back a failed batch', () => {
		const db = database();
		expect(() => executeBatch(db, [
			{ sql: 'INSERT INTO account (email, user_id) VALUES (?, ?)', params: ['test@example.com', 1] },
			{ sql: 'INSERT INTO account (email, user_id) VALUES (?, ?)', params: ['TEST@example.com', 2] }
		])).toThrow();
		expect(db.prepare('SELECT count(*) AS total FROM account').get().total).toBe(0);
		executeBatch(db, [
			{ sql: 'CREATE TABLE migration_probe (id INTEGER)' },
			{ sql: 'ALTER TABLE migration_probe ADD COLUMN value TEXT' },
			{ sql: 'INSERT INTO migration_probe (id, value) VALUES (?, ?)', params: [1, 'ready'] }
		]);
		expect(db.prepare('SELECT value FROM migration_probe').get().value).toBe('ready');
	});

	it('creates the administrator once and leaves an existing password unchanged', async () => {
		const db = database();
		const env = { db, orm: drizzle(db), kv: createKV(db), admin: 'admin@example.com', admin_password: 'first-password-123' };
		expect((await bootstrapAdmin(env)).created).toBe(true);
		env.admin_password = 'replacement-password-456';
		expect((await bootstrapAdmin(env)).created).toBe(false);
		const row = db.prepare('SELECT * FROM user').get();
		expect(await cryptoUtils.verifyPassword('first-password-123', row.salt, row.password)).toBe(true);
		expect(await cryptoUtils.verifyPassword(env.admin_password, row.salt, row.password)).toBe(false);
		expect(db.prepare('SELECT user_id FROM account').get().user_id).toBe(row.user_id);
		expect((await env.kv.get('setting:', 'json')).title).toBe('Cloud Mail');
		delete env.admin_password;
		expect((await bootstrapAdmin(env)).created).toBe(false);
	});

	it('rejects missing, blank and template initial administrator passwords without creating an account', async () => {
		const db = database();
		const env = { db, admin: 'admin@example.com' };
		for (const password of [undefined, 'short', ' '.repeat(32), 'REPLACE_WITH_A_LONG_UNIQUE_PASSWORD']) {
			env.admin_password = password;
			await expect(bootstrapAdmin(env)).rejects.toThrow('administrator password');
			expect(db.prepare('SELECT count(*) AS total FROM user').get().total).toBe(0);
			expect(db.prepare('SELECT count(*) AS total FROM account').get().total).toBe(0);
		}
	});

	it('binds quotes safely and makes administrator batch user creation atomic', async () => {
		const db = database();
		const c = context(db);
		await publicService.addUser(c, { list: [{ email: "o'connor@example.com", password: 'a-password' }] });
		const row = db.prepare('SELECT * FROM user').get();
		expect(row.email).toBe("o'connor@example.com");
		expect(db.prepare('SELECT user_id FROM account').get().user_id).toBe(row.user_id);
		await expect(publicService.addUser(c, { list: [
			{ email: 'first@example.com', password: 'a-password' },
			{ email: "O'CONNOR@example.com", password: 'a-password' }
		] })).rejects.toThrow();
		expect(db.prepare('SELECT count(*) AS total FROM user').get().total).toBe(1);
		expect(db.prepare('SELECT count(*) AS total FROM account').get().total).toBe(1);
		expect((await analysisDao.numberCount(c)).userTotal).toBe(1);
	});

	it('removes obsolete invitation permissions when upgrading without changing active permissions', () => {
		const db = database();
		db.exec(`INSERT INTO perm (perm_id, name, pid) VALUES (33, 'obsolete', 0), (34, 'obsolete child', 33);
			INSERT INTO role_perm (role_id, perm_id) VALUES (1, 34);
			DELETE FROM schema_migrations WHERE version = 7;`);
		const active = db.prepare('SELECT * FROM role_perm WHERE perm_id = 22').all();
		migrateDatabase(db);
		expect(db.prepare('SELECT * FROM perm WHERE perm_id = 33 OR pid = 33').all()).toEqual([]);
		expect(db.prepare('SELECT * FROM role_perm WHERE perm_id = 34').all()).toEqual([]);
		expect(db.prepare('SELECT * FROM role_perm WHERE perm_id = 22').all()).toEqual(active);
	});
});

describe('persistent KV', () => {
	it('expires sessions and metadata and omits expired entries from listings', async () => {
		const db = database();
		let clock = 100000;
		const kv = createKV(db, { now: () => clock });
		await kv.put('auth:1', JSON.stringify({ userId: 1 }), { expirationTtl: 10, metadata: { session: true } });
		expect(await kv.get('auth:1', { type: 'json' })).toEqual({ userId: 1 });
		clock += 10000;
		expect((await kv.list({ prefix: 'auth:' })).keys).toEqual([]);
		expect(await kv.getWithMetadata('auth:1', 'json')).toEqual({ value: null, metadata: null });
		await kv.put('absolute', 'value', { expiration: 111 });
		clock += 1000;
		expect(await kv.get('absolute')).toBeNull();
	});

	it('round trips binary values and paginates literal prefixes without duplicates', async () => {
		const kv = createKV(database());
		await kv.put('bin', new Uint8Array([0, 255, 128, 10]), { metadata: { contentType: 'application/octet-stream' } });
		const binary = await kv.getWithMetadata('bin', { type: 'arrayBuffer' });
		expect([...new Uint8Array(binary.value)]).toEqual([0, 255, 128, 10]);
		expect(binary.metadata.contentType).toBe('application/octet-stream');
		for (const key of ['cache:%_1', 'cache:%_2', 'cache:%_3', 'cache:other']) await kv.put(key, key);
		const first = await kv.list({ prefix: 'cache:%_', limit: 2 });
		const second = await kv.list({ prefix: 'cache:%_', limit: 2, cursor: first.cursor });
		expect(first.list_complete).toBe(false);
		expect(second.list_complete).toBe(true);
		expect([...first.keys, ...second.keys].map(key => key.name)).toEqual(['cache:%_1', 'cache:%_2', 'cache:%_3']);
		await kv.delete('bin');
		expect(await kv.get('bin')).toBeNull();
	});

	it('increments counters atomically and starts a fresh value after expiration', async () => {
		let clock = 100000;
		const kv = createKV(database(), { now: () => clock });
		const counts = await Promise.all(Array.from({ length: 20 }, () => kv.increment('day-count', 1, { expirationTtl: 10 })));
		expect(counts).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
		expect(await kv.get('day-count', 'json')).toBe(20);
		clock += 10000;
		expect(await kv.increment('day-count', 2, { expirationTtl: 10 })).toBe(2);
	});
});

describe('local attachment storage', () => {
	it.each([
		['', 'attachments/inline.png'],
		['', '/attachments/inline.png'],
		['/mail', '/mail/attachments/inline.png'],
	])('embeds an existing local image when replying or forwarding from %s at %s', async (basePath, imageUrl) => {
		const db = database();
		const storage = createStorage(temporaryDirectory());
		const c = context(db, storage);
		c.env.base_path = basePath;
		await storage.put('attachments/inline.png', new Uint8Array([0, 255, 3]), { contentType: 'image/png' });
		db.prepare('INSERT INTO attachments (user_id, account_id, email_id, key, filename, mime_type, size) VALUES (1, 1, 1, ?, ?, ?, ?)')
			.run('attachments/inline.png', 'inline.png', 'image/png', 3);
		const { html, imageDataList } = await attService.toImageUrlHtml(c, `<img src="${imageUrl}"><img src="https://outside.test/picture.png">`);
		expect(imageDataList).toHaveLength(1);
		expect([...new Uint8Array(imageDataList[0].content)]).toEqual([0, 255, 3]);
		expect(imageDataList[0].filename).toBe('inline.png');
		expect(html).toContain(`src="cid:${imageDataList[0].contentId}"`);
		expect(html).toContain('src="https://outside.test/picture.png"');
	});

	it('preserves bytes and HTTP metadata across reopening and overwrites atomically', async () => {
		const path = temporaryDirectory();
		let storage = createStorage(path);
		await storage.put('attachments/binary.bin', new Uint8Array([0, 255, 3]), {
			contentType: 'application/test', contentDisposition: 'attachment; filename="example.bin"', cacheControl: 'max-age=60'
		});
		storage = createStorage(path);
		const response = await storage.get('attachments/binary.bin');
		expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0, 255, 3]);
		expect(response.headers.get('content-type')).toBe('application/test');
		expect(response.headers.get('content-disposition')).toContain('example.bin');
		expect(response.headers.get('cache-control')).toBe('max-age=60');
		expect(response.headers.get('content-length')).toBe('3');
		await storage.put('attachments/binary.bin', 'replacement', { contentType: 'text/plain' });
		expect(await (await storage.get('attachments/binary.bin')).text()).toBe('replacement');
		await storage.put('attachments/unicode', 'document', { contentDisposition: 'attachment;filename=文件.pdf' });
		expect((await storage.get('attachments/unicode')).headers.get('content-disposition')).toContain("filename*=UTF-8''%E6%96%87%E4%BB%B6.pdf");
		await storage.delete(['attachments/binary.bin', 'attachments/missing']);
		expect(await storage.get('attachments/binary.bin')).toBeNull();
	});

	it('rejects traversal and malformed response headers', async () => {
		const storage = createStorage(temporaryDirectory());
		for (const key of ['../outside', '/absolute', 'attachments/../outside', 'attachments\\outside', 'attachments/./file']) {
			await expect(storage.put(key, 'no')).rejects.toThrow('Invalid storage object key');
		}
		await expect(storage.put('attachments/safe', 'no', { contentType: 'text/plain\r\nX-Injected: yes' })).rejects.toThrow();
	});

	it('rejects an unflushed write and preserves the previously durable object', async () => {
		const storage = createStorage(temporaryDirectory());
		await storage.put('attachments/durable', 'previous');
		diskFault.failNextSync = true;
		await expect(storage.put('attachments/durable', 'unflushed')).rejects.toThrow('Simulated disk sync failure');
		expect(await (await storage.get('attachments/durable')).text()).toBe('previous');
	});

	it('retains shared blobs until the last reference, including several references removed together', async () => {
		const db = database();
		const storage = createStorage(temporaryDirectory());
		const c = context(db, storage);
		const insert = db.prepare('INSERT INTO attachments (user_id, account_id, email_id, key) VALUES (?, ?, ?, ?)');
		await storage.put('attachments/shared', 'shared');
		insert.run(1, 1, 1, 'attachments/shared');
		insert.run(2, 2, 2, 'attachments/shared');
		await attService.removeByEmailIds(c, [1]);
		expect(await (await storage.get('attachments/shared')).text()).toBe('shared');
		await attService.removeByEmailIds(c, [2]);
		expect(await storage.get('attachments/shared')).toBeNull();
		await storage.put('attachments/together', 'same-owner');
		insert.run(1, 1, 3, 'attachments/together');
		insert.run(1, 1, 4, 'attachments/together');
		await attService.removeByUserIds(c, [1]);
		expect(await storage.get('attachments/together')).toBeNull();
	});
});
