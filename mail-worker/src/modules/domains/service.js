import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { FeatureError, strictJson } from '../shared/errors.js';
import { appendAudit } from '../shared/settings.js';
import { nodeRole } from '../nodes/access.js';

const MAX_DOMAINS = 100;
const DOMAIN_ORDER = 'is_default DESC, domain COLLATE NOCASE';

export function normalizeDomain(value) {
  const invalid = () => new FeatureError(400, 'INVALID_DOMAIN', 'Enter a valid domain name without an email prefix, URL, port, or wildcard.');
  if (typeof value !== 'string' || value.length > 1024) throw invalid();
  const input = value.trim();
  if (!input || /[\s@/\\:*?%#\[\]\u0000-\u001f\u007f]/u.test(input)) throw invalid();
  let domain;
  try { domain = domainToASCII(input).toLowerCase(); } catch { throw invalid(); }
  if (!domain || domain.length > 253 || isIP(domain) ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)) throw invalid();
  return domain;
}

function configuredDomains(env) {
  let configured = env.domain;
  if (typeof configured === 'string') configured = JSON.parse(configured);
  if (!Array.isArray(configured) || !configured.length) {
    throw new FeatureError(503, 'DOMAINS_UNAVAILABLE', 'No receiving domains are configured.');
  }
  const domains = [...new Set(configured.map(normalizeDomain))];
  if (domains.length > MAX_DOMAINS) throw new FeatureError(400, 'DOMAIN_LIMIT', `A site supports at most ${MAX_DOMAINS} receiving domains.`);
  return domains;
}

// Legacy unit-level environments predate this migration. Only an absent table
// falls back to configuration; query, permission, and corruption errors surface.
function hasDomainTable(env) {
  if (!env.db) return false;
  return !!env.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mail_domain'").get();
}

export function activeDomains(env) {
  if (!hasDomainTable(env)) return configuredDomains(env);
  return env.db.prepare(`SELECT domain FROM mail_domain WHERE enabled=1 ORDER BY ${DOMAIN_ORDER}`).all().map(row => row.domain);
}

export function knownDomains(env) {
  if (!hasDomainTable(env)) return configuredDomains(env);
  return env.db.prepare(`SELECT domain FROM mail_domain ORDER BY ${DOMAIN_ORDER}`).all().map(row => row.domain);
}

export function initializeDomains(env) {
  return env.db.transaction(() => {
    const current = env.db.prepare('SELECT domain,enabled,is_default FROM mail_domain').all();
    if (current.length) {
      if (!current.some(row => row.enabled && row.is_default)) {
        throw new FeatureError(503, 'DOMAINS_UNAVAILABLE', 'The receiving domains require an enabled default domain.');
      }
      return activeDomains(env);
    }
    const domains = configuredDomains(env), now = Date.now();
    const insert = env.db.prepare('INSERT INTO mail_domain(domain,enabled,is_default,created_at,updated_at) VALUES(?,1,?,?,?)');
    domains.forEach((domain, index) => insert.run(domain, index === 0 ? 1 : 0, now, now));
    return domains;
  }).immediate();
}

function requirePrimary(env) {
  if (nodeRole(env) !== 'primary') throw new FeatureError(403, 'PRIMARY_ONLY', 'Manage receiving domains on the primary node.');
}

function domainRecord(env, domain) {
  const row = env.db.prepare(`SELECT d.*,
    (SELECT count(*) FROM account a WHERE lower(substr(a.email,instr(a.email,'@')+1))=d.domain) AS account_count,
    (SELECT count(*) FROM source_mailbox m WHERE lower(substr(m.email,instr(m.email,'@')+1))=d.domain) AS mailbox_count
    FROM mail_domain d WHERE d.domain=? COLLATE NOCASE`).get(domain);
  if (!row) throw new FeatureError(404, 'DOMAIN_NOT_FOUND', 'The receiving domain was not found.');
  return row;
}

function domainDto(row) {
  return { domain: row.domain, enabled: !!row.enabled, isDefault: !!row.is_default,
    accountCount: row.account_count, mailboxCount: row.mailbox_count,
    createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString() };
}

export function listDomains(env) {
  requirePrimary(env);
  const rows = env.db.prepare(`SELECT d.*,
    (SELECT count(*) FROM account a WHERE lower(substr(a.email,instr(a.email,'@')+1))=d.domain) AS account_count,
    (SELECT count(*) FROM source_mailbox m WHERE lower(substr(m.email,instr(m.email,'@')+1))=d.domain) AS mailbox_count
    FROM mail_domain d ORDER BY ${DOMAIN_ORDER}`).all();
  return { items: rows.map(domainDto), defaultDomain: rows.find(row => row.is_default)?.domain ?? '' };
}

export function createDomain(env, { domain } = {}, { actorId = null, requestId = '' } = {}) {
  requirePrimary(env);
  domain = normalizeDomain(domain);
  return env.db.transaction(() => {
    if (env.db.prepare('SELECT 1 FROM mail_domain WHERE domain=? COLLATE NOCASE').get(domain)) {
      throw new FeatureError(409, 'DOMAIN_EXISTS', 'This receiving domain already exists.');
    }
    if (env.db.prepare('SELECT count(*) AS count FROM mail_domain').get().count >= MAX_DOMAINS) {
      throw new FeatureError(409, 'DOMAIN_LIMIT', `A site supports at most ${MAX_DOMAINS} receiving domains.`);
    }
    const now = Date.now();
    env.db.prepare('INSERT INTO mail_domain(domain,enabled,is_default,created_at,updated_at) VALUES(?,1,0,?,?)').run(domain, now, now);
    appendAudit(env.db, { actorId, action: 'domain.create', objectType: 'domain', objectId: domain, requestId });
    return domainDto(domainRecord(env, domain));
  }).immediate();
}

export function updateDomain(env, domain, data = {}, { actorId = null, requestId = '' } = {}) {
  requirePrimary(env);
  domain = normalizeDomain(domain);
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      !Object.keys(data).length || Object.keys(data).some(key => !['enabled', 'isDefault'].includes(key)) ||
      Object.values(data).some(value => typeof value !== 'boolean')) {
    throw new FeatureError(400, 'INVALID_DOMAIN_UPDATE', 'Provide enabled and/or isDefault as booleans.');
  }
  return env.db.transaction(() => {
    const current = domainRecord(env, domain);
    const enabled = data.enabled ?? !!current.enabled;
    const isDefault = data.isDefault ?? !!current.is_default;
    if (!enabled && isDefault) {
      throw new FeatureError(409, 'DEFAULT_DOMAIN_REQUIRED', 'Choose another enabled default domain before disabling this domain.');
    }
    if (current.is_default && !isDefault) {
      throw new FeatureError(409, 'DEFAULT_DOMAIN_REQUIRED', 'Set another enabled domain as the default instead.');
    }
    if (!enabled && env.db.prepare('SELECT count(*) AS count FROM mail_domain WHERE enabled=1 AND domain<>? COLLATE NOCASE').get(domain).count === 0) {
      throw new FeatureError(409, 'ENABLED_DOMAIN_REQUIRED', 'Keep at least one receiving domain enabled.');
    }
    const now = Date.now();
    if (isDefault) env.db.prepare('UPDATE mail_domain SET is_default=0,updated_at=? WHERE is_default=1 AND domain<>? COLLATE NOCASE').run(now, domain);
    env.db.prepare('UPDATE mail_domain SET enabled=?,is_default=?,updated_at=? WHERE domain=? COLLATE NOCASE').run(Number(enabled), Number(isDefault), now, domain);
    appendAudit(env.db, { actorId, action: 'domain.update', objectType: 'domain', objectId: domain, requestId });
    return domainDto(domainRecord(env, domain));
  }).immediate();
}

export function mountDomainRoutes(router) {
  router.get('/admin/domains', c => c.json({ data: listDomains(c.env) }));
  router.post('/admin/domains', async c => {
    const data = await strictJson(c, ['domain'], { maxBytes: 4096 });
    return c.json({ data: createDomain(c.env, data, { actorId: c.get('featureAdmin')?.userId, requestId: c.get('requestId') || '' }) }, 201);
  });
  router.put('/admin/domains/:domain', async c => {
    const data = await strictJson(c, ['enabled', 'isDefault'], { maxBytes: 4096 });
    return c.json({ data: updateDomain(c.env, c.req.param('domain'), data,
      { actorId: c.get('featureAdmin')?.userId, requestId: c.get('requestId') || '' }) });
  });
  return router;
}
