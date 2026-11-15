import Database from 'better-sqlite3';
import { cp, mkdir, open, readdir, rename, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireDataLock } from './lock.js';

const exists = path => stat(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });

export const restoreMarkerPath = config => `${config.sqlitePath}.restore-in-progress.json`;

function recoveryInstructions(config) {
  return `Restore recovery is required: ${restoreMarkerPath(config)}. Stop app and mail services; inspect this marker, the .pre-restore-* copies and .restore-* staging paths. Restore a matching database and objects set, then manually remove the marker before starting or retrying restore. See doc/server-deployment.md.`;
}

export async function assertNoPendingRestore(config) {
  if (await exists(restoreMarkerPath(config))) throw new Error(recoveryInstructions(config));
}

async function syncDirectory(path) {
  let handle;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch (error) {
    if (process.platform !== 'win32' || !['EISDIR', 'EPERM', 'EACCES', 'EINVAL', 'ENOTSUP', 'EBADF'].includes(error.code)) throw error;
  } finally { await handle?.close(); }
}

async function syncFile(path) {
  const handle = await open(path, process.platform === 'win32' ? 'r+' : 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncObjects(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = `${path}/${entry.name}`;
    if (entry.isDirectory()) await syncObjects(child);
    else if (entry.isFile()) await syncFile(child);
    else throw new Error('Backup objects must contain only regular files and directories.');
  }
  await syncDirectory(path);
}

async function writeRestoreMarker(config, contents) {
  const handle = await open(restoreMarkerPath(config), 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(contents, null, 2));
    await handle.sync();
  } finally { await handle.close(); }
  await syncDirectory(dirname(config.sqlitePath));
}

async function clearRestoreMarker(config) {
  const marker = restoreMarkerPath(config);
  const contents = await readFile(marker);
  await rm(marker);
  try {
    await syncDirectory(dirname(config.sqlitePath));
  } catch (error) {
    // If durable removal cannot be confirmed, keep the startup guard visible.
    await writeFile(marker, contents, { flag: 'wx', mode: 0o600 }).catch(writeError => { if (writeError.code !== 'EEXIST') throw writeError; });
    throw error;
  }
}
function within(parent, child) {
  const path = relative(resolve(parent), resolve(child));
  return !path || (!path.startsWith('..') && !isAbsolute(path));
}
function verifyDatabase(path) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('SQLite integrity check failed');
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get()) throw new Error('Not a Cloud Mail server database');
  } finally { db.close(); }
}

export async function backupData(config, destination) {
  const target = resolve(destination);
  if (within(config.objectsDir, target) || within(target, config.objectsDir) || within(target, config.sqlitePath)) throw new Error('Backup destination overlaps the application data');
  const release = await acquireDataLock(config.sqlitePath);
  const staging = `${target}.tmp-${randomUUID()}`;
  let db;
  try {
    await assertNoPendingRestore(config);
    if (await exists(target)) throw new Error('Backup destination already exists');
    await mkdir(staging, { recursive: true });
    db = new Database(config.sqlitePath, { fileMustExist: true });
    await db.backup(`${staging}/cloud-mail.sqlite`);
    db.close(); db = undefined;
    verifyDatabase(`${staging}/cloud-mail.sqlite`);
    if (await exists(config.objectsDir)) await cp(config.objectsDir, `${staging}/objects`, { recursive: true });
    else await mkdir(`${staging}/objects`);
    await writeFile(`${staging}/manifest.json`, JSON.stringify({ format: 1, createdAt: new Date().toISOString(), database: 'cloud-mail.sqlite', objects: 'objects' }, null, 2));
    await rename(staging, target);
    return target;
  } finally {
    db?.close();
    try { await rm(staging, { recursive: true, force: true }); }
    finally { await release(); }
  }
}

