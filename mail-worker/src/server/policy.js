import net from 'node:net';
import emailUtils from '../utils/email-utils.js';
import { knownDomains } from '../modules/domains/service.js';
import { isSuperAdmin } from '../modules/administrators/service.js';

export class MailError extends Error {
  constructor(message, responseCode = 451) {
    super(message);
    this.responseCode = responseCode;
  }
}

export function isTrustedMailPeer(env, address) {
  address = String(address || '').replace(/^::ffff:/i, '');
  if (address === '::1' || /^127\./.test(address)) return true;
  const subnet = env.server?.trustedMailSubnet || '172.30.89.0/24';
  const [network, bitsText] = subnet.split('/');
  const bits = Number(bitsText);
  const number = value => {
    const parts = value.split('.');
    if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
    return parts.reduce((result, part) => ((result << 8) | Number(part)) >>> 0, 0);
  };
  const peer = number(address), netAddress = number(network);
  if (peer === null || netAddress === null || !Number.isInteger(bits) || bits < 1 || bits > 32) return false;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return (peer & mask) === (netAddress & mask);
}

export function mailDomains(env) {
  return knownDomains(env);
}

export function isBounceRecipient(env, recipient) {
  const match = /^bounce\+([a-f0-9-]{36})@(.+)$/i.exec(recipient);
  if (!match || match[2].toLowerCase() !== (env.server?.bounceDomain || mailDomains(env)[0])) return false;
  return !!env.db.prepare('SELECT 1 FROM mail_outbox WHERE outbox_id = ?').get(match[1].toLowerCase());
}

// This is shared by Postfix's pre-queue RCPT policy and LMTP's final delivery.
export function resolveRecipient(env, recipient, sender = '') {
  recipient = String(recipient || '').trim().toLowerCase();
  sender = String(sender || '').trim().toLowerCase();
  if (!/^[^\s<>@]+@[^\s<>@]+$/.test(recipient) || !mailDomains(env).includes(emailUtils.getDomain(recipient))) {
    throw new MailError('5.7.1 Relaying denied', 550);
  }
  if (isBounceRecipient(env, recipient)) return { recipient, bounce: true };
  // Reserve this namespace so unsolicited messages cannot appear in catch-all mailboxes.
  if (recipient.startsWith('bounce+')) throw new MailError('5.1.1 Unknown bounce recipient', 550);
  const setting = env.db.prepare('SELECT * FROM setting LIMIT 1').get();
  if (!setting) throw new MailError('4.3.0 Mail database is not initialized');
  if (setting.receive === 1) throw new MailError('4.2.1 Receiving is temporarily suspended');
  let account = env.db.prepare('SELECT * FROM account WHERE email = ? COLLATE NOCASE').get(recipient);
  if (!account && recipient.includes('+')) {
    account = env.db.prepare('SELECT * FROM account WHERE email = ? COLLATE NOCASE').get(emailUtils.getBaseEmail(recipient));
  }
  if (!account) {
    if (setting.no_recipient !== 0) throw new MailError('5.1.1 Recipient not found', 550);
    return { recipient, account: null, setting };
  }
  const user = env.db.prepare('SELECT * FROM user WHERE user_id = ?').get(account.user_id);
  if (!user) throw new MailError('5.1.1 Recipient not found', 550);
  if (!isSuperAdmin(env, user)) {
    const role = env.db.prepare('SELECT * FROM role WHERE role_id = ?').get(user.type);
    if (!role) throw new MailError('4.3.0 Recipient role is unavailable');
    const allowed = splitList(role.avail_domain);
    if (allowed.length && !allowed.includes(emailUtils.getDomain(recipient))) {
      throw new MailError('5.7.1 Recipient is not authorized to use this domain', 550);
    }
    const blocked = splitList(role.ban_email);
    if (blocked.includes('*') || (sender && (blocked.includes(sender) || blocked.includes(emailUtils.getDomain(sender))))) {
      throw new MailError('5.7.1 Recipient does not accept this sender', 550);
    }
  }
  return { recipient, account, user, setting };
}

function splitList(value) {
  return String(value || '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
}

export function policyAction(env, attributes) {
  if (attributes.request !== 'smtpd_access_policy' || attributes.protocol_state !== 'RCPT') return 'DUNNO';
  try {
    resolveRecipient(env, attributes.recipient, attributes.sender);
    return 'DUNNO';
  } catch (error) {
    if (error instanceof MailError) return `${error.responseCode} ${error.message}`;
    console.error('SMTP recipient lookup failed:', error.message);
    return '451 4.3.0 Recipient lookup temporarily unavailable';
  }
}

export async function startPolicyServer(env) {
  const sockets = new Set();
  const server = net.createServer(socket => {
    if (!isTrustedMailPeer(env, socket.remoteAddress)) return socket.destroy();
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    let buffer = '';
    socket.setTimeout(15000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 65536) return socket.destroy();
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const request = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const attributes = {};
        for (const line of request.split('\n')) {
          const equals = line.indexOf('=');
          if (equals > 0) attributes[line.slice(0, equals)] = line.slice(equals + 1).replace(/\r$/, '');
        }
        socket.write(`action=${policyAction(env, attributes)}\n\n`);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(env.server?.policyPort ?? 10040, env.server?.policyHost || '0.0.0.0', resolve);
  });
  const close = server.close.bind(server);
  let shutdown;
  server.close = callback => {
    if (!shutdown) shutdown = new Promise((resolve, reject) => {
      close(error => error ? reject(error) : resolve());
      // Postfix keeps policy sockets alive between RCPT requests. No asynchronous
      // work runs in this protocol handler, so queued replies can be flushed and
      // the sockets closed immediately instead of waiting for their idle timeout.
      for (const socket of sockets) {
        socket.setTimeout(0);
        socket.end();
        socket.destroySoon();
      }
    });
    if (callback) shutdown.then(() => callback(), callback);
    return server;
  };
  return server;
}
