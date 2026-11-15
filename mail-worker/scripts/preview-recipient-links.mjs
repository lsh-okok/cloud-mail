// Isolated, local-only UI fixture. Never starts SMTP/LMTP or reads .env.
import { serve } from '@hono/node-server';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { loadConfig } from '../src/server/config.js';
import { createEnvironment } from '../src/server/environment.js';
import { createApp } from '../src/server/app.js';
import { saveSourceMailbox } from '../src/modules/mail-sources/service.js';

const root = mkdtempSync(join(tmpdir(), 'cloud-mail-feature-preview-'));
const config = loadConfig({ MAIL_DOMAINS: 'example.com', ADMIN_EMAIL: 'admin@example.com',
  ADMIN_PASSWORD: 'local-preview-password', JWT_SECRET: 'local-preview-jwt-secret-not-for-production',
  DATA_ENCRYPTION_KEY: 'ab'.repeat(32), APP_URL: 'http://127.0.0.1:3217',
  DATA_DIR: root, STATIC_DIR: resolve('dist') });
config.sqlitePath = ':memory:';
const env = await createEnvironment(config);
const app = createApp(env);
const source = saveSourceMailbox(env, { email: 'main@example.com', provider: 'mx', mxDomain: 'example.com' });
const account = env.db.prepare('SELECT * FROM account LIMIT 1').get();
for (const recipient of ['a1@example.com', 'a2@example.com', 'a3@example.com']) {
  env.db.prepare(`INSERT INTO email(user_id,account_id,send_email,subject,to_email,text,content,type,is_del)
    VALUES (?,?,?,?,?,?,?,0,0)`).run(account.user_id, account.account_id, 'sender@service.example',
    `只属于 ${recipient} 的邮件`, recipient, `收件地址：${recipient}`, `<p>这封邮件仅供 <strong>${recipient}</strong> 阅读。</p><script>alert('blocked')</script><img src="https://tracker.invalid/pixel">`);
}
const login = await (await app.request('http://127.0.0.1:3217/api/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: config.admin, password: config.admin_password }),
}, env)).json();
const token = login.data.token;
const session = await (await app.request('http://127.0.0.1:3217/api/admin/session', { headers: { Authorization: token } }, env)).json();
const links = await (await app.request('http://127.0.0.1:3217/api/admin/links', {
  method: 'POST', headers: { Authorization: token, 'X-CSRF-Token': session.data.csrfToken, 'content-type': 'application/json' },
  body: JSON.stringify({ mailboxId: source.id, recipients: ['a1@example.com', 'a2@example.com', 'a3@example.com'], expiresAt: null }),
}, env)).json();
if (!links.data) throw new Error('Unable to create local preview links.');
const server = serve({ fetch: request => app.fetch(request, env), hostname: '127.0.0.1', port: 3217 });
console.info(JSON.stringify({ publicUrls: links.data.items.map(item => item.pageUrl),
  adminUrl: 'http://127.0.0.1:3217/admin/links', email: config.admin, password: config.admin_password }));
process.once('SIGINT', () => server.close(() => {
  env.db.close();
  if (!resolve(root).startsWith(`${resolve(tmpdir())}${sep}`) || !basename(root).startsWith('cloud-mail-feature-preview-')) throw new Error('Unexpected preview directory.');
  rmSync(root, { recursive: true, force: true }); process.exit(0);
}));
