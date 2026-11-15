import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { FeatureError } from '../shared/errors.js';
import { normalizeBasePath } from '../shared/urls.js';

const lifetime = 60 * 60 * 1000;
const installerUrl = 'https://raw.githubusercontent.com/lsh-okok/ok-email-scripts/main/cloud-mail-node/install-node.sh';
const digest = value => createHash('sha256').update(value).digest('hex');
const quote = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;

export function deploymentOptions(env, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Object.keys(input).some(key => !['primaryUrl', 'port', 'allowInsecureHttp'].includes(key))) {
    throw new FeatureError(400, 'INVALID_DEPLOYMENT', '部署参数无效。');
  }
  const value = input.primaryUrl ?? `${env.app_url}${env.base_path || ''}`;
  let url;
  try {
    if (typeof value !== 'string' || value.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(value)) throw new Error();
    url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    normalizeBasePath(url.pathname);
  } catch { throw new FeatureError(400, 'INVALID_PRIMARY_URL', '请输入目标服务器可以访问的主节点 HTTP(S) 地址，不要包含账号、查询参数或片段。'); }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) ||
      ['::1', '::', '0.0.0.0'].includes(host) || /^::ffff:(?:7f[0-9a-f]{2}:|0:0$)/.test(host)) {
    throw new FeatureError(400, 'UNREACHABLE_PRIMARY_URL', '请使用目标 Docker 容器能访问的主节点局域网 IP 或域名，不能使用 localhost 或本机回环地址。');
  }
  if (input.allowInsecureHttp !== undefined && typeof input.allowInsecureHttp !== 'boolean') {
    throw new FeatureError(400, 'INVALID_DEPLOYMENT', '局域网 HTTP 选项必须为布尔值。');
  }
  if (url.protocol === 'http:' && input.allowInsecureHttp !== true) {
    throw new FeatureError(400, 'INSECURE_HTTP_CONFIRMATION', 'HTTP 会以明文传输接入信息，请确认仅在受信局域网使用后启用 HTTP。');
  }
  const port = input.port ?? 3001;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new FeatureError(400, 'INVALID_NODE_PORT', '节点端口必须为 1 到 65535 的整数。');
  return { primaryUrl: url.href.replace(/\/+$/, ''), port, allowInsecureHttp: url.protocol === 'http:' };
}

// Only a build-time allowlist is archived; never expose the application directory.
export async function deploymentBundle(env) {
  const state = env.nodeState ||= {};
  try {
    let image;
    if (env.nodeDeploymentImageDir) {
      const metadata = await readFile(join(env.nodeDeploymentImageDir, 'node-image.json'), 'utf8');
      if (metadata.length > 4096) throw new Error();
      image = JSON.parse(metadata);
      if (image.format !== 'docker-image' || !/^sha256:[a-f0-9]{64}$/.test(image.imageId) || !/^[a-f0-9]{64}$/.test(image.sha256)) throw new Error();
    }
    const path = image ? join(env.nodeDeploymentImageDir, 'node-image.tar.gz')
      : env.nodeDeploymentBundle || join(dirname(env.staticDir), 'server-dist', 'node-deploy.tar.gz');
    const info = await stat(path);
    if (!info.isFile() || info.size <= 0 || info.size > (image ? 2 * 1024 ** 3 : 128 * 1024 ** 2)) throw new Error();
    const key = `${path}:${info.size}:${info.mtimeMs}`;
    if (state.deploymentBundle?.key !== key) {
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(path)) hash.update(chunk);
      state.deploymentBundle = { key, path, size: info.size, sha256: hash.digest('hex') };
    }
    if (image && state.deploymentBundle.sha256 !== image.sha256) throw new Error();
    return { ...state.deploymentBundle, format: image ? 'docker-image' : 'source', ...(image ? { imageId: image.imageId } : {}) };
  } catch { throw new FeatureError(503, 'NODE_BUNDLE_UNAVAILABLE', '节点安装包尚未生成，请先构建并更新主节点，再进行一键部署。'); }
}

function tickets(env) {
  const state = env.nodeState ||= {};
  const entries = state.deploymentTickets ||= new Map();
  for (const [key, value] of entries) if (value.expiresAt <= Date.now()) entries.delete(key);
  return entries;
}

