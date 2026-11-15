import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function createDatabase(filePath) {
	if (!filePath) throw new Error('A SQLite database path is required.');
	const target = filePath === ':memory:' ? filePath : resolve(filePath);
	if (target !== ':memory:') mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
	const db = new Database(target);
	try {
		db.pragma('journal_mode = WAL');
		db.pragma('synchronous = FULL');
		db.pragma('busy_timeout = 5000');
		db.pragma('foreign_keys = ON');
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}

// Compile each statement only after its predecessors have executed. This also
// supports a migration adding a column before a later statement references it.
export function executeBatch(db, statements) {
	return db.transaction(() => statements.map(({ sql, params = [] }) => {
		const statement = db.prepare(sql);
		return statement.reader ? statement.all(...params) : statement.run(...params);
	}))();
}