export async function restoreData(config, source) {
  const backup = resolve(source);
  if (within(config.objectsDir, backup) || within(backup, config.objectsDir) || within(backup, config.sqlitePath)) throw new Error('Restore source overlaps the application data');
  const manifest = JSON.parse(await readFile(`${backup}/manifest.json`, 'utf8'));
  if (manifest.format !== 1 || manifest.database !== 'cloud-mail.sqlite' || manifest.objects !== 'objects') throw new Error('Unsupported backup format');
  verifyDatabase(`${backup}/cloud-mail.sqlite`);
  if (!(await stat(`${backup}/objects`)).isDirectory()) throw new Error('Backup objects directory is missing');
  const release = await acquireDataLock(config.sqlitePath);
  const suffix = `.pre-restore-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const stagingDb = `${config.sqlitePath}.restore-${randomUUID()}`;
  const stagingObjects = `${config.objectsDir}.restore-${randomUUID()}`;
  let oldDb = false, oldObjects = false, newDb = false, newObjects = false;
  let markerCreated = false;
  try {
    await assertNoPendingRestore(config);
    await mkdir(dirname(config.objectsDir), { recursive: true });
    await cp(`${backup}/cloud-mail.sqlite`, stagingDb, { errorOnExist: true, force: false });
    await cp(`${backup}/objects`, stagingObjects, { recursive: true });
    await syncFile(stagingDb);
    await syncObjects(stagingObjects);
    const previousDatabaseExists = await exists(config.sqlitePath);
    const previousObjectsExist = await exists(config.objectsDir);
    await writeRestoreMarker(config, {
      format: 1, operation: 'restore', status: 'in-progress', startedAt: new Date().toISOString(), source: backup,
      database: config.sqlitePath, objects: config.objectsDir, stagingDatabase: stagingDb, stagingObjects,
      previousDatabase: config.sqlitePath + suffix, previousObjects: config.objectsDir + suffix,
      previousDatabaseExists, previousObjectsExist,
    });
    markerCreated = true;
    if (await exists(config.sqlitePath)) {
      const db = new Database(config.sqlitePath);
      try { db.pragma('wal_checkpoint(TRUNCATE)'); } finally { db.close(); }
      await rename(config.sqlitePath, config.sqlitePath + suffix); oldDb = true;
    }
    // A stopped, checkpointed database must not inherit stale WAL/SHM files.
    for (const ext of ['-wal', '-shm']) await rm(config.sqlitePath + ext, { force: true });
    if (await exists(config.objectsDir)) { await rename(config.objectsDir, config.objectsDir + suffix); oldObjects = true; }
    await rename(stagingDb, config.sqlitePath); newDb = true;
    await rename(stagingObjects, config.objectsDir); newObjects = true;
    await syncDirectory(dirname(config.sqlitePath));
    await syncDirectory(dirname(config.objectsDir));
    await clearRestoreMarker(config);
    return { database: config.sqlitePath, objects: config.objectsDir, previousSuffix: suffix };
  } catch (error) {
    try {
      if (newDb) await rm(config.sqlitePath, { force: true });
      if (newObjects) await rm(config.objectsDir, { recursive: true, force: true });
      if (oldDb) await rename(config.sqlitePath + suffix, config.sqlitePath);
      if (oldObjects) await rename(config.objectsDir + suffix, config.objectsDir);
      if (markerCreated) {
        await syncDirectory(dirname(config.sqlitePath));
        await syncDirectory(dirname(config.objectsDir));
        await clearRestoreMarker(config);
      }
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], `Restore failed and rollback could not finish. ${recoveryInstructions(config)}`);
    }
    if (await exists(restoreMarkerPath(config))) throw new Error(`Restore did not complete. ${recoveryInstructions(config)}`, { cause: error });
    throw error;
  } finally {
    try {
      // Leave all remaining copies available to an operator after interrupted
      // recovery; starting the app is blocked while the durable marker exists.
      if (!(await exists(restoreMarkerPath(config)))) {
        await rm(stagingDb, { force: true });
        await rm(stagingObjects, { recursive: true, force: true });
      }
    } finally { await release(); }
  }
}
