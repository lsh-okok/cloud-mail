export const ADMINISTRATOR_SCHEMA = `
CREATE TABLE IF NOT EXISTS site_administrator (
  user_id INTEGER PRIMARY KEY REFERENCES user(user_id) ON DELETE CASCADE,
  granted_at INTEGER NOT NULL,
  granted_by INTEGER REFERENCES user(user_id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS site_administrator_state (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  initialized INTEGER NOT NULL DEFAULT 0 CHECK(initialized IN (0,1))
);
INSERT OR IGNORE INTO site_administrator_state(id,initialized) VALUES(1,0);
`;
