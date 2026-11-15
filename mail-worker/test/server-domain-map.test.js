import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import net from 'node:net';
import { loadConfig } from '../src/server/config.js';
import { createEnvironment } from '../src/server/environment.js';
import { domainMapResult, startDomainMapServer } from '../src/server/domain-map.js';
import { resolveRecipient } from '../src/server/policy.js';
import * as recipientPolicy from '../src/server/policy.js';
import { createDomain, updateDomain } from '../src/modules/domains/service.js';

const resources = [];
const frame = value => `${Buffer.byteLength(value)}:${value},`;

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cloud-mail-domain-map-'));
  const env = await createEnvironment(loadConfig({
    MAIL_DOMAINS: 'example.com', MAIL_HOST: 'mail.example.com', ADMIN_EMAIL: 'admin@example.com',
    ADMIN_PASSWORD: 'domain-map-administrator-password', JWT_SECRET: 'domain-map-jwt-secret-at-least-32-characters',
    APP_URL: 'https://mail.example.com', DATA_DIR: root, STATIC_DIR: root,
  }));
  const resource = { root, env, servers: [] };
  resources.push(resource);
  env.server = { ...env.server, domainMapHost: '127.0.0.1', domainMapPort: 0 };
  env.db.prepare('UPDATE setting SET receive=0,no_recipient=1').run();
  return resource;
}

async function start(resource) {
  const server = await startDomainMapServer(resource.env);
  resource.servers.push(server);
  return server;
}

function exchange(server, chunks, expected) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(server.address().port, '127.0.0.1');
    let result = '';
    socket.setTimeout(2000, () => socket.destroy(new Error('Socketmap response timed out')));
    socket.once('error', error => {
      if (!(expected === '' && error.code === 'ECONNRESET')) reject(error);
    });
    socket.once('close', () => {
      if (result !== expected) reject(new Error(`Unexpected socketmap response: ${result}`));
      else resolve(result);
    });
    socket.on('data', chunk => {
      result += chunk.toString('utf8');
      if (result.length >= expected.length) socket.destroy();
    });
    socket.once('connect', async () => {
      for (const chunk of chunks) {
        if (socket.destroyed) break;
        socket.write(chunk);
        await new Promise(resolve => setImmediate(resolve));
      }
    });
  });
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const { root, env, servers } of resources.splice(0)) {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    if (env.db.open) env.db.close();
    if (!resolve(root).startsWith(`${resolve(tmpdir())}${sep}`) || !basename(root).startsWith('cloud-mail-domain-map-')) throw Error('Unexpected domain map test directory');
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Postfix receiving domain socketmap', () => {
  it('preserves bootstrap domains and discovers newly added domains without a restart', async () => {
    const resource = await fixture(), { env } = resource;
    const server = await start(resource);
    expect(await exchange(server, [frame('domains example.com')], frame('OK example.com'))).toBe(frame('OK example.com'));
    expect(domainMapResult(env, 'domains later.example')).toMatch(/^NOTFOUND /);
    createDomain(env, { domain: 'later.example' });
    const user = env.db.prepare('SELECT user_id FROM user WHERE email=?').get(env.admin);
    env.db.prepare('INSERT INTO account(email,user_id) VALUES(?,?)').run('reader@later.example', user.user_id);
    expect(await exchange(server, [frame('domains LATER.EXAMPLE')], frame('OK later.example'))).toBe(frame('OK later.example'));
    expect(resolveRecipient(env, 'reader@later.example').account.email).toBe('reader@later.example');
    updateDomain(env, 'later.example', { enabled: false });
    expect(await exchange(server, [frame('domains later.example')], frame('OK later.example'))).toBe(frame('OK later.example'));
    expect(resolveRecipient(env, 'reader+tag@later.example').account.email).toBe('reader@later.example');
    expect(() => resolveRecipient(env, 'unknown@later.example')).toThrow('Recipient not found');
  });

  it('parses fragmented and pipelined strict netstrings on one persistent connection', async () => {
    const resource = await fixture(), server = await start(resource);
    const request = frame('domains example.com');
    const expected = frame('OK example.com') + frame('NOTFOUND Domain not configured');
    expect(await exchange(server, [request.slice(0, 1), request.slice(1, 8), request.slice(8) + frame('domains outside.example')], expected)).toBe(expected);
  });

  it.each(['0:,', '019:domains example.com,', '1025:', 'x:domains example.com,', '19:domains example.com;',
    '99999:', Buffer.from([0xb1, 58, 65, 44])])('closes malformed or oversized frames safely (%s)', async request => {
    const resource = await fixture(), server = await start(resource);
    expect(await exchange(server, [request], '')).toBe('');
  });

  it('fails database errors temporarily and never treats them as an allowed domain', async () => {
    const { env } = await fixture();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(env.db, 'prepare').mockImplementationOnce(() => { throw new Error('database unavailable'); });
    expect(domainMapResult(env, 'domains example.com')).toBe('TEMP Domain lookup temporarily unavailable');
    expect(domainMapResult(env, 'domains nobody.example')).toMatch(/^NOTFOUND /);
    expect(domainMapResult(env, 'other example.com')).toMatch(/^PERM /);
    expect(domainMapResult(env, 'domains example.com\nrelay_domains=evil')).toMatch(/^NOTFOUND /);
  });

  it('refuses a socket outside the trusted mail network before reading a request', async () => {
    const resource = await fixture();
    vi.spyOn(recipientPolicy, 'isTrustedMailPeer').mockReturnValue(false);
    const server = await start(resource);
    expect(await exchange(server, [frame('domains example.com')], '')).toBe('');
  });

  it('drains idle persistent lookup connections during shutdown', async () => {
    const resource = await fixture(), server = await start(resource);
    const socket = net.createConnection(server.address().port, '127.0.0.1');
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    const closed = new Promise(resolve => socket.once('close', resolve));
    socket.resume();
    await new Promise(resolve => server.close(resolve));
    await closed;
  });
});
