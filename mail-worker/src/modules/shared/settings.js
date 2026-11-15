import { isIP } from 'node:net';
import { FeatureError, positiveInt, strictJson } from './errors.js';
import { recordFeatureChange } from './events.js';

export function appendAudit(db, { actorId = null, action, objectType, objectId = '', count = 1, result = 'success', requestId = '' }) {
  if (typeof action !== 'string' || !/^[a-z][a-z0-9_.-]{0,79}$/.test(action) ||
      typeof objectType !== 'string' || !/^[a-z][a-z0-9_.-]{0,79}$/.test(objectType) ||
      !Number.isSafeInteger(count) || count < 0 || !['success', 'failure', 'denied'].includes(result)) {
    throw new TypeError('Invalid audit metadata.');
  }
  if (typeof objectId !== 'string' || objectId.length > 256 || typeof requestId !== 'string' || requestId.length > 100) {
    throw new TypeError('Audit identifiers must be bounded strings.');
  }
  db.prepare(`INSERT INTO feature_audit(actor_id,action,object_type,object_id,object_count,result,request_id,created_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(actorId, action, objectType, objectId, count, result, requestId, Date.now());
}

export function readFeatureSettings(db) {
  const row = db.prepare('SELECT public_base_url, time_zone, revision FROM feature_settings WHERE id = 1').get();
  if (!row) throw new FeatureError(503, 'SETTINGS_UNAVAILABLE', 'The feature settings are unavailable.');
  return { publicBaseUrl: row.public_base_url, timeZone: row.time_zone, revision: row.revision };
}

function publicBaseUrl(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\s\\\u0000-\u001f\u007f]/.test(value)) {
    throw new FeatureError(400, 'INVALID_PUBLIC_URL', 'The public base URL must be a valid HTTPS address without credentials, a query, or a fragment.');
  }
  if (value === '') return '';
  let url;
  try { url = new URL(value); } catch { throw new FeatureError(400, 'INVALID_PUBLIC_URL', 'The public base URL is not a valid absolute URL.'); }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const loopback = host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'));
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) {
    throw new FeatureError(400, 'INVALID_PUBLIC_URL', 'Use HTTPS for the public base URL; HTTP is allowed only for loopback testing.');
  }
  return url.href.replace(/\/+$/, '');
}

export function mountSettingsRoutes(router) {
  router.get('/admin/settings', c => c.json({ data: readFeatureSettings(c.env.db) }));
  router.put('/admin/settings', async c => {
    const data = await strictJson(c, ['publicBaseUrl', 'timeZone', 'revision']);
    const revision = positiveInt(data.revision, 'revision');
    const base = publicBaseUrl(data.publicBaseUrl);
    if (typeof data.timeZone !== 'string' || data.timeZone.length > 100 || !/^[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)*$/.test(data.timeZone)) {
      throw new FeatureError(400, 'INVALID_TIME_ZONE', 'Choose a valid IANA time zone.');
    }
    try { new Intl.DateTimeFormat('en', { timeZone: data.timeZone }); } catch {
      throw new FeatureError(400, 'INVALID_TIME_ZONE', 'Choose a valid IANA time zone.');
    }
    const saved = c.env.db.transaction(() => {
      const result = c.env.db.prepare(`UPDATE feature_settings SET public_base_url = ?, time_zone = ?, revision = revision + 1
        WHERE id = 1 AND revision = ?`).run(base, data.timeZone, revision);
      if (result.changes !== 1) throw new FeatureError(409, 'REVISION_CONFLICT', 'Settings changed. Reload them before saving.');
      appendAudit(c.env.db, { actorId: c.get('featureAdmin').userId, action: 'settings.update', objectType: 'settings', objectId: '1', requestId: c.get('requestId') });
      const current = readFeatureSettings(c.env.db);
      recordFeatureChange(c.env.db, { objectType: 'settings', objectId: '1', revision: current.revision, payload: current });
      return current;
    }).immediate();
    return c.json({ data: saved });
  });
  return router;
}
