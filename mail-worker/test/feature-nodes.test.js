import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/server/config.js';
import { createEnvironment } from '../src/server/environment.js';
import { createApp } from '../src/server/app.js';
import { startNodeRuntime, cleanupNodeStorage, primaryCursor } from '../src/modules/nodes/service.js';
import { applyReplicaEvents } from '../src/modules/nodes/runtime.js';
import { assertReplicaReady } from '../src/modules/nodes/access.js';
import { saveSourceMailbox } from '../src/modules/mail-sources/service.js';
import { recordFeatureChange } from '../src/modules/shared/events.js';
import { tokenDigest } from '../src/modules/links/service.js';
import { validatePublicLink } from '../src/modules/public-mail/service.js';

const resources = [];
const deploymentToken = result => /'--install-token' '([A-Za-z0-9_-]{43})'/.exec(result.deployment.command)[1];
async function fixture({ role = 'primary', primary, node, prefix = '', root: existingRoot } = {}) {
  const root = existingRoot || mkdtempSync(join(tmpdir(), 'cloud-mail-nodes-'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><html><body>Public recipient application</body></html>');
  const config = loadConfig({ MAIL_DOMAINS: role === 'primary' ? 'example.com' : undefined,
    ADMIN_EMAIL: role === 'primary' ? 'admin@example.com' : undefined,
    ADMIN_PASSWORD: role === 'primary' ? 'node-test-administrator-password' : undefined,
    JWT_SECRET: role === 'primary' ? 'node-primary-test-jwt-at-least-32-characters' : 'node-replica-independent-jwt-at-least-32-characters',
    DATA_ENCRYPTION_KEY: (role === 'primary' ? 'ab' : 'cd').repeat(32),
    APP_URL: role === 'primary' ? 'https://mail.example.com' : 'https://edge.example.net', APP_BASE_PATH: prefix,
    DATA_DIR: join(root, 'data'), STATIC_DIR: root, NODE_ROLE: role,
    ...(role === 'replica' ? { NODE_PRIMARY_URL: primary.config.app_url + primary.prefix,
      NODE_ID: node.node.id, NODE_CREDENTIAL: node.credential } : {}),
  });
  const env = await createEnvironment(config);
  env.mailReady = role === 'primary';
  const app = createApp(env);
  const f = { root, env, app, config, prefix, stop: null, removed: false };
  resources.push(f);
  let token, csrf;
  async function api(path, { method = 'GET', data, headers = {}, admin = true } = {}) {
    return app.request(`${config.app_url}${prefix}/api${path}`, {
      method, headers: { 'content-type': 'application/json', 'accept-language': 'en',
        ...(token && admin ? { authorization: token } : {}), ...(csrf && admin ? { 'x-csrf-token': csrf } : {}),
        ...(method === 'GET' || method === 'HEAD' ? {} : { origin: config.app_url }), ...headers },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    }, { ...env, remote_address: '172.18.0.5' });
  }
  async function ok(path, options, status = 200) {
    const response = await api(path, options), body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(status); return body.data;
  }
  if (role === 'primary') {
    const login = await (await api('/login', { method: 'POST', admin: false,
      data: { email: config.admin, password: config.admin_password } })).json();
    expect(login.code, login.message).toBe(200); token = login.data.token;
    csrf = (await ok('/admin/session')).csrfToken;
  } else env.node_fetch = (url, init) => primary.app.request(url, init, { ...primary.env, remote_address: '172.18.0.8' });
  f.api = api; f.ok = ok;
  f.createNode = name => ok('/admin/nodes', { method: 'POST', data: { name: name || 'Read replica' } }, 201);
  f.internal = (node, path, { method = 'GET', data, headers = {} } = {}) => api('/internal/' + path,
    { method, admin: false, data, headers: { authorization: `Bearer ${node.credential}`, 'x-node-id': node.node.id, ...headers } });
  f.source = data => ok('/admin/mailboxes', { method: 'POST', data: { email: 'a@example.com', provider: 'mx', mxDomain: 'example.com', ...data } }, 201);
  f.links = (mailboxId, recipients, options) => ok('/admin/links', { method: 'POST', data: { mailboxId, recipients, ...options } }, 201);
  f.message = (recipient, subject, { accountId, from = 'sender@shop.example', headerTo = recipient } = {}) => {
    const account = env.db.prepare('SELECT account_id,user_id FROM account WHERE email=?').get(config.admin);
    return Number(env.db.prepare(`INSERT INTO email(user_id,account_id,to_email,recipient,send_email,subject,text,type,is_del)
      VALUES(?,?,?,?,?,?,?,0,0)`).run(account.user_id, accountId || account.account_id, recipient, JSON.stringify([{ address: headerTo }]), from, subject, subject).lastInsertRowid);
  };
  f.start = () => { f.stop = startNodeRuntime(env); return f.stop; };
  f.read = async (link, suffix = '?limit=1') => {
    const path = new URL(link.jsonUrl).pathname.replace(primary?.prefix || prefix, '');
    const response = await app.request(`${config.app_url}${prefix}${path}${suffix}`, {}, env);
    return { response, body: await response.json() };
  };
  return f;
}

async function pair({ prefix = '', accountScope = false } = {}) {
  const p = await fixture({ prefix }); p.start();
  const account = p.env.db.prepare('SELECT account_id FROM account WHERE email=?').get(p.config.admin);
  const source = await p.source(accountScope ? { email: p.config.admin, localAccountId: account.account_id, mxDomain: null } : {});
  const links = (await p.links(source.id, ['a1@example.com', 'a2@example.com'])).items;
  const node = await p.createNode();
  const r = await fixture({ role: 'replica', primary: p, node, prefix: prefix ? '/edge' : '' }); r.start();
  await r.stop.tick();
  expect(r.env.nodeState.ready, JSON.stringify(r.env.db.prepare('SELECT * FROM node_replica_state').get())).toBe(true);
  return { p, r, node, source, links, account };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of resources.splice(0).reverse()) {
    await f.stop?.();
    if (f.env.db.open) f.env.db.close();
    if (!f.removed) rmSync(f.root, { recursive: true, force: true });
  }
});

