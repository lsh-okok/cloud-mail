import { randomBytes, randomUUID } from 'node:crypto';
import { FeatureError, positiveInt, strictJson } from '../shared/errors.js';
import { appendAudit } from '../shared/settings.js';
import { recordFeatureChange } from '../shared/events.js';
import { matchesPlatform, matchesRecipient, normalizeEmail, recipientAddresses } from './matching.js';
import { assertReplicaReady, nodeRole } from '../nodes/access.js';

export { matchesPlatform, matchesRecipient, normalizeEmail } from './matching.js';
const PROVIDERS = ['mx'];
const INPUT_KEYS = ['email', 'provider', 'enabled', 'localAccountId', 'mxDomain', 'revision', 'createLocalAccount'];
const MAX_BODY = 2 * 1024 * 1024;
const MAX_RESULT = 16 * 1024 * 1024;

function sourceRecord(env, id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new FeatureError(400, 'INVALID_MAILBOX_ID', 'A valid source mailbox ID is required.');
  const row = env.db.prepare('SELECT * FROM source_mailbox WHERE id=?').get(id);
  if (!row) throw new FeatureError(404, 'MAILBOX_NOT_FOUND', 'The source mailbox was not found.');
  return row;
}

function sourceDto(row) {
  return { id: row.id, email: row.email, provider: row.provider, enabled: !!row.enabled,
    publicId: row.public_id, revision: row.revision, generation: row.generation,
    localAccountId: row.local_account_id, mxDomain: row.mx_domain,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString() };
}

export function getSourceMailbox(env, id) {
  const source = sourceRecord(env, id);
  if (source.provider !== 'mx') throw new FeatureError(400, 'UNSUPPORTED_PROVIDER', 'Only local MX receiving sources are supported.');
  return sourceDto(source);
}

function domains(env) {
  const configured = typeof env.domain === 'string' ? JSON.parse(env.domain) : env.domain;
  return configured.map(item => item.toLowerCase());
}

function validateSource(env, data, current) {
  const email = normalizeEmail(data.email ?? current?.email);
  if (!email) throw new FeatureError(400, 'INVALID_MAILBOX_EMAIL', 'Enter the complete main mailbox email address.');
  const provider = data.provider ?? current?.provider ?? 'mx';
  if (provider !== 'mx' || (current && current.provider !== 'mx')) throw new FeatureError(400, 'UNSUPPORTED_PROVIDER', 'Only local MX receiving sources are supported.');
  if (data.enabled !== undefined && typeof data.enabled !== 'boolean') throw new FeatureError(400, 'INVALID_ENABLED', 'enabled must be a boolean.');
  const enabled = data.enabled ?? !!(current?.enabled ?? true);
  let localAccountId = data.localAccountId === undefined ? current?.local_account_id ?? null : data.localAccountId;
  let mxDomain = data.mxDomain === undefined ? current?.mx_domain ?? null : data.mxDomain;
  if (data.localAccountId !== undefined && data.mxDomain === undefined) mxDomain = null;
  if (data.mxDomain !== undefined && data.localAccountId === undefined) localAccountId = null;
  if (!domains(env).includes(email.split('@')[1])) throw new FeatureError(400, 'INVALID_MX_DOMAIN', 'MX source mailboxes must belong to a configured receiving domain.');
  if ((localAccountId != null) === (mxDomain != null && mxDomain !== '')) throw new FeatureError(400, 'MX_SCOPE_REQUIRED', 'Choose either a local mailbox account or a receiving domain for this MX source.');
  if (localAccountId != null) {
    localAccountId = positiveInt(localAccountId, 'localAccountId');
    const account = env.db.prepare('SELECT * FROM account WHERE account_id=?').get(localAccountId);
    const user = account && env.db.prepare('SELECT * FROM user WHERE user_id=?').get(account.user_id);
    if (!account || account.is_del || account.status || !user || user.is_del || user.status || account.email.toLowerCase() !== email) {
      throw new FeatureError(400, 'INVALID_LOCAL_ACCOUNT', 'Select an enabled local account with the same main mailbox address.');
    }
    mxDomain = null;
  } else {
    if (typeof mxDomain !== 'string') throw new FeatureError(400, 'INVALID_MX_DOMAIN', 'Choose a configured MX receiving domain.');
    mxDomain = mxDomain.trim().toLowerCase();
    if (mxDomain !== email.split('@')[1] || !domains(env).includes(mxDomain)) throw new FeatureError(400, 'INVALID_MX_DOMAIN', 'The MX receiving domain must match the main mailbox domain.');
    localAccountId = null;
  }
  if (Object.hasOwn(data, 'credentials')) throw new FeatureError(400, 'MX_CREDENTIALS_UNSUPPORTED', 'MX sources use local mail storage and do not accept external credentials.');
  return { email, provider, enabled, localAccountId, mxDomain: mxDomain || null };
}

