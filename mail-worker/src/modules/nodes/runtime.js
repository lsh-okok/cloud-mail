import { FeatureError } from '../shared/errors.js';
import { applyRecord, project } from './projection.js';
import { assertReplicaReady, invalidateNodeCaches, nodeRole } from './access.js';
import { cleanupNodeStorage } from './service.js';
import { randomUUID } from 'node:crypto';
import { startPublicIpDiscovery } from './address.js';

const needsSnapshot = () => new FeatureError(409, 'SNAPSHOT_REQUIRED', 'A complete new node snapshot is required.');
const unavailable = () => new FeatureError(503, 'NODE_UPSTREAM_UNAVAILABLE', 'The primary node could not confirm this read. Please retry shortly.');
const number = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const stateRow = env => env.db.prepare('SELECT * FROM node_replica_state WHERE id=1').get();

export function resetReplicaSnapshot(env) {
  env.db.transaction(() => {
    env.db.prepare('DELETE FROM node_replica_staging').run();
    env.db.prepare(`UPDATE node_replica_state SET phase='snapshot',snapshot_id=NULL,snapshot_cursor=NULL,snapshot_total=NULL,
      snapshot_pages=NULL,snapshot_next=0,snapshot_expires_at=NULL WHERE id=1`).run();
  }).immediate();
  env.nodeState.ready = false; env.clusterReady = false;
  invalidateNodeCaches(env);
}

export function applyReplicaEvents(env, batch) {
  const saved = stateRow(env);
  if (!batch || !Array.isArray(batch.events) || batch.events.length > 500 || !number(batch.after) || batch.after > saved.cursor ||
      !number(batch.cursor) || !number(batch.primaryCursor) || batch.cursor > batch.primaryCursor || typeof batch.hasMore !== 'boolean') throw needsSnapshot();
  env.db.transaction(() => {
    let cursor = saved.cursor;
    for (const event of batch.events) {
      if (!number(event.cursor, 1)) throw needsSnapshot();
      if (event.cursor <= cursor) continue; // Redelivery is safe after committed progress.
      if (event.cursor !== cursor + 1) throw needsSnapshot();
      const record = project(event.type, event.id, event.revision, event.data);
      applyRecord(env.db, record);
      cursor = event.cursor;
    }
    if (batch.cursor !== cursor || batch.hasMore !== (cursor < batch.primaryCursor)) throw needsSnapshot();
    env.db.prepare("UPDATE node_replica_state SET cursor=?,phase='events' WHERE id=1").run(cursor);
  }).immediate();
  if (batch.events.length) invalidateNodeCaches(env);
  return stateRow(env).cursor;
}

export function installSnapshot(env) {
  env.db.transaction(() => {
    const state = stateRow(env);
    const count = env.db.prepare('SELECT count(*) AS value FROM node_replica_staging').get().value;
    if (state.snapshot_next !== state.snapshot_pages || count !== state.snapshot_total ||
      env.db.prepare("SELECT count(*) AS value FROM node_replica_staging WHERE type='settings'").get().value !== 1) throw needsSnapshot();
    // Preserve node-local statistics for links which survive a full rebuild.
    const visits = env.db.prepare('SELECT * FROM link_access').all();
    env.db.exec('DELETE FROM mail_link; DELETE FROM source_mailbox; DELETE FROM platform_rule; DELETE FROM node_replica_version;');
    for (const row of env.db.prepare(`SELECT * FROM node_replica_staging ORDER BY CASE type
      WHEN 'mailbox' THEN 0 WHEN 'platform' THEN 1 WHEN 'link' THEN 2 ELSE 3 END,position`).all()) {
      applyRecord(env.db, { type: row.type, id: row.object_id, revision: row.revision, data: JSON.parse(row.data_json) });
    }
    const insertVisit = env.db.prepare('INSERT INTO link_access(link_id,page_visits,json_visits,last_access_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM mail_link WHERE id=?)');
    for (const row of visits) insertVisit.run(row.link_id, row.page_visits, row.json_visits, row.last_access_at, row.link_id);
    env.db.prepare("UPDATE node_replica_state SET cursor=snapshot_cursor,phase='events',snapshot_id=NULL,initialized=1 WHERE id=1").run();
    env.db.prepare('DELETE FROM node_replica_staging').run();
  }).immediate();
  invalidateNodeCaches(env);
}

