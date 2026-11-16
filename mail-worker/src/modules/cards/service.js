import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { FeatureError, positiveInt, strictJson } from '../shared/errors.js';
import { validateBrowserOrigin } from '../shared/security.js';
import { appendAudit } from '../shared/settings.js';
import { publicUrl } from '../shared/urls.js';
import { assertSourceReadable, normalizeEmail } from '../mail-sources/service.js';
import { findPlatform } from '../links/service.js';
import { createDelivery } from './delivery.js';

const MAX_LINKS_PER_CARD = 1000;
const MAX_LINKS_PER_ORDER = 5000;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_STORED_BYTES = 1024 * 1024 * 1024;
const MAX_ORDERS = 100000;
const digest = (value, purpose = '') => createHash('sha256').update(purpose).update('\0').update(value).digest('hex');
const codeDigest = value => createHash('sha256').update(value).digest('hex');
const iso = value => value == null ? null : new Date(value).toISOString();
const unavailableOrder = () => new FeatureError(404, 'ORDER_UNAVAILABLE', '订单不存在或查询凭证不正确。');
const downloadState = new WeakMap();

function vault(env) {
  if (!env.secretVault) throw new FeatureError(503, 'ENCRYPTION_NOT_CONFIGURED', '请先配置数据加密密钥。');
  return env.secretVault;
}

function status(card) {
  if (!card.is_current || card.revoked_at != null) return 'revoked';
  if (card.redeemed_at != null) return 'redeemed';
  return card.enabled ? 'unused' : 'disabled';
}

function cardDto(env, card) {
  return { id: card.id, code: vault(env).decrypt(card.code_encrypted, `mailbox-card:${card.id}`),
    status: status(card), enabled: !!card.enabled, revision: card.revision, isCurrent: !!card.is_current,
    createdAt: iso(card.created_at), redeemedAt: iso(card.redeemed_at), revokedAt: iso(card.revoked_at),
    supersedesCardId: card.supersedes_card_id };
}

function admin(c) { return c.get('featureAdmin').userId; }
function audit(c, action, { objectType = 'card', objectId = '', count = 1, result = 'success', anonymous = false } = {}) {
  appendAudit(c.env.db, { actorId: anonymous ? null : admin(c), action, objectType, objectId,
    count, result, requestId: c.get('requestId') || '' });
}

function ids(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 500 || value.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id))) {
    throw new FeatureError(400, 'INVALID_MAILBOX_IDS', '请选择 1～500 个主邮箱。');
  }
  return [...new Set(value)];
}

function cardRecord(env, id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new FeatureError(400, 'INVALID_CARD_ID', '兑换码标识无效。');
  const row = env.db.prepare('SELECT * FROM mailbox_card WHERE id=?').get(id);
  if (!row) throw new FeatureError(404, 'CARD_NOT_FOUND', '兑换码记录不存在。');
  return row;
}

function sourceRecord(env, id) {
  const source = env.db.prepare('SELECT * FROM source_mailbox WHERE id=?').get(id);
  if (!source || source.provider !== 'mx') throw new FeatureError(400, 'MAILBOX_UNAVAILABLE', '主邮箱不存在或来源不受支持。');
  assertSourceReadable(env, id);
  return source;
}

function assertBinding(card, source) {
  if (card.bound_email.toLowerCase() !== source.email.toLowerCase() ||
      card.bound_local_account_id !== source.local_account_id || card.bound_mx_domain !== source.mx_domain) {
    throw new FeatureError(400, 'MAILBOX_IDENTITY_CHANGED', '主邮箱绑定身份已改变，该兑换码不能继续使用。');
  }
}

