export const NODE_SCHEMA = `
CREATE TABLE cluster_node (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, credential_digest TEXT NOT NULL UNIQUE,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1)),
  revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1)), status_version INTEGER NOT NULL DEFAULT 1,
  ip TEXT, last_heartbeat_at INTEGER, last_sync_at INTEGER, cursor INTEGER NOT NULL DEFAULT 0,
  ready INTEGER NOT NULL DEFAULT 0, initialized INTEGER NOT NULL DEFAULT 0,
  snapshot_completed INTEGER NOT NULL DEFAULT 0, snapshot_total INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE node_snapshot (
  id TEXT PRIMARY KEY, node_id TEXT NOT NULL REFERENCES cluster_node(id) ON DELETE CASCADE,
  boot_id TEXT NOT NULL, cursor INTEGER NOT NULL, total INTEGER NOT NULL,
  pages INTEGER NOT NULL, expires_at INTEGER NOT NULL, bytes INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_node_snapshot_expiry ON node_snapshot(expires_at);
CREATE TABLE node_snapshot_page (
  snapshot_id TEXT NOT NULL REFERENCES node_snapshot(id) ON DELETE CASCADE,
  page INTEGER NOT NULL, envelope TEXT NOT NULL, PRIMARY KEY(snapshot_id,page)
);
CREATE TABLE node_sync_meta (id INTEGER PRIMARY KEY CHECK(id=1), pruned_cursor INTEGER NOT NULL DEFAULT 0);
INSERT INTO node_sync_meta(id) VALUES(1);
CREATE TABLE node_replica_state (
  id INTEGER PRIMARY KEY CHECK(id=1), phase TEXT NOT NULL DEFAULT 'snapshot', cursor INTEGER NOT NULL DEFAULT 0,
  snapshot_id TEXT, snapshot_cursor INTEGER, snapshot_total INTEGER, snapshot_pages INTEGER,
  snapshot_next INTEGER NOT NULL DEFAULT 0, snapshot_expires_at INTEGER,
  initialized INTEGER NOT NULL DEFAULT 0, last_success_at INTEGER, last_error TEXT NOT NULL DEFAULT ''
);
INSERT INTO node_replica_state(id) VALUES(1);
CREATE TABLE node_replica_staging (
  position INTEGER PRIMARY KEY, type TEXT NOT NULL, object_id TEXT NOT NULL, revision INTEGER NOT NULL,
  data_json TEXT NOT NULL, UNIQUE(type,object_id)
);
CREATE TABLE node_replica_version (
  type TEXT NOT NULL, object_id TEXT NOT NULL, revision INTEGER NOT NULL,
  PRIMARY KEY(type,object_id)
);
`;
