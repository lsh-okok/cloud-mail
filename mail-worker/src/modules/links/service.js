import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { domainToASCII } from 'node:url';
import { FeatureError, positiveInt, strictJson } from '../shared/errors.js';
import { appendAudit } from '../shared/settings.js';
import { recordFeatureChange } from '../shared/events.js';
import { publicUrl } from '../shared/urls.js';
import { assertSourceReadable, getSourceMailbox, normalizeEmail } from '../mail-sources/service.js';

export const tokenDigest = token => createHash('sha256').update(token).digest('hex');
const select = `SELECT l.*, s.email AS mailbox_email, s.public_id, p.name AS platform_name,
  coalesce(a.page_visits,0) AS page_visits, coalesce(a.json_visits,0) AS json_visits
  FROM mail_link l JOIN source_mailbox s ON s.id=l.mailbox_id
  LEFT JOIN platform_rule p ON p.id=l.platform_id LEFT JOIN link_access a ON a.link_id=l.id`;

export function normalizeRecipient(value) {
  const recipient = normalizeEmail(value);
  if (!recipient) throw new FeatureError(400, 'INVALID_RECIPIENT', 'Enter a complete recipient email address.');
  return recipient;
}

function expiry(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new FeatureError(400, 'INVALID_EXPIRY', 'Expiry must include a time zone, or be null for no expiry.');
  }
  const [year, month, day, hour, minute, second] = value.match(/^\d{4}|\d{2}/g).slice(0, 6).map(Number);
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (year < 1000 || month < 1 || month > 12 || day < 1 || day > days || hour > 23 || minute > 59 || second > 59) {
    throw new FeatureError(400, 'INVALID_EXPIRY', 'Enter a valid calendar date and time.');
  }
  return Date.parse(value);
}

function platformValue(value) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/.test(value)) throw new FeatureError(400, 'INVALID_PLATFORM', 'Choose an existing platform, or null for all platforms.');
  return value;
}

export function platformDto(row) {
  return { id: row.id, name: row.name, emails: JSON.parse(row.emails_json), domains: JSON.parse(row.domains_json), keywords: JSON.parse(row.keywords_json), revision: row.revision };
}

export function findPlatform(db, id) {
  const row = db.prepare('SELECT * FROM platform_rule WHERE id=?').get(id);
  if (!row) throw new FeatureError(404, 'PLATFORM_NOT_FOUND', 'The platform does not exist.');
  return platformDto(row);
}

function requireVault(env) {
  if (!env.secretVault) throw new FeatureError(503, 'ENCRYPTION_NOT_CONFIGURED', 'Configure DATA_ENCRYPTION_KEY before generating recipient links.');
  return env.secretVault;
}

export function linkDto(env, requestUrl, row, ambiguity) {
  const token = requireVault(env).decrypt(row.token_encrypted, `mail-link:${row.id}`);
  const local = row.recipient.split('@')[0];
  const ambiguous = ambiguity ? ambiguity.has(`${row.mailbox_id}\0${local}`) : env.db.prepare(`SELECT count(DISTINCT recipient) AS count FROM mail_link
    WHERE mailbox_id=? AND substr(recipient,1,instr(recipient,'@')-1)=? COLLATE NOCASE`).get(row.mailbox_id, local).count > 1;
  const segment = row.platform_id ? `${(row.platform_name || 'platform').replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 40) || 'platform'}~${row.platform_id}` : 'p0';
  const suffix = `${encodeURIComponent(segment)}/${row.public_id}/${encodeURIComponent(local)}`;
  return {
    id: row.id, mailboxId: row.mailbox_id, mailboxEmail: row.mailbox_email, recipient: row.recipient,
    platformId: row.platform_id, platformName: row.platform_name || '全部平台',
    pageUrl: publicUrl(env, requestUrl, ambiguous ? `m/${token}` : `show/${suffix}`),
    jsonUrl: publicUrl(env, requestUrl, `api/mailboxes/${ambiguous ? token : suffix}/messages`),
    expiresAt: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(), revision: row.revision,
    pageVisits: row.page_visits, jsonVisits: row.json_visits,
  };
}

