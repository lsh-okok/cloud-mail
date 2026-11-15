import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { FeatureError, positiveInt, strictJson } from '../shared/errors.js';
import { appendAudit } from '../shared/settings.js';
import { resolveClientIp } from '../shared/proxy.js';
import { nodeRole } from './access.js';
import { project, snapshotRecords } from './projection.js';
import { validatePublicLink } from '../public-mail/service.js';
import { readSourceMessages } from '../mail-sources/service.js';
import { coordinatedSourceRead } from '../mail-sources/coordinator.js';
import { deploymentOptions, deploymentBundle, prepareNodeDeployment, mountNodeDeploymentRoutes } from './deployment.js';

export { startNodeRuntime } from './runtime.js';
export { NODE_SCHEMA } from './schema.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const iso = value => value == null ? null : new Date(value).toISOString();
const integer = (value, name, max = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new FeatureError(400, 'INVALID_PARAMETER', `${name} must be a bounded nonnegative integer.`);
  return value;
};
const primaryOnly = env => {
  if (nodeRole(env) !== 'primary') throw new FeatureError(403, 'PRIMARY_ONLY', 'This endpoint is available only on the primary node.');
};
export function primaryCursor(db) {
  return Math.max(db.prepare('SELECT max(cursor) AS value FROM sync_event').get().value || 0,
    db.prepare('SELECT pruned_cursor FROM node_sync_meta WHERE id=1').get().pruned_cursor);
}
function primaryState(env) {
  const state = env.nodeState ||= {};
  state.bootId ||= randomUUID();
  return state;
}
function nodeRow(env, id) {
  const row = env.db.prepare('SELECT * FROM cluster_node WHERE id=?').get(id);
  if (!row) throw new FeatureError(404, 'NODE_NOT_FOUND', 'The node was not found.');
  return row;
}
export function nodeDto(env, row) {
  const cursor = primaryCursor(env.db);
  const online = !row.revoked && !row.disabled && row.last_heartbeat_at != null && Date.now() - row.last_heartbeat_at <= 15000;
  const ready = online && !!row.ready && row.cursor >= cursor;
  return { id: row.id, name: row.name, disabled: !!row.disabled, revoked: !!row.revoked,
    status: row.revoked ? 'revoked' : row.disabled ? 'disabled' : !row.initialized ? 'initializing' : online ? 'online' : 'offline',
    online, ready, ip: row.ip, lastHeartbeatAt: iso(row.last_heartbeat_at), lastSyncAt: iso(row.last_sync_at),
    cursor: row.cursor, primaryCursor: cursor, pendingEvents: Math.max(0, cursor - row.cursor),
    snapshot: { completed: row.snapshot_completed, total: row.snapshot_total,
      percent: row.snapshot_total ? Math.min(100, Math.floor(row.snapshot_completed * 100 / row.snapshot_total)) : 0 },
    lastError: row.last_error, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) };
}
function audit(c, action, id) {
  appendAudit(c.env.db, { actorId: c.get('featureAdmin')?.userId, action, objectType: 'node', objectId: id, requestId: c.get('requestId') || '' });
}

