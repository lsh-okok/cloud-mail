import { isAbsolute, relative, resolve, sep } from 'node:path';
import { domainToASCII } from 'node:url';
import { normalizeBasePath } from '../modules/shared/urls.js';
import { parseTrustedProxies } from '../modules/shared/proxy.js';

function port(value, fallback, name) {
  const result = Number(value ?? fallback);
  if (!Number.isInteger(result) || result < 1 || result > 65535) throw new Error(`Invalid ${name}`);
  return result;
}

function hostname(value) {
  const result = domainToASCII(value.trim().toLowerCase());
  if (result.length > 253 || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(result)) {
    throw new Error('MAIL_DOMAINS and MAIL_HOST must contain valid domain names');
  }
  return result;
}

export function loadConfig(source = process.env) {
  const nodeRole = source.NODE_ROLE || 'primary';
  if (!['primary', 'replica'].includes(nodeRole)) throw new Error('NODE_ROLE must be primary or replica');
  const replica = nodeRole === 'replica';
  const domain = [...new Set((source.MAIL_DOMAINS || (replica ? 'replica.invalid' : '')).split(',').filter(Boolean).map(hostname))];
  if (!domain.length) throw new Error('MAIL_DOMAINS is required');
  const mailHost = hostname(source.MAIL_HOST || `mail.${domain[0]}`);
  const admin = (source.ADMIN_EMAIL || `admin@${domain[0]}`).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(admin) || !domain.includes(admin.split('@')[1])) throw new Error('ADMIN_EMAIL must belong to MAIL_DOMAINS');
  if (typeof source.JWT_SECRET !== 'string' || source.JWT_SECRET.trim().length < 32) throw new Error('JWT_SECRET must contain at least 32 characters');
  if (/^REPLACE_/i.test(source.JWT_SECRET.trim())) throw new Error('JWT_SECRET must replace the example placeholder with a unique secret');
  const appUrl = new URL(source.APP_URL || `https://${mailHost}`);
  if (!['http:', 'https:'].includes(appUrl.protocol) || appUrl.username || appUrl.password || appUrl.pathname !== '/' || appUrl.search || appUrl.hash) throw new Error('APP_URL must be an HTTP(S) origin');
  const basePath = normalizeBasePath(source.APP_BASE_PATH || '');
  let publicBase = '';
  if (source.PUBLIC_BASE_URL) {
    const url = new URL(source.PUBLIC_BASE_URL);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('PUBLIC_BASE_URL must be an HTTP(S) URL without credentials, query, or fragment');
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('PUBLIC_BASE_URL requires HTTPS outside loopback testing');
    publicBase = url.href.replace(/\/+$/, '');
  }
  const trustedProxies = (source.TRUSTED_PROXIES || '').split(',').map(value => value.trim()).filter(Boolean);
  parseTrustedProxies(trustedProxies);
  let dataKeys = {};
  try { dataKeys = source.DATA_ENCRYPTION_PREVIOUS_KEYS ? JSON.parse(source.DATA_ENCRYPTION_PREVIOUS_KEYS) : {}; }
  catch { throw new Error('DATA_ENCRYPTION_PREVIOUS_KEYS must be a JSON key map'); }
  if (!dataKeys || Array.isArray(dataKeys) || typeof dataKeys !== 'object') throw new Error('DATA_ENCRYPTION_PREVIOUS_KEYS must be a JSON key map');
  const dataKeyId = source.DATA_ENCRYPTION_KEY_ID || 'v1';
  const validKeyId = id => /^[a-zA-Z0-9_-]{1,64}$/.test(id) && !['__proto__', 'prototype', 'constructor'].includes(id);
  if (!validKeyId(dataKeyId)) throw new Error('DATA_ENCRYPTION_KEY_ID is invalid');
  if (source.DATA_ENCRYPTION_KEY) dataKeys[dataKeyId] = source.DATA_ENCRYPTION_KEY;
  if (Object.entries(dataKeys).some(([id, value]) => !validKeyId(id) || typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value))) throw new Error('Data encryption keys must contain exactly 64 hexadecimal characters and safe key IDs');
  if (Object.keys(dataKeys).length && !dataKeys[dataKeyId]) throw new Error('The active data encryption key is missing');
  if (replica && !dataKeys[dataKeyId]) throw new Error('A replica requires its own DATA_ENCRYPTION_KEY');
  if (source.NODE_ALLOW_INSECURE_HTTP && !['true', 'false'].includes(source.NODE_ALLOW_INSECURE_HTTP)) throw new Error('NODE_ALLOW_INSECURE_HTTP must be true or false');
  const nodeAllowInsecureHttp = source.NODE_ALLOW_INSECURE_HTTP === 'true';
  let nodePrimaryUrl = '';
  if (source.NODE_PRIMARY_URL) {
    const url = new URL(source.NODE_PRIMARY_URL);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('NODE_PRIMARY_URL must be an HTTP(S) URL without credentials, query, or fragment');
    if (url.protocol === 'http:' && !nodeAllowInsecureHttp && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('NODE_PRIMARY_URL requires HTTPS or explicit NODE_ALLOW_INSECURE_HTTP=true for LAN testing');
    normalizeBasePath(url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, ''));
    nodePrimaryUrl = url.href.replace(/\/+$/, '');
  }
  const nodeId = source.NODE_ID || '';
  const nodeCredential = source.NODE_CREDENTIAL || '';
  if (replica && (!nodePrimaryUrl || !/^[a-zA-Z0-9_-]{1,128}$/.test(nodeId) || !/^[a-zA-Z0-9_-]{43}$/.test(nodeCredential))) throw new Error('Replica NODE_PRIMARY_URL, NODE_ID and NODE_CREDENTIAL are required');
  const nodeUpstreamTimeout = Number(source.NODE_UPSTREAM_TIMEOUT || 15000);
  if (!Number.isInteger(nodeUpstreamTimeout) || nodeUpstreamTimeout < 1000 || nodeUpstreamTimeout > 60000) throw new Error('NODE_UPSTREAM_TIMEOUT must be between 1000 and 60000 milliseconds');
  const verificationSmtpAllowCidrs = (source.VERIFICATION_SMTP_ALLOW_CIDRS || '').split(',').map(value => value.trim()).filter(Boolean);
  try { parseTrustedProxies(verificationSmtpAllowCidrs); }
  catch { throw new Error('VERIFICATION_SMTP_ALLOW_CIDRS must contain valid IP addresses or CIDR networks'); }
  const dataDir = resolve(source.DATA_DIR || './data');
  const sqlitePath = resolve(source.SQLITE_PATH || `${dataDir}/cloud-mail.sqlite`);
  const objectsDir = resolve(source.OBJECTS_DIR || `${dataDir}/objects`);
  const databaseWithinObjects = relative(objectsDir, sqlitePath);
  if (!databaseWithinObjects || (!isAbsolute(databaseWithinObjects) && databaseWithinObjects !== '..' && !databaseWithinObjects.startsWith(`..${sep}`))) {
    throw new Error('SQLITE_PATH must be outside OBJECTS_DIR; the database and object root cannot be the same path.');
  }
  const maxMessageBytes = Number(source.MAX_MESSAGE_BYTES || 25 * 1024 * 1024);
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 1024 || maxMessageBytes > 100 * 1024 * 1024) throw new Error('MAX_MESSAGE_BYTES must be between 1024 and 104857600');
  return {
    domain, admin: replica ? '' : admin, admin_password: replica ? undefined : source.ADMIN_PASSWORD,
    jwt_secret: source.JWT_SECRET, app_url: appUrl.origin, base_path: basePath, public_base_url: publicBase,
    data_keys: dataKeys, data_key_id: dataKeyId,
    node_role: nodeRole, node_primary_url: nodePrimaryUrl, node_id: nodeId,
    node_credential: nodeCredential, node_allow_insecure_http: nodeAllowInsecureHttp,
    node_upstream_timeout: nodeUpstreamTimeout, verificationSmtpAllowCidrs,
    orm_log: source.ORM_LOG === 'true', analysis_cache: source.ANALYSIS_CACHE === 'true',
    trust_proxy: source.TRUST_PROXY !== 'false' && trustedProxies.length > 0, trusted_proxies: trustedProxies,
    project_link: source.PROJECT_LINK !== 'false',
    port: port(source.PORT, 3000, 'PORT'), httpHost: source.HOST || '0.0.0.0',
    dataDir, sqlitePath, objectsDir,
    staticDir: resolve(source.STATIC_DIR || './dist'),
    smtp: {
      host: source.SMTP_HOST || 'mail', port: port(source.SMTP_PORT, 587, 'SMTP_PORT'),
      secure: source.SMTP_SECURE === 'true', requireTLS: source.SMTP_REQUIRE_TLS === 'true',
      ...(source.SMTP_USER ? { auth: { user: source.SMTP_USER, pass: source.SMTP_PASSWORD || '' } } : {}),
      maxMessageBytes,
    },
    server: {
      hostname: mailHost, bounceDomain: domain[0],
      trustedMailSubnet: source.MAIL_NETWORK_SUBNET || '172.30.89.0/24',
      lmtpHost: '0.0.0.0', lmtpPort: port(source.LMTP_PORT, 2525, 'LMTP_PORT'),
      policyHost: '0.0.0.0', policyPort: port(source.POLICY_PORT, 10040, 'POLICY_PORT'),
      domainMapHost: '0.0.0.0', domainMapPort: port(source.DOMAIN_MAP_PORT, 10041, 'DOMAIN_MAP_PORT'),
      mailLogPath: source.MAIL_LOG_PATH || '/var/log/postfix/postfix.log',
    },
  };
}