describe('independent MX replica nodes', () => {
  it('creates a temporary deployment command, serves only its build bundle, and invalidates it on lifecycle changes', async () => {
    const p = await fixture({ prefix: '/cloud' });
    const archive = Buffer.from('test-only-build-context');
    p.env.nodeDeploymentBundle = join(p.root, 'node-deploy.tar.gz');
    writeFileSync(p.env.nodeDeploymentBundle, archive);
    expect(await p.ok('/admin/nodes/deployment-options')).toEqual({ primaryUrl: 'https://mail.example.com/cloud', bundleAvailable: true, bundleFormat: 'source' });
    expect((await p.api('/admin/nodes/deployment-options', { admin: false })).status).toBe(401);
    const result = await p.ok('/admin/nodes', { method: 'POST', data: { name: 'One command', deployment: { port: 3010 } } }, 201);
    expect(result.deployment.installerUrl).toBe('https://raw.githubusercontent.com/lsh-okok/ok-email-scripts/main/cloud-mail-node/install-node.sh');
    expect(result.deployment.command).toContain(result.deployment.installerUrl);
    expect(result.deployment.command).toContain("'--primary-url' 'https://mail.example.com/cloud'");
    expect(result.deployment.command).toContain("'--port' '3010'");
    expect(result.deployment.localCommand).toMatch(/^sudo sh 'install-node.sh' /);
    expect(result.deployment.localCommand).toContain("'--primary-url' 'https://mail.example.com/cloud'");
    expect(result.deployment.command).not.toContain('--allow-insecure-http');
    expect(result.connection.env).toContain('APP_URL=http://localhost:3010');
    expect(result.connection.env).toContain('NODE_PRIMARY_URL=https://mail.example.com/cloud');
    const token = deploymentToken(result);
    expect(token).not.toBe(result.credential);
    expect(result.deployment.command).not.toContain(result.credential);
    const path = `/node-install/${token}`;
    const script = await p.api(`${path}/install.sh`, { admin: false });
    expect(script.status).toBe(200);
    expect(script.headers.get('cache-control')).toBe('no-store');
    expect(await script.text()).toBe(result.deployment.script);
    expect(result.deployment.script).toBe(`#!/bin/sh\nset -eu\n${result.deployment.command}\n`);
    expect(result.deployment.script).not.toContain(Buffer.from(result.connection.env).toString('base64'));
    expect(result.deployment.script).not.toContain(result.credential);
    expect(result.deployment.script).not.toContain('docker_cmd');
    expect(result.deployment.script).not.toContain(p.env.jwt_secret);
    expect(result.deployment.script).not.toContain(p.env.admin_password);
    const config = await p.api(`${path}/config.env`, { admin: false });
    expect(config.status).toBe(200);
    expect(config.headers.get('cache-control')).toBe('no-store');
    expect(config.headers.get('content-type')).toContain('text/plain');
    const configEnv = await config.text();
    expect(configEnv).toBe(`${result.connection.env}INSTALL_PORT=3010\nINSTALL_BUNDLE_SHA256=${createHash('sha256').update(archive).digest('hex')}\nINSTALL_BUNDLE_IMAGE_ID=\n`);
    expect(configEnv).not.toContain(p.env.jwt_secret);
    expect(configEnv).not.toContain(p.env.admin_password);
    expect((await p.api(`/node-install/${result.credential}/config.env`, { admin: false })).status).toBe(410);
    const bundle = await p.api(`${path}/bundle`, { admin: false });
    expect(bundle.status).toBe(200);
    expect(bundle.headers.get('cache-control')).toBe('no-store');
    expect(Buffer.from(await bundle.arrayBuffer())).toEqual(archive);
    const list = JSON.stringify(await p.ok('/admin/nodes'));
    expect(list).not.toContain(token);
    expect(list).not.toContain(result.credential);
    expect((await p.api('/node-install/invalid/install.sh', { admin: false })).status).toBe(410);
    expect((await p.api('/node-install/invalid/config.env', { admin: false })).status).toBe(410);
    await p.ok(`/admin/nodes/${result.node.id}/status`, { method: 'PUT', data: { disabled: true } });
    expect((await p.api(`${path}/install.sh`, { admin: false })).status).toBe(410);
    expect((await p.api(`${path}/config.env`, { admin: false })).status).toBe(410);
    await p.ok(`/admin/nodes/${result.node.id}/status`, { method: 'PUT', data: { disabled: false } });
    expect((await p.api(`${path}/bundle`, { admin: false })).status).toBe(410);
    expect((await p.api(`${path}/config.env`, { admin: false })).status).toBe(410);
  });

  it('rejects invalid deployment choices or missing bundles without creating orphan nodes, and expires installation access', async () => {
    const p = await fixture();
    p.env.nodeDeploymentBundle = join(p.root, 'missing.tar.gz');
    expect((await p.ok('/admin/nodes/deployment-options')).bundleAvailable).toBe(false);
    const create = deployment => p.api('/admin/nodes', { method: 'POST', data: { name: 'Deploy', deployment } });
    expect((await create({})).status).toBe(503);
    expect((await create({ primaryUrl: 'http://192.168.31.111:3000' })).status).toBe(400);
    for (const deployment of [{ port: 0 }, { port: 65536 }, { port: '3001' }, { unexpected: true },
      { primaryUrl: 'https://user:pass@primary.example.com' }, { primaryUrl: 'https://primary.example.com/?key=x' },
      { primaryUrl: 'https://primary.example.com/bad.path' }, { primaryUrl: 'https://localhost' },
      { primaryUrl: 'http://127.1', allowInsecureHttp: true }, { primaryUrl: 'https://[::1]' },
      { primaryUrl: 'https://0.0.0.0' }, { primaryUrl: 'https://[::ffff:127.0.0.1]' }, { allowInsecureHttp: 'true' }]) {
      expect((await create(deployment)).status).toBe(400);
    }
    expect((await p.ok('/admin/nodes')).total).toBe(0);
    writeFileSync(p.env.nodeDeploymentBundle, 'build-context');
    const response = await create({ primaryUrl: 'http://192.168.31.111:3000/cloud', allowInsecureHttp: true });
    expect(response.status).toBe(201);
    const result = (await response.json()).data;
    expect(result.connection.env).toContain('NODE_ALLOW_INSECURE_HTTP=true');
    expect(result.deployment.command).toContain("'--allow-insecure-http'");
    const token = deploymentToken(result);
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(result.deployment.expiresAt) + 1);
    expect((await p.api(`/node-install/${token}/install.sh`, { admin: false })).status).toBe(410);
    expect((await p.api(`/node-install/${token}/config.env`, { admin: false })).status).toBe(410);
  });

  it('rejects installation access after restart, package replacement, and permanent revocation', async () => {
    const p = await fixture();
    p.env.nodeDeploymentBundle = join(p.root, 'node-deploy.tar.gz');
    writeFileSync(p.env.nodeDeploymentBundle, 'original-build-context');
    const create = async () => {
      const result = await p.ok('/admin/nodes', { method: 'POST', data: { name: 'Deploy', deployment: {} } }, 201);
      const token = deploymentToken(result);
      return { result, path: `/node-install/${token}` };
    };
    const first = await create();
    writeFileSync(p.env.nodeDeploymentBundle, 'a different build context');
    expect((await p.api(`${first.path}/install.sh`, { admin: false })).status).toBe(410);
    expect((await p.api(`${first.path}/bundle`, { admin: false })).status).toBe(410);
    expect((await p.api(`${first.path}/config.env`, { admin: false })).status).toBe(410);
    const second = await create();
    await p.ok(`/admin/nodes/${second.result.node.id}`, { method: 'DELETE' });
    expect((await p.api(`${second.path}/bundle`, { admin: false })).status).toBe(410);
    expect((await p.api(`${second.path}/config.env`, { admin: false })).status).toBe(410);
    const third = await create();
    p.env.nodeState.deploymentTickets = new Map();
    expect((await p.api(`${third.path}/install.sh`, { admin: false })).status).toBe(410);
    expect((await p.api(`${third.path}/config.env`, { admin: false })).status).toBe(410);
  });

  it('serves a verified prebuilt image for offline deployment and rejects inconsistent release metadata', async () => {
    const p = await fixture(), archive = Buffer.from('test-image-archive');
    p.env.nodeDeploymentImageDir = p.root;
    writeFileSync(join(p.root, 'node-image.tar.gz'), archive);
    const metadata = { format: 'docker-image', imageId: `sha256:${'b'.repeat(64)}`, sha256: createHash('sha256').update(archive).digest('hex') };
    writeFileSync(join(p.root, 'node-image.json'), JSON.stringify(metadata));
    expect((await p.ok('/admin/nodes/deployment-options')).bundleFormat).toBe('docker-image');
    const result = await p.ok('/admin/nodes', { method: 'POST', data: { name: 'Offline', deployment: {} } }, 201);
    expect(result.deployment.format).toBe('docker-image');
    expect(result.deployment.script).not.toContain(metadata.imageId);
    const token = deploymentToken(result);
    const config = await p.api(`/node-install/${token}/config.env`, { admin: false });
    expect(config.status).toBe(200);
    expect(await config.text()).toContain(`INSTALL_BUNDLE_IMAGE_ID=${metadata.imageId}\n`);
    const bundle = await p.api(`/node-install/${token}/bundle`, { admin: false });
    expect(bundle.status).toBe(200);
    expect(Buffer.from(await bundle.arrayBuffer())).toEqual(archive);
    writeFileSync(join(p.root, 'node-image.json'), JSON.stringify({ ...metadata, sha256: '0'.repeat(64) }));
    expect((await p.ok('/admin/nodes/deployment-options')).bundleAvailable).toBe(false);
    expect((await p.api('/admin/nodes', { method: 'POST', data: { name: 'Broken release', deployment: {} } })).status).toBe(503);
    expect((await p.ok('/admin/nodes')).total).toBe(1);
  });

  it('returns random credentials once, stores only a digest, and enforces idempotent lifecycle boundaries', async () => {
    const p = await fixture(), node = await p.createNode('  Edge one  ');
    expect(node.node.name).toBe('Edge one');
    expect(node.credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(node.connection.env).toContain(`NODE_CREDENTIAL=${node.credential}`);
    expect(node.connection.env).not.toContain(p.env.jwt_secret);
    expect(node.connection.env).not.toContain(p.env.admin_password);
    const stored = p.env.db.prepare('SELECT * FROM cluster_node').get();
    expect(stored.credential_digest).toHaveLength(64);
    expect(JSON.stringify(stored)).not.toContain(node.credential);
    const list = await p.ok('/admin/nodes');
    expect(list.summary).toMatchObject({ total: 1, online: 0, ready: 0 });
    expect(JSON.stringify(list)).not.toContain(node.credential);
    expect(JSON.stringify(list)).not.toContain(stored.credential_digest);
    const heartbeat = () => p.internal(node, 'heartbeat', { method: 'POST', data: { cursor: 0, ready: true } });
    expect((await heartbeat()).status).toBe(200);
    expect((await p.ok('/admin/nodes')).items[0]).toMatchObject({ online: true, ready: true, ip: '172.18.0.5' });
    for (let i = 0; i < 2; i++) expect(await p.ok(`/admin/nodes/${node.node.id}/status`, { method: 'PUT', data: { disabled: true } })).toMatchObject({ disabled: true, online: false, ready: false });
    expect((await heartbeat()).status).toBe(403);
    expect(await p.ok(`/admin/nodes/${node.node.id}/status`, { method: 'PUT', data: { disabled: false } })).toMatchObject({ disabled: false, online: false });
    expect((await heartbeat()).status).toBe(200);
    expect((await p.api(`/admin/nodes/${node.node.id}/record`, { method: 'DELETE' })).status).toBe(409);
    await p.ok(`/admin/nodes/${node.node.id}`, { method: 'DELETE' });
    await p.ok(`/admin/nodes/${node.node.id}`, { method: 'DELETE' });
    expect((await p.api(`/admin/nodes/${node.node.id}/status`, { method: 'PUT', data: { disabled: false } })).status).toBe(409);
    expect((await heartbeat()).status).toBe(403);
    await p.ok(`/admin/nodes/${node.node.id}/record`, { method: 'DELETE' });
    expect((await heartbeat()).status).toBe(401);
    expect(p.env.db.prepare("SELECT count(*) AS count FROM feature_audit WHERE action LIKE 'node.%'").get().count).toBe(5);
  });

  it('keeps online separate from readiness and ignores forged IP or unauthorized heartbeats', async () => {
    const p = await fixture(), node = await p.createNode();
    await p.source();
    const body = { cursor: 0, ready: false, snapshotCompleted: 0, snapshotTotal: 1 };
    const before = p.env.db.prepare('SELECT * FROM cluster_node').get();
    const denied = await p.internal({ ...node, credential: randomBytes(32).toString('base64url') }, 'heartbeat', { method: 'POST', data: body });
    expect(denied.status).toBe(401);
    expect(p.env.db.prepare('SELECT * FROM cluster_node').get()).toEqual(before);
    await p.internal(node, 'heartbeat', { method: 'POST', data: body, headers: { 'x-forwarded-for': '203.0.113.99' } });
    expect((await p.ok('/admin/nodes')).items[0]).toMatchObject({ online: true, ready: false, ip: '172.18.0.5', pendingEvents: 1 });
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 15001);
    expect((await p.ok('/admin/nodes')).items[0].online).toBe(false);
  });

  it('rechecks status after an authenticated heartbeat body is delayed', async () => {
    const p = await fixture(), node = await p.createNode();
    let release;
    const stream = new ReadableStream({ start(controller) { release = () => { controller.enqueue(new TextEncoder().encode(JSON.stringify({ cursor: 0, ready: true }))); controller.close(); }; } });
    const pending = p.app.request(new Request('https://mail.example.com/api/internal/heartbeat', { method: 'POST', duplex: 'half',
      headers: { authorization: `Bearer ${node.credential}`, 'x-node-id': node.node.id, 'content-type': 'application/json' }, body: stream }), undefined, p.env);
    await new Promise(resolve => setImmediate(resolve));
    await p.ok(`/admin/nodes/${node.node.id}/status`, { method: 'PUT', data: { disabled: true } });
    release();
    expect((await pending).status).toBe(403);
    expect(p.env.db.prepare('SELECT disabled,last_heartbeat_at,ip,ready FROM cluster_node').get()).toEqual({ disabled: 1, last_heartbeat_at: null, ip: null, ready: 0 });
  });

  it('materializes node-bound encrypted fixed pages, excludes secrets and invalidates expired or restarted sessions', async () => {
    const p = await fixture(); p.start();
    const source = await p.source(), link = (await p.links(source.id, ['a1@example.com'])).items[0];
    const node = await p.createNode(), other = await p.createNode('Other edge');
    const snapshot = (await (await p.internal(node, 'snapshot', { method: 'POST', data: {} })).json()).data;
    const stored = p.env.db.prepare('SELECT envelope FROM node_snapshot_page').get().envelope;
    expect(stored).not.toContain('a1@example.com');
    const page = (await (await p.internal(node, `snapshot/${snapshot.sessionId}?page=0`)).json()).data;
    expect(page.items.map(item => item.type)).toEqual(['mailbox', 'link', 'settings']);
    const text = JSON.stringify(page);
    const secret = p.env.secretVault.decrypt(p.env.db.prepare('SELECT token_encrypted FROM mail_link WHERE id=?').get(link.id).token_encrypted, `mail-link:${link.id}`);
    expect(text).not.toContain('token_encrypted'); expect(text).not.toContain(secret);
    expect(text).not.toContain(p.env.jwt_secret); expect(text).not.toContain(p.env.admin_password); expect(text).not.toContain('source_secret');
    saveSourceMailbox(p.env, { email: 'new-main@example.com', revision: source.revision }, { id: source.id });
    expect((await (await p.internal(node, `snapshot/${snapshot.sessionId}?page=0`)).json()).data.items[0].data.email).toBe('a@example.com');
    expect((await p.internal(other, `snapshot/${snapshot.sessionId}?page=0`)).status).toBe(409);
    p.env.nodeState.bootId = randomUUID();
    expect((await p.internal(node, `snapshot/${snapshot.sessionId}?page=0`)).status).toBe(409);
    const fresh = (await (await p.internal(node, 'snapshot', { method: 'POST', data: {} })).json()).data;
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 900001);
    expect((await p.internal(node, `snapshot/${fresh.sessionId}?page=0`)).status).toBe(409);
  });

  it('resumes persistent staging after a replica restart and installs only a complete snapshot followed by newer events', async () => {
    const p = await fixture(); p.start(); const source = await p.source();
    p.env.db.transaction(() => {
      const insert = p.env.db.prepare("INSERT INTO mail_link(id,mailbox_id,recipient,token_digest,token_encrypted,created_at) VALUES(?,?,?,?,'protected-primary-only',?)");
      for (let i = 0; i < 5001; i++) insert.run(`link-${i}`, source.id, `child-${i}@example.com`, tokenDigest(`test-${i}`), Date.now());
    }).immediate();
    const node = await p.createNode(), r = await fixture({ role: 'replica', primary: p, node }); r.start();
    await r.stop.tick();
    expect(r.env.nodeState.ready).toBe(false);
    expect(r.env.db.prepare('SELECT count(*) AS n FROM mail_link').get().n).toBe(0);
    expect(r.env.db.prepare('SELECT count(*) AS n FROM node_replica_staging').get().n).toBe(5000);
    const session = r.env.db.prepare('SELECT snapshot_id FROM node_replica_state').get().snapshot_id;
    await r.stop(); r.stop = null; r.env.db.close(); r.removed = true;
    saveSourceMailbox(p.env, { email: 'updated-main@example.com', revision: source.revision }, { id: source.id });
    const resumed = await fixture({ role: 'replica', primary: p, node, root: r.root }); resumed.start(); await resumed.stop.tick();
    expect(resumed.env.nodeState.ready, JSON.stringify(resumed.env.db.prepare('SELECT * FROM node_replica_state').get())).toBe(true);
    expect(p.env.db.prepare('SELECT id FROM node_snapshot WHERE node_id=?').get(node.node.id).id).toBe(session);
    expect(resumed.env.db.prepare('SELECT count(*) AS n FROM mail_link').get().n).toBe(5001);
    expect(resumed.env.db.prepare('SELECT email FROM source_mailbox').get().email).toBe('updated-main@example.com');
    expect(resumed.env.db.prepare('SELECT count(*) AS n FROM node_replica_staging').get().n).toBe(0);
  });

  it('uses continuous 500-event batches, tolerates duplicates and rejects gaps without partial application', async () => {
    const { p, r, node } = await pair(); const start = primaryCursor(p.env.db);
    p.env.db.transaction(() => {
      for (let i = 1; i <= 601; i++) recordFeatureChange(p.env.db, { objectType: 'settings', objectId: '1', revision: i + 1,
        payload: { publicBaseUrl: '', timeZone: 'Asia/Shanghai', revision: i + 1 } });
    }).immediate();
    const batch = (await (await p.internal(node, `events?after=${start}`)).json()).data;
    expect(batch.events).toHaveLength(500); expect(batch.hasMore).toBe(true);
    expect(applyReplicaEvents(r.env, batch)).toBe(start + 500);
    expect(applyReplicaEvents(r.env, batch)).toBe(start + 500);
    const before = r.env.db.prepare('SELECT * FROM feature_settings').get();
    expect(() => applyReplicaEvents(r.env, { after: start + 500, events: [{ ...batch.events[0], cursor: start + 502 }], cursor: start + 502, primaryCursor: start + 601, hasMore: true })).toThrow();
    expect(r.env.db.prepare('SELECT * FROM feature_settings').get()).toEqual(before);
    await r.stop.tick(); expect(r.env.nodeState.ready).toBe(true);
    expect(r.env.db.prepare('SELECT revision FROM feature_settings').get().revision).toBe(602);
  });

  it('forces a fresh snapshot for expired history and preserves a monotonically increasing primary cursor', async () => {
    const { p, r, node, source } = await pair();
    const old = primaryCursor(p.env.db);
    saveSourceMailbox(p.env, { email: 'new-main@example.com', revision: source.revision }, { id: source.id });
    p.env.db.prepare('UPDATE sync_event SET created_at=?').run(Date.now() - 31 * 86400000);
    const head = primaryCursor(p.env.db); cleanupNodeStorage(p.env);
    expect(primaryCursor(p.env.db)).toBe(head);
    expect((await p.internal(node, `events?after=${old}`)).status).toBe(409);
    await r.stop.tick(); expect(r.env.nodeState.ready).toBe(true);
    expect(r.env.db.prepare('SELECT email FROM source_mailbox').get().email).toBe('new-main@example.com');
  });

  it('bounds continuous increment responses by bytes before the 500-event ceiling', async () => {
    const p = await fixture(), node = await p.createNode();
    const large = { name: 'Large platform', emails: [], domains: [], keywords: Array.from({ length: 1000 }, () => 'x'.repeat(300)) };
    p.env.db.transaction(() => {
      for (let i = 0; i < 80; i++) recordFeatureChange(p.env.db, { objectType: 'platform', objectId: `large-${i}`, revision: 1, payload: large });
    }).immediate();
    const response = await p.internal(node, 'events?after=0');
    const text = await response.text(), batch = JSON.parse(text).data;
    expect(response.status).toBe(200);
    expect(Buffer.byteLength(text)).toBeLessThan(17 * 1024 * 1024);
    expect(batch.events.length).toBeGreaterThan(1); expect(batch.events.length).toBeLessThan(80);
    expect(batch.events.map(event => event.cursor)).toEqual(Array.from({ length: batch.events.length }, (_, index) => index + 1));
    expect(batch.cursor).toBe(batch.events.length); expect(batch.hasMore).toBe(true);
    const next = (await (await p.internal(node, `events?after=${batch.cursor}`)).json()).data;
    expect(next.events[0].cursor).toBe(batch.cursor + 1); expect(next.hasMore).toBe(false);
  });

  it('relays exact envelope and platform reads with no mailbox database or primary secrets on the replica', async () => {
    const { p, r, links } = await pair({ prefix: '/mail' });
    p.message('a1@example.com', 'private-a1'); p.message('a2@example.com', 'private-a2', { headerTo: 'a1@example.com' });
    expect((await r.read(links[0])).body.data.items.map(item => item.subject)).toEqual(['private-a1']);
    expect((await r.read(links[1])).body.data.items.map(item => item.subject)).toEqual(['private-a2']);
    expect(r.env.db.prepare('SELECT count(*) AS n FROM email').get().n).toBe(0);
    expect(r.env.db.prepare('SELECT count(*) AS n FROM user').get().n).toBe(0);
    expect(r.env.db.prepare('SELECT count(*) AS n FROM source_secret').get().n).toBe(0);
    expect(r.env.db.prepare('SELECT token_encrypted FROM mail_link LIMIT 1').get().token_encrypted).toBe('');
    expect(p.env.db.prepare('SELECT sum(json_visits) AS n FROM link_access').get().n).toBeNull();
    expect(r.env.db.prepare('SELECT sum(json_visits) AS n FROM link_access').get().n).toBe(2);
  });

  it('relays forwarded external To and Cc within each main mailbox and rejects cached reads after primary source disable', async () => {
    const { p, r, source, account } = await pair({ accountScope: true });
    const parent = p.env.db.prepare('SELECT user_id FROM account WHERE account_id=?').get(account.account_id);
    const otherAccountId = Number(p.env.db.prepare('INSERT INTO account(email,name,user_id) VALUES(?,?,?)')
      .run('other@example.com', 'Other main mailbox', parent.user_id).lastInsertRowid);
    const otherSource = await p.source({ email: 'other@example.com', localAccountId: otherAccountId, mxDomain: null });
    const [toLink, ccLink] = (await p.links(source.id, ['forwarded-to@icloud.com', 'forwarded-cc@icloud.com'])).items;
    const [otherLink] = (await p.links(otherSource.id, [toLink.recipient])).items;
    const seed = (envelope, subject, accountId) => {
      const id = p.message(envelope, subject, { accountId, headerTo: toLink.recipient });
      p.env.db.prepare('UPDATE email SET cc=? WHERE email_id=?').run(JSON.stringify([{ address: ccLink.recipient }]), id);
    };
    seed(source.email, 'Main A forwarded verification', account.account_id);
    seed(otherSource.email, 'Main B forwarded verification', otherAccountId);
    seed('admin+private@example.com', 'Plus envelope private verification', account.account_id);
    await r.stop.tick();
    const relay = vi.spyOn(r.env.nodeState.runtime, 'relayRead');
    for (const [link, expected] of [[toLink, 'Main A forwarded verification'], [ccLink, 'Main A forwarded verification'], [otherLink, 'Main B forwarded verification']]) {
      const result = await r.read(link);
      expect(result.response.status, JSON.stringify(result.body)).toBe(200);
      expect(result.body.data.items.map(item => item.subject)).toEqual([expected]);
    }
    // Observe the real authenticated primary response; the replica must retain
    // these address fields to apply matchesRecipient again after the relay.
    const dataReads = relay.mock.calls.flatMap(([options], index) => options.validateOnly ? [] : [index]);
    expect(dataReads).toHaveLength(3);
    for (const index of dataReads) {
      const payload = await relay.mock.results[index].value;
      expect(payload.messages).toHaveLength(1);
      expect(payload.messages[0].to).toEqual([toLink.recipient]);
      expect(payload.messages[0].cc).toEqual([ccLink.recipient]);
      expect(payload.messages[0].envelopeRecipients).toEqual([
        payload.messages[0].subject.includes('Main A') ? source.email : otherSource.email,
      ]);
    }
    expect((await r.read(toLink)).response.status).toBe(200);
    expect(relay.mock.calls.filter(([options]) => !options.validateOnly)).toHaveLength(dataReads.length);
    expect(r.env.db.prepare('SELECT count(*) AS n FROM email').get().n).toBe(0);
    saveSourceMailbox(p.env, { enabled: false, revision: source.revision }, { id: source.id });
    // Do not synchronize this change: a cached body still needs current primary authorization.
    expect(r.env.db.prepare('SELECT enabled FROM source_mailbox WHERE id=?').get(source.id).enabled).toBe(1);
    const denied = await r.read(toLink);
    expect(denied.response.status).toBe(404);
    expect(JSON.stringify(denied.body)).not.toContain('Main A forwarded verification');
    expect((await r.read(otherLink)).response.status).toBe(200);
  });

  it('rechecks primary account and user status even for cached reads, stable cursors, pages and HEAD', async () => {
    const { p, r, links, account } = await pair({ accountScope: true });
    for (let i = 0; i < 4; i++) p.message('a1@example.com', `private-${i}`);
    expect((await r.read(links[0])).response.status).toBe(200);
    const cursor = (await r.read(links[0], '?limit=2')).body.data.nextCursor;
    expect(cursor).toBeTruthy();
    p.env.db.prepare('UPDATE account SET status=1 WHERE account_id=?').run(account.account_id);
    for (const query of ['?limit=1', `?limit=2&cursor=${cursor}`]) {
      const result = await r.read(links[0], query); expect(result.response.status).toBe(404); expect(JSON.stringify(result.body)).not.toContain('private-');
    }
    for (const method of ['GET', 'HEAD']) {
      const response = await r.app.request(links[0].pageUrl.replace('https://mail.example.com', 'https://edge.example.net'), { method }, r.env);
      expect(response.status).toBe(404);
    }
    p.env.db.prepare('UPDATE account SET status=0 WHERE account_id=?').run(account.account_id);
    p.env.db.prepare('UPDATE user SET status=1').run();
    expect((await r.read(links[0])).response.status).toBe(404);
  });

  it('rejects forged recipient or relaxed platform relay policies and stops old configuration reads', async () => {
    const { p, r, node, links, source } = await pair();
    p.message('a2@example.com', 'sibling-secret');
    const local = r.env.db.prepare('SELECT * FROM mail_link WHERE id=?').get(links[0].id);
    r.env.db.prepare('UPDATE mail_link SET recipient=? WHERE id=?').run('forged@example.com', local.id);
    expect((await r.read(links[0])).response.status).toBe(404);
    r.env.db.prepare('UPDATE mail_link SET recipient=? WHERE id=?').run(local.recipient, local.id);
    const bad = await p.internal(node, 'mx/read', { method: 'POST', data: { linkId: links[0].id, recipient: 'a2@example.com',
      platformId: null, fingerprint: 'forged', order: 'latest', limit: 1, validateOnly: false } });
    expect(bad.status).toBe(404); expect(await bad.text()).not.toContain('sibling-secret');
    saveSourceMailbox(p.env, { enabled: false, revision: source.revision }, { id: source.id });
    expect((await r.read(links[0])).response.status).toBe(404);
  });

  it('enforces bound platform rules on the primary relay and synchronizes changed rules and deletions', async () => {
    const { p, r, node, source } = await pair();
    const platform = await p.ok('/admin/platforms', { method: 'POST', data: {
      name: 'Store', emails: ['trusted@store.example'], domains: [], keywords: [],
    } }, 201);
    const link = (await p.links(source.id, ['platform-child@example.com'], { platformId: platform.id })).items[0];
    p.message(link.recipient, 'trusted-message', { from: 'trusted@store.example' });
    p.message(link.recipient, 'untrusted-newest', { from: 'attacker@elsewhere.example' });
    await r.stop.tick();
    expect((await r.read(link)).body.data.items.map(item => item.subject)).toEqual(['trusted-message']);
    const context = validatePublicLink(r.env, r.env.db.prepare('SELECT * FROM mail_link WHERE id=?').get(link.id));
    const relaxed = await p.internal(node, 'mx/read', { method: 'POST', data: { linkId: link.id, recipient: link.recipient,
      platformId: null, fingerprint: context.fingerprint, order: 'latest', limit: 1, validateOnly: false } });
    expect(relaxed.status).toBe(404);
    await p.ok(`/admin/platforms/${platform.id}`, { method: 'PUT', data: {
      revision: platform.revision, name: 'Store changed', emails: ['attacker@elsewhere.example'], domains: [], keywords: [],
    } });
    const stale = await r.read(link);
    expect(stale.response.status).toBe(409);
    expect(JSON.stringify(stale.body)).not.toContain('trusted-message');
    await r.stop.tick();
    expect((await r.read(link)).body.data.items.map(item => item.subject)).toEqual(['untrusted-newest']);
    await p.ok('/admin/links/batch', { method: 'POST', data: { ids: [link.id], action: 'delete' } });
    await r.stop.tick();
    expect(r.env.db.prepare('SELECT * FROM mail_link WHERE id=?').get(link.id)).toBeUndefined();
    expect((await r.read(link)).response.status).toBe(404);
    await p.ok(`/admin/platforms/${platform.id}`, { method: 'DELETE' });
    await r.stop.tick();
    expect(r.env.db.prepare('SELECT * FROM platform_rule WHERE id=?').get(platform.id)).toBeUndefined();
  });

  it('rejects a delayed cached relay result after the primary revokes the node', async () => {
    const { p, r, node, links } = await pair(); p.message('a1@example.com', 'delayed-secret');
    await r.stop(); r.stop = null;
    const normal = r.env.node_fetch;
    let release, began;
    const entered = new Promise(resolve => { began = resolve; });
    r.env.node_fetch = async (url, init) => {
      const response = await normal(url, init);
      if (url.endsWith('/mx/read') && JSON.parse(init.body).validateOnly === false) {
        began(); await new Promise(resolve => { release = resolve; });
      }
      return response;
    };
    r.start(); await r.stop.tick();
    const reading = r.read(links[0]); await entered;
    await p.ok(`/admin/nodes/${node.node.id}`, { method: 'DELETE' });
    release();
    const result = await reading;
    expect(result.response.status).toBe(503);
    expect(JSON.stringify(result.body)).not.toContain('delayed-secret');
    expect(r.env.nodeState.ready).toBe(false);
  });

  it('clears cached messages and cursors when policies synchronize and keeps absolute expiry enforcement', async () => {
    const { p, r, links } = await pair();
    for (let i = 0; i < 4; i++) p.message('a1@example.com', `private-${i}`);
    const cursor = (await r.read(links[0], '?limit=2')).body.data.nextCursor;
    expect(r.env.publicMailState.sessions.size).toBe(1);
    await p.ok(`/admin/links/${links[0].id}`, { method: 'PUT', data: { revision: 1, expiresAt: new Date(Date.now() + 60000).toISOString() } });
    await r.stop.tick();
    expect(r.env.publicMailState.sessions.size).toBe(0);
    expect((await r.read(links[0], `?limit=2&cursor=${cursor}`)).response.status).toBe(400);
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 60001);
    // Fresh synchronization proves the node is ready, so expiry is a 410 rather than staleness.
    await r.stop.tick();
    expect((await r.read(links[0])).response.status).toBe(410);
  });

  it('stops immediately on explicit disable and reconnects with original credentials after enable', async () => {
    const { p, r, node, links } = await pair(); p.message('a1@example.com', 'cached-private');
    expect((await r.read(links[0])).response.status).toBe(200);
    await p.ok(`/admin/nodes/${node.node.id}/status`, { method: 'PUT', data: { disabled: true } });
    expect((await r.read(links[0])).response.status).toBe(503);
    expect(r.env.nodeState.ready).toBe(false); expect(r.env.nodeState.denied).toBe(true);
    expect((await r.app.request('https://edge.example.net/health/ready', {}, r.env)).status).toBe(503);
    await p.ok(`/admin/nodes/${node.node.id}/status`, { method: 'PUT', data: { disabled: false } });
    expect((await p.ok('/admin/nodes')).items[0].online).toBe(false);
    await r.stop.tick(); expect(r.env.nodeState.ready).toBe(true);
    expect((await r.read(links[0])).response.status).toBe(200);
    await p.ok(`/admin/nodes/${node.node.id}`, { method: 'DELETE' });
    await r.stop.tick(); expect(r.env.nodeState.ready).toBe(false);
  });

  it('enforces the 120-second synchronization limit using shared state despite copied request environments', async () => {
    const { r } = await pair(); const requestEnv = { ...r.env };
    const now = Date.now(); r.env.node_fetch = () => { throw new Error('isolated network'); };
    // The runtime captured its transport intentionally; replace fetch before a fresh runtime.
    await r.stop(); r.stop = null;
    r.start(); await r.stop.tick();
    expect(r.env.nodeState.ready).toBe(false);
    r.env.nodeState.ready = true; r.env.nodeState.denied = false; r.env.nodeState.lastSuccessAt = now;
    vi.spyOn(Date, 'now').mockReturnValue(now + 119999);
    expect(() => assertReplicaReady(requestEnv)).not.toThrow();
    Date.now.mockReturnValue(now + 120001);
    expect(() => assertReplicaReady(requestEnv)).toThrow();
    expect((await r.app.request('https://edge.example.net/health/ready', {}, requestEnv)).status).toBe(503);
  });

  it('blocks new and legacy management, sending, deletion, object and internal endpoints on replicas', async () => {
    const { r } = await pair();
    for (const [method, path] of [['GET', '/api/admin/nodes'], ['POST', '/api/login'], ['GET', '/api/email/list'], ['POST', '/api/email/delete'],
      ['POST', '/api/email/send'], ['POST', '/api/redeem'], ['POST', '/api/internal/heartbeat'], ['GET', '/admin/nodes'],
      ['GET', '/attachments/private.eml'], ['GET', '/oss/private.eml'], ['GET', '/static/private.eml']]) {
      const response = await r.app.request(`https://edge.example.net${path}`, { method }, r.env);
      expect(response.status, `${method} ${path}`).toBe(403);
    }
    expect((await r.app.request('https://edge.example.net/health/live', {}, r.env)).status).toBe(200);
    expect((await r.app.request('https://edge.example.net/health/ready', {}, r.env)).status).toBe(200);
  });

  it('aborts and drains outstanding synchronization before stop resolves', async () => {
    const p = await fixture(); p.start(); const node = await p.createNode();
    const r = await fixture({ role: 'replica', primary: p, node });
    let entered;
    const started = new Promise(resolve => { entered = resolve; });
    let aborted = false;
    r.env.node_fetch = async (_url, init) => {
      entered();
      return new Promise((_, reject) => { init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true }); });
    };
    r.start(); await started;
    await r.stop(); r.stop = null;
    expect(aborted).toBe(true); expect(r.env.nodeState.ready).toBe(false); expect(r.env.nodeState.runtime).toBeNull();
    r.env.db.close();
  });
});
