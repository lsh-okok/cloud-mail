import { Hono } from 'hono';
import { configureFeatureRouter } from './shared/security.js';
import { mountSettingsRoutes } from './shared/settings.js';
import { mountSourceRoutes } from './mail-sources/service.js';
import { mountLinkRoutes, mountPlatformRoutes } from './links/service.js';
import { mountPublicMailRoutes } from './public-mail/service.js';
import { mountVerificationRoutes } from './verification/service.js';
import { mountNodeRoutes } from './nodes/service.js';
import { mountDomainRoutes } from './domains/service.js';
import { mountAdministratorRoutes } from './administrators/service.js';

export function createFeatureRouter() {
  const router = configureFeatureRouter(new Hono());
  mountSettingsRoutes(router);
  mountSourceRoutes(router);
  mountPlatformRoutes(router);
  mountLinkRoutes(router);
  mountPublicMailRoutes(router);
  mountVerificationRoutes(router);
  mountNodeRoutes(router);
  mountDomainRoutes(router);
  mountAdministratorRoutes(router);
  // Keep unknown management/recipient paths inside their own authorization boundary.
  router.all('/admin/*', c => c.json({ error: { code: 'NOT_FOUND', message: 'This management endpoint does not exist.' } }, 404));
  router.all('/mailboxes/*', c => c.json({ error: { code: 'NOT_FOUND', message: 'This recipient endpoint does not exist.' } }, 404));
  return router;
}
