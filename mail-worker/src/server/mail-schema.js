// Mail queues belong to the application database, independently of Postfix's spool.
// No network work runs inside a SQLite transaction.
export function migrateMail(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mail_ingress (
      ingress_key TEXT PRIMARY KEY, recipient TEXT NOT NULL, email_id INTEGER,
      disposition TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mail_outbox (
      outbox_id TEXT PRIMARY KEY, email_id INTEGER, message_id TEXT NOT NULL UNIQUE,
      envelope_from TEXT NOT NULL, recipients TEXT NOT NULL, raw_mime BLOB,
      state TEXT NOT NULL DEFAULT 'pending', queue_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mail_outbox_pending ON mail_outbox(state, next_attempt);
    CREATE INDEX IF NOT EXISTS idx_mail_outbox_email ON mail_outbox(email_id);
    CREATE TABLE IF NOT EXISTS mail_delivery (
      outbox_id TEXT NOT NULL, recipient TEXT NOT NULL COLLATE NOCASE,
      state TEXT NOT NULL DEFAULT 'pending', detail TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL,
      PRIMARY KEY(outbox_id, recipient)
    );
    CREATE TABLE IF NOT EXISTS mail_queue (
      queue_id TEXT PRIMARY KEY, message_id TEXT NOT NULL, outbox_id TEXT,
      accepted INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS mail_event (
      event_key TEXT PRIMARY KEY, queue_id TEXT NOT NULL, recipient TEXT NOT NULL,
      state TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL,
      processed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_mail_event_queue ON mail_event(queue_id, processed);
    CREATE TABLE IF NOT EXISTS mail_log_cursor (
      path TEXT PRIMARY KEY, inode TEXT NOT NULL, offset INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS mail_notification (
      email_id INTEGER PRIMARY KEY, state TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0,
      last_error TEXT NOT NULL DEFAULT ''
    );
  `);
  if (!db.prepare('PRAGMA table_info(mail_queue)').all().some(column => column.name === 'accepted')) {
    db.exec('ALTER TABLE mail_queue ADD COLUMN accepted INTEGER NOT NULL DEFAULT 0');
  }
}

export function insertRow(db, table, values) {
  // Both the table and property names are supplied by application code, never by a request.
  const keys = Object.keys(values).filter(key => values[key] !== undefined);
  const names = keys.map(key => key.replace(/[A-Z]/g, value => '_' + value.toLowerCase()));
  const result = db.prepare(`INSERT INTO ${table} (${names.map(key => '"' + key + '"').join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map(key => values[key]));
  return Number(result.lastInsertRowid);
}

export function camelRow(row) {
  return row && Object.fromEntries(Object.entries(row).map(([key, value]) =>
    [key.replace(/_([a-z])/g, (_, char) => char.toUpperCase()), value]));
}
