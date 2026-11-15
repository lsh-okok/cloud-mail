import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, renameSync, appendFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import nodemailer from 'nodemailer';
import { SMTPServer } from 'smtp-server';
import { loadConfig } from '../src/server/config.js';
import { createEnvironment, serviceContext } from '../src/server/environment.js';
import { resolveRecipient, policyAction, isTrustedMailPeer, startPolicyServer } from '../src/server/policy.js';
import { receiveInbound, flushNotifications } from '../src/server/inbound.js';
import { startLmtpServer } from '../src/server/mail.js';
import { prepareOutbound, insertOutbox, flushOutbox, applyPostfixLine, pollPostfixLog,
  outboxStatus, retryUncertainOutbox } from '../src/server/delivery.js';
import emailService from '../src/service/email-service.js';
import telegramService from '../src/service/telegram-service.js';
import settingService from '../src/service/setting-service.js';

const resources = [];
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cloud-mail-mail-'));
  const config = loadConfig({ MAIL_DOMAINS: 'example.com', MAIL_HOST: 'mail.example.com',
    ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'administrator-password-123',
    JWT_SECRET: 'test-jwt-secret-with-at-least-32-characters', APP_URL: 'https://mail.example.com',
    DATA_DIR: root, STATIC_DIR: root, LMTP_PORT: '2525', POLICY_PORT: '10040' });
  const env = await createEnvironment(config);
  env.server = { ...env.server, lmtpPort: 0, lmtpHost: '127.0.0.1', policyPort: 0, policyHost: '127.0.0.1', mailLogPath: join(root, 'postfix.log') };
  env.db.prepare('UPDATE setting SET receive=0,send=0,no_recipient=1,tg_bot_status=1,webhook_status=1,forward_status=1').run();
  await settingService.refresh(serviceContext(env));
  const resource = { root, env, close: [] }; resources.push(resource);
  return resource;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const resource of resources.splice(0)) {
    for (const close of resource.close.reverse()) await close();
    if (resource.env.db.open) resource.env.db.close();
    if (!resolve(resource.root).startsWith(resolve(tmpdir()) + sep) || !basename(resource.root).startsWith('cloud-mail-mail-')) throw Error('Unexpected mail test directory');
    rmSync(resource.root, { recursive: true, force: true });
  }
});

const raw = (extra = '', body = 'Hello') => Buffer.from(`Received: by mail.example.com (Postfix) id inbox-1\r\nFrom: Sender <sender@outside.test>\r\nTo: Visible <visible@outside.test>\r\nBcc: secret@outside.test\r\nSubject: Example\r\nMessage-ID: <inbox-1@outside.test>\r\n${extra}\r\n${body}`);
const policy = (recipient, sender = 'sender@outside.test') => ({ request: 'smtpd_access_policy', protocol_state: 'RCPT', recipient, sender });
async function queued(env, recipients = ['person@outside.test']) {
  const prepared = await prepareOutbound(env, { accountEmail: 'admin@example.com', name: 'Admin', receiveEmail: recipients, text: 'test', subject: 'test' });
  env.db.transaction(() => insertOutbox(env, prepared))();
  return prepared;
}
const cleanupLine = (id, mid) => `Nov 12 12:00:00 mail postfix/cleanup[20]: ${id}: message-id=${mid}`;
const deliveryLine = (id, recipient, state) => `Nov 12 12:00:01 mail postfix/smtp[21]: ${id}: to=<${recipient}>, relay=mx.example[1.2.3.4]:25, delay=1, dsn=2.0.0, status=${state} (250 accepted)`;
async function within(promise, milliseconds = 1500) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Operation did not finish promptly')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