export function saveSourceMailbox(env, data, { id, actorId = null, requestId = '' } = {}) {
  if (data.createLocalAccount !== undefined) throw new FeatureError(400, 'INVALID_PARAMETER', 'Account creation is available only when adding a new main mailbox.');
  const current = id ? sourceRecord(env, id) : null;
  const value = validateSource(env, data, current);
  if (current) {
    const revision = positiveInt(data.revision, 'revision');
    if (revision !== current.revision) throw new FeatureError(409, 'REVISION_CONFLICT', 'The source mailbox changed. Reload it before saving.');
  } else if (data.revision !== undefined) throw new FeatureError(400, 'INVALID_PARAMETER', 'New source mailboxes do not accept a revision.');
  id ||= randomUUID();
  try {
    return env.db.transaction(() => {
      const now = Date.now();
      if (current) {
        const update = env.db.prepare(`UPDATE source_mailbox SET email=?,enabled=?,local_account_id=?,mx_domain=?,
          revision=revision+1,generation=generation+1,updated_at=? WHERE id=? AND revision=?`).run(
          value.email, Number(value.enabled), value.localAccountId, value.mxDomain, now, id, current.revision);
        if (update.changes !== 1) throw new FeatureError(409, 'REVISION_CONFLICT', 'The source mailbox changed. Reload it before saving.');
      } else {
        const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
        let publicId = '';
        // Rejection sampling avoids modulo bias while retaining the stable
        // ten-character URL contract.
        while (publicId.length < 10) for (const byte of randomBytes(20)) {
          if (byte < 252 && publicId.length < 10) publicId += alphabet[byte % 36];
        }
        env.db.prepare(`INSERT INTO source_mailbox(id,email,provider,enabled,public_id,local_account_id,mx_domain,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,?,?)`).run(id, value.email, value.provider, Number(value.enabled), publicId, value.localAccountId, value.mxDomain, now, now);
      }
      const result = getSourceMailbox(env, id);
      appendAudit(env.db, { actorId, action: current ? 'mailbox.update' : 'mailbox.create', objectType: 'mailbox', objectId: id, requestId });
      recordFeatureChange(env.db, { objectType: 'mailbox', objectId: id, revision: result.revision, payload: result });
      return result;
    }).immediate();
  } catch (error) {
    if (error.code?.startsWith('SQLITE_CONSTRAINT_UNIQUE')) throw new FeatureError(409, 'MAILBOX_EXISTS', 'This provider already has a source mailbox with the same address.');
    throw error;
  }
}

