import { drizzle } from 'drizzle-orm/better-sqlite3';
import { BASELINE_SQL, PERMISSIONS } from './schema.js';
import setting from '../entity/setting.js';
import cryptoUtils from '../utils/crypto-utils.js';
import KvConst from '../const/kv-const.js';
import { FOUNDATION_SCHEMA } from '../modules/shared/schema.js';
import { SOURCE_SCHEMA } from '../modules/mail-sources/schema.js';
import { LINK_SCHEMA } from '../modules/links/schema.js';
import { VERIFICATION_SCHEMA } from '../modules/verification/schema.js';
import { NODE_SCHEMA, NODE_PUBLIC_IP_SCHEMA } from '../modules/nodes/schema.js';
import { DOMAIN_SCHEMA } from '../modules/domains/schema.js';
import { ADMINISTRATOR_SCHEMA } from '../modules/administrators/schema.js';

const migrations = [
	{
		version: 1,
		name: 'cloud-mail-v3.5-baseline',
		up(db) {
			db.exec(BASELINE_SQL);
			db.prepare('INSERT INTO setting (title) SELECT ? WHERE NOT EXISTS (SELECT 1 FROM setting)').run('Cloud Mail');
			if (db.prepare('SELECT count(*) AS count FROM perm').get().count === 0) {
				const insert = db.prepare('INSERT INTO perm (perm_id, name, perm_key, pid, type, sort) VALUES (?, ?, ?, ?, ?, ?)');
				for (const permission of PERMISSIONS) insert.run(...permission);
			}
			if (db.prepare('SELECT count(*) AS count FROM role').get().count === 0) {
				db.prepare(`INSERT INTO role (role_id, name, description, user_id, is_default, send_type, account_count)
					VALUES (1, ?, ?, 0, 1, 'ban', 10)`).run('普通用户', '只有普通使用权限');
				const insert = db.prepare('INSERT INTO role_perm (role_id, perm_id) VALUES (1, ?)');
				for (const permission of [2, 21, 22, 23, 24, 4, 5, 1, 3]) insert.run(permission);
			}
		}
	},
	{
		version: 2,
		name: 'persistent-kv',
		up(db) {
			db.exec(`CREATE TABLE server_kv (key TEXT PRIMARY KEY, value BLOB NOT NULL, metadata TEXT, expiration INTEGER);
				CREATE INDEX idx_server_kv_expiration ON server_kv(expiration) WHERE expiration IS NOT NULL;`);
		}
	},
	{
		version: 3,
		name: 'recipient-links-and-source-mailboxes',
		up(db) {
			db.exec(FOUNDATION_SCHEMA);
			db.exec(SOURCE_SCHEMA);
			db.exec(LINK_SCHEMA);
		}
	},
	{
		version: 4,
		name: 'mailbox-verification-and-readonly-nodes',
		up(db) {
			db.exec(VERIFICATION_SCHEMA);
			db.exec(NODE_SCHEMA);
		}
	},
	{
		version: 5,
		name: 'managed-mail-domains',
		up(db) {
			db.exec(DOMAIN_SCHEMA);
		}
	},
	{
		version: 6,
		name: 'persistent-site-administrators',
		up(db) {
			db.exec(ADMINISTRATOR_SCHEMA);
		}
	},
	{
		version: 7,
		name: 'remove-registration-key-permissions',
		up(db) {
			db.exec(`DELETE FROM role_perm WHERE perm_id IN (SELECT perm_id FROM perm WHERE perm_id = 33 OR pid = 33);
				DELETE FROM perm WHERE perm_id = 33 OR pid = 33;`);
		}
	},
	{
		version: 8,
		name: 'reported-node-public-ip',
		up(db) {
			db.exec(NODE_PUBLIC_IP_SCHEMA);
		}
	}
];

export function migrateDatabase(db) {
	db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
		version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
	)`);
	const latest = db.prepare('SELECT max(version) AS version FROM schema_migrations').get().version || 0;
	if (latest > migrations.at(-1).version) throw new Error('The database schema is newer than this application.');
	for (const migration of migrations) {
		db.transaction(() => {
			if (db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(migration.version)) return;
			migration.up(db);
			db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(migration.version, migration.name);
		}).immediate();
	}
}

export async function bootstrapAdmin(env) {
	const { db, admin, admin_password: password } = env;
	if (!db || !admin) throw new Error('SQLite and an administrator email are required.');
	const initialized = db.prepare('SELECT initialized FROM site_administrator_state WHERE id=1').get()?.initialized === 1 ||
		!!db.prepare('SELECT 1 FROM site_administrator LIMIT 1').get();
	if (initialized) db.prepare('UPDATE site_administrator_state SET initialized=1 WHERE id=1').run();
	let existing = initialized ? null : db.prepare('SELECT user_id FROM user WHERE email = ? COLLATE NOCASE').get(admin);
	let created = false;
	if (!initialized && !existing) {
		if (typeof password !== 'string' || password.trim().length < 12) throw new Error('The initial administrator password must contain at least 12 characters.');
		if (/^REPLACE_/i.test(password.trim())) throw new Error('The initial administrator password must replace the example placeholder with a unique password.');
		const { salt, hash } = await cryptoUtils.hashPassword(password);
		existing = db.transaction(() => {
			const present = db.prepare('SELECT user_id FROM user WHERE email = ? COLLATE NOCASE').get(admin);
			if (present) return present;
			const role = db.prepare('SELECT role_id FROM role WHERE is_default = 1 ORDER BY role_id LIMIT 1').get();
			if (!role) throw new Error('A default role is required before administrator initialization.');
			const result = db.prepare('INSERT INTO user (email, password, salt, type) VALUES (?, ?, ?, ?)').run(admin, hash, salt, role.role_id);
			const userId = Number(result.lastInsertRowid);
			db.prepare('INSERT INTO account (email, name, user_id) VALUES (?, ?, ?)').run(admin, admin.split('@')[0], userId);
			created = true;
			return { user_id: userId };
		}).immediate();
	}
	if (!initialized) {
		db.transaction(() => {
			if (db.prepare('SELECT initialized FROM site_administrator_state WHERE id=1').get()?.initialized === 1) return;
			db.prepare('INSERT OR IGNORE INTO site_administrator(user_id,granted_at,granted_by) VALUES(?,?,NULL)').run(existing.user_id, Date.now());
			db.prepare('UPDATE site_administrator_state SET initialized=1 WHERE id=1').run();
		}).immediate();
	}
	if (env.kv) {
		const settingRow = (env.orm || drizzle(db)).select().from(setting).get();
		settingRow.resendTokens = JSON.parse(settingRow.resendTokens);
		await env.kv.put(KvConst.SETTING, JSON.stringify(settingRow));
	}
	if (!existing) existing = db.prepare('SELECT user_id FROM site_administrator ORDER BY granted_at,user_id LIMIT 1').get();
	return { created, userId: existing?.user_id ?? null };
}
