import { randomBytes } from 'node:crypto';
import { FeatureError, positiveInt } from '../shared/errors.js';
import { tokenDigest, findPlatform } from '../links/service.js';
import { assertSourceReadable, readSourceMessages } from '../mail-sources/service.js';
import { coordinatedSourceRead } from '../mail-sources/coordinator.js';
import { assertReplicaReady, nodeRole } from '../nodes/access.js';

const notFound = () => new FeatureError(404, 'LINK_NOT_FOUND', 'The recipient link is unavailable.');
const stale = () => new FeatureError(400, 'CURSOR_EXPIRED', 'The message list changed or expired. Refresh the recipient page.');

export function ensurePublicReady(env) {
  if (nodeRole(env) === 'replica') { assertReplicaReady(env); return; }
  if ((env.nodeRole ?? env.node_role ?? 'primary') !== 'primary' && !env.clusterReady) {
    throw new FeatureError(503, 'NODE_NOT_READY', 'This node is not ready to read messages.');
  }
}

export function resolvePublicLink(env, params) {
  let row;
  if (params.token) {
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(params.token)) throw notFound();
    row = env.db.prepare('SELECT * FROM mail_link WHERE token_digest=?').get(tokenDigest(params.token));
  } else {
    if (!/^[A-Za-z0-9]{10}$/.test(params.publicId || '') || typeof params.recipient !== 'string' || params.recipient.length > 320) throw notFound();
    const source = env.db.prepare('SELECT id FROM source_mailbox WHERE public_id=?').get(params.publicId);
    if (!source) throw notFound();
    const platformPart = params.platform || '';
    let selectedPlatform = null;
    if (!['p0', 'all'].includes(platformPart)) {
      const id = platformPart.includes('~') ? platformPart.slice(platformPart.lastIndexOf('~') + 1) : platformPart;
      try { selectedPlatform = findPlatform(env.db, id); } catch { throw notFound(); }
    }
    const recipient = params.recipient.trim().toLowerCase();
    const predicate = recipient.includes('@') ? 'recipient=? COLLATE NOCASE' : "substr(recipient,1,instr(recipient,'@')-1)=? COLLATE NOCASE";
    const candidates = env.db.prepare(`SELECT * FROM mail_link WHERE mailbox_id=? AND ${predicate}`).all(source.id, recipient);
    if (new Set(candidates.map(item => item.recipient.toLowerCase())).size > 1) throw notFound();
    row = candidates.find(item => (item.platform_id || null) === (selectedPlatform?.id || null));
    // An unrestricted link may receive additional filtering, never the reverse.
    if (!row && selectedPlatform) row = candidates.find(item => item.platform_id === null);
    if (row) row = { ...row, extraPlatformId: selectedPlatform?.id || null };
  }
  if (!row) throw notFound();
  return row;
}

export function validatePublicLink(env, row) {
  ensurePublicReady(env);
  let source;
  try { source = assertSourceReadable(env, row.mailbox_id); } catch { throw notFound(); }
  if (!source.enabled) throw notFound();
  if (row.expires_at !== null && (!Number.isSafeInteger(row.expires_at) || row.expires_at <= Date.now())) {
    throw new FeatureError(410, 'LINK_EXPIRED', 'This recipient link has expired.');
  }
  let platform = null;
  if (row.platform_id || row.extraPlatformId) {
    try { platform = findPlatform(env.db, row.platform_id || row.extraPlatformId); } catch { throw notFound(); }
  }
  const fingerprint = JSON.stringify([row.id, row.revision, row.recipient, source.id, source.revision, source.generation, platform?.id, platform?.revision, row.expires_at]);
  return { link: row, source, platform, fingerprint };
}

function revalidate(env, context) {
  const row = env.db.prepare('SELECT * FROM mail_link WHERE id=?').get(context.link.id);
  if (!row) throw notFound();
  const current = validatePublicLink(env, { ...row, extraPlatformId: context.link.extraPlatformId });
  if (current.fingerprint !== context.fingerprint) throw stale();
}

export async function confirmPublicAccess(env, context, signal) {
  revalidate(env, context);
  if (nodeRole(env) === 'replica') {
    await env.nodeState.runtime.relayRead({ context, recipient: context.link.recipient,
      platform: context.platform, order: 'latest', limit: 1, validateOnly: true, signal });
    revalidate(env, context);
  }
}