describe('SMTP recipient policy', () => {
  it('uses envelope recipients, plus aliases, catch-all settings, domain and role rules', async () => {
    const { env } = await fixture();
    expect(policyAction(env, policy('admin+tag@example.com'))).toBe('DUNNO');
    expect(policyAction(env, policy('nobody@outside.test'))).toMatch(/^550.*Relaying denied/);
    expect(policyAction(env, policy('nobody@example.com'))).toMatch(/^550.*not found/);
    env.db.prepare('UPDATE setting SET no_recipient=0').run();
    expect(resolveRecipient(env, 'nobody@example.com').account).toBeNull();
    env.db.prepare("INSERT INTO user(email,password,salt,type) VALUES ('limited@example.com','x','x',1)").run();
    const user = env.db.prepare("SELECT user_id FROM user WHERE email='limited@example.com'").get();
    env.db.prepare("INSERT INTO account(email,user_id) VALUES ('limited@example.com',?)").run(user.user_id);
    env.db.prepare("UPDATE role SET avail_domain='other.test' WHERE role_id=1").run();
    expect(policyAction(env, policy('limited@example.com'))).toMatch(/^550.*not authorized/);
    env.db.prepare("UPDATE role SET avail_domain='',ban_email='outside.test' WHERE role_id=1").run();
    expect(policyAction(env, policy('limited@example.com'))).toMatch(/^550.*does not accept/);
    env.db.prepare('UPDATE setting SET receive=1').run();
    expect(policyAction(env, policy('admin@example.com'))).toMatch(/^451/);
  });

  it('only trusts the private mail subnet and speaks the persistent Postfix policy protocol', async () => {
    const resource = await fixture(), { env } = resource;
    expect(isTrustedMailPeer(env, '::ffff:172.30.89.22')).toBe(true);
    expect(isTrustedMailPeer(env, '172.30.90.22')).toBe(false);
    expect(isTrustedMailPeer(env, '203.0.113.1')).toBe(false);
    const server = await startPolicyServer(env);
    resource.close.push(() => new Promise(resolve => server.close(resolve)));
    const answer = await new Promise((resolve, reject) => {
      const socket = net.createConnection(server.address().port, '127.0.0.1');
      socket.once('error', reject);
      socket.on('connect', () => socket.write('request=smtpd_access_policy\nprotocol_state=RCPT\nrecipient=admin@example.com\nsender=sender@outside.test\n\n'));
      socket.on('data', data => { socket.destroy(); resolve(data.toString()); });
    });
    expect(answer).toBe('action=DUNNO\n\n');
  });
});

