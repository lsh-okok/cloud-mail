import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import constant from '../../const/constant.js';
import KvConst from '../../const/kv-const.js';
import { FeatureError } from './errors.js';

const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);

function equalText(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function verifySessionJwt(jwt, secret) {
  try {
    if (typeof jwt !== 'string' || jwt.length > 8192) return null;
    const parts = jwt.split('.');
    if (parts.length !== 3 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) return null;
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    if (header.alg !== 'HS256' || header.typ !== 'JWT') return null;
    const expected = createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest('base64url');
    if (!equalText(expected, parts[2])) return null;
    const value = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!Number.isSafeInteger(value.userId) || value.userId <= 0 || value.gen !== constant.AUTH_GEN ||
        typeof value.token !== 'string' || !value.token || value.token.length > 256) return null;
    if (value.exp !== undefined && (!Number.isFinite(value.exp) || value.exp <= Date.now() / 1000)) return null;
    return value;
  } catch { return null; }
}

function csrfToken(jwt, secret) {
  return createHmac('sha256', secret).update('cloud-mail-admin-csrf-v1\0').update(jwt).digest('base64url');
}

function validateBrowserOrigin(c) {
  const origin = c.req.header('origin');
  if (origin) {
    let expected;
    try { expected = new URL(c.env.app_url).origin; } catch { throw new FeatureError(503, 'ORIGIN_UNAVAILABLE', 'The public site origin is not configured.'); }
    if (origin !== expected) throw new FeatureError(403, 'CROSS_SITE_REQUEST', 'This operation must be submitted from the configured site.');
  }
  const site = c.req.header('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') {
    throw new FeatureError(403, 'CROSS_SITE_REQUEST', 'Cross-site submissions are not allowed.');
  }
}

export async function requireAdmin(c, next) {
  if ((c.env.nodeRole ?? c.env.node_role ?? 'primary') !== 'primary') {
    throw new FeatureError(403, 'PRIMARY_ONLY', 'Management is available only on the primary node.');
  }
  const authorization = c.req.header('authorization');
  const jwt = authorization?.replace(/^Bearer\s+/i, '');
  const session = verifySessionJwt(jwt, c.env.jwt_secret);
  if (!session) throw new FeatureError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
  const auth = await c.env.kv.get(KvConst.AUTH_INFO + session.userId, { type: 'json' });
  if (!auth || !Array.isArray(auth.tokens) || !auth.tokens.includes(session.token)) {
    throw new FeatureError(401, 'SESSION_EXPIRED', 'The session has expired. Sign in again.');
  }
  // Cached authInfo cannot keep an account alive after disable/delete or identity changes.
  const user = c.env.db.prepare('SELECT user_id, email, status, is_del FROM user WHERE user_id = ?').get(session.userId);
  if (!user || user.status !== 0 || user.is_del !== 0) throw new FeatureError(401, 'SESSION_EXPIRED', 'The session is no longer active.');
  if (user.email.toLowerCase() !== String(c.env.admin).toLowerCase()) {
    throw new FeatureError(403, 'ADMIN_REQUIRED', 'This operation requires the site administrator.');
  }
  c.set('featureAdmin', { userId: user.user_id, email: user.email, sessionToken: session.token });
  c.set('featureCsrfToken', csrfToken(jwt, c.env.jwt_secret));
  if (!safeMethods.has(c.req.method)) {
    validateBrowserOrigin(c);
    if (!equalText(c.req.header('x-csrf-token'), c.get('featureCsrfToken'))) {
      throw new FeatureError(403, 'CSRF_REQUIRED', 'Refresh the management page and retry this operation.');
    }
  }
  await next();
}

export function configureFeatureRouter(router) {
  router.use('*', async (c, next) => {
    const requestId = randomUUID();
    c.set('requestId', requestId);
    c.header('X-Request-ID', requestId);
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    await next();
  });
  router.onError((error, c) => {
    const known = error instanceof FeatureError;
    return c.json({ error: { code: known ? error.code : 'INTERNAL_ERROR',
      message: known ? error.message : 'The operation could not be completed.', requestId: c.get('requestId') } }, known ? error.status : 500);
  });
  router.notFound(c => c.json({ error: { code: 'NOT_FOUND', message: 'The requested resource was not found.', requestId: c.get('requestId') } }, 404));
  router.use('/admin/*', requireAdmin);
  router.get('/admin/session', c => c.json({ data: { csrfToken: c.get('featureCsrfToken') } }));
  return router;
}
