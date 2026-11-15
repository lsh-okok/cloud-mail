import KvConst from '../../const/kv-const.js';
import { FeatureError, positiveInt, strictJson } from '../shared/errors.js';
import { appendAudit } from '../shared/settings.js';

export function hasAdministratorTable(env) {
  return !!env.db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='site_administrator'").get();
}

function primary(env) {
  return (env.nodeRole ?? env.node_role ?? 'primary') === 'primary';
}

function userRecord(env, userOrId) {
  const id = typeof userOrId === 'object' && userOrId !== null ? userOrId.userId ?? userOrId.user_id : userOrId;
  if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0) return null;
  if (env.db) return env.db.prepare('SELECT user_id,email,status,is_del FROM user WHERE user_id=?').get(Number(id));
  return typeof userOrId === 'object' ? { user_id: Number(id), email: userOrId.email,
    status: userOrId.status ?? 0, is_del: userOrId.isDel ?? userOrId.is_del ?? 0 } : null;
}

export function isAdministrator(env, userOrId) {
  if (!primary(env)) return false;
  const user = userRecord(env, userOrId);
  if (!user) return false;
  if (hasAdministratorTable(env)) return !!env.db.prepare('SELECT 1 FROM site_administrator WHERE user_id=?').get(user.user_id);
  return typeof env.admin === 'string' && env.admin !== '' && user.email?.toLowerCase() === env.admin.toLowerCase();
}

export function isSuperAdmin(env, userOrId) {
  if (!primary(env)) return false;
  const user = userRecord(env, userOrId);
  return !!user && user.status === 0 && user.is_del === 0 && isAdministrator(env, user);
}

function hasActiveLoginAccount(env, user) {
  return !!env.db.prepare(`SELECT 1 FROM account WHERE user_id=? AND email=? COLLATE NOCASE
    AND status=0 AND is_del=0`).get(user.user_id, user.email);
}

export function assertCanManageUsers(env, targetIds) {
  const ids = Array.isArray(targetIds) ? targetIds : [targetIds];
  if (ids.some(id => isAdministrator(env, id))) {
    throw new FeatureError(409, 'ADMINISTRATOR_PROTECTED', 'Remove super administrator access before changing this user.');
  }
}

function requireAdministrator(env, actorId) {
  if (!primary(env)) throw new FeatureError(403, 'PRIMARY_ONLY', 'Manage administrators on the primary node.');
  if (!isSuperAdmin(env, actorId)) throw new FeatureError(403, 'ADMIN_REQUIRED', 'This operation requires a super administrator.');
  if (!hasAdministratorTable(env)) throw new FeatureError(503, 'ADMINISTRATORS_UNAVAILABLE', 'Administrator storage is not initialized.');
}

export function listAdministrators(env, { actorId } = {}) {
  requireAdministrator(env, actorId);
  const items = env.db.prepare(`SELECT u.user_id,u.email,u.status,u.is_del,a.granted_at
    FROM site_administrator a JOIN user u ON u.user_id=a.user_id ORDER BY a.granted_at,u.user_id`).all();
  return { items: items.map(user => ({ userId: user.user_id, email: user.email, isAdministrator: true,
    active: user.status === 0 && user.is_del === 0 && hasActiveLoginAccount(env, user), grantedAt: new Date(user.granted_at).toISOString() })) };
}

export function setAdministrator(env, userId, data, { actorId = null, requestId = '' } = {}) {
  userId = positiveInt(userId, 'userId');
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.enabled !== 'boolean' ||
    Object.keys(data).some(key => key !== 'enabled')) {
    throw new FeatureError(400, 'INVALID_ADMINISTRATOR_UPDATE', 'Provide enabled as a boolean.');
  }
  return env.db.transaction(() => {
    requireAdministrator(env, actorId);
    const user = userRecord(env, userId);
    if (!user) throw new FeatureError(404, 'USER_NOT_FOUND', 'The user was not found.');
    if (data.enabled && (user.status !== 0 || user.is_del !== 0 || !hasActiveLoginAccount(env, user))) {
      throw new FeatureError(409, 'USER_UNAVAILABLE', 'Enable and restore this user and their login mailbox before granting administrator access.');
    }
    const current = isAdministrator(env, user);
    if (current === data.enabled) return { userId, email: user.email, isAdministrator: current, changed: false };
    if (!data.enabled) {
      const activeCount = env.db.prepare(`SELECT count(*) AS n FROM site_administrator a
        JOIN user u ON u.user_id=a.user_id WHERE u.user_id<>? AND u.status=0 AND u.is_del=0
        AND EXISTS(SELECT 1 FROM account m WHERE m.user_id=u.user_id AND m.email=u.email COLLATE NOCASE AND m.status=0 AND m.is_del=0)`)
        .get(userId).n;
      if (activeCount < 1) throw new FeatureError(409, 'LAST_ADMINISTRATOR', 'Keep at least one active super administrator.');
    }
    if (data.enabled) {
      env.db.prepare('INSERT INTO site_administrator(user_id,granted_at,granted_by) VALUES(?,?,?)').run(userId, Date.now(), actorId);
    } else {
      env.db.prepare('DELETE FROM site_administrator WHERE user_id=?').run(userId);
    }
    // Sessions are stored in this database: commit revocation and permission changes together.
    env.db.prepare('DELETE FROM server_kv WHERE key=?').run(KvConst.AUTH_INFO + userId);
    if (!data.enabled) env.db.prepare('DELETE FROM server_kv WHERE key=?').run(KvConst.PUBLIC_KEY);
    appendAudit(env.db, { actorId, action: data.enabled ? 'administrator.grant' : 'administrator.revoke',
      objectType: 'administrator', objectId: String(userId), requestId });
    return { userId, email: user.email, isAdministrator: data.enabled, changed: true };
  }).immediate();
}

export function mountAdministratorRoutes(router) {
  router.get('/admin/administrators', c => c.json({ data: listAdministrators(c.env, { actorId: c.get('featureAdmin').userId }) }));
  router.put('/admin/users/:userId/administrator', async c => {
    const data = await strictJson(c, ['enabled'], { maxBytes: 1024 });
    return c.json({ data: setAdministrator(c.env, c.req.param('userId'), data,
      { actorId: c.get('featureAdmin').userId, requestId: c.get('requestId') || '' }) });
  });
  return router;
}