describe('durable inbound mail', () => {
  it('parses MIME and HTML with external dependencies in the production Node 24 CJS bundle', async () => {
    const { env } = await fixture();
    const compiled = await build({
      entryPoints: [resolve('src/server/inbound.js')], bundle: true, platform: 'node',
      target: 'node24', format: 'cjs', packages: 'external', write: false,
    });
    const cjs = { exports: {} }, require = createRequire(import.meta.url);
    new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, cjs, cjs.exports);
    const mime = raw('Content-Type: text/html; charset=UTF-8\r\n', '<p>Production parsing</p>');
    const receipt = await cjs.exports.receiveInbound(env, { raw: mime, recipient: 'admin@example.com', sender: 'sender@outside.test' });
    const stored = env.db.prepare('SELECT content,subject FROM email WHERE email_id=?').get(receipt.emailId);
    expect(stored.content).toContain('Production parsing');
    expect(stored.subject).toBe('Example');
    expect(typeof require('linkedom').parseHTML).toBe('function');
    expect(require('uuid').v4()).toMatch(/^[a-f0-9-]{36}$/);
  });

  it('delivers by SMTP envelope, hides BCC, persists binary attachments and deduplicates retries', async () => {
    const { env } = await fixture();
    const message = await prepareOutbound(env, { accountEmail: 'sender@outside.test', name: 'Sender',
      receiveEmail: ['visible@outside.test'], bccEmail: ['secret@outside.test'], subject: 'Binary attachment',
      text: 'test', attachments: [{ filename: '文件.bin', mimeType: 'application/octet-stream', content: Buffer.from([0, 255, 1, 0]) }] });
    const result = await receiveInbound(env, { raw: message.raw, recipient: 'admin+private@example.com', sender: 'sender@outside.test' });
    const stored = env.db.prepare('SELECT * FROM email WHERE email_id=?').get(result.emailId);
    expect(stored.to_email).toBe('admin+private@example.com');
    expect(stored.bcc).toBe('[]');
    expect(stored.recipient).toContain('visible@outside.test');
    const attachment = env.db.prepare('SELECT * FROM attachments WHERE email_id=?').get(result.emailId);
    const object = await env.storage.get(attachment.key);
    expect(Buffer.from(await object.arrayBuffer())).toEqual(Buffer.from([0, 255, 1, 0]));
    expect((await receiveInbound(env, { raw: message.raw, recipient: 'admin+private@example.com', sender: 'sender@outside.test' })).duplicate).toBe(true);
    expect(env.db.prepare('SELECT count(*) AS n FROM email').get().n).toBe(1);
  });

  it('does not acknowledge failed object writes and stores exactly one copy after recovery', async () => {
    const { env } = await fixture();
    const message = await prepareOutbound(env, { accountEmail: 'sender@outside.test', receiveEmail: ['admin@example.com'],
      text: 'test', attachments: [{ filename: 'data.bin', content: Buffer.from('binary') }] });
    const original = env.storage.put;
    const write = vi.spyOn(env.storage, 'put').mockRejectedValueOnce(new Error('disk full'));
    await expect(receiveInbound(env, { raw: message.raw, recipient: 'admin@example.com', sender: 'sender@outside.test' })).rejects.toThrow('disk full');
    expect(env.db.prepare('SELECT count(*) AS n FROM email').get().n).toBe(0);
    expect(env.db.prepare('SELECT count(*) AS n FROM mail_ingress').get().n).toBe(0);
    write.mockImplementation(original);
    await receiveInbound(env, { raw: message.raw, recipient: 'admin@example.com', sender: 'sender@outside.test' });
    expect(env.db.prepare('SELECT count(*) AS n FROM email').get().n).toBe(1);
  });

  it('discards blacklisted bodies without a bounce, and notification failures cannot duplicate mail', async () => {
    const { env } = await fixture();
    env.db.prepare("UPDATE setting SET black_content='blocked',tg_bot_status=0,tg_chat_id='1'").run();
    await settingService.refresh(serviceContext(env));
    expect(policyAction(env, policy('admin@example.com'))).toBe('DUNNO');
    expect((await receiveInbound(env, { raw: raw('', 'blocked text'), recipient: 'admin@example.com' })).disposition).toBe('blacklist');
    expect(env.db.prepare('SELECT count(*) AS n FROM email').get().n).toBe(0);
    await receiveInbound(env, { raw: raw(), recipient: 'admin@example.com' });
    vi.spyOn(telegramService, 'sendEmailToBot').mockRejectedValue(new Error('network down'));
    await flushNotifications(env);
    expect(env.db.prepare('SELECT count(*) AS n FROM email').get().n).toBe(1);
    expect((await receiveInbound(env, { raw: raw(), recipient: 'admin@example.com' })).duplicate).toBe(true);
  });

  it('acknowledges a real private LMTP transaction only after storage', async () => {
    const resource = await fixture(), { env } = resource;
    const server = await startLmtpServer(env);
    resource.close.push(() => new Promise(resolve => server.close(resolve)));
    const client = nodemailer.createTransport({ host: '127.0.0.1', port: server.server.address().port, lmtp: true, ignoreTLS: true });
    const response = await client.sendMail({ envelope: { from: 'sender@outside.test', to: ['admin+wire@example.com'] }, raw: raw() });
    expect(response.accepted).toEqual(['admin+wire@example.com']);
    expect(env.db.prepare('SELECT to_email FROM email').get().to_email).toBe('admin+wire@example.com');
  });

  it('returns per-recipient LMTP failures so retrying the failed recipient cannot duplicate the successful one', async () => {
    const resource = await fixture(), { env } = resource;
    const server = await startLmtpServer(env);
    resource.close.push(() => new Promise(resolve => server.close(resolve)));
    const client = nodemailer.createTransport({ host: '127.0.0.1', port: server.server.address().port, lmtp: true, ignoreTLS: true });
    const message = await prepareOutbound(env, { accountEmail: 'sender@outside.test', receiveEmail: ['admin@example.com'],
      text: 'two recipients', attachments: [{ filename: 'data.bin', content: Buffer.from('data') }] });
    const put = env.storage.put; let writes = 0;
    const failure = vi.spyOn(env.storage, 'put').mockImplementation((...args) => {
      if (++writes === 2) return Promise.reject(new Error('temporary disk error'));
      return put(...args);
    });
    const response = await client.sendMail({ envelope: { from: 'sender@outside.test', to: ['admin+first@example.com', 'admin+second@example.com'] }, raw: message.raw });
    expect(response.accepted).toEqual(['admin+first@example.com']);
    expect(response.rejected).toEqual(['admin+second@example.com']);
    expect(env.db.prepare('SELECT count(*) AS n FROM email').get().n).toBe(1);
    failure.mockRestore();
    await client.sendMail({ envelope: { from: 'sender@outside.test', to: ['admin+second@example.com'] }, raw: message.raw });
    expect(env.db.prepare('SELECT count(*) AS n FROM email').get().n).toBe(2);
  });
});