export function countLinkVisit(env, linkId, kind) {
  const column = kind === 'page' ? 'page_visits' : 'json_visits';
  env.db.prepare(`INSERT INTO link_access(link_id,${column},last_access_at) VALUES (?,1,?)
    ON CONFLICT(link_id) DO UPDATE SET ${column}=${column}+1,last_access_at=excluded.last_access_at`).run(linkId, Date.now());
}

function sessionState(env) {
  const state = env.publicMailState;
  const now = Date.now();
  for (const [id, session] of state.sessions) {
    if (session.expiresAt <= now) { state.sessions.delete(id); state.bytes -= session.bytes; }
  }
  return state;
}

function safeMessage(message) {
  const text = String(message.text || ''), html = String(message.html || '');
  if (Buffer.byteLength(text) + Buffer.byteLength(html) > 2 * 1024 * 1024) {
    throw new FeatureError(502, 'MESSAGE_TOO_LARGE', 'This message body exceeds the 2 MiB reading limit.');
  }
  return { id: String(message.id), subject: String(message.subject || ''), from: String(message.from || ''),
    receivedAt: message.receivedAt, text, html };
}

async function takePage(env, context, session, offset, limit, id, signal) {
  await confirmPublicAccess(env, context, signal);
  if (session.fingerprint !== context.fingerprint) throw stale();
  const items = session.items.slice(offset, offset + limit);
  const hasMore = offset + limit < session.items.length;
  return { recipient: context.link.recipient, items, order: session.order, hasMore,
    nextCursor: hasMore ? `${id}.${offset + limit}` : null };
}

export async function readPublicMessages(env, params, query = {}, signal) {
  const link = resolvePublicLink(env, params);
  const context = validatePublicLink(env, link);
  if (query.order !== undefined && !['latest', 'oldest'].includes(query.order)) throw new FeatureError(400, 'INVALID_ORDER', 'Choose latest or oldest message order.');
  const order = query.order || 'latest';
  const limit = positiveInt(query.limit, 'limit', { fallback: 20, max: 20 });
  const state = sessionState(env);
  if (query.cursor) {
    if (typeof query.cursor !== 'string' || query.cursor.length > 100 || !/^[A-Za-z0-9_-]{32}\.[1-9]\d*$/.test(query.cursor)) throw stale();
    const [id, position] = query.cursor.split('.'), offset = Number(position);
    const session = state.sessions.get(id);
    if (!session || session.order !== order || session.limit !== limit || !Number.isSafeInteger(offset) || offset >= session.items.length || offset % limit !== 0) throw stale();
    return takePage(env, context, session, offset, limit, id, signal);
  }
  const scanLimit = limit === 1 ? 1 : 100000;
  const result = await coordinatedSourceRead(env, { key: `${context.fingerprint}:${order}:${scanLimit}`, sourceId: context.source.id, signal },
    workSignal => readSourceMessages(env, context.source.id, {
      recipient: link.recipient, platform: context.platform, order, limit: scanLimit, signal: workSignal, accessContext: context,
    }));
  const items = result.messages.map(safeMessage);
  await confirmPublicAccess(env, context, signal);
  if (limit === 1 || items.length <= limit) return { recipient: link.recipient, items, order, hasMore: false, nextCursor: null };
  const bytes = Buffer.byteLength(JSON.stringify(items));
  if (bytes > 16 * 1024 * 1024 || state.bytes + bytes > 64 * 1024 * 1024 || state.sessions.size >= 64) {
    throw new FeatureError(429, 'PAGINATION_CAPACITY', 'Message pagination is busy. Retry later or request only the latest message.');
  }
  const id = randomBytes(24).toString('base64url');
  const session = { items, bytes, order, limit, fingerprint: context.fingerprint, expiresAt: Date.now() + 30 * 60 * 1000 };
  state.sessions.set(id, session); state.bytes += bytes;
  return takePage(env, context, session, 0, limit, id, signal);
}

export function mountPublicMailRoutes(router) {
  const list = async c => {
    const params = c.req.param();
    const row = resolvePublicLink(c.env, params);
    if (c.req.method === 'GET') countLinkVisit(c.env, row.id, 'json');
    const allowed = new Set(['limit', 'order', 'cursor']);
    if (Object.keys(c.req.query()).some(key => !allowed.has(key))) throw new FeatureError(400, 'INVALID_PARAMETER', 'Only limit, order, and cursor may be supplied.');
    return c.json({ data: await readPublicMessages(c.env, params, c.req.query(), c.req.raw.signal) });
  };
  router.get('/mailboxes/:token/messages', list);
  router.get('/mailboxes/:platform/:publicId/:recipient/messages', list);
}
