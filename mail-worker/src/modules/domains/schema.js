export const DOMAIN_SCHEMA = `
CREATE TABLE mail_domain (
  domain TEXT PRIMARY KEY COLLATE NOCASE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  is_default INTEGER NOT NULL DEFAULT 0 CHECK(is_default IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK(is_default <= enabled)
);
CREATE UNIQUE INDEX idx_mail_domain_default ON mail_domain(is_default) WHERE is_default = 1;
`;
