import { drizzle } from 'drizzle-orm/better-sqlite3';
import { createDatabase } from './database.js';
import { migrateDatabase, bootstrapAdmin } from './migrations.js';
import { createKV } from './kv.js';
import { createStorage } from './storage.js';
import { migrateMail } from './mail-schema.js';
import settingService from '../service/setting-service.js';
import { assertNoPendingRestore } from './backup.js';
import { createSecretVault } from '../modules/shared/secrets.js';
import { initializeDomains } from '../modules/domains/service.js';

export function serviceContext(env) {
  const values = new Map();
  return { env, get: key => values.get(key), set: (key, value) => values.set(key, value) };
}

export async function createEnvironment(config) {
  await assertNoPendingRestore(config);
  const db = createDatabase(config.sqlitePath);
  try {
    migrateDatabase(db);
    migrateMail(db);
    const kv = createKV(db);
    const role = config.node_role || 'primary';
    const savedRole = await kv.get('server:node-role');
    if (savedRole && savedRole !== role) throw new Error('NODE_ROLE cannot change for an existing database. Use a separate DATA_DIR for each node.');
    if (!savedRole && role === 'replica' && db.prepare('SELECT count(*) AS count FROM user').get().count) {
      throw new Error('A replica cannot use an existing primary database. Use a separate DATA_DIR.');
    }
    if (!savedRole) await kv.put('server:node-role', role);
    const env = {
      ...config, db, orm: drizzle(db, { logger: config.orm_log }),
      kv, storage: createStorage(config.objectsDir),
      secretVault: createSecretVault(config.data_keys || {}, { activeKeyId: config.data_key_id || 'v1' }),
      publicMailState: { sessions: new Map(), bytes: 0 },
      mailSourceState: {},
      verificationState: {}, nodeState: {},
    };
    if (config.node_role !== 'replica') {
      initializeDomains(env);
      await bootstrapAdmin(env);
      await settingService.refresh(serviceContext(env));
    }
    return env;
  } catch (error) {
    db.close();
    throw error;
  }
}