function rows(env, ids) {
  const statement = env.db.prepare(`${select} WHERE l.id=?`);
  return ids.map(id => statement.get(id)).filter(Boolean);
}

function recordLink(db, row, deleted = false) {
  recordFeatureChange(db, { objectType: 'link', objectId: row.id, revision: row.revision,
    payload: deleted ? { deleted: true } : { id: row.id, mailboxId: row.mailbox_id, recipient: row.recipient,
      platformId: row.platform_id, expiresAt: row.expires_at, tokenDigest: row.token_digest, revision: row.revision } });
}

function audit(c, action, id = '', count = 1) {
  appendAudit(c.env.db, { actorId: c.get('featureAdmin').userId, action, objectType: 'link', objectId: id, count, requestId: c.get('requestId') });
}

function filters(c) {
  const clauses = ["s.provider='mx'"], params = [];
  const { mailboxId, platformId, q = '' } = c.req.query();
  if (mailboxId) { clauses.push('l.mailbox_id=?'); params.push(mailboxId); }
  if (platformId) { clauses.push(platformId === 'p0' ? 'l.platform_id IS NULL' : 'l.platform_id=?'); if (platformId !== 'p0') params.push(platformId); }
  if (q) {
    if (q.length > 8192) throw new FeatureError(400, 'INVALID_SEARCH', 'The search is too long.');
    let query = q.trim();
    try {
      const url = new URL(query);
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (parts.at(-1) === 'messages') parts.pop();
      const publicId = parts.at(-2), recipient = parts.at(-1), platform = parts.at(-3);
      if (/^[A-Za-z0-9]{10}$/.test(publicId || '') && platform) {
        clauses.push('s.public_id=?'); params.push(publicId);
        clauses.push(recipient.includes('@') ? 'l.recipient=? COLLATE NOCASE' : "substr(l.recipient,1,instr(l.recipient,'@')-1)=? COLLATE NOCASE");
        params.push(recipient.toLowerCase());
        if (['all', 'p0'].includes(platform)) clauses.push('l.platform_id IS NULL');
        else {
          const id = platform.slice(platform.lastIndexOf('~') + 1);
          if (!c.env.db.prepare('SELECT id FROM platform_rule WHERE id=?').get(id)) clauses.push('0');
          else { clauses.push('(l.platform_id=? OR l.platform_id IS NULL)'); params.push(id); }
        }
        return { where: ` WHERE ${clauses.join(' AND ')}`, params };
      }
      query = parts.at(-1);
    } catch { /* A plain address or token is also a valid search. */ }
    const like = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
    clauses.push(`(l.recipient LIKE ? ESCAPE '\\' OR s.email LIKE ? ESCAPE '\\' OR s.public_id=? OR l.token_digest=?)`);
    params.push(like, like, query, tokenDigest(query));
  }
  return { where: clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '', params };
}

function validIds(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 10000 || input.some(id => typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id))) {
    throw new FeatureError(400, 'INVALID_SELECTION', 'Select between 1 and 10000 recipient links.');
  }
  return [...new Set(input)];
}

function translateConstraint(error) {
  if (error.code?.startsWith('SQLITE_CONSTRAINT')) throw new FeatureError(409, 'LINK_CONFLICT', 'This change would create duplicate links or invalid relationships. No changes were saved.');
  throw error;
}