function insertCard(c, source, supersedes = null) {
  const id = randomUUID(), code = `ML-${randomBytes(32).toString('base64url')}`;
  c.env.db.prepare(`INSERT INTO mailbox_card(id,mailbox_id,code_digest,code_encrypted,created_at,
    supersedes_card_id,bound_local_account_id,bound_email,bound_mx_domain,created_by) VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(id, source.id, codeDigest(code), vault(c.env).encrypt(code, `mailbox-card:${id}`), Date.now(),
      supersedes, source.local_account_id, source.email, source.mx_domain, admin(c));
  return cardRecord(c.env, id);
}

function mailboxRow(env, source) {
  const card = env.db.prepare('SELECT * FROM mailbox_card WHERE mailbox_id=? AND is_current=1').get(source.id);
  const counts = env.db.prepare('SELECT count(*) AS links,count(DISTINCT recipient COLLATE NOCASE) AS children FROM mail_link WHERE mailbox_id=?').get(source.id);
  let enabled = !!source.enabled;
  if (enabled) {
    try { assertSourceReadable(env, source.id); }
    catch (error) { if (error instanceof FeatureError && [400, 404].includes(error.status)) enabled = false; else throw error; }
  }
  return { mailboxId: source.id, mailboxEmail: source.email, mailboxEnabled: enabled,
    linkCount: counts.links, childCount: counts.children, card: card ? cardDto(env, card) : null };
}

function queryFields(c, allowed) {
  for (const key of new URL(c.req.url).searchParams.keys()) if (!allowed.includes(key)) {
    throw new FeatureError(400, 'UNKNOWN_FIELD', '查询参数不受支持。');
  }
}

function pagination(input) {
  return { page: positiveInt(input.page, 'page', { fallback: 1, max: 1000000 }),
    pageSize: positiveInt(input.pageSize, 'pageSize', { fallback: 50, max: 100 }) };
}

function cardList(c, input, code) {
  const { page, pageSize } = pagination(input);
  const wantedStatus = input.status || '';
  if (!['', 'unissued', 'unused', 'redeemed', 'disabled'].includes(wantedStatus)) throw new FeatureError(400, 'INVALID_STATUS', '兑换码状态无效。');
  const q = input.q || '';
  if (typeof q !== 'string' || Buffer.byteLength(q) > 320 || /^ML-[A-Za-z0-9_-]{43}$/.test(q.trim())) {
    throw new FeatureError(400, 'INVALID_SEARCH', '邮箱查询只能填写邮箱；完整兑换码请使用精确查询。');
  }
  const stateSql = `CASE WHEN k.id IS NULL THEN 'unissued' WHEN k.redeemed_at IS NOT NULL THEN 'redeemed' WHEN k.enabled=0 THEN 'disabled' ELSE 'unused' END`;
  const from = `FROM source_mailbox s LEFT JOIN mailbox_card k ON k.mailbox_id=s.id AND k.is_current=1 WHERE s.provider='mx'`;
  const stats = { unissued: 0, unused: 0, redeemed: 0, disabled: 0 };
  for (const row of c.env.db.prepare(`SELECT ${stateSql} AS state,count(*) AS count ${from} GROUP BY state`).all()) stats[row.state] = row.count;
  const clauses = [], params = [];
  if (q) { clauses.push(`s.email LIKE ? ESCAPE '\\'`); params.push(`%${q.trim().replace(/[\\%_]/g, '\\$&')}%`); }
  if (wantedStatus) { clauses.push(`${stateSql}=?`); params.push(wantedStatus); }
  if (code !== undefined) {
    clauses.push('EXISTS(SELECT 1 FROM mailbox_card historical WHERE historical.mailbox_id=s.id AND historical.code_digest=?)');
    params.push(codeDigest(code));
  }
  const filtered = `${from}${clauses.length ? ` AND ${clauses.join(' AND ')}` : ''}`;
  const total = c.env.db.prepare(`SELECT count(*) AS count ${filtered}`).get(...params).count;
  const rows = c.env.db.prepare(`SELECT s.* ${filtered} ORDER BY s.email COLLATE NOCASE,s.id LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);
  return { items: rows.map(row => mailboxRow(c.env, row)), total, page, pageSize, stats };
}

function normalizedCode(code) {
  if (typeof code !== 'string' || !code.trim() || Buffer.byteLength(code.trim()) > 128 || /[\u0000-\u001f\u007f]/.test(code.trim())) {
    throw new FeatureError(400, 'INVALID_CODE', '兑换码必须是 1～128 字节的非空字符串。');
  }
  return code.trim();
}

function requestKey(value, { management = false } = {}) {
  const highEntropy = typeof value === 'string' && (/^[A-Za-z0-9_-]{43}$/.test(value) && Buffer.from(value, 'base64url').length === 32 || /^[a-fA-F0-9]{64}$/.test(value));
  if (!highEntropy && !(management && typeof value === 'string' && /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/.test(value))) {
    throw new FeatureError(400, 'INVALID_REQUEST_KEY', '请使用 32 字节安全随机值作为请求和查询凭证。');
  }
  return value;
}