export function prepareNodeDeployment(env, { id, connectionEnv, options, bundle }) {
  const entries = tickets(env);
  if (entries.size >= 1000) throw new FeatureError(429, 'NODE_DEPLOYMENT_CAPACITY', '待部署节点过多，请稍后重试。');
  const token = randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + lifetime;
  // Keep temporary download grants in memory, separate from long-lived node credentials.
  // Invalidation on restart or a lifecycle change prevents reuse after revocation.
  const args = ['--primary-url', options.primaryUrl, '--install-token', token, '--port', String(options.port),
    ...(options.allowInsecureHttp ? ['--allow-insecure-http'] : [])].map(quote).join(' ');
  const command = `curl -fsSL --connect-timeout 15 --max-time 120 ${quote(installerUrl)} -o 'install-node.sh' && sh 'install-node.sh' ${args}`;
  const script = `#!/bin/sh\nset -eu\n${command}\n`;
  const ticket = { id, script, connectionEnv, port: options.port, expiresAt, statusVersion: 1,
    bundleSha256: bundle.sha256, bundleImageId: bundle.imageId || '' };
  return {
    commit: () => entries.set(digest(token), ticket),
    result: { command,
      installerUrl, localCommand: `sudo sh 'install-node.sh' ${args}`,
      script, filename: `cloud-mail-node-${id}.sh`, expiresAt: new Date(expiresAt).toISOString(), format: bundle.format || 'source', ...options },
  };
}

function installationTicket(c) {
  if ((c.env.node_role || 'primary') !== 'primary') throw new FeatureError(403, 'PRIMARY_ONLY', '仅主节点提供安装包。');
  const token = c.req.param('token');
  const entries = tickets(c.env), key = /^[A-Za-z0-9_-]{43}$/.test(token) ? digest(token) : '';
  const ticket = entries.get(key);
  const node = ticket && c.env.db.prepare('SELECT disabled,revoked,status_version FROM cluster_node WHERE id=?').get(ticket.id);
  if (!ticket || !node || node.disabled || node.revoked || node.status_version !== ticket.statusVersion) {
    if (ticket) entries.delete(key);
    throw new FeatureError(410, 'NODE_INSTALL_EXPIRED', '部署命令已失效、节点已停用或主服务已重启，请重新创建待部署节点。');
  }
  return ticket;
}

export function mountNodeDeploymentRoutes(router) {
  router.get('/admin/nodes/deployment-options', async c => {
    if ((c.env.node_role || 'primary') !== 'primary') throw new FeatureError(403, 'PRIMARY_ONLY', '仅主节点提供部署管理。');
    let bundleAvailable = false, bundleFormat = 'source';
    try { const bundle = await deploymentBundle(c.env); bundleAvailable = true; bundleFormat = bundle.format; } catch (error) { if (!(error instanceof FeatureError)) throw error; }
    return c.json({ data: { primaryUrl: `${c.env.app_url}${c.env.base_path || ''}`, bundleAvailable, bundleFormat } });
  });
  router.get('/node-install/:token/install.sh', async c => {
    const ticket = installationTicket(c);
    const bundle = await deploymentBundle(c.env);
    if (bundle.sha256 !== ticket.bundleSha256) throw new FeatureError(410, 'NODE_INSTALL_EXPIRED', '主节点版本已更新，请重新创建部署命令。');
    c.header('Content-Type', 'text/x-shellscript; charset=utf-8');
    c.header('Content-Disposition', 'attachment; filename="install-node.sh"');
    return c.body(ticket.script);
  });
  router.get('/node-install/:token/config.env', async c => {
    const ticket = installationTicket(c), bundle = await deploymentBundle(c.env);
    if (bundle.sha256 !== ticket.bundleSha256) throw new FeatureError(410, 'NODE_INSTALL_EXPIRED', '主节点版本已更新，请重新创建部署命令。');
    const connectionEnv = ticket.connectionEnv.endsWith('\n') ? ticket.connectionEnv : ticket.connectionEnv + '\n';
    c.header('Content-Type', 'text/plain; charset=utf-8');
    c.header('Content-Disposition', 'attachment; filename="node.env"');
    c.header('Cache-Control', 'no-store');
    return c.body(`${connectionEnv}INSTALL_PORT=${ticket.port}\nINSTALL_BUNDLE_SHA256=${ticket.bundleSha256}\nINSTALL_BUNDLE_IMAGE_ID=${ticket.bundleImageId}\n`);
  });
  router.get('/node-install/:token/bundle', async c => {
    const ticket = installationTicket(c), bundle = await deploymentBundle(c.env);
    if (bundle.sha256 !== ticket.bundleSha256) throw new FeatureError(410, 'NODE_INSTALL_EXPIRED', '主节点版本已更新，请重新创建部署命令。');
    c.header('Content-Type', 'application/gzip');
    c.header('Content-Disposition', 'attachment; filename="node-deploy.tar.gz"');
    c.header('Content-Length', String(bundle.size));
    return new Response(Readable.toWeb(createReadStream(bundle.path)), { headers: c.res.headers });
  });
}
