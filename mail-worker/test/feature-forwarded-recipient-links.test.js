import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { loadConfig } from '../src/server/config.js';
import { createEnvironment, serviceContext } from '../src/server/environment.js';
import { createApp } from '../src/server/app.js';
import { receiveInbound } from '../src/server/inbound.js';
import settingService from '../src/service/setting-service.js';

const resources = [];
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cloud-mail-forwarded-links-'));
  const env = await createEnvironment(loadConfig({
    MAIL_DOMAINS: 'example.com', ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'forwarded-test-admin-password',
    JWT_SECRET: 'forwarded-links-test-jwt-at-least-32-characters', DATA_ENCRYPTION_KEY: 'ab'.repeat(32),
    APP_URL: 'https://mail.example.com', DATA_DIR: join(root, 'data'), STATIC_DIR: root,
  }));
  resources.push({ root, env });
  env.mailReady = true;
  env.db.prepare('UPDATE setting SET receive=0,tg_bot_status=1,webhook_status=1,forward_status=1').run();
  await settingService.refresh(serviceContext(env));
  const app = createApp(env);
  let token, csrf;
  async function api(path, { method = 'GET', data } = {}) {
    return app.request(`https://mail.example.com/api${path}`, {
      method, headers: { 'content-type': 'application/json', 'accept-language': 'en',
        ...(token ? { authorization: token } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}),
        ...(method === 'GET' ? {} : { origin: env.app_url }) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    }, env);
  }
  const login = await (await api('/login', { method: 'POST', data: { email: env.admin, password: env.admin_password } })).json();
  expect(login.code, login.message).toBe(200);
  token = login.data.token;
  csrf = (await (await api('/admin/session')).json()).data.csrfToken;
  async function success(path, options, status = 200) {
    const response = await api(path, options), body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(status);
    return body.data;
  }
  async function main(name = 'main', scope = 'account') {
    let source = await success('/admin/mailboxes', { method: 'POST', data: {
      email: `${name}@example.com`, provider: 'mx', createLocalAccount: true,
    } }, 201);
    const account = env.db.prepare('SELECT account_id,user_id FROM account WHERE email=?').get(source.email);
    if (scope === 'domain') source = await success(`/admin/mailboxes/${source.id}`, { method: 'PUT', data: {
      revision: source.revision, mxDomain: 'example.com',
    } });
    return { source, account };
  }
  async function links(source, recipients) {
    return (await success('/admin/links', { method: 'POST', data: { mailboxId: source.id, recipients } }, 201)).items;
  }
  async function incoming(envelope, subject, { to = envelope, cc = '', extra = [], text = 'Verification content' } = {}) {
    const raw = Buffer.from([
      'From: Verification <sender@platform.test>', ...(to ? [`To: ${to}`] : []), ...(cc ? [`Cc: ${cc}`] : []),
      `Subject: ${subject}`, `Message-ID: <${randomUUID()}@platform.test>`, ...extra, '', text,
    ].join('\r\n'));
    const result = await receiveInbound(env, { raw, recipient: envelope, sender: 'forwarder@icloud.com' });
    expect(result.disposition).toBe('stored');
    return result.emailId;
  }
  function stored(mainMailbox, envelope, subject, { to = [], cc = [], type = 0, accountId = mainMailbox.account.account_id } = {}) {
    return Number(env.db.prepare(`INSERT INTO email(user_id,account_id,to_email,recipient,cc,send_email,subject,text,type,is_del)
      VALUES(?,?,?,?,?,?,?,?,?,0)`).run(mainMailbox.account.user_id, accountId, envelope,
      JSON.stringify(to.map(address => ({ address }))), JSON.stringify(cc.map(address => ({ address }))),
      'sender@platform.test', subject, 'Historical message content', type).lastInsertRowid);
  }
  async function mail(link, query = '?limit=20') {
    const response = await app.request(link.jsonUrl + query, {}, env), body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.data.recipient).toBe(link.recipient);
    return body.data.items;
  }
  return { env, app, api, main, links, incoming, stored, mail };
}

afterEach(() => {
  for (const { root, env } of resources.splice(0)) {
    if (env.db.open) env.db.close();
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !basename(root).startsWith('cloud-mail-forwarded-links-')) throw Error('Unexpected forwarded links test directory');
    rmSync(root, { recursive: true, force: true });
  }
});