export function mountLinkRoutes(router) {
  router.get('/admin/links', c => {
    const page = positiveInt(c.req.query('page'), 'page', { fallback: 1, max: 1000000 });
    const pageSize = positiveInt(c.req.query('pageSize'), 'pageSize', { fallback: 20, max: 750 });
    const { where, params } = filters(c);
    const total = c.env.db.prepare(`SELECT count(*) AS count FROM mail_link l JOIN source_mailbox s ON s.id=l.mailbox_id${where}`).get(...params).count;
    const items = c.env.db.prepare(`${select}${where} ORDER BY l.created_at DESC,l.id LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);
    return c.json({ data: { items: items.map(row => linkDto(c.env, c.req.url, row)), total, page, pageSize } });
  });
  router.get('/admin/links/selection', c => {
    if (!c.req.query('mailboxId')) throw new FeatureError(400, 'MAILBOX_REQUIRED', 'Choose a main mailbox before selecting across pages.');
    getSourceMailbox(c.env, c.req.query('mailboxId'));
    const { where, params } = filters(c);
    const ids = c.env.db.prepare(`SELECT l.id FROM mail_link l JOIN source_mailbox s ON s.id=l.mailbox_id${where} ORDER BY l.id LIMIT 10001`).all(...params).map(row => row.id);
    if (ids.length > 10000) throw new FeatureError(400, 'SELECTION_TOO_LARGE', 'Narrow the selection to at most 10000 links.');
    return c.json({ data: { ids, total: ids.length } });
  });
  router.get('/admin/links/export', c => {
    const { where, params } = filters(c);
    const ambiguity = new Set();
    for (const row of c.env.db.prepare(`SELECT mailbox_id,substr(recipient,1,instr(recipient,'@')-1) AS local
      FROM mail_link GROUP BY mailbox_id,local HAVING count(DISTINCT recipient)>1`).iterate()) ambiguity.add(`${row.mailbox_id}\0${row.local}`);
    let bytes = 0;
    const lines = [];
    for (const row of c.env.db.prepare(`${select}${where} ORDER BY l.recipient,l.id`).iterate(...params)) {
      const line = `${row.recipient}----${linkDto(c.env, c.req.url, row, ambiguity).pageUrl}\n`;
      bytes += Buffer.byteLength(line);
      if (bytes > 32 * 1024 * 1024) throw new FeatureError(413, 'EXPORT_TOO_LARGE', 'Narrow the export to at most 32 MiB.');
      lines.push(line);
    }
    audit(c, 'links.export', '', lines.length);
    c.header('Content-Type', 'text/plain; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="recipient-links-${Date.now()}.txt"`);
    c.header('Content-Length', String(bytes));
    c.header('X-Content-SHA256', createHash('sha256').update(lines.join('')).digest('hex'));
    return c.body(lines.join(''));
  });
  router.post('/admin/links', async c => {
    const data = await strictJson(c, ['mailboxId', 'recipients', 'platformId', 'expiresAt'], { maxBytes: 32 * 1024 * 1024 });
    const source = assertSourceReadable(c.env, data.mailboxId);
    if (!source.enabled) throw new FeatureError(400, 'MAILBOX_DISABLED', 'Enable the main mailbox before creating recipient links.');
    if (!Array.isArray(data.recipients) || data.recipients.length < 1 || data.recipients.length > 10000) throw new FeatureError(400, 'INVALID_RECIPIENTS', 'Provide between 1 and 10000 complete recipient addresses.');
    const recipients = [...new Set(data.recipients.map(normalizeRecipient))];
    const platformId = data.platformId === undefined ? null : platformValue(data.platformId);
    if (platformId) findPlatform(c.env.db, platformId);
    const expiresAt = expiry(data.expiresAt === undefined ? null : data.expiresAt);
    const vault = requireVault(c.env);
    const created = [], reused = [];
    c.env.db.transaction(() => {
      for (const recipient of recipients) {
        const existing = c.env.db.prepare('SELECT id FROM mail_link WHERE mailbox_id=? AND recipient=? COLLATE NOCASE AND platform_id IS ?').get(source.id, recipient, platformId);
        if (existing) { reused.push(existing.id); continue; }
        const id = randomUUID(), token = randomBytes(32).toString('base64url');
        c.env.db.prepare(`INSERT INTO mail_link (id,mailbox_id,recipient,platform_id,expires_at,token_digest,token_encrypted,created_at) VALUES (?,?,?,?,?,?,?,?)`)
          .run(id, source.id, recipient, platformId, expiresAt, tokenDigest(token), vault.encrypt(token, `mail-link:${id}`), Date.now());
        recordLink(c.env.db, c.env.db.prepare('SELECT * FROM mail_link WHERE id=?').get(id));
        created.push(id);
      }
      audit(c, 'links.generate', source.id, created.length);
    }).immediate();
    return c.json({ data: { items: rows(c.env, [...created, ...reused]).map(row => linkDto(c.env, c.req.url, row)), created: created.length, reused: reused.length } }, 201);
  });
  router.put('/admin/links/:id', async c => {
    const data = await strictJson(c, ['revision', 'expiresAt', 'platformId']);
    const revision = positiveInt(data.revision, 'revision');
    const current = c.env.db.prepare('SELECT * FROM mail_link WHERE id=?').get(c.req.param('id'));
    if (!current) throw new FeatureError(404, 'LINK_NOT_FOUND', 'The link does not exist.');
    const expiresAt = data.expiresAt === undefined ? current.expires_at : expiry(data.expiresAt);
    const platformId = data.platformId === undefined ? current.platform_id : platformValue(data.platformId);
    if (platformId) findPlatform(c.env.db, platformId);
    try {
      c.env.db.transaction(() => {
        if (!c.env.db.prepare('UPDATE mail_link SET expires_at=?,platform_id=?,revision=revision+1 WHERE id=? AND revision=?').run(expiresAt, platformId, current.id, revision).changes) throw new FeatureError(409, 'REVISION_CONFLICT', 'The link changed. Reload before saving.');
        recordLink(c.env.db, c.env.db.prepare('SELECT * FROM mail_link WHERE id=?').get(current.id));
        audit(c, 'links.update', current.id);
      }).immediate();
    } catch (error) { translateConstraint(error); }
    return c.json({ data: linkDto(c.env, c.req.url, rows(c.env, [current.id])[0]) });
  });
  router.delete('/admin/links/:id', c => {
    c.env.db.transaction(() => {
      const row = c.env.db.prepare('SELECT * FROM mail_link WHERE id=?').get(c.req.param('id'));
      if (row) {
        recordLink(c.env.db, { ...row, revision: row.revision + 1 }, true);
        c.env.db.prepare('DELETE FROM mail_link WHERE id=?').run(row.id);
      }
      audit(c, 'links.delete', c.req.param('id'), row ? 1 : 0);
    }).immediate();
    return c.json({ data: { deleted: true } });
  });
  router.post('/admin/links/batch', async c => {
    const data = await strictJson(c, ['ids', 'action', 'value'], { maxBytes: 1024 * 1024 });
    const ids = validIds(data.ids);
    if (!['platform', 'expiry', 'delete'].includes(data.action)) throw new FeatureError(400, 'INVALID_ACTION', 'Choose platform, expiry, or delete.');
    const value = data.action === 'expiry' ? expiry(data.value) : data.action === 'platform' ? platformValue(data.value) : null;
    if (data.action === 'platform' && value) findPlatform(c.env.db, value);
    try {
      c.env.db.transaction(() => {
        const selected = ids.map(id => c.env.db.prepare('SELECT * FROM mail_link WHERE id=?').get(id));
        if (data.action !== 'delete' && selected.some(row => !row)) throw new FeatureError(404, 'LINK_NOT_FOUND', 'A selected link no longer exists. No changes were saved.');
        for (const row of selected.filter(Boolean)) {
          if (data.action === 'delete') {
            recordLink(c.env.db, { ...row, revision: row.revision + 1 }, true);
            c.env.db.prepare('DELETE FROM mail_link WHERE id=?').run(row.id);
          } else {
            const column = data.action === 'platform' ? 'platform_id' : 'expires_at';
            c.env.db.prepare(`UPDATE mail_link SET ${column}=?,revision=revision+1 WHERE id=?`).run(value, row.id);
            recordLink(c.env.db, c.env.db.prepare('SELECT * FROM mail_link WHERE id=?').get(row.id));
          }
        }
        audit(c, `links.batch.${data.action}`, '', selected.filter(Boolean).length);
      }).immediate();
    } catch (error) { translateConstraint(error); }
    return c.json({ data: { updated: ids.length } });
  });
}

