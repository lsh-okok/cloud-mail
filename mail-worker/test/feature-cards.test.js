import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';
import { loadConfig } from '../src/server/config.js';
import { createEnvironment } from '../src/server/environment.js';
import { createApp } from '../src/server/app.js';
import { synchronizeLocalMailboxSources } from '../src/modules/mail-sources/service.js';
import jwtUtils from '../src/utils/jwt-utils.js';
import constant from '../src/const/constant.js';
import KvConst from '../src/const/kv-const.js';

const resources = [];
const queryKey = () => randomBytes(32).toString('base64url');
const sha256 = value => createHash('sha256').update(value).digest('hex');

async function fixture({ prefix = '' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cloud-mail-cards-'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><html><body>Mailbox redemption</body></html>');
  const config = loadConfig({
    MAIL_DOMAINS: 'example.com', ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'cards-administrator-password',
    JWT_SECRET: 'cards-test-jwt-secret-at-least-32-characters', DATA_ENCRYPTION_KEY: 'cd'.repeat(32),
    APP_URL: 'https://mail.example.com', APP_BASE_PATH: prefix, DATA_DIR: join(root, 'data'), STATIC_DIR: root,
  });
  const env = await createEnvironment(config);
  env.mailReady = true;
  resources.push({ root, env });
  const app = createApp(env);
  let adminToken = '', adminCsrf = '';
  async function issue(userId = 1) {
    const sessionToken = randomUUID();
    await env.kv.put(KvConst.AUTH_INFO + userId, JSON.stringify({ tokens: [sessionToken] }));
    return jwtUtils.generateToken({ env }, { userId, token: sessionToken, gen: constant.AUTH_GEN });
  }
  function api(path, { method = 'GET', data, body, admin = true, token, csrf = true, headers = {}, clientIp = '198.51.100.12' } = {}) {
    return app.request(`https://mail.example.com${prefix}/api${path}`, {
      method,
      headers: { 'accept-language': 'en', 'content-type': 'application/json',
        ...(admin && (token ?? adminToken) ? { authorization: token ?? adminToken } : {}),
        ...(admin && csrf && adminCsrf ? { 'x-csrf-token': adminCsrf } : {}),
        ...(['GET', 'HEAD'].includes(method) ? {} : { origin: 'https://mail.example.com' }), ...headers },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }), ...(body === undefined ? {} : { body }),
    }, { ...env, remote_address: clientIp });
  }
  adminToken = await issue();
  const session = await api('/admin/session');
  expect(session.status).toBe(200);
  adminCsrf = (await session.json()).data.csrfToken;
  async function success(path, options = {}) {
    const response = await api(path, options), payload = await response.json();
    expect(response.status, JSON.stringify(payload)).toBeGreaterThanOrEqual(200);
    expect(response.status, JSON.stringify(payload)).toBeLessThan(300);
    return payload.data;
  }
  async function source(email = 'parent@example.com', { account = false } = {}) {
    return success('/admin/mailboxes', { method: 'POST', data: account ? { email, createLocalAccount: true } : {
      email, provider: 'mx', mxDomain: 'example.com',
    } });
  }
  async function links(mailboxId, recipients = ['child@example.com'], extra = {}) {
    return (await success('/admin/links', { method: 'POST', data: { mailboxId, recipients, ...extra } })).items;
  }
  async function generate(mailboxIds) {
    return (await success('/admin/cards', { method: 'POST', data: { mailboxIds } })).items;
  }
  async function current(mailboxId) {
    return (await success('/admin/cards')).items.find(item => item.mailboxId === mailboxId);
  }
  async function redeem(codes, requestKey = queryKey()) {
    return { key: requestKey, order: await success('/redeem', { method: 'POST', admin: false, data: { codes, requestKey } }) };
  }
  async function download(key, orderNo) {
    const response = await api('/orders/download', { method: 'POST', admin: false, data: { queryKey: key, ...(orderNo ? { orderNo } : {}) } });
    expect(response.status, response.statusText).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(response.headers.get('x-content-sha256')).toBe(sha256(bytes));
    expect(Number(response.headers.get('content-length'))).toBe(bytes.length);
    return { response, bytes };
  }
  return { env, app, api, success, source, links, generate, current, redeem, download, issue, prefix };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const { root, env } of resources.splice(0)) {
    if (env.db.open) env.db.close();
    if (!resolve(root).startsWith(`${resolve(tmpdir())}${sep}`) || !basename(root).startsWith('cloud-mail-cards-')) throw new Error('Unexpected cards test directory.');
    rmSync(root, { recursive: true, force: true });
  }
});