export function createLocalSourceMailbox(env, data, { actorId, requestId = '' } = {}) {
  if (nodeRole(env) !== 'primary') throw new FeatureError(403, 'PRIMARY_ONLY', 'Create main mailboxes on the primary node.');
  if (data.createLocalAccount !== true || data.localAccountId !== undefined || data.mxDomain !== undefined || data.revision !== undefined) {
    throw new FeatureError(400, 'INVALID_PARAMETER', 'A new local main mailbox must create or associate its own local account.');
  }
  const email = normalizeEmail(data.email);
  if (!email) throw new FeatureError(400, 'INVALID_MAILBOX_EMAIL', 'Enter a valid mailbox prefix and domain.');
  if (!domains(env).includes(email.split('@')[1])) throw new FeatureError(400, 'INVALID_MX_DOMAIN', 'Choose a configured receiving domain.');
  return env.db.transaction(() => {
    const owner = env.db.prepare('SELECT * FROM user WHERE user_id=?').get(actorId);
    if (!owner || owner.email.toLowerCase() !== String(env.admin).toLowerCase() || owner.status || owner.is_del) {
      throw new FeatureError(403, 'ADMIN_REQUIRED', 'An active administrator is required.');
    }
    const prefix = email.split('@')[0];
    const settings = env.db.prepare('SELECT min_email_prefix,email_prefix_filter FROM setting').get();
    if (prefix.length < (settings?.min_email_prefix || 1)) throw new FeatureError(400, 'PREFIX_TOO_SHORT', `The mailbox prefix requires at least ${settings?.min_email_prefix || 1} characters.`);
    if (String(settings?.email_prefix_filter || '').split(',').filter(Boolean).some(value => prefix.includes(value.toLowerCase()))) {
      throw new FeatureError(400, 'PREFIX_BLOCKED', 'This mailbox prefix is unavailable.');
    }
    let account = env.db.prepare('SELECT * FROM account WHERE email=? COLLATE NOCASE').get(email);
    if (account && (account.user_id !== actorId || account.status || account.is_del)) {
      throw new FeatureError(409, 'LOCAL_ACCOUNT_UNAVAILABLE', 'This address already belongs to another account or is unavailable.');
    }
    if (!account) {
      if (prefix.includes('+')) {
        const baseEmail = `${prefix.split('+')[0]}@${email.split('@')[1]}`;
        const base = env.db.prepare('SELECT * FROM account WHERE email=? COLLATE NOCASE').get(baseEmail);
        if (!base || base.user_id !== actorId || base.status || base.is_del) throw new FeatureError(409, 'BASE_ACCOUNT_REQUIRED', 'Create your base mailbox before adding a plus address.');
      }
      const created = env.db.prepare('INSERT INTO account(email,name,user_id) VALUES(?,?,?)').run(email, prefix, actorId);
      account = { account_id: Number(created.lastInsertRowid) };
    }
    const { createLocalAccount, ...source } = data;
    return saveSourceMailbox(env, { ...source, email, localAccountId: account.account_id }, { actorId, requestId });
  }).immediate();
}

const BATCH_ERROR_MESSAGES = {
  INVALID_MAILBOX_EMAIL: '邮箱地址格式不正确。',
  INVALID_MX_DOMAIN: '邮箱域名不在当前受控收件域名中。',
  PREFIX_BLOCKED: '邮箱前缀包含系统禁止使用的内容。',
  LOCAL_ACCOUNT_UNAVAILABLE: '该地址已属于其他用户，或邮箱已停用、删除。',
  INVALID_LOCAL_ACCOUNT: '已有主邮箱关联的本地邮箱不可用，请检查原配置。',
  BASE_ACCOUNT_REQUIRED: '请先创建并启用该地址对应的基础邮箱。',
};
const BATCH_ITEM_ERROR_CODES = new Set([...Object.keys(BATCH_ERROR_MESSAGES), 'PREFIX_TOO_SHORT']);

