export const VERIFICATION_SCHEMA = `
CREATE TABLE verification_source (
 id TEXT PRIMARY KEY, mailbox_id TEXT NOT NULL, mailbox_email TEXT NOT NULL,
 recipient TEXT NOT NULL COLLATE NOCASE, link_id TEXT NOT NULL UNIQUE,
 mode TEXT NOT NULL DEFAULT 'system', custom_url TEXT NOT NULL DEFAULT '', revision INTEGER NOT NULL DEFAULT 1,
 eligible INTEGER NOT NULL DEFAULT 1, reason TEXT NOT NULL DEFAULT '', fingerprint TEXT NOT NULL DEFAULT '',
 policy_json TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL
);
CREATE INDEX idx_verification_source_mailbox ON verification_source(mailbox_id,recipient);
CREATE TABLE verification_task (
 number INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued', options_json TEXT NOT NULL, parent_task_id TEXT,
 total INTEGER NOT NULL, processed INTEGER NOT NULL DEFAULT 0, passed INTEGER NOT NULL DEFAULT 0,
 failed INTEGER NOT NULL DEFAULT 0, pending INTEGER NOT NULL DEFAULT 0,
 skipped_json TEXT NOT NULL DEFAULT '[]', original_unpassed INTEGER NOT NULL DEFAULT 0, last_recheck_json TEXT,
 error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER,
 idempotency_key TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL
);
CREATE TABLE verification_item (
 id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES verification_task(id), ordinal INTEGER NOT NULL,
 source_id TEXT NOT NULL, snapshot_json TEXT NOT NULL, result TEXT NOT NULL DEFAULT 'pending',
 processed INTEGER NOT NULL DEFAULT 0, phase TEXT NOT NULL DEFAULT 'queued', marker TEXT,
 sender_email TEXT, http_status INTEGER, note TEXT NOT NULL DEFAULT '', started_at INTEGER,
 sent_at INTEGER, checked_at INTEGER, UNIQUE(task_id,ordinal)
);
CREATE INDEX idx_verification_items_task ON verification_item(task_id,ordinal);
CREATE TABLE verification_smtp (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL,
 email TEXT NOT NULL COLLATE NOCASE UNIQUE, encryption TEXT NOT NULL,
 password_encrypted TEXT, enabled INTEGER NOT NULL DEFAULT 1, last_used_at INTEGER,
 revision INTEGER NOT NULL DEFAULT 1
);
CREATE UNIQUE INDEX idx_verification_smtp_default ON verification_smtp(kind) WHERE kind='default';
CREATE TABLE verification_plan (
 id INTEGER PRIMARY KEY CHECK(id=1), enabled INTEGER NOT NULL DEFAULT 0,
 time TEXT NOT NULL DEFAULT '02:00', options_json TEXT NOT NULL DEFAULT '{"sample":1,"timeoutSeconds":10,"concurrency":5,"waitSeconds":60,"sendIntervalMs":1000,"mailboxIds":[]}',
 revision INTEGER NOT NULL DEFAULT 1, last_claim_date TEXT, last_task_id TEXT,
 last_run_at INTEGER, last_status TEXT, last_error TEXT NOT NULL DEFAULT ''
);
INSERT INTO verification_plan(id) VALUES(1);
`;