function primaryUrl(env) {
  let url;
  try { url = new URL(env.node_primary_url); } catch { throw new Error('NODE_PRIMARY_URL must be an absolute primary URL.'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1' || /^127\./.test(host);
  if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol) ||
      (url.protocol === 'http:' && !loopback && env.node_allow_insecure_http !== true)) throw new Error('NODE_PRIMARY_URL requires HTTPS; controlled LAN HTTP requires NODE_ALLOW_INSECURE_HTTP=true.');
  if (typeof env.node_id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(env.node_id) ||
      typeof env.node_credential !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(env.node_credential)) throw new Error('A replica requires NODE_ID and NODE_CREDENTIAL.');
  return url.href.replace(/\/+$/, '');
}

async function boundedJson(response, signal) {
  const reader = response.body?.getReader();
  if (!reader) throw unavailable();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      if (signal.aborted) throw unavailable();
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 20 * 1024 * 1024) { await reader.cancel(); throw unavailable(); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { reader.releaseLock(); }
}

export function startNodeRuntime(env) {
  const owner = env.nodeState ||= {};
  if (owner.runtime) throw new Error('The node runtime is already running.');
  let stopped = false, pending = null;
  const lifetime = new AbortController(), requests = new Map();
  owner.ready = false; owner.denied = false; owner.lastSuccessAt = 0; env.clusterReady = false;
  const replica = nodeRole(env) === 'replica';
  if (!replica) owner.bootId = randomUUID();
  const base = replica ? primaryUrl(env) : null;
  const timeout = env.node_upstream_timeout ?? 15000;
  if (!number(timeout, 100) || timeout > 60000) throw new Error('NODE_UPSTREAM_TIMEOUT must be between 100 and 60000 milliseconds.');
  const fetcher = env.node_fetch || globalThis.fetch;
  const publicIp = replica ? startPublicIpDiscovery({
    fetcher: env.node_public_ip_fetch || globalThis.fetch, signal: lifetime.signal, publicIp: env.node_public_ip,
  }) : null;
  let publicIpReporting = false;

  function notReady() { owner.ready = false; env.clusterReady = false; invalidateNodeCaches(env); }
  function syncFailure(error) {
    const code = error instanceof FeatureError && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : 'NODE_SYNC_UNAVAILABLE';
    if (error.status === 401 || error.status === 403) { owner.denied = true; notReady(); }
    if (!owner.lastSuccessAt || Date.now() - owner.lastSuccessAt > 120000) notReady();
    if (!stopped) env.db.prepare('UPDATE node_replica_state SET last_error=? WHERE id=1').run(code);
  }

  async function request(path, data, externalSignal) {
    if (stopped) throw unavailable();
    const controller = new AbortController();
    let finish;
    const completed = new Promise(resolve => { finish = resolve; });
    requests.set(controller, completed);
    const timer = setTimeout(() => controller.abort(), timeout); timer.unref?.();
    const signal = AbortSignal.any([lifetime.signal, controller.signal, ...(externalSignal ? [externalSignal] : [])]);
    try {
      const response = await fetcher(`${base}/api/internal/${path}`, {
        method: data === undefined ? 'GET' : 'POST', signal, redirect: 'error',
        headers: { authorization: `Bearer ${env.node_credential}`, 'x-node-id': env.node_id,
          ...(data === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
      const body = await boundedJson(response, signal);
      if (stopped || signal.aborted) throw unavailable();
      if (!response.ok) {
        const code = typeof body.error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(body.error.code) ? body.error.code : 'NODE_UPSTREAM_ERROR';
        // Do not echo an upstream error body, URL or credential to public callers.
        throw new FeatureError(response.status, code, response.status === 404 ? 'The recipient link is unavailable.' :
          response.status === 410 ? 'The recipient link expired.' : 'The primary rejected or could not complete this operation.');
      }
      if (!body || !Object.hasOwn(body, 'data')) throw unavailable();
      return body.data;
    } catch (error) {
      const result = error instanceof FeatureError ? error : unavailable();
      if (result.status === 401 || result.status === 403) { owner.denied = true; notReady(); }
      throw result;
    } finally { clearTimeout(timer); requests.delete(controller); finish(); }
  }

  async function heartbeat(ready) {
    const row = stateRow(env);
    const data = { cursor: row.cursor, ready,
      snapshotCompleted: Math.min(row.snapshot_total || 0, row.snapshot_next * 1000), snapshotTotal: row.snapshot_total || 0, lastError: '' };
    const address = publicIpReporting ? publicIp.getIp() : null;
    let result;
    try { result = await request('heartbeat', { ...data, ...(address ? { publicIp: address } : {}) }); }
    catch (error) {
      // A primary can be rolled back while a replica remains online. Retry the
      // old protocol once if that version no longer recognizes publicIp.
      if (!address || error.status !== 400 || error.code !== 'UNKNOWN_FIELD') throw error;
      publicIpReporting = false;
      result = await request('heartbeat', data);
    }
    if (!number(result.primaryCursor) || typeof result.ready !== 'boolean' || result.nodeId !== env.node_id) throw needsSnapshot();
    publicIpReporting = result.publicIpReporting === true;
    return result;
  }

  async function synchronize() {
    let row = stateRow(env);
    if (row.phase === 'snapshot') {
      notReady();
      if (!row.snapshot_id || row.snapshot_expires_at <= Date.now()) {
        const snapshot = await request('snapshot', {});
        const expiresAt = Date.parse(snapshot.expiresAt);
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(snapshot.sessionId || '') || !number(snapshot.cursor) || !number(snapshot.total, 1) || snapshot.total > 250000 ||
            snapshot.pageSize !== 1000 || snapshot.pages !== Math.ceil(snapshot.total / 1000) || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw needsSnapshot();
        env.db.transaction(() => {
          env.db.prepare('DELETE FROM node_replica_staging').run();
          env.db.prepare(`UPDATE node_replica_state SET snapshot_id=?,snapshot_cursor=?,snapshot_total=?,snapshot_pages=?,snapshot_next=0,snapshot_expires_at=? WHERE id=1`)
            .run(snapshot.sessionId, snapshot.cursor, snapshot.total, snapshot.pages, expiresAt);
        }).immediate();
        row = stateRow(env);
      }
      // Bound work per tick while retaining every completed page across restarts.
      for (let work = 0; row.snapshot_next < row.snapshot_pages && work < 5; work++) {
        const page = await request(`snapshot/${encodeURIComponent(row.snapshot_id)}?page=${row.snapshot_next}`);
        const expectedLength = Math.min(1000, row.snapshot_total - row.snapshot_next * 1000);
        if (page.sessionId !== row.snapshot_id || page.page !== row.snapshot_next || page.cursor !== row.snapshot_cursor ||
            page.total !== row.snapshot_total || page.pageSize !== 1000 || !Array.isArray(page.items) || page.items.length !== expectedLength ||
            page.nextPage !== (row.snapshot_next + 1 < row.snapshot_pages ? row.snapshot_next + 1 : null)) throw needsSnapshot();
        const records = page.items.map(item => {
          const record = project(item.type, item.id, item.revision, item.data);
          if (record.type === 'noop' || record.data.deleted) throw needsSnapshot();
          return record;
        });
        env.db.transaction(() => {
          const insert = env.db.prepare('INSERT INTO node_replica_staging(position,type,object_id,revision,data_json) VALUES(?,?,?,?,?)');
          records.forEach((record, index) => insert.run(row.snapshot_next * 1000 + index, record.type, record.id, record.revision, JSON.stringify(record.data)));
          env.db.prepare('UPDATE node_replica_state SET snapshot_next=snapshot_next+1 WHERE id=1 AND snapshot_id=? AND snapshot_next=?').run(row.snapshot_id, row.snapshot_next);
        }).immediate();
        row = stateRow(env);
      }
      if (row.snapshot_next < row.snapshot_pages) { await heartbeat(false); return; }
      installSnapshot(env); row = stateRow(env);
    }
    for (let batches = 0; batches < 20; batches++) {
      const batch = await request(`events?after=${row.cursor}`);
      applyReplicaEvents(env, batch); row = stateRow(env);
      if (batch.hasMore) { notReady(); continue; }
      const confirmation = await heartbeat(true);
      if (confirmation.primaryCursor < row.cursor) throw needsSnapshot();
      owner.denied = false; owner.lastSuccessAt = Date.now(); owner.ready = confirmation.ready && row.cursor === confirmation.primaryCursor;
      env.clusterReady = owner.ready;
      env.db.prepare('UPDATE node_replica_state SET last_success_at=?,last_error=? WHERE id=1').run(owner.lastSuccessAt, '');
      if (!owner.ready) invalidateNodeCaches(env);
      return;
    }
    notReady(); await heartbeat(false);
  }

  function tick() {
    if (stopped) return Promise.resolve();
    if (pending) return pending;
    pending = (async () => {
      if (!replica) { cleanupNodeStorage(env); return; }
      for (let attempt = 0; attempt < 2; attempt++) {
        try { await synchronize(); return; }
        catch (error) {
          if (stopped) return;
          if (error.code === 'SNAPSHOT_REQUIRED') { resetReplicaSnapshot(env); if (attempt === 0) continue; }
          if (error.code === 'LINK_POLICY_CHANGED') notReady();
          syncFailure(error); return;
        }
      }
    })().finally(() => { pending = null; });
    return pending;
  }

  const runtime = {
    tick,
    async relayRead({ context, recipient, platform, order = 'latest', limit = 1, validateOnly = false, signal }) {
      assertReplicaReady(env);
      if (!context?.link?.id || typeof context.fingerprint !== 'string' || context.link.recipient !== recipient ||
          (context.platform?.id || null) !== (platform?.id || null)) throw new FeatureError(403, 'NODE_POLICY_REQUIRED', 'A complete public link policy is required.');
      try {
        const result = await request('mx/read', { linkId: context.link.id, recipient, platformId: platform?.id || null,
          fingerprint: context.fingerprint, order, limit, validateOnly }, signal);
        assertReplicaReady(env);
        if (!result || !Array.isArray(result.messages) || (validateOnly && result.messages.length)) throw unavailable();
        return result;
      } catch (error) {
        if (error.code === 'LINK_POLICY_CHANGED') { notReady(); void tick(); }
        if (error.status >= 500) syncFailure(error);
        if (error.status === 401 || error.status === 403) throw new FeatureError(503, 'NODE_NOT_READY', 'The primary disabled or revoked this node.');
        throw error;
      }
    },
  };
  owner.runtime = runtime;
  const timer = setInterval(() => { void tick().catch(() => { if (replica) notReady(); }); }, replica ? 5000 : 60000); timer.unref?.();
  queueMicrotask(() => { if (!stopped) void tick().catch(() => { if (replica) notReady(); }); });
  const stop = async () => {
    stopped = true; clearInterval(timer); lifetime.abort(); notReady();
    const inFlight = [...requests.values()];
    for (const controller of requests.keys()) controller.abort();
    await publicIp?.close();
    await pending?.catch(() => {});
    await Promise.allSettled(inFlight);
    // Public relay requests are awaited by HTTP shutdown before this runtime;
    // aborting them here still prevents any delayed network result being used.
    owner.runtime = null;
  };
  stop.tick = tick;
  return stop;
}