async function publicGuard(c, kind) {
  if ((c.env.node_role || c.env.nodeRole || 'primary') !== 'primary') throw new FeatureError(403, 'PRIMARY_ONLY', '兑换及订单只在主节点提供。');
  validateBrowserOrigin(c, { publicSite: true });
  const now = Date.now(), window = Math.floor(now / 60000);
  const cap = kind === 'redeem' ? 30 : kind === 'query' ? 60 : 20;
  const key = `cards:rate:${kind}:${window}:${digest(c.get('clientIp') || 'Unknown', 'client-ip')}`;
  const count = await c.env.kv.increment(key, 1, { expirationTtl: 120 });
  if (count > cap) {
    c.header('Retry-After', String(Math.max(1, Math.ceil(((window + 1) * 60000 - now) / 1000))));
    throw new FeatureError(429, 'RATE_LIMITED', '请求过于频繁，请稍后重试。');
  }
}

function checkedPlatform(env, id, cache) {
  if (!cache.has(id)) {
    let platform;
    try { platform = findPlatform(env.db, id); }
    catch (error) {
      if (!(error instanceof SyntaxError) && !(error instanceof FeatureError && error.code === 'PLATFORM_NOT_FOUND')) throw error;
      cache.set(id, new FeatureError(400, 'LINK_CONFIGURATION_INVALID', '子邮箱平台规则损坏或失效，无法完整交付。'));
    }
    if (platform) {
      const validLists = ['emails', 'domains', 'keywords'].every(key => Array.isArray(platform[key]) && platform[key].length <= 500 &&
        platform[key].every(value => typeof value === 'string' && value.trim() && value.length <= 320));
      const valid = validLists && typeof platform.name === 'string' && platform.name.trim() && platform.name.length <= 80 &&
        Number.isSafeInteger(platform.revision) && platform.revision > 0 && (platform.emails.length || platform.domains.length) &&
        platform.emails.every(value => normalizeEmail(value)) && platform.domains.every(value => value.length <= 253 && value.includes('.') &&
          value.split('.').every(part => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(part)));
      cache.set(id, valid ? platform : new FeatureError(400, 'LINK_CONFIGURATION_INVALID', '子邮箱平台规则格式异常，无法完整交付。'));
    }
  }
  const platform = cache.get(id);
  if (platform instanceof FeatureError) throw platform;
  return platform;
}

function linkSnapshot(env, requestUrl, source, platformCache) {
  const rows = env.db.prepare(`SELECT l.*,p.name AS platform_name FROM mail_link l LEFT JOIN platform_rule p ON p.id=l.platform_id
    WHERE l.mailbox_id=? ORDER BY l.recipient COLLATE NOCASE,coalesce(l.platform_id,''),l.id LIMIT ?`).all(source.id, MAX_LINKS_PER_CARD + 1);
  if (!rows.length) throw new FeatureError(400, 'NO_CHILD_LINKS', '该主邮箱没有子邮箱链接，未核销兑换码。');
  if (rows.length > MAX_LINKS_PER_CARD) throw new FeatureError(400, 'CARD_CAPACITY_EXCEEDED', '该主邮箱链接超过 1000 条，无法完整交付。');
  const links = [], seen = new Set();
  for (const row of rows) {
    if (!normalizeEmail(row.recipient) || /[\r\n]/.test(row.recipient) || row.platform_id && !row.platform_name ||
        row.expires_at !== null && (!Number.isSafeInteger(row.expires_at) || Math.abs(row.expires_at) > 8640000000000000)) {
      throw new FeatureError(400, 'LINK_CONFIGURATION_INVALID', '子邮箱链接配置异常，无法完整交付。');
    }
    if (row.platform_id) checkedPlatform(env, row.platform_id, platformCache);
    const token = vault(env).decrypt(row.token_encrypted, `mail-link:${row.id}`);
    if (!/^[A-Za-z0-9_-]{20,128}$/.test(token) || codeDigest(token) !== row.token_digest) {
      throw new FeatureError(400, 'LINK_CONFIGURATION_INVALID', '子邮箱链接标识异常，无法完整交付。');
    }
    const url = publicUrl(env, requestUrl, `m/${token}`);
    let parsed;
    try { parsed = new URL(url); } catch { throw new FeatureError(400, 'LINK_CONFIGURATION_INVALID', '公开链接地址配置无效。'); }
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || /[\r\n]/.test(url)) {
      throw new FeatureError(400, 'LINK_CONFIGURATION_INVALID', '公开链接地址配置无效。');
    }
    const key = `${row.recipient}\0${url}`;
    if (!seen.has(key)) links.push({ recipient: row.recipient, url, platformName: row.platform_name || '全部平台', expiresAt: iso(row.expires_at) });
    seen.add(key);
  }
  return links;
}

