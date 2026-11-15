import lockfile from 'proper-lockfile';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function acquireDataLock(sqlitePath) {
  await mkdir(dirname(sqlitePath), { recursive: true });
  try {
    return await lockfile.lock(sqlitePath, {
      realpath: false, stale: 120000, update: 10000,
      onCompromised(error) {
        console.error('Database process lock lost:', error.message);
        process.exit(1);
      },
    });
  } catch (error) {
    if (error.code === 'ELOCKED') throw new Error('The data directory is in use. Stop the app before backup/restore; only one application instance is supported.');
    throw error;
  }
}