function platformInput(data) {
  if (typeof data.name !== 'string' || !data.name.trim() || data.name.trim().length > 80) throw new FeatureError(400, 'INVALID_PLATFORM', 'Platform names must contain 1 to 80 characters.');
  for (const key of ['emails', 'domains', 'keywords']) if (data[key] !== undefined && (!Array.isArray(data[key]) || data[key].length > 500 || data[key].some(item => typeof item !== 'string' || item.length > 320))) throw new FeatureError(400, 'INVALID_PLATFORM', 'Platform rules must contain bounded text lists.');
  const unique = values => [...new Set((values || []).map(value => value.trim().toLowerCase()).filter(Boolean))];
  const emails = unique(data.emails).map(normalizeRecipient);
  const domains = unique(data.domains).map(value => domainToASCII(value));
  if (domains.some(value => !value || value.length > 253 || !value.includes('.') || !value.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)))) throw new FeatureError(400, 'INVALID_PLATFORM', 'Enter valid sender domains.');
  if (!emails.length && !domains.length) throw new FeatureError(400, 'INVALID_PLATFORM', 'Provide at least one sender email address or domain.');
  return { name: data.name.trim(), emails, domains, keywords: unique(data.keywords) };
}

export function mountPlatformRoutes(router) {
  router.get('/admin/platforms', c => c.json({ data: { items: c.env.db.prepare('SELECT * FROM platform_rule ORDER BY name,id').all().map(platformDto) } }));
  const save = async c => {
    const data = await strictJson(c, ['name', 'emails', 'domains', 'keywords', 'revision']);
    const input = platformInput(data), id = c.req.param('id') || randomUUID();
    const revision = c.req.method === 'PUT' ? positiveInt(data.revision, 'revision') : null;
    c.env.db.transaction(() => {
      if (revision) {
        if (!c.env.db.prepare(`UPDATE platform_rule SET name=?,emails_json=?,domains_json=?,keywords_json=?,revision=revision+1 WHERE id=? AND revision=?`).run(input.name, JSON.stringify(input.emails), JSON.stringify(input.domains), JSON.stringify(input.keywords), id, revision).changes) throw new FeatureError(409, 'REVISION_CONFLICT', 'The platform changed. Reload before saving.');
      } else c.env.db.prepare('INSERT INTO platform_rule (id,name,emails_json,domains_json,keywords_json,created_at) VALUES (?,?,?,?,?,?)').run(id, input.name, JSON.stringify(input.emails), JSON.stringify(input.domains), JSON.stringify(input.keywords), Date.now());
      recordFeatureChange(c.env.db, { objectType: 'platform', objectId: id, revision: (revision || 0) + 1, payload: findPlatform(c.env.db, id) });
      appendAudit(c.env.db, { actorId: c.get('featureAdmin').userId, action: revision ? 'platform.update' : 'platform.create', objectType: 'platform', objectId: id, requestId: c.get('requestId') });
    }).immediate();
    return c.json({ data: findPlatform(c.env.db, id) }, revision ? 200 : 201);
  };
  router.post('/admin/platforms', save);
  router.put('/admin/platforms/:id', save);
  router.delete('/admin/platforms/:id', c => {
    const id = c.req.param('id');
    c.env.db.transaction(() => {
      if (c.env.db.prepare('SELECT 1 FROM mail_link WHERE platform_id=? LIMIT 1').get(id)) throw new FeatureError(409, 'PLATFORM_IN_USE', 'Remove this platform from its links before deleting it.');
      const row = c.env.db.prepare('SELECT revision FROM platform_rule WHERE id=?').get(id);
      if (row) {
        c.env.db.prepare('DELETE FROM platform_rule WHERE id=?').run(id);
        recordFeatureChange(c.env.db, { objectType: 'platform', objectId: id, revision: row.revision + 1, payload: { deleted: true } });
        appendAudit(c.env.db, { actorId: c.get('featureAdmin').userId, action: 'platform.delete', objectType: 'platform', objectId: id, requestId: c.get('requestId') });
      }
    }).immediate();
    return c.json({ data: { deleted: true } });
  });
}
