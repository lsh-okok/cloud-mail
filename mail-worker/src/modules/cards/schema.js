export const CARD_SCHEMA = `
CREATE TABLE mailbox_card (
  id TEXT PRIMARY KEY,
  mailbox_id TEXT NOT NULL,
  code_digest TEXT NOT NULL UNIQUE,
  code_encrypted TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 1 CHECK(is_current IN (0,1)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  redeemed_at INTEGER,
  revoked_at INTEGER,
  supersedes_card_id TEXT REFERENCES mailbox_card(id),
  bound_local_account_id INTEGER,
  bound_email TEXT NOT NULL,
  bound_mx_domain TEXT,
  created_by INTEGER
);
CREATE UNIQUE INDEX idx_mailbox_card_current ON mailbox_card(mailbox_id) WHERE is_current=1;
CREATE INDEX idx_mailbox_card_history ON mailbox_card(mailbox_id,created_at,id);
CREATE TABLE redemption_order (
  order_no TEXT PRIMARY KEY,
  request_key_digest TEXT NOT NULL UNIQUE,
  query_key_digest TEXT NOT NULL UNIQUE,
  request_fingerprint TEXT NOT NULL,
  batch INTEGER NOT NULL CHECK(batch IN (0,1)),
  status TEXT NOT NULL CHECK(status IN ('success','partial','failed')),
  created_at INTEGER NOT NULL,
  result_encrypted TEXT NOT NULL,
  file_encrypted TEXT,
  filename TEXT,
  content_type TEXT,
  file_size INTEGER NOT NULL DEFAULT 0,
  file_sha256 TEXT,
  stored_bytes INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_redemption_order_created ON redemption_order(created_at,order_no);
CREATE TABLE redemption_order_item (
  id TEXT PRIMARY KEY,
  order_no TEXT NOT NULL REFERENCES redemption_order(order_no),
  ordinal INTEGER NOT NULL,
  card_id TEXT REFERENCES mailbox_card(id),
  mailbox_id TEXT,
  ok INTEGER NOT NULL CHECK(ok IN (0,1)),
  payload_encrypted TEXT NOT NULL,
  UNIQUE(order_no,ordinal)
);
CREATE INDEX idx_redemption_order_item_mailbox ON redemption_order_item(mailbox_id,order_no);
CREATE TABLE card_redemption (
  card_id TEXT PRIMARY KEY REFERENCES mailbox_card(id),
  order_item_id TEXT NOT NULL UNIQUE REFERENCES redemption_order_item(id),
  redeemed_at INTEGER NOT NULL,
  bound_snapshot_encrypted TEXT NOT NULL
);
CREATE TABLE card_management_operation (
  actor_id INTEGER NOT NULL,
  operation_digest TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  new_card_id TEXT NOT NULL REFERENCES mailbox_card(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(actor_id,operation_digest)
);
`;

export const CARDS_SCHEMA = CARD_SCHEMA;