describe('mail service shutdown', () => {
  it('closes persistent idle policy and LMTP connections promptly', async () => {
    const resource = await fixture(), { env } = resource;
    const policyServer = await startPolicyServer(env), lmtp = await startLmtpServer(env);
    resource.close.push(() => new Promise(resolve => policyServer.close(resolve)), () => lmtp.close());
    const policySocket = net.createConnection(policyServer.address().port, '127.0.0.1');
    const lmtpSocket = net.createConnection(lmtp.server.address().port, '127.0.0.1');
    resource.close.push(() => policySocket.destroy(), () => lmtpSocket.destroy());
    await within(Promise.all([
      new Promise((resolve, reject) => {
        policySocket.once('error', reject);
        policySocket.once('connect', () => policySocket.write('request=smtpd_access_policy\nprotocol_state=RCPT\nrecipient=admin@example.com\n\n'));
        policySocket.once('data', resolve);
      }),
      new Promise((resolve, reject) => { lmtpSocket.once('error', reject); lmtpSocket.once('data', resolve); })
    ]));
    await within(Promise.all([new Promise(resolve => policyServer.close(resolve)), lmtp.close()]));
  });

  it('waits for pending persistence even when its LMTP connection reaches the shutdown deadline', async () => {
    const resource = await fixture(), { env } = resource;
    const server = await startLmtpServer(env);
    // Exercise the real deadline without making the test wait five seconds.
    server.options.closeTimeout = 50;
    resource.close.push(() => server.close());
    let unblock, began;
    const blocked = new Promise(resolve => { unblock = resolve; });
    const started = new Promise(resolve => { began = resolve; });
    const put = env.storage.put;
    vi.spyOn(env.storage, 'put').mockImplementation(async (...args) => {
      began(); await blocked; return put(...args);
    });
    const message = await prepareOutbound(env, { accountEmail: 'sender@outside.test', receiveEmail: ['admin@example.com'],
      text: 'shutdown durability', attachments: [{ filename: 'pending.txt', content: Buffer.from('pending') }] });
    const client = nodemailer.createTransport({ host: '127.0.0.1', port: server.server.address().port, lmtp: true, ignoreTLS: true });
    const response = client.sendMail({ envelope: { from: 'sender@outside.test', to: ['admin@example.com'] }, raw: message.raw })
      .then(value => ({ value }), error => ({ error }));
    await within(started);
    let closed = false;
    const closing = server.close().then(() => { closed = true; });
    try {
      const outcome = await within(response);
      // LMTP can report a temporary failure per recipient without rejecting the
      // client promise; either form must contain no successful acknowledgement.
      if (!outcome.error) {
        expect(outcome.value.accepted).toEqual([]);
        expect(outcome.value.rejected).toEqual(['admin@example.com']);
      }
      expect(closed).toBe(false);
      expect(env.db.prepare('SELECT count(*) AS n FROM email').get().n).toBe(0);
    } finally { unblock(); }
    await within(closing);
    expect(env.db.prepare('SELECT count(*) AS n FROM email').get().n).toBe(1);
    expect((await receiveInbound(env, { raw: message.raw, recipient: 'admin@example.com', sender: 'sender@outside.test' })).duplicate).toBe(true);
  });
});

