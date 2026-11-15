import { FeatureError } from '../shared/errors.js';

const fail = () => new FeatureError(409, 'SNAPSHOT_REQUIRED', 'The synchronization data is invalid. Start a new snapshot.');
const integer = (value, min = 0) => Number.isSafeInteger(value) && value >= min;
const text = (value, max = 8192) => typeof value === 'string' && value.length <= max;
const time = value => typeof value === 'string' ? Date.parse(value) : value;

// Explicit projections are used for both snapshots and historical events.
// Never spread event payloads: older installations may contain secret fields.
export function project(type, id, revision, input) {
  if (!text(id, 128) || !id || !integer(revision, 1) || !input || typeof input !== 'object' || Array.isArray(input)) throw fail();
  if (!['mailbox', 'platform', 'link', 'settings'].includes(type)) return { type: 'noop', id, revision, data: {} };
  if (input.deleted === true) return { type, id, revision, data: { deleted: true } };
  let data;
  if (type === 'mailbox') {
    if (input.provider !== 'mx') return { type, id, revision, data: { deleted: true } };
    data = { id, email: input.email, provider: 'mx', enabled: !!input.enabled, publicId: input.publicId,
      revision, generation: input.generation, localAccountId: input.localAccountId ?? null,
      mxDomain: input.mxDomain ?? null, createdAt: time(input.createdAt) || 0, updatedAt: time(input.updatedAt) || 0 };
    if (!text(data.email, 320) || !/^[^\s@]+@[^\s@]+$/.test(data.email) || !/^[A-Za-z0-9]{10}$/.test(data.publicId || '') ||
      !integer(data.generation, 1) || (data.localAccountId !== null && !integer(data.localAccountId, 1)) ||
      (data.mxDomain !== null && !text(data.mxDomain, 253))) throw fail();
  } else if (type === 'platform') {
    data = { id, name: input.name, emails: input.emails, domains: input.domains, keywords: input.keywords, revision };
    if (!text(data.name, 120) || ![data.emails, data.domains, data.keywords].every(list => Array.isArray(list) && list.length <= 1000 && list.every(item => text(item, 320)))) throw fail();
  } else if (type === 'link') {
    data = { id, mailboxId: input.mailboxId, recipient: input.recipient, platformId: input.platformId ?? null,
      expiresAt: input.expiresAt ?? null, tokenDigest: input.tokenDigest, revision, createdAt: time(input.createdAt) || 0 };
    if (!text(data.mailboxId, 128) || !text(data.recipient, 320) || !/^[^\s@]+@[^\s@]+$/.test(data.recipient) ||
      (data.platformId !== null && !text(data.platformId, 128)) || (data.expiresAt !== null && !integer(data.expiresAt)) ||
      !/^[a-f0-9]{64}$/.test(data.tokenDigest || '')) throw fail();
  } else if (type === 'settings') {
    data = { publicBaseUrl: input.publicBaseUrl, timeZone: input.timeZone, revision };
    if (!text(data.publicBaseUrl) || !text(data.timeZone, 100)) throw fail();
  } else return { type: 'noop', id, revision, data: {} };
  return { type, id, revision, data };
}

