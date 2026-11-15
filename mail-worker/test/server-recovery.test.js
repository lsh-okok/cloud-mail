import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { loadConfig } from '../src/server/config.js';
import { createEnvironment } from '../src/server/environment.js';
import { backupData, restoreData, restoreMarkerPath } from '../src/server/backup.js';

const faults = vi.hoisted(() => ({ objectDestination: '', databaseRollbackDestination: '', marker: '', markerObserved: false }));
vi.mock('node:fs/promises', async importOriginal => {
	const original = await importOriginal();
	return {
		...original,
		async rename(source, destination) {
			if (destination === faults.objectDestination && source.startsWith(`${destination}.restore-`)) {
				faults.objectDestination = '';
				faults.markerObserved = Boolean(await original.stat(faults.marker));
				throw Object.assign(new Error('Simulated object directory swap failure'), { code: 'EIO' });
			}
			if (destination === faults.databaseRollbackDestination && source.startsWith(`${destination}.pre-restore-`)) {
				faults.databaseRollbackDestination = '';
				throw Object.assign(new Error('Simulated rollback failure'), { code: 'EIO' });
			}
			return original.rename(source, destination);
		},
	};
});

const directories = [];
const databases = [];
const exists = path => stat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'cloud-mail-recovery-'));
	directories.push(root);
	const config = loadConfig({
		MAIL_DOMAINS: 'example.com', MAIL_HOST: 'mail.example.com',
		ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'administrator-password',
		JWT_SECRET: 'recovery-test-secret-at-least-32-characters', DATA_DIR: join(root, 'data'),
	});
	const env = await createEnvironment(config);
	databases.push(env.db);
	await env.storage.put('attachments/state', 'backup-object');
	env.db.prepare('UPDATE setting SET title = ?').run('Backup database');
	env.db.close();
	const backup = join(root, 'backup');
	await backupData(config, backup);
	return { root, config, backup };
}
async function changeCurrentData(config) {
	const env = await createEnvironment(config);
	databases.push(env.db);
	env.db.prepare('UPDATE setting SET title = ?').run('Current database');
	await env.storage.put('attachments/state', 'current-object');
	env.db.close();
}
afterEach(async () => {
	faults.objectDestination = '';
	faults.databaseRollbackDestination = '';
	faults.marker = '';
	faults.markerObserved = false;
	for (const db of databases.splice(0)) if (db.open) db.close();
	for (const root of directories.splice(0)) {
		if (!resolve(root).startsWith(`${resolve(tmpdir())}${sep}`) || !basename(root).startsWith('cloud-mail-recovery-')) throw new Error('Unexpected recovery test directory.');
		await rm(root, { recursive: true, force: true });
	}
});

describe('restore recovery boundaries', () => {
	it('rejects a database inside or equal to the object root before opening files', () => {
		const base = { MAIL_DOMAINS: 'example.com', JWT_SECRET: 's'.repeat(32), OBJECTS_DIR: join(tmpdir(), 'object-root') };
		expect(() => loadConfig({ ...base, SQLITE_PATH: join(base.OBJECTS_DIR, 'mail.sqlite') })).toThrow('outside OBJECTS_DIR');
		expect(() => loadConfig({ ...base, SQLITE_PATH: base.OBJECTS_DIR })).toThrow('outside OBJECTS_DIR');
		expect(loadConfig({ ...base, SQLITE_PATH: `${base.OBJECTS_DIR}-database.sqlite` }).sqlitePath).toContain('-database.sqlite');
	});

	it('blocks startup, backup and another restore when an interrupted restore has moved the database', async () => {
		const { config, backup, root } = await fixture();
		const previous = `${config.sqlitePath}.pre-restore-interrupted`;
		await writeFile(restoreMarkerPath(config), JSON.stringify({ format: 1, database: config.sqlitePath, previousDatabase: previous }));
		await rename(config.sqlitePath, previous);
		await expect(createEnvironment(config)).rejects.toThrow('Restore recovery is required');
		expect(await exists(config.sqlitePath)).toBe(false);
		await expect(backupData(config, join(root, 'second-backup'))).rejects.toThrow('Restore recovery is required');
		await expect(restoreData(config, backup)).rejects.toThrow('Restore recovery is required');
		expect(await exists(restoreMarkerPath(config))).toBe(true);
		expect(await exists(previous)).toBe(true);
	});

	it('restores a matching database and objects set and clears its marker only on success', async () => {
		const { config, backup } = await fixture();
		await changeCurrentData(config);
		await restoreData(config, backup);
		expect(await exists(restoreMarkerPath(config))).toBe(false);
		const env = await createEnvironment(config);
		databases.push(env.db);
		expect(env.db.prepare('SELECT title FROM setting').get().title).toBe('Backup database');
		expect(await (await env.storage.get('attachments/state')).text()).toBe('backup-object');
	});

	it('fully rolls back a failed swap before removing the durable marker', async () => {
		const { config, backup } = await fixture();
		await changeCurrentData(config);
		faults.objectDestination = config.objectsDir;
		faults.marker = restoreMarkerPath(config);
		await expect(restoreData(config, backup)).rejects.toThrow('Simulated object directory swap failure');
		expect(faults.markerObserved).toBe(true);
		expect(await exists(restoreMarkerPath(config))).toBe(false);
		const env = await createEnvironment(config);
		databases.push(env.db);
		expect(env.db.prepare('SELECT title FROM setting').get().title).toBe('Current database');
		expect(await (await env.storage.get('attachments/state')).text()).toBe('current-object');
	});

	it('retains the marker and remaining recovery copies if rollback itself fails', async () => {
		const { config, backup } = await fixture();
		await changeCurrentData(config);
		faults.objectDestination = config.objectsDir;
		faults.databaseRollbackDestination = config.sqlitePath;
		faults.marker = restoreMarkerPath(config);
		await expect(restoreData(config, backup)).rejects.toThrow('rollback could not finish');
		const marker = JSON.parse(await readFile(restoreMarkerPath(config), 'utf8'));
		expect(marker.previousDatabaseExists).toBe(true);
		expect(await exists(marker.previousDatabase)).toBe(true);
		expect(await exists(marker.previousObjects)).toBe(true);
		expect(await exists(marker.stagingObjects)).toBe(true);
		await expect(createEnvironment(config)).rejects.toThrow('manually remove the marker');
		expect(await exists(config.sqlitePath)).toBe(false);
	});
});