describe('forwarded original recipient links within a local main mailbox', () => {
  it.each(['account', 'domain'])('creates complete external recipient links for a %s source, including equal local parts on different domains', async scope => {
    const f = await fixture(), { source } = await f.main('main', scope);
    const links = await f.links(source, [' Child@ICLOUD.COM ', 'child@icloud.com', 'child@other.test', 'unique@icloud.com']);
    expect(links.map(link => link.recipient).sort()).toEqual(['child@icloud.com', 'child@other.test', 'unique@icloud.com']);
    expect(new Set(links.map(link => link.jsonUrl)).size).toBe(3);
    for (const link of links) {
      expect(await f.mail(link)).toEqual([]);
      const explicit = `https://mail.example.com/api/mailboxes/p0/${source.publicId}/${encodeURIComponent(link.recipient)}/messages`;
      const response = await f.app.request(explicit + '?limit=1', {}, f.env);
      expect(response.status).toBe(200);
      expect((await response.json()).data.recipient).toBe(link.recipient);
    }
  });

  it('matches forwarded To and Cc as complete parsed addresses and preserves historical forwarded messages', async () => {
    const f = await fixture(), main = await f.main();
    const addresses = ['one@icloud.com', 'two@icloud.com', 'one@other.test'];
    const links = await f.links(main.source, addresses);
    await f.incoming(main.source.email, 'Shared To and Cc', {
      to: '"two@icloud.com" <ONE@ICLOUD.COM>', cc: 'Second child <two@icloud.com>',
    });
    await f.incoming(main.source.email, 'Same local part on another domain', { to: 'one@other.test' });
    const historical = f.stored(main, main.source.email, 'Historical original recipient', { to: ['one@icloud.com'] });
    expect(f.env.db.prepare('SELECT 1 FROM mail_ingress WHERE email_id=?').get(historical)).toBeUndefined();
    const expected = {
      'one@icloud.com': ['Historical original recipient', 'Shared To and Cc'],
      'two@icloud.com': ['Shared To and Cc'],
      'one@other.test': ['Same local part on another domain'],
    };
    for (const link of links) expect((await f.mail(link)).map(message => message.subject)).toEqual(expected[link.recipient]);
  });

  it('ignores substring addresses, display names, content and arbitrary headers before selecting the latest match', async () => {
    const f = await fixture(), main = await f.main();
    const [link] = await f.links(main.source, ['child@icloud.com']);
    await f.incoming(main.source.email, 'Intended verification', { to: 'Child <CHILD@ICLOUD.COM>' });
    for (const to of ['child1@icloud.com', 'xchild@icloud.com', 'child+tag@icloud.com', 'child@other.test', 'child@icloud.com.evil.test']) {
      await f.incoming(main.source.email, `Private ${to}`, { to, text: 'child@icloud.com' });
    }
    await f.incoming(main.source.email, 'child@icloud.com in subject only', {
      to: '"child@icloud.com" <someone@icloud.com>', text: 'child@icloud.com in body',
      extra: ['Reply-To: child@icloud.com', 'Bcc: child@icloud.com', 'Delivered-To: child@icloud.com', 'X-Original-To: child@icloud.com'],
    });
    expect((await f.mail(link, '?limit=1')).map(message => message.subject)).toEqual(['Intended verification']);
    expect((await f.mail(link)).map(message => message.subject)).toEqual(['Intended verification']);
  });

  it('handles absent or malformed historical recipient lists and still reads parsed address groups', async () => {
    const f = await fixture(), main = await f.main();
    const [link] = await f.links(main.source, ['child@icloud.com']);
    await f.incoming(main.source.email, 'Grouped original recipient', { to: 'Children: Child <child@icloud.com>;' });
    await f.incoming(main.source.email, 'No original recipient headers', { to: null, text: 'child@icloud.com' });
    for (const [recipient, cc] of [
      ['', ''], ['null', 'null'], ['{broken-json', '[]'], ['{}', 'null'], ['"child@icloud.com"', 'false'],
      ['[{"name":"child@icloud.com"}]', '[{"name":"child@icloud.com"}]'],
    ]) {
      const id = f.stored(main, main.source.email, 'Malformed historical recipient metadata');
      f.env.db.prepare('UPDATE email SET recipient=?,cc=? WHERE email_id=?').run(recipient, cc, id);
    }
    expect((await f.mail(link, '?limit=1')).map(message => message.subject)).toEqual(['Grouped original recipient']);
    expect((await f.mail(link)).map(message => message.subject)).toEqual(['Grouped original recipient']);
  });

  it.each(['account', 'domain'])('keeps external To/Cc inside the exact main envelope for a %s source and excludes plus aliases and sent mail', async scope => {
    const f = await fixture(), main = await f.main('main-a', scope), other = await f.main('main-b');
    const [link] = await f.links(main.source, ['child@icloud.com']);
    const [otherLink] = await f.links(other.source, ['child@icloud.com']);
    await f.incoming(main.source.email, 'Main A private verification', { to: 'child@icloud.com' });
    await f.incoming(other.source.email, 'Main B private verification', { to: 'child@icloud.com' });
    await f.incoming('main-a+private@example.com', 'Main A plus alias private verification', { to: 'child@icloud.com' });
    f.stored(main, other.source.email, 'Other envelope in the same storage account', { to: ['child@icloud.com'] });
    f.stored(main, main.source.email, 'Sent record with a forged original recipient', { to: ['child@icloud.com'], type: 1 });
    if (scope === 'account') f.stored(main, main.source.email, 'Other storage account with the same envelope', {
      to: ['child@icloud.com'], accountId: other.account.account_id,
    });
    expect((await f.mail(link)).map(message => message.subject)).toEqual(['Main A private verification']);
    expect((await f.mail(otherLink)).map(message => message.subject)).toEqual(['Main B private verification']);
  });

  it('continues to isolate same-domain children by their exact SMTP envelopes even when To/Cc target another child', async () => {
    const f = await fixture(), main = await f.main();
    const links = await f.links(main.source, ['main+one@example.com', 'main+two@example.com']);
    await f.incoming('main+one@example.com', 'One envelope only', { to: 'main+two@example.com' });
    await f.incoming('main+two@example.com', 'Two envelope only', { to: main.source.email, cc: 'main+one@example.com' });
    await f.incoming(main.source.email, 'Parent private message', { to: 'main+one@example.com', cc: 'main+two@example.com' });
    for (const link of links) expect((await f.mail(link)).map(message => message.subject))
      .toEqual([link.recipient.includes('+one@') ? 'One envelope only' : 'Two envelope only']);
  });
});