// Each request is committed once. createLocalSourceMailbox's nested transaction
// is a savepoint, so a validation failure cannot leave an orphan inbox account.
export function createLocalSourceMailboxBatch(env, input, { actorId, requestId = '' } = {}) {
  if (nodeRole(env) !== 'primary') throw new FeatureError(403, 'PRIMARY_ONLY', 'Create main mailboxes on the primary node.');
  if (!Array.isArray(input) || input.length < 1 || input.length > 100 || input.some(email => typeof email !== 'string')) {
    throw new FeatureError(400, 'INVALID_MAILBOXES', '每次请求须提供 1～100 个邮箱地址。');
  }
  const seen = new Set();
  const entries = input.flatMap(value => {
    const email = normalizeEmail(value) || value.trim().toLowerCase();
    if (seen.has(email)) return [];
    seen.add(email);
    return [{ email }];
  });
  // A base address may appear after its plus alias in an imported list.
  const ordered = [...entries].sort((left, right) => Number(left.email.split('@')[0].includes('+')) - Number(right.email.split('@')[0].includes('+')));
  return env.db.transaction(() => {
    const owner = env.db.prepare('SELECT * FROM user WHERE user_id=?').get(actorId);
    if (!owner || owner.email.toLowerCase() !== String(env.admin).toLowerCase() || owner.status || owner.is_del) {
      throw new FeatureError(403, 'ADMIN_REQUIRED', 'An active administrator is required.');
    }
    const allowedDomains = domains(env);
    for (const entry of ordered) {
      try {
        const email = normalizeEmail(entry.email);
        if (!email) throw new FeatureError(400, 'INVALID_MAILBOX_EMAIL', BATCH_ERROR_MESSAGES.INVALID_MAILBOX_EMAIL);
        if (!allowedDomains.includes(email.split('@')[1])) throw new FeatureError(400, 'INVALID_MX_DOMAIN', BATCH_ERROR_MESSAGES.INVALID_MX_DOMAIN);
        const account = env.db.prepare('SELECT * FROM account WHERE email=? COLLATE NOCASE').get(email);
        if (account && (account.user_id !== actorId || account.status || account.is_del)) {
          throw new FeatureError(409, 'LOCAL_ACCOUNT_UNAVAILABLE', BATCH_ERROR_MESSAGES.LOCAL_ACCOUNT_UNAVAILABLE);
        }
        const existing = env.db.prepare("SELECT * FROM source_mailbox WHERE provider='mx' AND email=? COLLATE NOCASE").get(email);
        if (existing) {
          if (existing.local_account_id != null && (!account || existing.local_account_id !== account.account_id)) {
            throw new FeatureError(409, 'INVALID_LOCAL_ACCOUNT', BATCH_ERROR_MESSAGES.INVALID_LOCAL_ACCOUNT);
          }
          // Domain-scoped sources are configuration in their own right. Do not
          // change the scope or manufacture an inbox account when skipping one.
          if (existing.local_account_id == null && existing.mx_domain !== email.split('@')[1]) {
            throw new FeatureError(409, 'INVALID_MX_DOMAIN', '已有主邮箱的收件域名配置不可用，请检查原配置。');
          }
          Object.assign(entry, { status: 'existing', mailboxId: existing.id });
          continue;
        }
        const source = createLocalSourceMailbox(env, { email, provider: 'mx', createLocalAccount: true }, { actorId, requestId });
        Object.assign(entry, { status: 'created', mailboxId: source.id });
      } catch (error) {
        // Infrastructure failures must roll back this entire request. Only
        // expected address validation/conflict failures become item results.
        if (!(error instanceof FeatureError) || error.status >= 500 || !BATCH_ITEM_ERROR_CODES.has(error.code)) {
          // saveSourceMailbox translates uniqueness constraints. A real
          // existing address was handled above, so an unexpected constraint
          // here must not become a successful partial batch response.
          if (error instanceof FeatureError && error.code === 'MAILBOX_EXISTS') {
            throw new Error('Unexpected mailbox creation constraint.', { cause: error });
          }
          throw error;
        }
        Object.assign(entry, { status: 'failed', error: { code: error.code,
          message: BATCH_ERROR_MESSAGES[error.code] || (error.code === 'PREFIX_TOO_SHORT'
            ? `邮箱前缀至少需要 ${env.db.prepare('SELECT min_email_prefix FROM setting').get()?.min_email_prefix || 1} 个字符。`
            : error.message) } });
      }
    }
    return { items: entries, created: entries.filter(entry => entry.status === 'created').length,
      existing: entries.filter(entry => entry.status === 'existing').length, failed: entries.filter(entry => entry.status === 'failed').length };
  }).immediate();
}

