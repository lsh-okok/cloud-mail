export const LINK_SCHEMA = `
CREATE TABLE platform_rule (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, emails_json TEXT NOT NULL,
  domains_json TEXT NOT NULL, keywords_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE mail_link (
  id TEXT PRIMARY KEY, mailbox_id TEXT NOT NULL REFERENCES source_mailbox(id) ON DELETE CASCADE,
  recipient TEXT NOT NULL COLLATE NOCASE,
  platform_id TEXT REFERENCES platform_rule(id) ON DELETE RESTRICT,
  expires_at INTEGER, token_digest TEXT NOT NULL UNIQUE, token_encrypted TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_mail_link_policy ON mail_link(mailbox_id, recipient COLLATE NOCASE, coalesce(platform_id, ''));
CREATE INDEX idx_mail_link_mailbox ON mail_link(mailbox_id, created_at, id);
CREATE INDEX idx_mail_link_localpart ON mail_link(mailbox_id, substr(recipient,1,instr(recipient,'@')-1) COLLATE NOCASE);
CREATE TABLE link_access (
  link_id TEXT PRIMARY KEY REFERENCES mail_link(id) ON DELETE CASCADE,
  page_visits INTEGER NOT NULL DEFAULT 0, json_visits INTEGER NOT NULL DEFAULT 0,
  last_access_at INTEGER
);
CREATE INDEX idx_public_mx_recipient ON email(to_email COLLATE NOCASE, type, is_del, email_id);
`;
