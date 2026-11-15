import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { SMTPServer } from 'smtp-server';
import PostalMime from 'postal-mime';
import { loadConfig } from '../src/server/config.js';
import { createEnvironment, serviceContext } from '../src/server/environment.js';
import { createApp } from '../src/server/app.js';
import { receiveInbound } from '../src/server/inbound.js';
import { flushOutbox } from '../src/server/delivery.js';
import settingService from '../src/service/setting-service.js';

const resources = [];
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cloud-mail-api-send-'));
  const env = await createEnvironment(loadConfig({
    MAIL_DOMAINS: 'example.com', MAIL_HOST: 'mail.example.com', ADMIN_EMAIL: 'admin@example.com',
    ADMIN_PASSWORD: 'administrator-password-123', JWT_SECRET: 'mail-api-test-secret-at-least-32-characters',
    APP_URL: 'https://mail.example.com', DATA_DIR: root, STATIC_DIR: root,
  }));
  const resource = { root, env, close: [] };
  resources.push(resource);
  env.db.prepare('UPDATE setting SET receive=0,send=0,tg_bot_status=1,webhook_status=1,forward_status=1').run();
  await settingService.refresh(serviceContext(env));
  const app = createApp(env);
  let adminToken;
  async function request(path, { method = 'GET', token = adminToken, data } = {}) {
    const response = await app.request(`https://mail.example.com/api${path}`, {
      method, headers: { 'content-type': 'application/json', 'accept-language': 'en', ...(token ? { Authorization: token } : {}) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    }, env);
    return response.json();
  }
  async function login(email, password) {
    const result = await request('/login', { method: 'POST', data: { email, password } });
    expect(result.code, result.message).toBe(200);
    return result.data.token;
  }
  adminToken = await login(env.admin, env.admin_password);
  async function user(name, { permissions = [3, 22], sendType = 'count', sendCount = 0 } = {}) {
    const role = await request('/role/add', { method: 'POST', data: {
      name, key: name, description: 'Mail API acceptance', permIds: permissions,
      banEmail: [], availDomain: ['example.com'], sendType, sendCount, accountCount: 2,
    } });
    expect(role.code, role.message).toBe(200);
    const roleId = env.db.prepare('SELECT role_id FROM role WHERE key=?').get(name).role_id;
    const email = `${name}@example.com`, password = `${name}-password-123`;
    const created = await request('/user/add', { method: 'POST', data: { email, password, type: roleId } });
    expect(created.code, created.message).toBe(200);
    const account = env.db.prepare('SELECT * FROM account WHERE email=?').get(email);
    return { token: await login(email, password), accountId: account.account_id, userId: account.user_id };
  }
  async function smtp() {
    const messages = [];
    const server = new SMTPServer({
      authOptional: true, disabledCommands: ['AUTH', 'STARTTLS'],
      onData(stream, session, done) {
        const chunks = [];
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('end', () => {
          messages.push({ envelope: session.envelope, raw: Buffer.concat(chunks) });
          done(null, `Ok: queued as Acceptance${messages.length}`);
        });
      },
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    resource.close.push(() => new Promise(resolve => server.close(resolve)));
    env.smtp = { ...env.smtp, host: '127.0.0.1', port: server.server.address().port };
    return messages;
  }
  const adminAccount = env.db.prepare('SELECT * FROM account WHERE email=?').get(env.admin);
  const send = (data, token) => request('/email/send', {
    method: 'POST', token, data: { accountId: adminAccount.account_id, text: 'Acceptance message', ...data },
  });
  return { env, request, user, smtp, send, adminAccount };
}

afterEach(async () => {
  for (const { root, env, close } of resources.splice(0)) {
    for (const stop of close.reverse()) await stop();
    if (env.db.open) env.db.close();
    if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !basename(root).startsWith('cloud-mail-api-send-')) throw Error('Unexpected API mail test directory');
    rmSync(root, { recursive: true, force: true });
  }
});

describe('mail API acceptance with SQLite and loopback SMTP', () => {
  it('replies with thread headers and deduplicates To/CC/BCC without disclosing blind recipients over SMTP', async () => {
    const { env, send, smtp } = await fixture();
    const received = await receiveInbound(env, {
      sender: 'sender@outside.test', recipient: env.admin,
      raw: Buffer.from('From: sender@outside.test\r\nTo: admin@example.com\r\nSubject: Original\r\nMessage-ID: <original@outside.test>\r\n\r\nQuestion'),
    });
    const messages = await smtp();
    const result = await send({
      sendType: 'reply', emailId: received.emailId, subject: 'Re: Original',
      receiveEmail: ['sender@outside.test', 'SENDER@outside.test'],
      ccEmail: ['sender@outside.test', 'copy@outside.test'],
      bccEmail: ['COPY@outside.test', 'blind@outside.test', 'BLIND@outside.test'],
    });
    expect(result.code, result.message).toBe(200);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({ inReplyTo: '<original@outside.test>', relation: '<original@outside.test>', deliveryStatus: 'pending' });
    expect(result.data[0].deliveries).toHaveLength(3);
    await flushOutbox(env);
    expect(messages).toHaveLength(1);
    expect(messages[0].envelope.rcptTo.map(item => item.address).sort()).toEqual(['blind@outside.test', 'copy@outside.test', 'sender@outside.test']);
    const parsed = await PostalMime.parse(messages[0].raw);
    expect(parsed.inReplyTo).toBe('<original@outside.test>');
    expect(parsed.references).toBe('<original@outside.test>');
    expect(parsed.to.map(item => item.address)).toEqual(['sender@outside.test']);
    expect(parsed.cc.map(item => item.address)).toEqual(['copy@outside.test']);
    expect(messages[0].raw.toString()).not.toMatch(/^Bcc:/mi);
    expect(messages[0].raw.toString()).not.toContain('blind@outside.test');
    expect(JSON.parse(result.data[0].bcc)).toEqual([{ address: 'blind@outside.test', name: '' }]);
  });

  it('rejects a reply referencing another user’s mailbox without creating a send or reserving quota', async () => {
    const { env, user, send, adminAccount } = await fixture();
    const ordinary = await user('reply-sender', { sendCount: 2 });
    const originalId = Number(env.db.prepare('INSERT INTO email(user_id,account_id,message_id,subject) VALUES (?,?,?,?)')
      .run(adminAccount.user_id, adminAccount.account_id, '<private-thread@outside.test>', 'Private original').lastInsertRowid);
    const result = await send({ accountId: ordinary.accountId, sendType: 'reply', emailId: originalId, receiveEmail: ['to@outside.test'] }, ordinary.token);
    expect(result.code).not.toBe(200);
    expect(env.db.prepare('SELECT count(*) AS n FROM mail_outbox').get().n).toBe(0);
    expect(env.db.prepare('SELECT count(*) AS n FROM email WHERE type=1').get().n).toBe(0);
    expect(Number(env.db.prepare('SELECT send_count FROM user WHERE user_id=?').get(ordinary.userId).send_count)).toBe(0);
    const ownId = Number(env.db.prepare('INSERT INTO email(user_id,account_id,message_id,subject) VALUES (?,?,?,?)')
      .run(ordinary.userId, ordinary.accountId, '<own-thread@outside.test>', 'Own original').lastInsertRowid);
    const ownReply = await send({ accountId: ordinary.accountId, sendType: 'reply', emailId: ownId, receiveEmail: ['to@outside.test'] }, ordinary.token);
    expect(ownReply.code, ownReply.message).toBe(200);
    expect(ownReply.data[0].inReplyTo).toBe('<own-thread@outside.test>');
    expect(Number(env.db.prepare('SELECT send_count FROM user WHERE user_id=?').get(ordinary.userId).send_count)).toBe(1);
  });

  it('submits divided bulk sends as separate messages with separate envelopes and no copies', async () => {
    const { env, send, smtp } = await fixture();
    const messages = await smtp();
    const result = await send({
      manyType: 'divide', receiveEmail: ['first@outside.test', 'second@outside.test'],
      ccEmail: ['copy@outside.test'], bccEmail: ['blind@outside.test'], subject: 'Separate bulk message',
    });
    expect(result.code, result.message).toBe(200);
    expect(result.data.emails).toHaveLength(2);
    expect(result.data.failedRecipients).toEqual([]);
    expect(result.data.error).toBe('');
    await flushOutbox(env);
    expect(messages).toHaveLength(2);
    expect(messages.map(message => message.envelope.rcptTo.map(item => item.address))).toEqual([['first@outside.test'], ['second@outside.test']]);
    const parsed = await Promise.all(messages.map(message => PostalMime.parse(message.raw)));
    expect(parsed[0].messageId).not.toBe(parsed[1].messageId);
    for (const [index, message] of parsed.entries()) {
      expect(message.to.map(item => item.address)).toEqual([[ 'first@outside.test' ], [ 'second@outside.test' ]][index]);
      expect(message.cc || []).toEqual([]);
      expect(messages[index].raw.toString()).not.toMatch(/^Bcc:/mi);
    }
  });

  it('enforces normal-user send permission, role bans and distinct-recipient quotas at the API boundary', async () => {
    const { env, user, send } = await fixture();
    const noPermission = await user('no-send-perm', { permissions: [22] });
    expect((await send({ accountId: noPermission.accountId, receiveEmail: ['to@outside.test'] }, noPermission.token)).code).toBe(403);
    const banned = await user('send-banned', { sendType: 'ban' });
    expect((await send({ accountId: banned.accountId, receiveEmail: ['to@outside.test'] }, banned.token)).code).toBe(403);
    const limited = await user('send-limited', { sendCount: 3 });
    const excess = await send({ accountId: limited.accountId, receiveEmail: ['to@outside.test'], ccEmail: ['copy@outside.test'], bccEmail: ['blind@outside.test', 'extra@outside.test'] }, limited.token);
    expect(excess.code, excess.message).toBe(403);
    expect(env.db.prepare('SELECT count(*) AS n FROM mail_outbox').get().n).toBe(0);
    expect(Number(env.db.prepare('SELECT send_count FROM user WHERE user_id=?').get(limited.userId).send_count)).toBe(0);
    const permitted = await send({
      accountId: limited.accountId, receiveEmail: ['one@outside.test', 'ONE@outside.test'],
      ccEmail: ['one@outside.test', 'copy@outside.test'], bccEmail: ['copy@outside.test', 'blind@outside.test', 'BLIND@outside.test'],
    }, limited.token);
    expect(permitted.code, permitted.message).toBe(200);
    expect(permitted.data[0].deliveries).toHaveLength(3);
    expect(Number(env.db.prepare('SELECT send_count FROM user WHERE user_id=?').get(limited.userId).send_count)).toBe(3);
    expect((await send({ accountId: limited.accountId, receiveEmail: ['another@outside.test'] }, limited.token)).code).toBe(403);
    expect(env.db.prepare('SELECT count(*) AS n FROM mail_outbox').get().n).toBe(1);
  });

  it('rejects external copies for an internal-only role and hides BCC from every local inbox', async () => {
    const { env, user, send } = await fixture();
    const internal = await user('internal-sender', { sendType: 'internal' });
    for (const field of ['ccEmail', 'bccEmail']) {
      const denied = await send({ accountId: internal.accountId, receiveEmail: [env.admin], [field]: ['outside@outside.test'] }, internal.token);
      expect(denied.code, denied.message).toBe(403);
    }
    const delivered = await send({
      accountId: internal.accountId, receiveEmail: ['admin+to@example.com'],
      ccEmail: ['admin+copy@example.com'], bccEmail: ['admin+blind@example.com'],
    }, internal.token);
    expect(delivered.code, delivered.message).toBe(200);
    expect(delivered.data[0].deliveryStatus).toBe('delivered');
    expect(delivered.data[0].deliveries).toHaveLength(3);
    const inbox = env.db.prepare('SELECT to_email,bcc,cc,recipient FROM email WHERE type=0 ORDER BY email_id').all();
    expect(inbox.map(row => row.to_email)).toEqual(['admin+to@example.com', 'admin+copy@example.com', 'admin+blind@example.com']);
    expect(inbox.every(row => row.bcc === '[]')).toBe(true);
    expect(inbox.every(row => !row.cc.includes('blind') && !row.recipient.includes('blind'))).toBe(true);
    expect(env.db.prepare('SELECT count(*) AS n FROM mail_outbox').get().n).toBe(0);
  });
});