function orderDto(env, order) {
  return JSON.parse(vault(env).decrypt(order.result_encrypted, `redemption-order:${order.order_no}`));
}

function businessError(error) {
  return error instanceof FeatureError && [400, 404].includes(error.status);
}

function redeem(c, data) {
  const key = requestKey(data.requestKey);
  if (!Array.isArray(data.codes) || data.codes.length < 1 || data.codes.length > 100) throw new FeatureError(400, 'INVALID_CODES', '一次请提交 1～100 个兑换码。');
  const codes = [...new Set(data.codes.map(normalizedCode))], batch = codes.length > 1;
  const fingerprint = digest(JSON.stringify({ codes, batch }), 'redemption-content-v1');
  const requestDigest = digest(key, 'redemption-request-v1');
  const secret = vault(c.env);
  return c.env.db.transaction(() => {
    const existing = c.env.db.prepare('SELECT * FROM redemption_order WHERE request_key_digest=?').get(requestDigest);
    if (existing) {
      if (existing.request_fingerprint !== fingerprint) throw new FeatureError(409, 'REQUEST_KEY_CONFLICT', '该请求凭证已用于其他兑换内容，请使用新凭证。');
      return { order: orderDto(c.env, existing), replayed: true };
    }
    const storage = c.env.db.prepare('SELECT count(*) AS count,coalesce(sum(stored_bytes),0) AS bytes FROM redemption_order').get();
    if (storage.count >= MAX_ORDERS || storage.bytes >= MAX_STORED_BYTES) throw new FeatureError(503, 'ORDER_STORAGE_CAPACITY', '订单保留空间已满，请联系管理员。');
    const orderNo = `RD-${randomBytes(16).toString('hex')}`, now = Date.now();
    const items = [], files = [], successful = [], seenMailboxes = new Set(), platformCache = new Map();
    let linkCount = 0, childCount = 0;
    for (const [index, code] of codes.entries()) {
      const card = c.env.db.prepare('SELECT * FROM mailbox_card WHERE code_digest=?').get(codeDigest(code));
      let item;
      try {
        if (!card) throw new FeatureError(400, 'CARD_NOT_FOUND', '兑换码不存在。');
        if (!card.is_current || card.revoked_at != null) throw new FeatureError(400, 'CARD_REVOKED', '兑换码已作废，请联系发码方。');
        if (card.redeemed_at != null || c.env.db.prepare('SELECT 1 FROM card_redemption WHERE card_id=?').get(card.id)) throw new FeatureError(400, 'CARD_REDEEMED', '兑换码已核销，请使用原订单查询凭证下载。');
        if (!card.enabled) throw new FeatureError(400, 'CARD_DISABLED', '兑换码已停用，请联系发码方。');
        const source = sourceRecord(c.env, card.mailbox_id);
        assertBinding(card, source);
        if (seenMailboxes.has(source.id)) throw new FeatureError(400, 'DUPLICATE_MAILBOX', '本次订单已包含该主邮箱。');
        const links = linkSnapshot(c.env, c.req.url, source, platformCache);
        if (linkCount + links.length > MAX_LINKS_PER_ORDER) throw new FeatureError(413, 'ORDER_CAPACITY_EXCEEDED', '本次链接总数超过 5000 条，请减少兑换码数量。');
        const children = new Set(links.map(link => link.recipient.toLowerCase())).size;
        item = { index, ok: true, codeStatus: 'redeemed', mailboxId: source.id, mailboxEmail: source.email,
          childCount: children, linkCount: links.length, links };
        files.push({ mailboxId: source.id, mailboxEmail: source.email, links });
        successful.push({ card, source, item, itemId: randomUUID() });
        seenMailboxes.add(source.id);
        linkCount += links.length; childCount += children;
      } catch (error) {
        if (!businessError(error)) throw error;
        item = { index, ok: false, codeStatus: card ? status(card) : 'unknown', error: { code: error.code, message: error.message } };
      }
      items.push({ item, cardId: card?.id || null });
    }
    const delivery = files.length ? createDelivery(orderNo, files, { batch }) : null;
    const file = delivery ? { filename: delivery.filename, contentType: delivery.contentType, size: delivery.buffer.length,
      sha256: codeDigest(delivery.buffer) } : null;
    const result = { orderNo, status: successful.length === codes.length ? 'success' : successful.length ? 'partial' : 'failed',
      createdAt: iso(now), batch, items: items.map(({ item }) => item), file,
      successCount: successful.length, failureCount: codes.length - successful.length, childCount, linkCount };
    const resultJson = JSON.stringify(result);
    if (Buffer.byteLength(resultJson) > MAX_SNAPSHOT_BYTES) throw new FeatureError(413, 'ORDER_CAPACITY_EXCEEDED', '订单结果超过容量限制，请减少兑换码数量。');
    const encryptedResult = secret.encrypt(resultJson, `redemption-order:${orderNo}`);
    const encryptedFile = delivery ? secret.encrypt(delivery.buffer.toString('base64'), `redemption-order-file:${orderNo}`) : null;
    let storedBytes = Buffer.byteLength(encryptedResult) + Buffer.byteLength(encryptedFile || '') + 1024;
    const persistedItems = items.map((entry, ordinal) => {
      const success = successful.find(value => value.item.index === ordinal), itemId = success?.itemId || randomUUID();
      const payload = secret.encrypt(JSON.stringify(entry.item), `redemption-order-item:${itemId}`);
      const binding = success ? secret.encrypt(JSON.stringify({ mailboxId: success.source.id,
        localAccountId: success.source.local_account_id, email: success.source.email, mxDomain: success.source.mx_domain }), `card-redemption:${success.card.id}`) : null;
      storedBytes += Buffer.byteLength(payload) + Buffer.byteLength(binding || '') + 512;
      return { entry, ordinal, success, itemId, payload, binding };
    });
    if (storage.bytes + storedBytes > MAX_STORED_BYTES) throw new FeatureError(503, 'ORDER_STORAGE_CAPACITY', '订单保留空间不足，未核销本次兑换码。');
    c.env.db.prepare(`INSERT INTO redemption_order(order_no,request_key_digest,query_key_digest,request_fingerprint,batch,status,created_at,
      result_encrypted,file_encrypted,filename,content_type,file_size,file_sha256,stored_bytes) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(orderNo, requestDigest, digest(key, 'redemption-query-v1'), fingerprint, Number(batch), result.status, now,
        encryptedResult, encryptedFile, file?.filename || null, file?.contentType || null, file?.size || 0, file?.sha256 || null, storedBytes);
    for (const { entry, ordinal, success, itemId, payload, binding } of persistedItems) {
      c.env.db.prepare(`INSERT INTO redemption_order_item(id,order_no,ordinal,card_id,mailbox_id,ok,payload_encrypted) VALUES(?,?,?,?,?,?,?)`)
        .run(itemId, orderNo, ordinal, entry.cardId, entry.item.mailboxId || null, Number(entry.item.ok), payload);
      if (success) {
        const changed = c.env.db.prepare(`UPDATE mailbox_card SET redeemed_at=?,revision=revision+1 WHERE id=? AND revision=?
          AND is_current=1 AND enabled=1 AND revoked_at IS NULL AND redeemed_at IS NULL`).run(now, success.card.id, success.card.revision);
        if (changed.changes !== 1) throw new FeatureError(409, 'CARD_CONFLICT', '兑换码状态已改变，请重新提交。');
        c.env.db.prepare(`INSERT INTO card_redemption(card_id,order_item_id,redeemed_at,bound_snapshot_encrypted) VALUES(?,?,?,?)`)
          .run(success.card.id, itemId, now, binding);
      }
    }
    audit(c, 'cards.redeem', { objectType: 'redemption-order', objectId: orderNo, count: successful.length,
      result: successful.length ? 'success' : 'failure', anonymous: true });
    return { order: result, replayed: false };
  }).immediate();
}

function authorizedOrder(c, data) {
  const key = requestKey(data.queryKey);
  if (data.orderNo !== undefined && (typeof data.orderNo !== 'string' || !/^RD-[a-f0-9]{32}$/.test(data.orderNo))) throw unavailableOrder();
  const order = c.env.db.prepare('SELECT * FROM redemption_order WHERE query_key_digest=?').get(digest(key, 'redemption-query-v1'));
  if (!order || data.orderNo && data.orderNo !== order.order_no) throw unavailableOrder();
  return order;
}

async function download(c, order, anonymous) {
  if (!order.file_encrypted || !order.filename || !order.file_sha256) throw new FeatureError(404, 'ORDER_FILE_UNAVAILABLE', '该订单没有可下载的成功结果。');
  // The HTTP adapter creates a fresh environment wrapper for each request.
  // The database object is shared for the lifetime of this primary process.
  const state = downloadState.get(c.env.db) || { active: 0 };
  downloadState.set(c.env.db, state);
  if (state.active >= 4) { c.header('Retry-After', '2'); throw new FeatureError(429, 'DOWNLOAD_BUSY', '下载任务较多，请稍后重试。'); }
  state.active++;
  let sent = false, released = false;
  const release = () => { if (!released) { state.active--; released = true; } };
  try {
    const body = Buffer.from(vault(c.env).decrypt(order.file_encrypted, `redemption-order-file:${order.order_no}`), 'base64');
    if (body.length !== order.file_size || codeDigest(body) !== order.file_sha256) throw new FeatureError(503, 'ORDER_FILE_CORRUPTED', '订单文件完整性校验失败，请联系管理员。');
    if (anonymous) {
      const bucket = Math.floor(Date.now() / 60000);
      const bytes = await c.env.kv.increment(`cards:bandwidth:${bucket}:${digest(c.get('clientIp') || 'Unknown', 'client-ip')}`, body.length, { expirationTtl: 120 });
      if (bytes > 64 * 1024 * 1024) {
        c.header('Retry-After', String(60 - Math.floor(Date.now() / 1000) % 60));
        throw new FeatureError(429, 'DOWNLOAD_RATE_LIMITED', '本分钟下载量已达上限，请稍后重试。');
      }
    }
    audit(c, 'cards.order.download', { objectType: 'redemption-order', objectId: order.order_no, anonymous });
    const stream = new ReadableStream({
      pull(controller) { if (!sent) { controller.enqueue(new Uint8Array(body)); sent = true; } else { controller.close(); release(); } },
      cancel() { release(); },
    });
    c.header('Content-Type', order.content_type);
    const encodedName = encodeURIComponent(order.filename).replace(/['()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
    c.header('Content-Disposition', `attachment; filename="${order.filename.replace(/[^A-Za-z0-9._-]/g, '_')}"; filename*=UTF-8''${encodedName}`);
    c.header('Content-Length', String(body.length));
    c.header('X-Content-SHA256', order.file_sha256);
    return c.body(stream);
  } catch (error) {
    release();
    throw error;
  }
}

function adminOrder(c, orderNo) {
  if (!/^RD-[a-f0-9]{32}$/.test(orderNo || '')) throw unavailableOrder();
  const order = c.env.db.prepare('SELECT * FROM redemption_order WHERE order_no=?').get(orderNo);
  if (!order) throw unavailableOrder();
  return order;
}

export function mountCardRoutes(router) {
  router.get('/admin/cards/config', c => c.json({ data: {
    redeemUrl: publicUrl(c.env, c.req.url, 'redeem'), orderQueryUrl: publicUrl(c.env, c.req.url, 'orders'),
  } }));
  router.get('/admin/cards', c => {
    queryFields(c, ['q', 'status', 'page', 'pageSize']);
    return c.json({ data: cardList(c, c.req.query()) });
  });
  router.post('/admin/cards/search', async c => {
    const data = await strictJson(c, ['code', 'status', 'page', 'pageSize']);
    return c.json({ data: cardList(c, data, normalizedCode(data.code)) });
  });
  router.post('/admin/cards', async c => {
    const data = await strictJson(c, ['mailboxIds']);
    const selected = ids(data.mailboxIds);
    vault(c.env);
    const items = c.env.db.transaction(() => {
      const sources = selected.map(id => sourceRecord(c.env, id));
      for (const source of sources) {
        const existing = c.env.db.prepare('SELECT * FROM mailbox_card WHERE mailbox_id=? AND is_current=1').get(source.id);
        if (existing) assertBinding(existing, source);
        else { insertCard(c, source); audit(c, 'cards.generate', { objectId: source.id }); }
      }
      return sources.map(source => mailboxRow(c.env, source));
    }).immediate();
    return c.json({ data: { items } }, 201);
  });
  router.put('/admin/cards/:cardId', async c => {
    const data = await strictJson(c, ['enabled', 'revision']);
    if (typeof data.enabled !== 'boolean') throw new FeatureError(400, 'INVALID_ENABLED', 'enabled 必须为布尔值。');
    const revision = positiveInt(data.revision, 'revision');
    const card = c.env.db.transaction(() => {
      const current = cardRecord(c.env, c.req.param('cardId'));
      if (!current.is_current || current.revoked_at != null) throw new FeatureError(409, 'CARD_REVOKED', '作废码不能恢复或修改。');
      if (current.redeemed_at != null) throw new FeatureError(409, 'CARD_REDEEMED', '已核销码不能恢复或修改，请重新生成新码。');
      if (!c.env.db.prepare('UPDATE mailbox_card SET enabled=?,revision=revision+1 WHERE id=? AND revision=?').run(Number(data.enabled), current.id, revision).changes) {
        throw new FeatureError(409, 'REVISION_CONFLICT', '兑换码已改变，请刷新后重试。');
      }
      audit(c, data.enabled ? 'cards.enable' : 'cards.disable', { objectId: current.id });
      return cardDto(c.env, cardRecord(c.env, current.id));
    }).immediate();
    return c.json({ data: { card } });
  });
  router.post('/admin/cards/:cardId/regenerate', async c => {
    const data = await strictJson(c, ['revision', 'requestKey']);
    const revision = positiveInt(data.revision, 'revision'), key = requestKey(data.requestKey, { management: true });
    const operationDigest = digest(key, 'card-regenerate-operation-v1');
    const fingerprint = digest(JSON.stringify({ cardId: c.req.param('cardId'), revision }), 'card-regenerate-content-v1');
    const result = c.env.db.transaction(() => {
      const operation = c.env.db.prepare('SELECT * FROM card_management_operation WHERE actor_id=? AND operation_digest=?').get(admin(c), operationDigest);
      if (operation) {
        if (operation.fingerprint !== fingerprint) throw new FeatureError(409, 'REQUEST_KEY_CONFLICT', '该操作凭证已用于其他换码操作。');
        return { card: cardDto(c.env, cardRecord(c.env, operation.new_card_id)), replayed: true };
      }
      const previous = cardRecord(c.env, c.req.param('cardId'));
      if (previous.revision !== revision || !previous.is_current || previous.revoked_at != null) throw new FeatureError(409, 'REVISION_CONFLICT', '当前码已改变，请刷新后重试。');
      const source = sourceRecord(c.env, previous.mailbox_id);
      assertBinding(previous, source);
      c.env.db.prepare('UPDATE mailbox_card SET is_current=0,revoked_at=?,revision=revision+1 WHERE id=?').run(Date.now(), previous.id);
      const current = insertCard(c, source, previous.id);
      c.env.db.prepare('INSERT INTO card_management_operation(actor_id,operation_digest,fingerprint,new_card_id,created_at) VALUES(?,?,?,?,?)')
        .run(admin(c), operationDigest, fingerprint, current.id, Date.now());
      audit(c, 'cards.regenerate', { objectId: current.id });
      return { card: cardDto(c.env, current), replayed: false };
    }).immediate();
    return c.json({ data: { card: result.card } }, result.replayed ? 200 : 201);
  });
  router.get('/admin/cards/:mailboxId/history', c => {
    queryFields(c, []);
    const mailboxId = c.req.param('mailboxId');
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(mailboxId)) throw new FeatureError(400, 'INVALID_MAILBOX_ID', '主邮箱标识无效。');
    const rows = c.env.db.prepare('SELECT * FROM mailbox_card WHERE mailbox_id=? ORDER BY created_at DESC,id DESC LIMIT 1001').all(mailboxId);
    if (rows.length > 1000) throw new FeatureError(413, 'HISTORY_CAPACITY', '历史码超过单次查询容量，请联系管理员。');
    return c.json({ data: { mailboxId, items: rows.map(row => cardDto(c.env, row)) } });
  });
  router.post('/admin/cards/export', async c => {
    const data = await strictJson(c, ['mailboxIds']);
    const selected = ids(data.mailboxIds);
    const text = c.env.db.transaction(() => {
      const codes = [];
      for (const mailboxId of selected) {
        const card = c.env.db.prepare('SELECT * FROM mailbox_card WHERE mailbox_id=? AND is_current=1 AND enabled=1 AND redeemed_at IS NULL AND revoked_at IS NULL').get(mailboxId);
        if (card) {
          const source = sourceRecord(c.env, mailboxId);
          assertBinding(card, source);
          codes.push(cardDto(c.env, card).code);
        }
      }
      audit(c, 'cards.export', { count: codes.length });
      return codes.length ? `${codes.join('\r\n')}\r\n` : '';
    }).immediate();
    const body = Buffer.from(`\ufeff${text}`, 'utf8');
    c.header('Content-Type', 'text/plain; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="mailbox-cards-${Date.now()}.txt"`);
    c.header('Content-Length', String(body.length));
    c.header('X-Content-SHA256', codeDigest(body));
    return c.body(body);
  });
  router.post('/redeem', async c => {
    await publicGuard(c, 'redeem');
    const result = redeem(c, await strictJson(c, ['codes', 'requestKey']));
    return c.json({ data: result.order }, result.replayed ? 200 : 201);
  });
  router.post('/orders/query', async c => {
    await publicGuard(c, 'query');
    const data = await strictJson(c, ['orderNo', 'queryKey']);
    return c.json({ data: orderDto(c.env, authorizedOrder(c, data)) });
  });
  router.post('/orders/download', async c => {
    await publicGuard(c, 'download');
    return download(c, authorizedOrder(c, await strictJson(c, ['orderNo', 'queryKey'])), true);
  });
  router.get('/admin/redemption-orders', c => {
    queryFields(c, ['q', 'status', 'mailboxId', 'page', 'pageSize']);
    const input = c.req.query(), { page, pageSize } = pagination(input), clauses = [], params = [];
    if (input.status) {
      if (!['success', 'partial', 'failed'].includes(input.status)) throw new FeatureError(400, 'INVALID_STATUS', '订单状态无效。');
      clauses.push('o.status=?'); params.push(input.status);
    }
    if (input.mailboxId) { clauses.push('EXISTS(SELECT 1 FROM redemption_order_item i WHERE i.order_no=o.order_no AND i.mailbox_id=?)'); params.push(input.mailboxId); }
    if (input.q) {
      if (Buffer.byteLength(input.q) > 320) throw new FeatureError(400, 'INVALID_SEARCH', '查询内容过长。');
      const like = `%${input.q.replace(/[\\%_]/g, '\\$&')}%`;
      clauses.push(`(o.order_no LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM redemption_order_item i JOIN mailbox_card k ON k.id=i.card_id WHERE i.order_no=o.order_no AND k.bound_email LIKE ? ESCAPE '\\'))`);
      params.push(like, like);
    }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const total = c.env.db.prepare(`SELECT count(*) AS count FROM redemption_order o${where}`).get(...params).count;
    const rows = c.env.db.prepare(`SELECT o.order_no FROM redemption_order o${where} ORDER BY o.created_at DESC,o.order_no DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize);
    const statement = c.env.db.prepare('SELECT * FROM redemption_order WHERE order_no=?');
    const items = rows.map(row => {
      const order = orderDto(c.env, statement.get(row.order_no));
      // The detail endpoint returns the links. Do not accumulate up to 100
      // maximum-size encrypted snapshots and link collections in a list page.
      return { ...order, items: order.items.map(({ links, ...item }) => item) };
    });
    return c.json({ data: { items, total, page, pageSize } });
  });
  router.get('/admin/redemption-orders/:orderNo', c => c.json({ data: orderDto(c.env, adminOrder(c, c.req.param('orderNo'))) }));
  router.post('/admin/redemption-orders/:orderNo/download', async c => {
    await strictJson(c, []);
    return download(c, adminOrder(c, c.req.param('orderNo')), false);
  });
}