export function authenticateNode(c, previous) {
  primaryOnly(c.env);
  const id = c.req.header('x-node-id'), credential = c.req.header('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
  if (!id || !/^[A-Za-z0-9_-]{1,128}$/.test(id) || !credential) throw new FeatureError(401, 'NODE_UNAUTHENTICATED', 'Valid node credentials are required.');
  const row = c.env.db.prepare('SELECT * FROM cluster_node WHERE id=?').get(id);
  const actual = Buffer.from(digest(credential), 'hex'), expected = Buffer.from(row?.credential_digest || '00'.repeat(32), 'hex');
  if (!row || expected.length !== actual.length || !timingSafeEqual(actual, expected)) throw new FeatureError(401, 'NODE_UNAUTHENTICATED', 'Valid node credentials are required.');
  if (row.disabled || row.revoked || (previous && previous.status_version !== row.status_version)) throw new FeatureError(403, 'NODE_DISABLED', 'Node access is disabled or permanently revoked.');
  return row;
}

export function cleanupNodeStorage(env) {
  primaryOnly(env);
  env.db.transaction(() => {
    env.db.prepare('DELETE FROM node_snapshot WHERE expires_at<=? OR boot_id<>?').run(Date.now(), primaryState(env).bootId);
    const cutoff = Date.now() - 30 * 86400000;
    const firstFresh = env.db.prepare('SELECT min(cursor) AS value FROM sync_event WHERE created_at>=?').get(cutoff).value;
    const pruneThrough = firstFresh == null ? primaryCursor(env.db) : firstFresh - 1;
    const old = env.db.prepare('SELECT pruned_cursor FROM node_sync_meta WHERE id=1').get().pruned_cursor;
    if (pruneThrough > old) {
      env.db.prepare('DELETE FROM sync_event WHERE cursor<=?').run(pruneThrough);
      env.db.prepare('UPDATE node_sync_meta SET pruned_cursor=? WHERE id=1').run(pruneThrough);
    }
  }).immediate();
}

function makeSnapshot(c) {
  const authenticated = authenticateNode(c);
  if (!c.env.secretVault) throw new FeatureError(503, 'DATA_KEY_REQUIRED', 'Configure a data encryption key before creating protected snapshots.');
  cleanupNodeStorage(c.env);
  return c.env.db.transaction(() => {
    authenticateNode(c, authenticated);
    const records = snapshotRecords(c.env.db), cursor = primaryCursor(c.env.db);
    const bytes = Buffer.byteLength(JSON.stringify(records));
    if (records.length > 250000 || bytes > 128 * 1024 * 1024) throw new FeatureError(429, 'SNAPSHOT_CAPACITY', 'The fixed snapshot exceeds the supported capacity.');
    c.env.db.prepare('DELETE FROM node_snapshot WHERE node_id=?').run(authenticated.id);
    const usage = c.env.db.prepare('SELECT count(*) AS count,coalesce(sum(bytes),0) AS bytes FROM node_snapshot').get();
    if (usage.count >= 32 || usage.bytes + bytes > 256 * 1024 * 1024) throw new FeatureError(429, 'SNAPSHOT_CAPACITY', 'Snapshot storage is busy. Retry later.');
    const id = randomUUID(), pages = Math.ceil(records.length / 1000), expiresAt = Date.now() + 900000;
    c.env.db.prepare('INSERT INTO node_snapshot(id,node_id,boot_id,cursor,total,pages,expires_at,bytes) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, authenticated.id, primaryState(c.env).bootId, cursor, records.length, pages, expiresAt, bytes);
    const insert = c.env.db.prepare('INSERT INTO node_snapshot_page(snapshot_id,page,envelope) VALUES(?,?,?)');
    for (let page = 0; page < pages; page++) {
      const content = JSON.stringify(records.slice(page * 1000, (page + 1) * 1000));
      if (Buffer.byteLength(content) > 16 * 1024 * 1024) throw new FeatureError(429, 'SNAPSHOT_PAGE_CAPACITY', 'A fixed snapshot page exceeds the supported response capacity.');
      insert.run(id, page, c.env.secretVault.encrypt(content, `node-snapshot:${authenticated.id}:${id}:${page}`));
    }
    c.env.db.prepare('UPDATE cluster_node SET ready=0,snapshot_completed=0,snapshot_total=? WHERE id=? AND status_version=?')
      .run(records.length, authenticated.id, authenticated.status_version);
    return { sessionId: id, cursor, total: records.length, pageSize: 1000, pages, expiresAt: iso(expiresAt) };
  }).immediate();
}

export function mountNodeRoutes(router) {
  mountNodeDeploymentRoutes(router);
  router.get('/admin/nodes', c => {
    primaryOnly(c.env);
    const page = positiveInt(c.req.query('page'), 'page', { fallback: 1 }), pageSize = positiveInt(c.req.query('pageSize'), 'pageSize', { fallback: 20, max: 100 });
    const all = c.env.db.prepare('SELECT * FROM cluster_node ORDER BY created_at DESC,id').all();
    const items = all.slice((page - 1) * pageSize, page * pageSize).map(row => nodeDto(c.env, row));
    const current = all.filter(row => !row.revoked).map(row => nodeDto(c.env, row));
    return c.json({ data: { items, total: all.length, page, pageSize, summary: {
      total: current.length, online: current.filter(row => row.online).length, ready: current.filter(row => row.ready).length, primaryCursor: primaryCursor(c.env.db) } } });
  });
  router.post('/admin/nodes', async c => {
    primaryOnly(c.env);
    const data = await strictJson(c, ['name', 'deployment']);
    if (typeof data.name !== 'string' || !data.name.trim() || data.name.trim().length > 80 || /[\u0000-\u001f\u007f]/.test(data.name)) throw new FeatureError(400, 'INVALID_NODE_NAME', 'Enter a node name containing 1 to 80 characters.');
    const options = data.deployment === undefined ? null : deploymentOptions(c.env, data.deployment);
    const bundle = options ? await deploymentBundle(c.env) : null;
    const id = randomUUID(), credential = randomBytes(32).toString('base64url'), now = Date.now();
    const url = options?.primaryUrl || `${c.env.app_url}${c.env.base_path || ''}`;
    const env = `# Save this file securely. Use a separate data directory/volume from the primary.\nNODE_ROLE=replica\nNODE_PRIMARY_URL=${url}\nNODE_ID=${id}\nNODE_CREDENTIAL=${credential}\nNODE_ALLOW_INSECURE_HTTP=${options?.allowInsecureHttp || false}\nNODE_UPSTREAM_TIMEOUT=15000\nAPP_URL=http://localhost:${options?.port || 3001}\nAPP_BASE_PATH=\nPORT=3000\nDATA_DIR=./data-node-${id}\nJWT_SECRET=${randomBytes(32).toString('hex')}\nDATA_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}\nDATA_ENCRYPTION_KEY_ID=v1\n`;
    const deployment = options ? prepareNodeDeployment(c.env, { id, connectionEnv: env, options, bundle }) : null;
    const node = c.env.db.transaction(() => {
      if (c.env.db.prepare('SELECT count(*) AS total FROM cluster_node').get().total >= 1000) throw new FeatureError(429, 'NODE_CAPACITY', 'Remove obsolete revoked records before creating more nodes.');
      c.env.db.prepare('INSERT INTO cluster_node(id,name,credential_digest,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, data.name.trim(), digest(credential), now, now);
      audit(c, 'node.create', id);
      return nodeDto(c.env, nodeRow(c.env, id));
    }).immediate();
    deployment?.commit();
    return c.json({ data: { node, credential, connection: { filename: `cloud-mail-node-${id}.env`, env }, ...(deployment ? { deployment: deployment.result } : {}) } }, 201);
  });
  router.put('/admin/nodes/:id/status', async c => {
    primaryOnly(c.env);
    const data = await strictJson(c, ['disabled']);
    if (typeof data.disabled !== 'boolean') throw new FeatureError(400, 'INVALID_DISABLED', 'disabled must be a boolean.');
    const result = c.env.db.transaction(() => {
      const row = nodeRow(c.env, c.req.param('id'));
      if (row.revoked) throw new FeatureError(409, 'NODE_REVOKED', 'A permanently revoked node cannot be enabled.');
      if (!!row.disabled !== data.disabled) {
        c.env.db.prepare('UPDATE cluster_node SET disabled=?,ready=0,last_heartbeat_at=NULL,status_version=status_version+1,updated_at=? WHERE id=?')
          .run(Number(data.disabled), Date.now(), row.id);
        audit(c, data.disabled ? 'node.disable' : 'node.enable', row.id);
      }
      return nodeDto(c.env, nodeRow(c.env, row.id));
    }).immediate();
    return c.json({ data: result });
  });
  router.delete('/admin/nodes/:id', c => {
    primaryOnly(c.env);
    const result = c.env.db.transaction(() => {
      const row = nodeRow(c.env, c.req.param('id'));
      if (!row.revoked) {
        c.env.db.prepare('UPDATE cluster_node SET revoked=1,ready=0,status_version=status_version+1,updated_at=? WHERE id=?').run(Date.now(), row.id);
        c.env.db.prepare('DELETE FROM node_snapshot WHERE node_id=?').run(row.id);
        audit(c, 'node.revoke', row.id);
      }
      return nodeDto(c.env, nodeRow(c.env, row.id));
    }).immediate();
    return c.json({ data: result });
  });
  router.delete('/admin/nodes/:id/record', c => {
    primaryOnly(c.env);
    const id = c.req.param('id');
    c.env.db.transaction(() => {
      const row = nodeRow(c.env, id);
      if (!row.revoked) throw new FeatureError(409, 'NODE_NOT_REVOKED', 'Only permanently revoked node records may be deleted.');
      c.env.db.prepare('DELETE FROM cluster_node WHERE id=?').run(id);
      audit(c, 'node.delete', id);
    }).immediate();
    return c.json({ data: { deleted: true, id } });
  });
  router.use('/internal/*', async (c, next) => { authenticateNode(c); await next(); });
  router.post('/internal/snapshot', async c => { await strictJson(c, []); return c.json({ data: makeSnapshot(c) }); });
  router.get('/internal/snapshot/:id', c => {
    const node = authenticateNode(c), id = c.req.param('id');
    const page = c.req.query('page') === undefined ? 0 : integer(Number(c.req.query('page')), 'page');
    const row = c.env.db.prepare('SELECT * FROM node_snapshot WHERE id=? AND node_id=?').get(id, node.id);
    if (!row || row.expires_at <= Date.now() || row.boot_id !== primaryState(c.env).bootId) throw new FeatureError(409, 'SNAPSHOT_REQUIRED', 'The snapshot expired or the primary restarted. Start a new snapshot.');
    if (page >= row.pages) throw new FeatureError(400, 'INVALID_PARAMETER', 'The snapshot page is outside the fixed snapshot.');
    const saved = c.env.db.prepare('SELECT envelope FROM node_snapshot_page WHERE snapshot_id=? AND page=?').get(id, page);
    const items = JSON.parse(c.env.secretVault.decrypt(saved.envelope, `node-snapshot:${node.id}:${id}:${page}`));
    authenticateNode(c, node);
    return c.json({ data: { sessionId: id, cursor: row.cursor, total: row.total, page, pageSize: 1000, items, nextPage: page + 1 < row.pages ? page + 1 : null } });
  });
  router.get('/internal/events', c => {
    const node = authenticateNode(c), after = integer(Number(c.req.query('after')), 'after');
    const result = c.env.db.transaction(() => {
      const head = primaryCursor(c.env.db), floor = c.env.db.prepare('SELECT pruned_cursor FROM node_sync_meta WHERE id=1').get().pruned_cursor;
      if (after < floor || after > head) throw new FeatureError(409, 'SNAPSHOT_REQUIRED', 'The synchronization cursor is outside the retained event history.');
      const rows = c.env.db.prepare('SELECT * FROM sync_event WHERE cursor>? ORDER BY cursor LIMIT 500').all(after);
      let expected = after, bytes = 0;
      const events = [];
      for (const row of rows) {
        if (row.cursor !== expected + 1) throw new FeatureError(409, 'SNAPSHOT_REQUIRED', 'A synchronization event is missing. Start a new snapshot.');
        const event = { cursor: row.cursor, ...project(row.object_type, row.object_id, row.revision, JSON.parse(row.payload_json)) };
        const size = Buffer.byteLength(JSON.stringify(event)) + 1;
        if (bytes + size > 16 * 1024 * 1024) {
          if (!events.length) throw new FeatureError(429, 'EVENT_BATCH_CAPACITY', 'A synchronization event exceeds the supported response capacity.');
          break;
        }
        bytes += size; events.push(event); expected = row.cursor;
      }
      if (!rows.length && after < head) throw new FeatureError(409, 'SNAPSHOT_REQUIRED', 'The synchronization event history has a gap.');
      authenticateNode(c, node);
      return { after, events, cursor: expected, primaryCursor: head, hasMore: expected < head };
    }).immediate();
    return c.json({ data: result });
  });
  router.post('/internal/heartbeat', async c => {
    const authenticated = authenticateNode(c);
    const data = await strictJson(c, ['cursor', 'ready', 'snapshotCompleted', 'snapshotTotal', 'lastError']);
    const cursor = integer(data.cursor, 'cursor'), completed = integer(data.snapshotCompleted ?? 0, 'snapshotCompleted', 250000), total = integer(data.snapshotTotal ?? 0, 'snapshotTotal', 250000);
    if (typeof data.ready !== 'boolean' || completed > total || (data.lastError !== undefined && (typeof data.lastError !== 'string' || !/^[A-Z0-9_]{0,80}$/.test(data.lastError)))) throw new FeatureError(400, 'INVALID_PARAMETER', 'Heartbeat progress or error code is invalid.');
    const result = c.env.db.transaction(() => {
      const row = authenticateNode(c, authenticated), head = primaryCursor(c.env.db);
      if (cursor > head) throw new FeatureError(409, 'SNAPSHOT_REQUIRED', 'The node cursor is ahead of the primary.');
      const ready = data.ready && cursor === head && completed === total;
      const now = Date.now(), ip = c.get('clientIp') || resolveClientIp(c.env, c.req, c.env.remote_address) || null;
      const updated = c.env.db.prepare(`UPDATE cluster_node SET ip=?,last_heartbeat_at=?,last_sync_at=CASE WHEN ? THEN ? ELSE last_sync_at END,
        cursor=max(cursor,?),ready=?,initialized=max(initialized,?),snapshot_completed=?,snapshot_total=?,last_error=?
        WHERE id=? AND status_version=? AND disabled=0 AND revoked=0`).run(ip, now, Number(ready || cursor > row.cursor), now, cursor,
        Number(ready), Number(ready), completed, total, data.lastError || '', row.id, authenticated.status_version);
      if (!updated.changes) throw new FeatureError(403, 'NODE_DISABLED', 'The node status changed during its heartbeat.');
      return { primaryCursor: head, ready, nodeId: row.id };
    }).immediate();
    return c.json({ data: result });
  });
  router.post('/internal/mx/read', async c => {
    const node = authenticateNode(c);
    const data = await strictJson(c, ['linkId', 'recipient', 'platformId', 'fingerprint', 'order', 'limit', 'validateOnly']);
    if (typeof data.linkId !== 'string' || data.linkId.length > 128 || typeof data.recipient !== 'string' || data.recipient.length > 320 ||
      typeof data.fingerprint !== 'string' || data.fingerprint.length > 8192 || (data.platformId != null && typeof data.platformId !== 'string') ||
      typeof data.validateOnly !== 'boolean' || !['latest', 'oldest'].includes(data.order)) throw new FeatureError(400, 'INVALID_PARAMETER', 'A complete policy-bound mailbox read is required.');
    const limit = positiveInt(data.limit, 'limit', { max: 100000 });
    const resolve = () => {
      const row = c.env.db.prepare('SELECT * FROM mail_link WHERE id=?').get(data.linkId);
      if (!row || row.recipient.toLowerCase() !== data.recipient.toLowerCase() || (row.platform_id && row.platform_id !== data.platformId)) throw new FeatureError(404, 'LINK_NOT_FOUND', 'The recipient link is unavailable.');
      const context = validatePublicLink(c.env, { ...row, extraPlatformId: data.platformId || null });
      if (context.fingerprint !== data.fingerprint || (context.platform?.id || null) !== (data.platformId || null)) throw new FeatureError(409, 'LINK_POLICY_CHANGED', 'The primary policy changed. Wait for synchronization and refresh.');
      return context;
    };
    const context = resolve();
    const result = data.validateOnly ? { messages: [] } : await coordinatedSourceRead(c.env,
      { sourceId: context.source.id, key: `node:${context.fingerprint}:${data.order}:${limit}`, signal: c.req.raw.signal },
      signal => readSourceMessages(c.env, context.source.id, { recipient: context.link.recipient, platform: context.platform, order: data.order, limit, signal }));
    authenticateNode(c, node); resolve();
    return c.json({ data: result });
  });
  return router;
}