describe('durable outbound mail and reports', () => {
  it('rolls back mail and quota on queue failure and reserves quota atomically across concurrent sends', async () => {
    const { env } = await fixture();
    env.db.prepare("INSERT INTO role(role_id,name,key,send_type,send_count) VALUES (2,'sender','sender','count',1)").run();
    env.db.prepare("INSERT INTO user(email,password,salt,type) VALUES ('sender@example.com','x','x',2)").run();
    const userId = env.db.prepare("SELECT user_id FROM user WHERE email='sender@example.com'").get().user_id;
    const accountId = Number(env.db.prepare("INSERT INTO account(email,user_id) VALUES ('sender@example.com',?)").run(userId).lastInsertRowid);
    const send = () => emailService.send(serviceContext(env), { accountId, receiveEmail: ['to@outside.test'], text: 'hello' }, userId);
    env.db.exec("CREATE TRIGGER reject_queue BEFORE INSERT ON mail_outbox BEGIN SELECT RAISE(ABORT,'queue unavailable'); END");
    await expect(send()).rejects.toThrow('queue unavailable');
    expect(env.db.prepare('SELECT count(*) AS n FROM email').get().n).toBe(0);
    expect(Number(env.db.prepare('SELECT send_count FROM user WHERE user_id=?').get(userId).send_count)).toBe(0);
    env.db.exec('DROP TRIGGER reject_queue');
    const results = await Promise.allSettled([send(), send()]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(env.db.prepare('SELECT count(*) AS n FROM email').get().n).toBe(1);
    expect(env.db.prepare('SELECT count(*) AS n FROM mail_outbox').get().n).toBe(1);
    expect(Number(env.db.prepare('SELECT send_count FROM user WHERE user_id=?').get(userId).send_count)).toBe(1);
  });

  it('commits local sender and recipient copies together and preserves BCC privacy', async () => {
    const { env } = await fixture();
    const account = env.db.prepare("SELECT * FROM account WHERE email='admin@example.com'").get();
    const send = () => emailService.send(serviceContext(env), { accountId: account.account_id,
      receiveEmail: ['admin+to@example.com'], bccEmail: ['admin+blind@example.com'], text: 'local',
      attachments: [{ filename: 'local.txt', type: 'text/plain', content: Buffer.from('local').toString('base64') }] }, account.user_id);
    env.db.exec("CREATE TRIGGER reject_local BEFORE INSERT ON email WHEN NEW.to_email='admin+blind@example.com' BEGIN SELECT RAISE(ABORT,'mailbox unavailable'); END");
    await expect(send()).rejects.toThrow('mailbox unavailable');
    expect(env.db.prepare('SELECT count(*) AS n FROM email').get().n).toBe(0);
    expect(env.db.prepare('SELECT count(*) AS n FROM attachments').get().n).toBe(0);
    env.db.exec('DROP TRIGGER reject_local');
    const result = await send();
    expect(result[0].status).toBe(2);
    expect(result[0].deliveries).toHaveLength(2);
    expect(env.db.prepare('SELECT count(*) AS n FROM email').get().n).toBe(3);
    expect(env.db.prepare('SELECT count(*) AS n FROM mail_outbox').get().n).toBe(0);
    expect(env.db.prepare('SELECT bcc FROM email WHERE type=0').all().every(row => row.bcc === '[]')).toBe(true);
    const list = await emailService.list(serviceContext(env), { accountId: account.account_id, type: 1, size: 10 }, account.user_id);
    expect(list.list[0].deliveries).toHaveLength(2);
  });

  it('atomically saves API sends with attachments, CC/BCC and a delivery task', async () => {
    const { env } = await fixture();
    const account = env.db.prepare("SELECT * FROM account WHERE email='admin@example.com'").get();
    const result = await emailService.send(serviceContext(env), {
      accountId: account.account_id, receiveEmail: ['to@outside.test'], ccEmail: ['copy@outside.test'], bccEmail: ['blind@outside.test'],
      subject: 'Queued API mail', text: 'text', content: '<p>text</p>',
      attachments: [{ filename: 'note.txt', type: 'text/plain', content: Buffer.from('note').toString('base64') }]
    }, account.user_id);
    expect(result[0].status).toBe(1);
    expect(result[0].deliveries).toHaveLength(3);
    const task = env.db.prepare('SELECT * FROM mail_outbox').get();
    expect(task.state).toBe('pending');
    expect(task.raw_mime.toString()).not.toMatch(/^Bcc:/mi);
    expect(JSON.parse(task.recipients)).toContain('blind@outside.test');
    expect(env.db.prepare('SELECT count(*) AS n FROM attachments').get().n).toBe(1);
    const list = await emailService.list(serviceContext(env), { accountId: account.account_id, type: 1, size: 10 }, account.user_id);
    expect(list.list[0].deliveries).toHaveLength(3);
  });

  it('submits over actual SMTP and waits for every recipient report before delivered', async () => {
    const resource = await fixture(), { env } = resource;
    let received;
    const server = new SMTPServer({ authOptional: true, disabledCommands: ['AUTH', 'STARTTLS'],
      onData(stream, session, done) {
        const chunks = []; stream.on('data', chunk => chunks.push(chunk));
        stream.on('end', () => { received = { envelope: session.envelope, raw: Buffer.concat(chunks) }; done(null, 'Ok: queued as LongQueue123'); });
      } });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    resource.close.push(() => new Promise(resolve => server.close(resolve)));
    env.smtp = { ...env.smtp, host: '127.0.0.1', port: server.server.address().port };
    const prepared = await queued(env, ['one@outside.test', 'two@outside.test']);
    await flushOutbox(env);
    expect(received.envelope.mailFrom.address).toBe(`bounce+${prepared.id}@example.com`);
    expect(outboxStatus(env, prepared.id).state).toBe('queued');
    applyPostfixLine(env, deliveryLine('LongQueue123', 'one@outside.test', 'sent'));
    expect(outboxStatus(env, prepared.id).state).toBe('queued');
    applyPostfixLine(env, deliveryLine('LongQueue123', 'two@outside.test', 'deferred'));
    expect(outboxStatus(env, prepared.id).state).toBe('deferred');
    applyPostfixLine(env, deliveryLine('LongQueue123', 'two@outside.test', 'sent'));
    expect(outboxStatus(env, prepared.id).state).toBe('delivered');
    expect(env.db.prepare('SELECT raw_mime FROM mail_outbox').get().raw_mime).toBeNull();
  });

  it('holds ambiguous DATA disconnects, recovers from out-of-order logs and never auto-resends', async () => {
    const { env } = await fixture();
    const prepared = await queued(env);
    const transport = { sendMail: vi.fn().mockRejectedValue(Object.assign(new Error('socket closed after DATA'), { command: 'DATA', code: 'ECONNRESET' })) };
    await flushOutbox(env, transport);
    expect(outboxStatus(env, prepared.id).state).toBe('uncertain');
    await flushOutbox(env, transport);
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    applyPostfixLine(env, deliveryLine('UnknownQueue', 'person@outside.test', 'sent'));
    applyPostfixLine(env, cleanupLine('UnknownQueue', prepared.messageId));
    expect(outboxStatus(env, prepared.id).state).toBe('delivered');
    expect(() => retryUncertainOutbox(env, prepared.id)).toThrow();
  });

  it('does not mistake cleanup ID logging for final queue acceptance', async () => {
    const { env } = await fixture();
    const prepared = await queued(env);
    await flushOutbox(env, { sendMail: async () => { throw Object.assign(new Error('ambiguous DATA'), { command: 'DATA' }); } });
    applyPostfixLine(env, cleanupLine('PreAcceptance', prepared.messageId));
    expect(outboxStatus(env, prepared.id).state).toBe('uncertain');
    expect(outboxStatus(env, prepared.id).queueId).toBeNull();
    applyPostfixLine(env, 'Nov 12 12:00:00 mail postfix/qmgr[22]: PreAcceptance: from=<bounce@example.com>, size=1000, nrcpt=1 (queue active)');
    expect(outboxStatus(env, prepared.id).state).toBe('queued');
  });

  it('keeps a positive delivery report when it races the submission callback', async () => {
    const { env } = await fixture();
    const prepared = await queued(env);
    await flushOutbox(env, { sendMail: async () => {
      applyPostfixLine(env, cleanupLine('RaceAccepted', prepared.messageId));
      applyPostfixLine(env, deliveryLine('RaceAccepted', 'person@outside.test', 'sent'));
      throw Object.assign(new Error('final response connection lost'), { command: 'DATA' });
    } });
    expect(outboxStatus(env, prepared.id).state).toBe('delivered');
    expect(outboxStatus(env, prepared.id).deliveries[0].state).toBe('sent');
  });

  it('accepts structured DSNs only for known delivery tokens and matching envelope recipients', async () => {
    const { env } = await fixture();
    const prepared = await queued(env);
    expect(policyAction(env, policy(`bounce+${prepared.id}@example.com`, ''))).toBe('DUNNO');
    expect(policyAction(env, policy('bounce+00000000-0000-0000-0000-000000000000@example.com', ''))).toMatch(/^550/);
    const report = Buffer.from('From: Mailer-Daemon <mailer@outside.test>\r\nContent-Type: multipart/report; report-type=delivery-status; boundary="report"\r\n\r\n--report\r\nContent-Type: message/delivery-status\r\n\r\nReporting-MTA: dns; mx.outside.test\r\n\r\nFinal-Recipient: rfc822; person@outside.test\r\nAction: failed\r\nStatus: 5.1.1\r\nDiagnostic-Code: smtp; 550 User unknown\r\n\r\n--report--\r\n');
    await receiveInbound(env, { raw: report, recipient: `bounce+${prepared.id}@example.com`, sender: '' });
    expect(outboxStatus(env, prepared.id).deliveries[0].state).toBe('bounced');
    expect(env.db.prepare('SELECT count(*) AS n FROM email').get().n).toBe(0);
  });

  it('persists log offsets and drains a renamed log before its replacement', async () => {
    const { env } = await fixture();
    const prepared = await queued(env);
    writeFileSync(env.server.mailLogPath, cleanupLine('Rotated123', prepared.messageId) + '\n');
    await pollPostfixLog(env);
    appendFileSync(env.server.mailLogPath, deliveryLine('Rotated123', 'person@outside.test', 'sent') + '\n');
    renameSync(env.server.mailLogPath, env.server.mailLogPath + '.1');
    writeFileSync(env.server.mailLogPath, 'unrelated log\n');
    await pollPostfixLog(env);
    expect(outboxStatus(env, prepared.id).state).toBe('delivered');
    const offset = env.db.prepare('SELECT offset FROM mail_log_cursor').get().offset;
    expect(offset).toBe(readFileSync(env.server.mailLogPath).length);
    await pollPostfixLog(env);
    expect(env.db.prepare('SELECT count(*) AS n FROM mail_event').get().n).toBe(1);
  });

  it('replays every retained rotation in chronological order after downtime', async () => {
    const { env } = await fixture(), file = env.server.mailLogPath;
    const prepared = await queued(env, ['one@outside.test', 'two@outside.test', 'three@outside.test']);
    writeFileSync(file, cleanupLine('MultipleRotations', prepared.messageId) + '\n');
    await pollPostfixLog(env);
    appendFileSync(file, deliveryLine('MultipleRotations', 'one@outside.test', 'sent') + '\n');
    renameSync(file, file + '.20261112-120000');
    writeFileSync(file, deliveryLine('MultipleRotations', 'two@outside.test', 'sent') + '\n');
    renameSync(file, file + '.20261112-130000');
    writeFileSync(file, deliveryLine('MultipleRotations', 'three@outside.test', 'sent') + '\n');
    utimesSync(file + '.20261112-120000', 100, 100);
    utimesSync(file + '.20261112-130000', 200, 200);
    await pollPostfixLog(env);
    expect(outboxStatus(env, prepared.id).state).toBe('delivered');
    expect(env.db.prepare('SELECT count(*) AS n FROM mail_event').get().n).toBe(3);
    await pollPostfixLog(env);
    expect(env.db.prepare('SELECT count(*) AS n FROM mail_event').get().n).toBe(3);
  });

  it('bounds each poll, resumes across block boundaries and advances past an archived partial tail', async () => {
    const { env } = await fixture(), file = env.server.mailLogPath;
    const prepared = await queued(env, ['one@outside.test', 'two@outside.test']);
    writeFileSync(file, cleanupLine('LargeRotations', prepared.messageId) + '\n');
    await pollPostfixLog(env);
    appendFileSync(file, 'unrelated log padding\n'.repeat(55000) + deliveryLine('LargeRotations', 'one@outside.test', 'sent'));
    renameSync(file, file + '.20261112-120000');
    writeFileSync(file, deliveryLine('LargeRotations', 'two@outside.test', 'sent'));
    await pollPostfixLog(env);
    expect(outboxStatus(env, prepared.id).deliveries.every(delivery => delivery.state === 'pending')).toBe(true);
    expect(env.db.prepare('SELECT offset FROM mail_log_cursor WHERE path=?').get(file).offset).toBeLessThan(1024 * 1024 + 200);
    await pollPostfixLog(env);
    expect(outboxStatus(env, prepared.id).deliveries.find(delivery => delivery.recipient === 'one@outside.test').state).toBe('sent');
    expect(outboxStatus(env, prepared.id).state).toBe('queued');
    // A live partial line is retained until completed, unlike the immutable archive tail.
    appendFileSync(file, '\n');
    await pollPostfixLog(env);
    expect(outboxStatus(env, prepared.id).state).toBe('delivered');
    expect(env.db.prepare('SELECT count(*) AS n FROM mail_event').get().n).toBe(2);
  });

  it('recovers retained archives after cursor retention and skips oversized lines without looping', async () => {
    const { env } = await fixture(), file = env.server.mailLogPath;
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const prepared = await queued(env);
    writeFileSync(file + '.20261112-120000', cleanupLine('RetentionRecovery', prepared.messageId) + '\n');
    writeFileSync(file + '.20261112-130000', 'x'.repeat(1024 * 1024 + 100) + '\n' + deliveryLine('RetentionRecovery', 'person@outside.test', 'sent') + '\n');
    utimesSync(file + '.20261112-120000', 100, 100);
    utimesSync(file + '.20261112-130000', 200, 200);
    writeFileSync(file, 'current log\n');
    env.db.prepare('INSERT INTO mail_log_cursor(path,inode,offset) VALUES (?,?,?)').run(file, 'deleted-inode', 1000);
    for (let attempt = 0; attempt < 4; attempt++) await pollPostfixLog(env);
    expect(outboxStatus(env, prepared.id).state).toBe('delivered');
    expect(warning.mock.calls.some(call => call[0].includes('removed by retention'))).toBe(true);
    expect(warning.mock.calls.some(call => call[0].includes('oversized'))).toBe(true);
    expect(env.db.prepare('SELECT count(*) AS n FROM mail_event').get().n).toBe(1);
  });
});
