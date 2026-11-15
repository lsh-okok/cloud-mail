export const FOUNDATION_SCHEMA = `
CREATE TABLE feature_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  public_base_url TEXT NOT NULL DEFAULT '',
  time_zone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0)
);
INSERT INTO feature_settings(id) VALUES (1);
CREATE TABLE feature_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER,
  action TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id TEXT NOT NULL DEFAULT '',
  object_count INTEGER NOT NULL DEFAULT 1 CHECK (object_count >= 0),
  result TEXT NOT NULL DEFAULT 'success',
  request_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_feature_audit_created ON feature_audit(created_at, id);
CREATE INDEX idx_feature_audit_object ON feature_audit(object_type, object_id, id);
`;
