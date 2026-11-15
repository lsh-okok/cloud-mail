import { loadConfig } from './config.js';
import { backupData, restoreData } from './backup.js';
import Database from 'better-sqlite3';
import { outboxStatus, retryUncertainOutbox } from './delivery.js';
import { acquireDataLock } from './lock.js';

async function main() {
  const [command, argument, acknowledgement] = process.argv.slice(2);
  if (!['backup', 'restore', 'mail-status', 'mail-retry'].includes(command) || !argument) throw new Error('Usage: cli.cjs <backup|restore> <directory>, mail-status <delivery-id>, or mail-retry <delivery-id> --ack-duplicate-risk');
  const config = loadConfig();
  let result;
  if (command === 'backup' || command === 'restore') {
    result = command === 'backup' ? await backupData(config, argument) : await restoreData(config, argument);
  } else {
    if (command === 'mail-retry' && acknowledgement !== '--ack-duplicate-risk') throw new Error('Inspect Postfix queue and logs first. An uncertain SMTP submission may already be accepted; retry requires --ack-duplicate-risk.');
    const release = command === 'mail-retry' ? await acquireDataLock(config.sqlitePath) : null;
    let db;
    try {
      db = new Database(config.sqlitePath, { readonly: command === 'mail-status', fileMustExist: true });
      result = command === 'mail-status' ? outboxStatus({ db }, argument) : retryUncertainOutbox({ db }, argument);
    } finally { db?.close(); await release?.(); }
  }
  console.info(JSON.stringify({ command, result }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