export function mountSourceRoutes(router) {
  router.get('/admin/mailboxes/domains', c => c.json({ data: { domains: domains(c.env),
    minEmailPrefix: c.env.db.prepare('SELECT min_email_prefix FROM setting').get()?.min_email_prefix || 1 } }));
  router.get('/admin/mailboxes', c => {
    const page = positiveInt(c.req.query('page'), 'page', { fallback: 1 });
    const pageSize = positiveInt(c.req.query('pageSize'), 'pageSize', { fallback: 20, max: 100 });
    const q = c.req.query('q') || '';
    if (q.length > 320) throw new FeatureError(400, 'INVALID_PARAMETER', 'The mailbox search is too long.');
    const provider = c.req.query('provider');
    if (provider && provider !== 'mx') throw new FeatureError(400, 'UNSUPPORTED_PROVIDER', 'Only local MX receiving sources are supported.');
    let where = "WHERE provider='mx' AND instr(lower(email),lower(?)) > 0";
    const params = [q];
    const exactEmail = c.req.query('email');
    if (exactEmail !== undefined) {
      const email = normalizeEmail(exactEmail);
      if (!email) throw new FeatureError(400, 'INVALID_MAILBOX_EMAIL', '请输入合法的完整邮箱地址。');
      where += ' AND email=? COLLATE NOCASE';
      params.push(email);
    }
    const total = c.env.db.prepare(`SELECT count(*) AS total FROM source_mailbox ${where}`).get(...params).total;
    const items = c.env.db.prepare(`SELECT * FROM source_mailbox ${where} ORDER BY email,id LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize).map(sourceDto);
    return c.json({ data: { items, total, page, pageSize,
      capabilities: { providers: PROVIDERS, linkEncryption: !!c.env.secretVault } } });
  });
  router.get('/admin/mailboxes/:id', c => c.json({ data: getSourceMailbox(c.env, c.req.param('id')) }));
  router.post('/admin/mailboxes', async c => {
    const data = await strictJson(c, INPUT_KEYS);
    const save = data.createLocalAccount === true ? createLocalSourceMailbox : saveSourceMailbox;
    return c.json({ data: save(c.env, data, { actorId: c.get('featureAdmin').userId, requestId: c.get('requestId') }) }, 201);
  });
  router.post('/admin/mailboxes/batch', async c => {
    const data = await strictJson(c, ['emails']);
    return c.json({ data: createLocalSourceMailboxBatch(c.env, data.emails,
      { actorId: c.get('featureAdmin').userId, requestId: c.get('requestId') }) });
  });
  router.put('/admin/mailboxes/:id', async c => {
    const data = await strictJson(c, INPUT_KEYS);
    return c.json({ data: saveSourceMailbox(c.env, data, { id: c.req.param('id'), actorId: c.get('featureAdmin').userId, requestId: c.get('requestId') }) });
  });
}

function assertReadable(env, source) {
  if (!source.enabled) throw new FeatureError(404, 'MAILBOX_UNAVAILABLE', 'The source mailbox is unavailable.');
  if (source.provider !== 'mx') throw new FeatureError(404, 'MAILBOX_UNAVAILABLE', 'Only local MX receiving sources are available.');
  // Replicas hold only projected configuration. Account and user lifecycle
  // remain authoritative on the primary and are checked by every relay call.
  if (nodeRole(env) === 'replica') { assertReplicaReady(env); return; }
  if (source.local_account_id != null) {
    const row = env.db.prepare(`SELECT a.status,a.is_del,u.status AS user_status,u.is_del AS user_deleted FROM account a
      JOIN user u ON u.user_id=a.user_id WHERE a.account_id=? AND a.email=? COLLATE NOCASE`).get(source.local_account_id, source.email);
    if (!row || row.status || row.is_del || row.user_status || row.user_deleted) throw new FeatureError(404, 'MAILBOX_UNAVAILABLE', 'The local source mailbox is unavailable.');
  } else if (!domains(env).includes(source.mx_domain)) throw new FeatureError(404, 'MAILBOX_UNAVAILABLE', 'The source receiving domain is unavailable.');
}

// Public callers must use this guard even when a message body comes from a
// short cache or a stable page snapshot, because the linked local account/user
// can be disabled independently of source_mailbox.revision.
export function assertSourceReadable(env, sourceId) {
  const source = sourceRecord(env, sourceId);
  assertReadable(env, source);
  return sourceDto(source);
}

function storedRecipients(value) {
  try { return recipientAddresses(JSON.parse(value)); }
  catch { return []; }
}

function mxMessages(env, source, { recipient, platform, order, limit, signal }) {
  const forwarded = recipient.split('@')[1] !== (source.mx_domain || source.email.split('@')[1]);
  // A foreign child must have been forwarded to this exact main address. This
  // envelope boundary applies to domain sources too, including shared accounts
  // and plus aliases; headers never grant access to another main mailbox.
  const where = `to_email=? COLLATE NOCASE AND type=0 AND is_del=0${source.local_account_id != null ? ' AND account_id=?' : ''}`;
  const envelope = forwarded ? source.email : recipient;
  const params = source.local_account_id != null ? [envelope, source.local_account_id] : [envelope];
  const rows = env.db.prepare(`SELECT email_id,subject,send_email,to_email,recipient,cc,create_time,text,content FROM email
    WHERE ${where} ORDER BY email_id ${order === 'oldest' ? 'ASC' : 'DESC'}`).iterate(...params);
  const messages = [];
  let bytes = 0;
  let scanned = 0;
  for (const row of rows) {
    if (signal?.aborted) throw new FeatureError(503, 'READ_CANCELLED', 'The mailbox read was cancelled.');
    if (++scanned > 100000) throw new FeatureError(429, 'MAILBOX_SCAN_LIMIT', 'Too many messages must be examined for this recipient.');
    const message = { id: `mx:${row.email_id}`, subject: row.subject || '', from: row.send_email || '',
      envelopeRecipients: [row.to_email],
      to: forwarded ? storedRecipients(row.recipient) : [row.to_email],
      cc: forwarded ? storedRecipients(row.cc) : [],
      receivedAt: new Date(/(?:Z|[+-]\d\d:\d\d)$/.test(row.create_time) ? row.create_time : row.create_time.replace(' ', 'T') + 'Z').toISOString(),
      text: row.text || '', html: row.content || '', headers: {} };
    if (!matchesRecipient(message, recipient, source) || !matchesPlatform(message, platform)) continue;
    if (Buffer.byteLength(message.text) + Buffer.byteLength(message.html) > MAX_BODY) throw new FeatureError(502, 'MESSAGE_TOO_LARGE', 'The message body exceeds 2 MiB.');
    bytes += Buffer.byteLength(JSON.stringify(message));
    if (bytes > MAX_RESULT) throw new FeatureError(429, 'MAILBOX_SNAPSHOT_TOO_LARGE', 'The message snapshot exceeds its supported capacity.');
    messages.push(message);
    if (messages.length === limit) break;
  }
  return messages;
}

export async function readSourceMessages(env, sourceId, { recipient, platform = null, order = 'latest', limit = 20, signal, accessContext } = {}) {
  recipient = normalizeEmail(recipient);
  if (!recipient) throw new FeatureError(400, 'INVALID_RECIPIENT', 'A complete child mailbox address is required.');
  if (!['latest', 'oldest'].includes(order)) throw new FeatureError(400, 'INVALID_SORT', 'Choose latest or oldest message order.');
  limit = positiveInt(limit, 'limit', { max: 100000 });
  const source = sourceRecord(env, sourceId);
  assertReadable(env, source);
  if (signal?.aborted) throw new FeatureError(503, 'READ_CANCELLED', 'The mailbox read was cancelled.');
  const options = { recipient, platform, order, limit, signal };
  const messages = nodeRole(env) === 'replica'
    ? (await env.nodeState.runtime.relayRead({ ...options, context: accessContext })).messages
    : mxMessages(env, source, options);
  const current = sourceRecord(env, sourceId);
  assertReadable(env, current);
  if (current.revision !== source.revision || current.generation !== source.generation) throw new FeatureError(404, 'MAILBOX_POLICY_CHANGED', 'The mailbox configuration changed during reading. Please refresh.');
  let bytes = 0;
  for (const message of messages) {
    if (!matchesRecipient(message, recipient, source) || !matchesPlatform(message, platform)) throw new FeatureError(502, 'UPSTREAM_RECIPIENT_MISMATCH', 'The provider returned a message outside the requested recipient policy.');
    bytes += Buffer.byteLength(JSON.stringify(message));
    if (bytes > MAX_RESULT) throw new FeatureError(429, 'MAILBOX_SNAPSHOT_TOO_LARGE', 'The message snapshot exceeds its supported capacity.');
  }
  return { messages };
}