export function snapshotRecords(db) {
  const records = [];
  for (const row of db.prepare("SELECT * FROM source_mailbox WHERE provider='mx' ORDER BY id").iterate()) {
    records.push(project('mailbox', row.id, row.revision, { email: row.email, provider: row.provider,
      enabled: !!row.enabled, publicId: row.public_id, generation: row.generation,
      localAccountId: row.local_account_id, mxDomain: row.mx_domain, createdAt: row.created_at, updatedAt: row.updated_at }));
  }
  for (const row of db.prepare('SELECT * FROM platform_rule ORDER BY id').iterate()) records.push(project('platform', row.id, row.revision,
    { name: row.name, emails: JSON.parse(row.emails_json), domains: JSON.parse(row.domains_json), keywords: JSON.parse(row.keywords_json) }));
  for (const row of db.prepare("SELECT l.* FROM mail_link l JOIN source_mailbox s ON s.id=l.mailbox_id WHERE s.provider='mx' ORDER BY l.id").iterate()) {
    records.push(project('link', row.id, row.revision, { mailboxId: row.mailbox_id, recipient: row.recipient, platformId: row.platform_id,
      expiresAt: row.expires_at, tokenDigest: row.token_digest, createdAt: row.created_at }));
  }
  const row = db.prepare('SELECT * FROM feature_settings WHERE id=1').get();
  records.push(project('settings', '1', row.revision, { publicBaseUrl: row.public_base_url, timeZone: row.time_zone }));
  return records;
}

export function applyRecord(db, record) {
  if (record.type === 'noop') return;
  const { type, id, revision, data } = project(record.type, record.id, record.revision, record.data);
  const old = db.prepare('SELECT revision FROM node_replica_version WHERE type=? AND object_id=?').get(type, id);
  if (old && old.revision >= revision) return;
  if (data.deleted) {
    if (type === 'link') db.prepare('DELETE FROM mail_link WHERE id=?').run(id);
    else if (type === 'mailbox') db.prepare('DELETE FROM source_mailbox WHERE id=?').run(id);
    else if (type === 'platform') db.prepare('DELETE FROM platform_rule WHERE id=?').run(id);
    else throw fail();
  } else if (type === 'mailbox') {
    db.prepare(`INSERT INTO source_mailbox(id,email,provider,enabled,public_id,revision,generation,local_account_id,mx_domain,created_at,updated_at)
      VALUES(?,?,'mx',?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email,enabled=excluded.enabled,
      public_id=excluded.public_id,revision=excluded.revision,generation=excluded.generation,local_account_id=excluded.local_account_id,
      mx_domain=excluded.mx_domain,updated_at=excluded.updated_at`).run(id, data.email, Number(data.enabled), data.publicId, revision,
      data.generation, data.localAccountId, data.mxDomain, data.createdAt, data.updatedAt);
  } else if (type === 'platform') {
    db.prepare(`INSERT INTO platform_rule(id,name,emails_json,domains_json,keywords_json,revision,created_at) VALUES(?,?,?,?,?,?,0)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,emails_json=excluded.emails_json,domains_json=excluded.domains_json,
      keywords_json=excluded.keywords_json,revision=excluded.revision`).run(id, data.name, JSON.stringify(data.emails), JSON.stringify(data.domains), JSON.stringify(data.keywords), revision);
  } else if (type === 'link') {
    // Historical external-provider link events become no-ops on MX-only replicas.
    if (!db.prepare("SELECT 1 FROM source_mailbox WHERE id=? AND provider='mx'").get(data.mailboxId)) return;
    db.prepare(`INSERT INTO mail_link(id,mailbox_id,recipient,platform_id,expires_at,token_digest,token_encrypted,revision,created_at)
      VALUES(?,?,?,?,?,?,'',?,?) ON CONFLICT(id) DO UPDATE SET mailbox_id=excluded.mailbox_id,recipient=excluded.recipient,
      platform_id=excluded.platform_id,expires_at=excluded.expires_at,token_digest=excluded.token_digest,revision=excluded.revision`)
      .run(id, data.mailboxId, data.recipient, data.platformId, data.expiresAt, data.tokenDigest, revision, data.createdAt);
  } else if (type === 'settings') {
    db.prepare('UPDATE feature_settings SET public_base_url=?,time_zone=?,revision=? WHERE id=1').run(data.publicBaseUrl, data.timeZone, revision);
  }
  db.prepare(`INSERT INTO node_replica_version(type,object_id,revision) VALUES(?,?,?)
    ON CONFLICT(type,object_id) DO UPDATE SET revision=excluded.revision`).run(type, id, revision);
}
