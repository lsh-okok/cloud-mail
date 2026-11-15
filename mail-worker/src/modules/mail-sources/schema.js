// Configuration events are inserted in the same transaction as their objects.
// Their payloads are explicit public projections, never credential records.
export const SOURCE_SCHEMA = `
CREATE TABLE source_mailbox (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE,
  provider TEXT NOT NULL CHECK(provider IN ('mx','outlook','icloud')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  public_id TEXT NOT NULL UNIQUE CHECK(length(public_id) = 10),
  revision INTEGER NOT NULL DEFAULT 1,
  generation INTEGER NOT NULL DEFAULT 1,
  local_account_id INTEGER,
  mx_domain TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(provider,email)
);
CREATE TABLE source_secret (
  mailbox_id TEXT PRIMARY KEY REFERENCES source_mailbox(id) ON DELETE CASCADE,
  envelope_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE sync_event (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_source_mailbox_listing ON source_mailbox(provider,enabled,email);
CREATE INDEX idx_sync_event_time ON sync_event(created_at,cursor);
CREATE INDEX idx_email_public_recipient ON email(to_email COLLATE NOCASE,account_id,type,is_del,email_id);
`;
