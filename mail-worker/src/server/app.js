import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { serveStatic } from '@hono/node-server/serve-static';
import { join } from 'node:path';
import api from '../hono/webs.js';
import { createFeatureRouter } from '../modules/router.js';
import { resolveClientIp } from '../modules/shared/proxy.js';
import { resolvePublicLink, validatePublicLink, countLinkVisit, confirmPublicAccess } from '../modules/public-mail/service.js';
import { assertReplicaReady, nodeRole } from '../modules/nodes/access.js';
import { FeatureError } from '../modules/shared/errors.js';

export function createApp(env) {
  const application = createRoutes(env);
  if (!env.base_path) return application;
  const wrapper = new Hono();
  wrapper.all(env.base_path, c => c.redirect(`${env.base_path}/${new URL(c.req.url).search}`, 308));
  wrapper.all(`${env.base_path}/*`, c => {
    const url = new URL(c.req.url);
    url.pathname = url.pathname.slice(env.base_path.length) || '/';
    return application.fetch(new Request(url, c.req.raw), c.env);
  });
  return wrapper;
}

function createRoutes(env) {
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('clientIp', resolveClientIp(env, c.req, c.env.remote_address));
    c.header('X-Content-Type-Options', 'nosniff');
    if (nodeRole(env) === 'replica') {
      const path = c.req.path;
      const safeMethod = c.req.method === 'GET' || c.req.method === 'HEAD';
      const blocked = !safeMethod || (path.startsWith('/api/') && path !== '/api/health' && !path.startsWith('/api/mailboxes/')) ||
        /^\/(?:admin|login|redeem|orders|internal|oss|attachments|static)(?:\/|$)/.test(path);
      if (blocked) return c.json({ error: { code: 'REPLICA_READ_ONLY', message: 'This replica provides only public recipient reads.' } }, 403);
    }
    await next();
  });
  app.use('/api/*', bodyLimit({
    maxSize: Math.ceil(env.smtp.maxMessageBytes * 1.5) + 1024 * 1024,
    onError: c => c.json({ code: 413, message: 'Request body too large' }, 413),
  }));
  app.get('/api/health', c => {
    try {
      env.db.prepare('SELECT 1').get();
      return c.json({ status: 'ok', database: 'sqlite', mail: env.mailReady ? 'ready' : 'starting' });
    } catch {
      return c.json({ status: 'unavailable' }, 503);
    }
  });
  app.get('/health/live', c => c.json({ status: 'alive', role: env.node_role || 'primary' }));
  app.get('/health/ready', c => {
    const primary = (env.node_role || 'primary') === 'primary';
    let replicaReady = false;
    if (!primary) { try { assertReplicaReady(env); replicaReady = true; } catch {} }
    const ready = (primary ? !!env.mailReady : replicaReady) && env.db.open;
    return c.json({ status: ready ? 'ready' : 'unavailable', role: env.node_role || 'primary' }, ready ? 200 : 503);
  });
  app.route('/api', createFeatureRouter());
  app.all('/api/init/*', c => c.notFound());
  app.all('/api/*', c => {
    // Existing authorization and API handlers intentionally use paths without /api.
    const url = new URL(c.req.url);
    url.pathname = url.pathname.slice('/api'.length);
    return api.fetch(new Request(url, c.req.raw), { ...env, client_ip: c.get('clientIp') });
  });
  const objectResponse = async c => {
    const key = c.req.path.startsWith('/oss/') ? c.req.path.slice(5) : c.req.path.slice(1);
    const response = await c.env.storage.get(key);
    return response || c.notFound();
  };
  app.get('/oss/*', objectResponse);
  app.get('/attachments/*', objectResponse);
  app.get('/static/*', objectResponse);
  // Public routes must precede the asset heuristic: recipients may contain dots.
  const recipientPage = async (c, next) => {
    let status = 200;
    try {
      const link = resolvePublicLink(c.env, c.req.param());
      if (c.req.method === 'GET') countLinkVisit(c.env, link.id, 'page');
      await confirmPublicAccess(c.env, validatePublicLink(c.env, link), c.req.raw.signal);
    } catch (error) {
      status = error instanceof FeatureError ? error.status : 500;
    }
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    c.header('Content-Security-Policy', "frame-ancestors 'none'");
    const response = await serveStatic({ path: join(env.staticDir, 'index.html') })(c, next);
    if (response && status !== 200) return new Response(response.body, { status, headers: response.headers });
    return response;
  };
  app.get('/m/:token', recipientPage);
  app.get('/show/:platform/:publicId/:recipient', recipientPage);
  const redemptionPage = async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('Pragma', 'no-cache');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    c.header('Content-Security-Policy', "frame-ancestors 'none'");
    return serveStatic({ path: join(env.staticDir, 'index.html') })(c, next);
  };
  app.get('/redeem', redemptionPage);
  app.get('/orders', redemptionPage);
  app.use('*', serveStatic({ root: env.staticDir }));
  // Missing asset requests must not receive the SPA HTML with a successful status.
  app.get('*', async (c, next) => {
    if (c.req.path.split('/').at(-1).includes('.')) return c.notFound();
    return serveStatic({ path: join(env.staticDir, 'index.html') })(c, next);
  });
  return app;
}