// Read the ZIP central directory independently of the application's writer.
function unzip(bytes) {
  const end = bytes.length - 22;
  expect(bytes.readUInt32LE(end)).toBe(0x06054b50);
  const count = bytes.readUInt16LE(end + 10), entries = [];
  let cursor = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < count; index++) {
    expect(bytes.readUInt32LE(cursor)).toBe(0x02014b50);
    const method = bytes.readUInt16LE(cursor + 10), checksum = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    expect(name).not.toMatch(/[\\/]|\.\.|[\u0000-\u001f]/);
    expect(name).toMatch(/\.txt$/);
    expect(bytes.readUInt32LE(localOffset)).toBe(0x04034b50);
    const dataOffset = localOffset + 30 + bytes.readUInt16LE(localOffset + 26) + bytes.readUInt16LE(localOffset + 28);
    const compressed = bytes.subarray(dataOffset, dataOffset + compressedSize);
    expect([0, 8]).toContain(method);
    const content = method === 8 ? inflateRawSync(compressed) : compressed;
    expect(content.length).toBe(size);
    expect(crc32(content)).toBe(checksum);
    entries.push({ name, content });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  expect(new Set(entries.map(entry => entry.name)).size).toBe(count);
  return entries;
}

function txtLines(bytes) {
  expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  const text = bytes.subarray(3).toString('utf8');
  expect(text.replace(/\r\n/g, '')).not.toContain('\n');
  const lines = text.split('\r\n').filter(Boolean);
  for (const line of lines) {
    expect(line.split('----')).toHaveLength(2);
    expect(line).toMatch(/^[^\s@]+@[^\s@]+----https:\/\//);
  }
  return lines;
}

function deliveredLine(fixture, link) {
  const row = fixture.env.db.prepare('SELECT token_encrypted FROM mail_link WHERE id=?').get(link.id);
  const token = fixture.env.secretVault.decrypt(row.token_encrypted, `mail-link:${link.id}`);
  return `${link.recipient}----https://mail.example.com${fixture.prefix}/m/${token}`;
}

describe('mailbox card management security and generation', () => {
  it('enforces administrator, CSRF, browser origin and replica boundaries on management and anonymous order routes', async () => {
    const f = await fixture({ prefix: '/cloud' });
    expect((await f.api('/admin/cards', { admin: false })).status).toBe(401);
    const userId = Number(f.env.db.prepare('INSERT INTO user(email,password,salt) VALUES(?,?,?)').run('ordinary@example.com', 'unused', 'unused').lastInsertRowid);
    const regularToken = await f.issue(userId);
    expect((await f.api('/admin/cards', { token: regularToken })).status).toBe(403);
    expect((await f.api('/admin/cards', { method: 'POST', data: { mailboxIds: [randomUUID()] }, csrf: false })).status).toBe(403);
    for (const path of ['/redeem', '/orders/query', '/orders/download']) {
      for (const headers of [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'same-site' }]) {
        expect((await f.api(path, { method: 'POST', admin: false, data: {}, headers })).status).toBe(403);
      }
    }
    const config = await f.success('/admin/cards/config');
    expect(config.redeemUrl).toBe('https://mail.example.com/cloud/redeem');
    expect(config.orderQueryUrl).toBe('https://mail.example.com/cloud/orders');
    for (const url of [config.redeemUrl, config.orderQueryUrl]) {
      const page = await f.app.request(url, {}, f.env);
      expect(page.status).toBe(200);
      expect(page.headers.get('cache-control')).toBe('no-store');
      expect(page.headers.get('x-frame-options')).toBe('DENY');
      expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    }
    f.env.node_role = 'replica';
    expect((await f.app.request(config.redeemUrl, {}, f.env)).status).toBe(403);
    expect((await f.app.request(config.orderQueryUrl, {}, f.env)).status).toBe(403);
    for (const path of ['/admin/cards', '/redeem', '/orders/query', '/orders/download']) {
      expect((await f.api(path, { method: path === '/admin/cards' ? 'GET' : 'POST', admin: false, data: path === '/admin/cards' ? undefined : {} })).status).toBe(403);
    }
  });

  it('accepts a configured public-site origin for anonymous APIs under a deployment prefix while keeping administrator writes on the app origin', async () => {
    const f = await fixture({ prefix: '/cloud' }), source = await f.source();
    await f.links(source.id);
    const [issued] = await f.generate([source.id]);
    await f.success('/admin/settings', { method: 'PUT', data: { publicBaseUrl: 'https://public.example.net/site', timeZone: 'Asia/Shanghai', revision: 1 } });
    const publicHeaders = { origin: 'https://public.example.net', 'sec-fetch-site': 'same-origin' };
    const key = queryKey(), data = { codes: [issued.card.code], requestKey: key };
    const order = await f.success('/redeem', { method: 'POST', admin: false, data, headers: publicHeaders });
    expect(order.successCount).toBe(1);
    expect(order.items[0].links[0].url).toMatch(/^https:\/\/public\.example\.net\/site\/m\//);
    expect(await f.success('/orders/query', { method: 'POST', admin: false, data: { queryKey: key }, headers: publicHeaders })).toEqual(order);
    const file = await f.api('/orders/download', { method: 'POST', admin: false, data: { queryKey: key }, headers: publicHeaders });
    expect(file.status).toBe(200);
    expect(txtLines(Buffer.from(await file.arrayBuffer()))[0]).toContain('----https://public.example.net/site/m/');
    for (const headers of [{ origin: 'https://evil.example' }, { ...publicHeaders, 'sec-fetch-site': 'cross-site' }]) {
      for (const [path, payload] of [['/redeem', data], ['/orders/query', { queryKey: key }], ['/orders/download', { queryKey: key }]]) {
        expect((await f.api(path, { method: 'POST', admin: false, data: payload, headers })).status).toBe(403);
      }
    }
    const adminWrite = await f.api('/admin/cards', { method: 'POST', data: { mailboxIds: [source.id] }, headers: publicHeaders });
    expect(adminWrite.status).toBe(403);
    expect((await adminWrite.json()).error.code).toBe('CROSS_SITE_REQUEST');
    expect((await f.generate([source.id]))[0].card.status).toBe('redeemed');
  });

  it('issues one encrypted current code, reuses initial generation, and rolls back a batch with an invalid target', async () => {
    const f = await fixture(), first = await f.source(), second = await f.source('second@example.com');
    const [issued] = await f.generate([first.id, first.id]);
    expect(issued).toMatchObject({ mailboxId: first.id, mailboxEmail: first.email, card: { status: 'unused', enabled: true } });
    expect(issued.card.code).toMatch(/^ML-[A-Za-z0-9_-]{43}$/);
    expect((await f.generate([first.id]))[0].card).toEqual(issued.card);
    const invalid = await f.api('/admin/cards', { method: 'POST', data: { mailboxIds: [second.id, randomUUID()] } });
    expect(invalid.status).toBeGreaterThanOrEqual(400);
    expect((await f.current(second.id)).card).toBeNull();
    const stored = f.env.db.prepare('SELECT * FROM mailbox_card').all();
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(issued.card.code);
    expect(stored[0].code_digest).toBe(sha256(issued.card.code));
    expect(JSON.stringify(f.env.db.prepare('SELECT * FROM feature_audit').all())).not.toContain(issued.card.code);
    expect(f.env.db.prepare("SELECT count(*) AS n FROM sync_event WHERE object_type IN ('card','mailbox_card')").get().n).toBe(0);
    const searched = await f.success('/admin/cards/search', { method: 'POST', data: { code: issued.card.code } });
    expect(searched.items.map(item => item.mailboxId)).toEqual([first.id]);
    const unsafeSearch = await f.api(`/admin/cards?code=${encodeURIComponent(issued.card.code)}`);
    expect(unsafeSearch.status).toBe(400);
  });

  it('validates raw array limits and malformed JSON before issuing or consuming any card', async () => {
    const f = await fixture(), source = await f.source();
    const [issued] = await f.generate([source.id]);
    for (const mailboxIds of [[], Array(501).fill(source.id), [source.id, 2]]) {
      expect((await f.api('/admin/cards', { method: 'POST', data: { mailboxIds } })).status).toBe(400);
    }
    const key = queryKey();
    for (const data of [
      { codes: Array(101).fill(issued.card.code), requestKey: key },
      { codes: [issued.card.code], requestKey: 'short' },
      { codes: [null], requestKey: key },
      { codes: ['x'.repeat(129)], requestKey: key },
      { codes: [issued.card.code], requestKey: key, unknown: true },
    ]) expect((await f.api('/redeem', { method: 'POST', admin: false, data })).status).toBe(400);
    expect((await f.api('/redeem', { method: 'POST', admin: false, body: '{"codes":[]}trailing' })).status).toBe(400);
    expect((await f.api('/redeem', { method: 'POST', admin: false, data: { codes: [issued.card.code], requestKey: key, padding: 'x'.repeat(65536) } })).status).toBe(413);
    expect((await f.current(source.id)).card.status).toBe('unused');
    expect(f.env.db.prepare('SELECT count(*) AS n FROM redemption_order').get().n).toBe(0);
  });

  it('rolls back initial generation and regeneration when their audit cannot be stored', async () => {
    const f = await fixture(), source = await f.source();
    f.env.db.exec("CREATE TRIGGER reject_card_audit BEFORE INSERT ON feature_audit BEGIN SELECT RAISE(ABORT,'AUDIT_SECRET'); END;");
    const failedGeneration = await f.api('/admin/cards', { method: 'POST', data: { mailboxIds: [source.id] } });
    expect(failedGeneration.status).toBe(500);
    expect(await failedGeneration.text()).not.toContain('AUDIT_SECRET');
    expect(f.env.db.prepare('SELECT count(*) AS n FROM mailbox_card').get().n).toBe(0);
    f.env.db.exec('DROP TRIGGER reject_card_audit');
    const [issued] = await f.generate([source.id]), requestKey = queryKey();
    const before = f.env.db.prepare('SELECT * FROM mailbox_card').get();
    f.env.db.exec("CREATE TRIGGER reject_card_audit BEFORE INSERT ON feature_audit BEGIN SELECT RAISE(ABORT,'AUDIT_SECRET'); END;");
    const payload = { revision: issued.card.revision, requestKey };
    expect((await f.api(`/admin/cards/${issued.card.id}/regenerate`, { method: 'POST', data: payload })).status).toBe(500);
    expect(f.env.db.prepare('SELECT * FROM mailbox_card').all()).toEqual([before]);
    expect(f.env.db.prepare('SELECT count(*) AS n FROM card_management_operation').get().n).toBe(0);
    f.env.db.exec('DROP TRIGGER reject_card_audit');
    const replacement = await f.success(`/admin/cards/${issued.card.id}/regenerate`, { method: 'POST', data: payload });
    expect(replacement.card.code).not.toBe(issued.card.code);
    expect(f.env.db.prepare('SELECT count(*) AS n FROM mailbox_card WHERE is_current=1').get().n).toBe(1);
  });
});

describe('one-time redemption and permanent order delivery', () => {
  it('delivers a BOM TXT with all original links including expired links, and keeps its snapshot unchanged', async () => {
    const f = await fixture(), source = await f.source();
    const currentLinks = await f.links(source.id, ['second@example.com']);
    const expiredLinks = await f.links(source.id, ['first@example.com'], { expiresAt: '2020-01-01T00:00:00Z' });
    const [issued] = await f.generate([source.id]);
    const { key, order } = await f.redeem([issued.card.code]);
    expect(order).toMatchObject({ status: 'success', batch: false, successCount: 1, failureCount: 0, childCount: 2, linkCount: 2 });
    expect(order.items[0]).toMatchObject({ ok: true, mailboxId: source.id, mailboxEmail: source.email, childCount: 2, linkCount: 2 });
    expect(order.file).toMatchObject({ contentType: 'text/plain;charset=utf-8', size: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const download = await f.download(key, order.orderNo);
    expect(download.bytes.length).toBe(order.file.size);
    expect(sha256(download.bytes)).toBe(order.file.sha256);
    expect(txtLines(download.bytes)).toEqual([...currentLinks, ...expiredLinks].sort((a, b) => a.recipient.localeCompare(b.recipient))
      .map(link => deliveredLine(f, link)));
    expect(download.bytes.toString('utf8')).not.toContain(issued.card.code);
    expect(download.bytes.toString('utf8')).not.toContain(key);
    await f.links(source.id, ['later@example.com']);
    const queried = await f.success('/orders/query', { method: 'POST', admin: false, data: { queryKey: key } });
    expect(queried).toEqual(order);
    expect((await f.download(key, order.orderNo)).bytes).toEqual(download.bytes);
    expect(JSON.stringify(queried)).not.toContain('later@example.com');
    const raw = JSON.stringify(f.env.db.prepare('SELECT * FROM redemption_order').all());
    const items = JSON.stringify(f.env.db.prepare('SELECT * FROM redemption_order_item').all());
    for (const secret of [key, issued.card.code, currentLinks[0].pageUrl, expiredLinks[0].pageUrl]) {
      expect(raw).not.toContain(secret); expect(items).not.toContain(secret);
    }
    expect((await f.app.request(expiredLinks[0].pageUrl, {}, f.env)).status).toBe(410);
  });

  it('allows only one distinct request to consume a code and returns the same order for concurrent same-key retries', async () => {
    const f = await fixture(), source = await f.source();
    await f.links(source.id);
    const [issued] = await f.generate([source.id]), key = queryKey();
    const first = await Promise.all([f.redeem([issued.card.code], key), f.redeem([issued.card.code], key)]);
    expect(first[0].order.orderNo).toBe(first[1].order.orderNo);
    expect(first[0].order.successCount).toBe(1);
    const other = await f.redeem([issued.card.code]);
    expect(other.order).toMatchObject({ status: 'failed', successCount: 0, file: null });
    expect(other.order.items[0].error.code).toBe('CARD_REDEEMED');
    expect(JSON.stringify(other.order)).not.toContain('child@example.com');
    const conflict = await f.api('/redeem', { method: 'POST', admin: false, data: { requestKey: key, codes: ['not-the-original-code'] } });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error.code).toBe('REQUEST_KEY_CONFLICT');
    expect(f.env.db.prepare('SELECT count(*) AS n FROM card_redemption').get().n).toBe(1);
    expect(f.env.db.prepare('SELECT count(*) AS n FROM redemption_order').get().n).toBe(2);
    const renewedSource = await f.source('race@example.com');
    await f.links(renewedSource.id, ['race-child@example.com']);
    const [race] = await f.generate([renewedSource.id]);
    const competing = await Promise.all([f.redeem([race.card.code]), f.redeem([race.card.code])]);
    expect(competing.map(result => result.order.successCount).sort()).toEqual([0, 1]);
  });

  it('packages batch successes as one independently valid TXT per mailbox and preserves individual failures', async () => {
    const f = await fixture(), first = await f.source(), second = await f.source('other@example.com'), empty = await f.source('empty@example.com');
    const firstLinks = await f.links(first.id, ['a@example.com', 'b@example.com']);
    const secondLinks = await f.links(second.id, ['other-child@example.com']);
    const cards = await f.generate([first.id, second.id, empty.id]);
    const codes = cards.map(item => item.card.code);
    const { key, order } = await f.redeem([...codes, 'ML-does-not-exist']);
    expect(order).toMatchObject({ batch: true, status: 'partial', successCount: 2, failureCount: 2, childCount: 3, linkCount: 3 });
    expect(order.items[2].error.code).toBe('NO_CHILD_LINKS');
    expect(order.items[3].error.code).toBe('CARD_NOT_FOUND');
    expect(order.file.contentType).toBe('application/zip');
    const { bytes } = await f.download(key, order.orderNo);
    const entries = unzip(bytes);
    expect(entries).toHaveLength(2);
    const sets = entries.map(entry => txtLines(entry.content).sort());
    expect(sets).toContainEqual(firstLinks.map(link => deliveredLine(f, link)).sort());
    expect(sets).toContainEqual(secondLinks.map(link => deliveredLine(f, link)).sort());
    expect((await f.current(empty.id)).card.status).toBe('unused');
    expect(f.env.db.prepare('SELECT count(*) AS n FROM card_redemption').get().n).toBe(2);
    const partial = await f.redeem([cards[2].card.code, 'another-nonexistent-code']);
    expect(partial.order).toMatchObject({ status: 'failed', file: null, successCount: 0 });
    await f.links(empty.id, ['previously-empty@example.com']);
    const recovered = await f.redeem([cards[2].card.code, 'still-missing']);
    expect(recovered.order).toMatchObject({ batch: true, status: 'partial', successCount: 1 });
    expect(unzip((await f.download(recovered.key, recovered.order.orderNo)).bytes)).toHaveLength(1);
  });

  it('keeps different platform links for one child as separate exact lines and counts that child once', async () => {
    const f = await fixture(), source = await f.source();
    const platform = await f.success('/admin/platforms', { method: 'POST', data: { name: 'Shop', emails: ['sender@shop.example'] } });
    const broad = await f.links(source.id, ['shared@example.com']);
    const restricted = await f.links(source.id, ['shared@example.com'], { platformId: platform.id });
    const [issued] = await f.generate([source.id]);
    const { key, order } = await f.redeem([issued.card.code]);
    expect(order).toMatchObject({ childCount: 1, linkCount: 2 });
    const lines = txtLines((await f.download(key, order.orderNo)).bytes);
    expect(lines).toHaveLength(2);
    expect(lines).toContain(deliveredLine(f, broad[0]));
    expect(lines).toContain(deliveredLine(f, restricted[0]));
  });

  it('supports stop and restore, then regenerates a consumed code once without changing its original order or expiry', async () => {
    const f = await fixture(), source = await f.source();
    const [link] = await f.links(source.id, ['child@example.com'], { expiresAt: '2031-01-01T00:00:00Z' });
    const [issued] = await f.generate([source.id]);
    await f.success(`/admin/cards/${issued.card.id}`, { method: 'PUT', data: { enabled: false, revision: issued.card.revision } });
    expect((await f.redeem([issued.card.code])).order.items[0].error.code).toBe('CARD_DISABLED');
    const disabled = (await f.current(source.id)).card;
    await f.success(`/admin/cards/${disabled.id}`, { method: 'PUT', data: { enabled: true, revision: disabled.revision } });
    const original = await f.redeem([issued.card.code]);
    const originalBytes = (await f.download(original.key, original.order.orderNo)).bytes;
    const consumed = (await f.current(source.id)).card, requestKey = queryKey();
    const payload = { revision: consumed.revision, requestKey };
    const regenerated = await f.success(`/admin/cards/${consumed.id}/regenerate`, { method: 'POST', data: payload });
    const repeated = await f.success(`/admin/cards/${consumed.id}/regenerate`, { method: 'POST', data: payload });
    expect(repeated.card).toEqual(regenerated.card);
    expect(regenerated.card.code).not.toBe(issued.card.code);
    expect(regenerated.card).toMatchObject({ status: 'unused', enabled: true, supersedesCardId: consumed.id });
    expect((await f.redeem([issued.card.code])).order.items[0].error.code).toBe('CARD_REVOKED');
    expect((await f.redeem([regenerated.card.code])).order.successCount).toBe(1);
    expect((await f.download(original.key, original.order.orderNo)).bytes).toEqual(originalBytes);
    expect(f.env.db.prepare('SELECT expires_at FROM mail_link WHERE id=?').get(link.id).expires_at).toBe(Date.parse('2031-01-01T00:00:00Z'));
    const history = await f.success(`/admin/cards/${source.id}/history`);
    expect(history.items).toHaveLength(2);
    expect(history.items.find(card => card.id === consumed.id)).toMatchObject({ status: 'revoked', isCurrent: false, redeemedAt: expect.any(String), revokedAt: expect.any(String) });
    const stale = await f.api(`/admin/cards/${regenerated.card.id}`, { method: 'PUT', data: { enabled: false, revision: 0 } });
    expect(stale.status).toBeGreaterThanOrEqual(400);
  });

  it('serializes regeneration racing redemption without losing either the old history or the new current code', async () => {
    const f = await fixture(), source = await f.source();
    await f.links(source.id);
    const [issued] = await f.generate([source.id]);
    const [replacement, competing] = await Promise.all([
      f.success(`/admin/cards/${issued.card.id}/regenerate`, { method: 'POST', data: { revision: issued.card.revision, requestKey: queryKey() } }),
      f.redeem([issued.card.code]),
    ]);
    const old = f.env.db.prepare('SELECT * FROM mailbox_card WHERE id=?').get(issued.card.id);
    expect(old).toMatchObject({ is_current: 0, revoked_at: expect.any(Number) });
    expect((await f.current(source.id)).card.id).toBe(replacement.card.id);
    if (competing.order.successCount) {
      expect(old.redeemed_at).not.toBeNull();
      expect(txtLines((await f.download(competing.key, competing.order.orderNo)).bytes)).toHaveLength(1);
    } else {
      expect(competing.order.items[0].error.code).toBe('CARD_REVOKED');
      expect(old.redeemed_at).toBeNull();
    }
    expect((await f.redeem([replacement.card.code])).order.successCount).toBe(1);
    expect(f.env.db.prepare('SELECT count(*) AS n FROM mailbox_card WHERE is_current=1').get().n).toBe(1);
  });
});

describe('order credentials, atomicity and source lifecycle', () => {
  it('authorizes query and downloads only by the corresponding query credential, never by a code or URL parameter', async () => {
    const f = await fixture(), source = await f.source();
    await f.links(source.id);
    const [issued] = await f.generate([source.id]);
    const { key, order } = await f.redeem([issued.card.code]);
    const failures = [];
    for (const path of ['/orders/query', '/orders/download']) {
      for (const data of [{ orderNo: order.orderNo, queryKey: queryKey() }, { orderNo: 'different-order', queryKey: key }]) {
        const response = await f.api(path, { method: 'POST', admin: false, data });
        expect(response.status).toBe(404);
        const body = await response.json();
        expect(body.error.code).toBe('ORDER_UNAVAILABLE');
        for (const secret of [key, issued.card.code, source.email, order.orderNo]) expect(JSON.stringify(body)).not.toContain(secret);
        failures.push(body.error.message);
      }
      const response = await f.api(`${path}?queryKey=${encodeURIComponent(key)}`, { method: 'POST', admin: false, data: { orderNo: order.orderNo } });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await response.text()).not.toContain('child@example.com');
      const codeAsKey = await f.api(path, { method: 'POST', admin: false, data: { queryKey: issued.card.code } });
      expect(codeAsKey.status).toBeGreaterThanOrEqual(400);
      expect(await codeAsKey.text()).not.toContain('child@example.com');
    }
    expect(new Set(failures).size).toBe(1);
    expect(await f.success(`/admin/redemption-orders/${order.orderNo}`)).toEqual(order);
    const adminDownload = await f.api(`/admin/redemption-orders/${order.orderNo}/download`, { method: 'POST', data: {} });
    expect(adminDownload.status).toBe(200);
    expect(sha256(Buffer.from(await adminDownload.arrayBuffer()))).toBe(order.file.sha256);
    const listed = await f.success('/admin/redemption-orders');
    expect(listed.items.some(item => item.orderNo === order.orderNo)).toBe(true);
  });

  it('rolls back all successful items, order files and audit when storage fails, and safely retries the same request', async () => {
    const f = await fixture(), first = await f.source(), second = await f.source('rollback@example.com');
    await f.links(first.id, ['first-secret@example.com']);
    await f.links(second.id, ['second-secret@example.com']);
    const issued = await f.generate([first.id, second.id]), key = queryKey(), codes = issued.map(item => item.card.code);
    const auditCount = f.env.db.prepare('SELECT count(*) AS n FROM feature_audit').get().n;
    f.env.db.exec("CREATE TRIGGER reject_redemption BEFORE INSERT ON card_redemption WHEN (SELECT count(*) FROM card_redemption)>0 BEGIN SELECT RAISE(ABORT,'PRIVATE_STORAGE_FAILURE'); END;");
    const response = await f.api('/redeem', { method: 'POST', admin: false, data: { codes, requestKey: key } });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('PRIVATE_STORAGE_FAILURE');
    for (const table of ['card_redemption', 'redemption_order', 'redemption_order_item']) expect(f.env.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n).toBe(0);
    expect(f.env.db.prepare('SELECT count(*) AS n FROM mailbox_card WHERE redeemed_at IS NOT NULL').get().n).toBe(0);
    expect(f.env.db.prepare('SELECT count(*) AS n FROM feature_audit').get().n).toBe(auditCount);
    f.env.db.exec('DROP TRIGGER reject_redemption');
    expect((await f.redeem(codes, key)).order.successCount).toBe(2);
  });

  it('does not consume codes when encryption is unavailable or omit a child with a corrupted link token', async () => {
    const f = await fixture(), source = await f.source();
    const childLinks = await f.links(source.id, ['valid-child@example.com', 'broken-child@example.com']);
    const [issued] = await f.generate([source.id]), key = queryKey(), originalVault = f.env.secretVault;
    f.env.secretVault = null;
    const unavailable = await f.api('/redeem', { method: 'POST', admin: false, data: { codes: [issued.card.code], requestKey: key } });
    expect(unavailable.status).toBe(503);
    expect(f.env.db.prepare('SELECT count(*) AS n FROM redemption_order').get().n).toBe(0);
    expect(f.env.db.prepare('SELECT redeemed_at FROM mailbox_card WHERE id=?').get(issued.card.id).redeemed_at).toBeNull();
    f.env.secretVault = originalVault;
    const child = childLinks[0];
    const original = f.env.db.prepare('SELECT token_encrypted FROM mail_link WHERE id=?').get(child.id).token_encrypted;
    f.env.db.prepare('UPDATE mail_link SET token_encrypted=? WHERE id=?')
      .run(originalVault.encrypt(queryKey(), `mail-link:${child.id}`), child.id);
    const invalid = await f.redeem([issued.card.code], key);
    expect(invalid.order).toMatchObject({ status: 'failed', file: null, linkCount: 0 });
    expect(invalid.order.items[0].error.code).toBe('LINK_CONFIGURATION_INVALID');
    expect((await f.current(source.id)).card.status).toBe('unused');
    f.env.db.prepare('UPDATE mail_link SET token_encrypted=? WHERE id=?').run(original, child.id);
    expect((await f.redeem([issued.card.code])).order.linkCount).toBe(2);
  });

  it('fails the whole mailbox for malformed platform JSON without omitting its restricted child, then delivers all links after repair', async () => {
    const f = await fixture(), source = await f.source();
    const platform = await f.success('/admin/platforms', { method: 'POST', data: { name: 'Shop', emails: ['sender@shop.example'] } });
    await f.links(source.id, ['unrestricted@example.com']);
    await f.links(source.id, ['restricted@example.com'], { platformId: platform.id });
    const [issued] = await f.generate([source.id]);
    const original = f.env.db.prepare('SELECT emails_json,domains_json FROM platform_rule WHERE id=?').get(platform.id);
    for (const broken of [{ emails: '{broken', domains: original.domains_json }, { emails: original.emails_json, domains: '{}' }]) {
      f.env.db.prepare('UPDATE platform_rule SET emails_json=?,domains_json=? WHERE id=?').run(broken.emails, broken.domains, platform.id);
      const invalid = await f.redeem([issued.card.code]);
      expect(invalid.order).toMatchObject({ status: 'failed', successCount: 0, linkCount: 0, childCount: 0, file: null });
      expect(invalid.order.items[0].error.code).toBe('LINK_CONFIGURATION_INVALID');
      expect(f.env.db.prepare('SELECT count(*) AS n FROM card_redemption').get().n).toBe(0);
      expect((await f.current(source.id)).card.status).toBe('unused');
    }
    f.env.db.prepare('UPDATE platform_rule SET emails_json=?,domains_json=? WHERE id=?').run(original.emails_json, original.domains_json, platform.id);
    const repaired = await f.redeem([issued.card.code]);
    expect(repaired.order).toMatchObject({ status: 'success', successCount: 1, linkCount: 2, childCount: 2 });
    expect(txtLines((await f.download(repaired.key, repaired.order.orderNo)).bytes)).toHaveLength(2);
  });

  it('checks persisted file integrity before returning bytes and releases shared download slots on cancellation', async () => {
    const f = await fixture(), source = await f.source();
    await f.links(source.id);
    const [issued] = await f.generate([source.id]);
    const { key, order } = await f.redeem([issued.card.code]);
    const data = { orderNo: order.orderNo, queryKey: key };
    const pending = [];
    for (let index = 0; index < 4; index++) {
      const response = await f.api('/orders/download', { method: 'POST', admin: false, data });
      expect(response.status).toBe(200);
      pending.push(response);
    }
    const busy = await f.api('/orders/download', { method: 'POST', admin: false, data });
    expect(busy.status).toBe(429);
    expect((await busy.json()).error.code).toBe('DOWNLOAD_BUSY');
    await pending.shift().body.cancel();
    expect((await f.download(key, order.orderNo)).bytes.length).toBe(order.file.size);
    for (const response of pending) await response.body.cancel();
    const row = f.env.db.prepare('SELECT file_encrypted FROM redemption_order WHERE order_no=?').get(order.orderNo);
    const changed = f.env.secretVault.encrypt(Buffer.from('PRIVATE_TAMPERED_FILE').toString('base64'), `redemption-order-file:${order.orderNo}`);
    f.env.db.prepare('UPDATE redemption_order SET file_encrypted=? WHERE order_no=?').run(changed, order.orderNo);
    const corrupt = await f.api('/orders/download', { method: 'POST', admin: false, data });
    expect(corrupt.status).toBe(503);
    const payload = await corrupt.json();
    expect(payload.error.code).toBe('ORDER_FILE_CORRUPTED');
    expect(JSON.stringify(payload)).not.toContain('PRIVATE_TAMPERED_FILE');
    f.env.db.prepare('UPDATE redemption_order SET file_encrypted=? WHERE order_no=?').run(row.file_encrypted, order.orderNo);
    expect((await f.download(key, order.orderNo)).bytes.length).toBe(order.file.size);
  });

  it('releases download reservations after decryption, integrity or audit failures so subsequent requests retain all four slots', async () => {
    const f = await fixture(), source = await f.source();
    await f.links(source.id);
    const [issued] = await f.generate([source.id]);
    const { key, order } = await f.redeem([issued.card.code]);
    const data = { orderNo: order.orderNo, queryKey: key }, secretVault = f.env.secretVault;
    f.env.secretVault = null;
    for (let index = 0; index < 4; index++) {
      const failed = await f.api('/orders/download', { method: 'POST', admin: false, data });
      expect(failed.status).toBe(503);
      expect((await failed.json()).error.code).toBe('ENCRYPTION_NOT_CONFIGURED');
    }
    f.env.secretVault = secretVault;
    const original = f.env.db.prepare('SELECT file_sha256 FROM redemption_order WHERE order_no=?').get(order.orderNo).file_sha256;
    f.env.db.prepare('UPDATE redemption_order SET file_sha256=? WHERE order_no=?').run('0'.repeat(64), order.orderNo);
    for (let index = 0; index < 4; index++) {
      const failed = await f.api('/orders/download', { method: 'POST', admin: false, data });
      expect(failed.status).toBe(503);
      expect((await failed.json()).error.code).toBe('ORDER_FILE_CORRUPTED');
    }
    f.env.db.prepare('UPDATE redemption_order SET file_sha256=? WHERE order_no=?').run(original, order.orderNo);
    f.env.db.exec("CREATE TRIGGER reject_download_audit BEFORE INSERT ON feature_audit BEGIN SELECT RAISE(ABORT,'DOWNLOAD_AUDIT_FAILURE'); END;");
    for (let index = 0; index < 4; index++) {
      const failed = await f.api('/orders/download', { method: 'POST', admin: false, data });
      expect(failed.status).toBe(500);
      expect(await failed.text()).not.toContain('DOWNLOAD_AUDIT_FAILURE');
    }
    f.env.db.exec('DROP TRIGGER reject_download_audit');
    const pending = [];
    for (let index = 0; index < 4; index++) {
      const response = await f.api('/orders/download', { method: 'POST', admin: false, data });
      expect(response.status).toBe(200);
      pending.push(response);
    }
    expect((await f.api('/orders/download', { method: 'POST', admin: false, data })).status).toBe(429);
    for (const response of pending) await response.body.cancel();
    expect((await f.download(key, order.orderNo)).bytes.length).toBe(order.file.size);
  });

  it('refuses changed source identity and does not transfer an old code to a recreated same-address local account', async () => {
    const f = await fixture(), source = await f.source('identity@example.com', { account: true });
    await f.links(source.id);
    const [issued] = await f.generate([source.id]);
    const attempted = await f.api(`/admin/mailboxes/${source.id}`, { method: 'PUT', data: { revision: source.revision, email: 'different@example.com', mxDomain: 'example.com' } });
    expect(attempted.status).toBe(409);
    f.env.db.prepare('UPDATE source_mailbox SET email=? WHERE id=?').run('changed@example.com', source.id);
    expect((await f.redeem([issued.card.code])).order.items[0].error.code).toBe('MAILBOX_UNAVAILABLE');
    f.env.db.prepare('UPDATE source_mailbox SET email=? WHERE id=?').run(source.email, source.id);
    f.env.db.prepare('DELETE FROM account WHERE account_id=?').run(source.localAccountId);
    const adminId = f.env.db.prepare('SELECT user_id FROM user WHERE email=?').get(f.env.admin).user_id;
    const replacementId = Number(f.env.db.prepare('INSERT INTO account(email,name,user_id) VALUES(?,?,?)').run(source.email, 'replacement mailbox', adminId).lastInsertRowid);
    expect(replacementId).not.toBe(source.localAccountId);
    synchronizeLocalMailboxSources(f.env);
    const replacement = f.env.db.prepare('SELECT * FROM source_mailbox WHERE email=?').get(source.email);
    expect(replacement.id).not.toBe(source.id);
    expect((await f.redeem([issued.card.code])).order.items[0].error.code).toBe('MAILBOX_UNAVAILABLE');
    expect(f.env.db.prepare('SELECT count(*) AS n FROM card_redemption').get().n).toBe(0);
    expect(f.env.db.prepare('SELECT id FROM mailbox_card WHERE id=?').get(issued.card.id)).toBeTruthy();
  });

  it('applies durable rate limits using the trusted client address, with no bypass through forged forwarding headers', async () => {
    const f = await fixture();
    vi.spyOn(Date, 'now').mockReturnValue(1794787200000);
    for (let attempt = 0; attempt < 60; attempt++) {
      const response = await f.api('/orders/query', { method: 'POST', admin: false, data: { queryKey: queryKey() }, headers: { 'x-forwarded-for': `203.0.113.${attempt + 1}` } });
      expect(response.status).toBe(404);
    }
    const limited = await f.api('/orders/query', { method: 'POST', admin: false, data: { queryKey: queryKey() }, headers: { 'x-forwarded-for': '192.0.2.250' } });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    const other = await f.api('/orders/query', { method: 'POST', admin: false, clientIp: '198.51.100.13', data: { queryKey: queryKey() } });
    expect(other.status).toBe(404);
  });
});
