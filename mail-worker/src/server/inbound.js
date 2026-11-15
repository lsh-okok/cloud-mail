import { createHash } from 'node:crypto';
import PostalMimeModule from 'postal-mime';
import { parseHTML } from 'linkedom';
import telegramService from '../service/telegram-service.js';
import webhookService from '../service/webhook-service.js';
import aiService from '../service/ai-service.js';
import { camelRow, insertRow } from './mail-schema.js';
import { resolveRecipient, MailError } from './policy.js';
import { applyDeliveryReport, prepareOutbound, insertOutbox } from './delivery.js';

// Node 24's require(ESM), as used by the production CJS bundle, returns the
// module namespace. Native ESM imports return the class directly.
const PostalMime = PostalMimeModule.default || PostalMimeModule;

const digest = data => createHash('sha256').update(data).digest('hex');
function blockList(value) { return String(value || '').split(',').map(value => value.trim()).filter(Boolean); }

export function isBlocked(setting, parsed) {
  const from = (parsed.from?.address || '').toLowerCase(), domain = from.split('@')[1];
  return blockList(setting.blackSubject).some(value => parsed.subject?.includes(value)) ||
    blockList(setting.blackContent).some(value => parsed.text?.includes(value) || parsed.html?.includes(value)) ||
    blockList(setting.blackFrom).some(value => [from, domain].includes(value.toLowerCase()));
}

export function replaceCidImages(content, attachments) {
  if (!content) return '';
  const { document } = parseHTML(content);
  for (const image of document.querySelectorAll('img')) {
    const source = image.getAttribute('src');
    if (!source?.startsWith('cid:')) continue;
    const attachment = attachments.find(item => item.contentId?.replace(/^<|>$/g, '') === source.slice(4));
    if (attachment) { image.setAttribute('src', '{{domain}}' + attachment.key); attachment.type = 1; }
  }
  return document.toString();
}

export async function persistAttachments(env, attachments) {
  const metadata = [];
  for (const source of attachments || []) {
    const content = Buffer.from(source.content);
    const ext = /\.[a-zA-Z0-9]{1,12}$/.exec(source.filename || '')?.[0] || '';
    const key = 'attachments/' + digest(content).slice(0, 32) + ext;
    const filename = String(source.filename || 'attachment').replace(/[\r\n\0]/g, '');
    const mimeType = source.mimeType || source.contentType || 'application/octet-stream';
    await env.storage.put(key, content, {
      contentType: mimeType,
      contentDisposition: `${source.contentId ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(filename)}`
    });
    metadata.push({ key, filename, mimeType, size: content.byteLength,
      contentId: source.contentId || null, disposition: source.disposition || null,
      encoding: source.encoding || null, type: source.contentId ? 1 : 0 });
  }
  return metadata;
}

function saveDisposition(env, key, recipient, disposition) {
  env.db.prepare(`INSERT OR IGNORE INTO mail_ingress(ingress_key,recipient,disposition,created_at)
    VALUES (?,?,?,?)`).run(key, recipient, disposition, Date.now());
  return { disposition };
}
function forwardingApplies(setting, recipient) {
  return setting.ruleType !== 1 || blockList(setting.ruleEmail).map(item => item.toLowerCase()).includes(recipient);
}

// Storage failures propagate to LMTP; notifications run outside its ACK path.
export async function receiveInbound(env, { raw, recipient, sender = '' }) {
  raw = Buffer.from(raw); recipient = recipient.trim().toLowerCase();
  if (raw.length > (env.smtp?.maxMessageBytes || 25 * 1024 * 1024)) throw new MailError('5.3.4 Message too large', 552);
  const key = digest(Buffer.concat([raw, Buffer.from('\0' + recipient)]));
  const prior = env.db.prepare('SELECT * FROM mail_ingress WHERE ingress_key = ?').get(key);
  if (prior) return { disposition: prior.disposition, emailId: prior.email_id, duplicate: true };
  let target;
  try { target = resolveRecipient(env, recipient, sender); }
  catch (error) {
    // If a recipient was revoked after public RCPT acceptance, avoid backscatter.
    if (error instanceof MailError && error.responseCode >= 500) return saveDisposition(env, key, recipient, 'recipient-revoked');
    throw error;
  }
  if (target.bounce) {
    const id = /^bounce\+([^@]+)/i.exec(recipient)[1];
    env.db.transaction(() => {
      if (!sender) applyDeliveryReport(env, id, raw.toString('utf8'));
      saveDisposition(env, key, recipient, 'delivery-report');
    })();
    return { disposition: 'delivery-report' };
  }
  const parsed = await PostalMime.parse(raw), setting = camelRow(target.setting);
  if (isBlocked(setting, parsed)) return saveDisposition(env, key, recipient, 'blacklist');
  try { resolveRecipient(env, recipient, parsed.from?.address || sender); }
  catch (error) {
    if (error instanceof MailError && error.responseCode >= 500) return saveDisposition(env, key, recipient, 'sender-blocked');
    throw error;
  }
  const attachments = await persistAttachments(env, parsed.attachments || []);
  const content = replaceCidImages(parsed.html, attachments);
  const code = env.ai ? await aiService.extractCode({ env }, parsed, { aiCode: setting.aiCode, aiCodeFilter: setting.aiCodeFilter }) : '';
  const headerRecipients = parsed.to?.length ? parsed.to : [{ address: recipient, name: '' }];
  const row = {
    sendEmail: parsed.from?.address || sender, name: parsed.from?.name || parsed.from?.address || sender,
    senderEmail: sender, toEmail: recipient,
    toName: [...headerRecipients, ...(parsed.cc || [])].find(item => item.address?.toLowerCase() === recipient)?.name || '',
    accountId: target.account?.account_id || 0, userId: target.account?.user_id || 0,
    subject: parsed.subject || '', text: parsed.text || '', content, code,
    recipient: JSON.stringify(headerRecipients), cc: JSON.stringify(parsed.cc || []), bcc: '[]',
    messageId: parsed.messageId || '', inReplyTo: parsed.inReplyTo || '',
    relation: Array.isArray(parsed.references) ? parsed.references.join(' ') : parsed.references || '',
    type: 0, status: target.account ? 0 : 7, isDel: 0
  };
  let forward;
  if (setting.forwardStatus === 0 && setting.forwardEmail && forwardingApplies(setting, recipient) &&
      !/^X-Cloud-Mail-Forwarded:/mi.test(raw.toString('latin1').split(/\r?\n\r?\n/, 1)[0])) {
    const recipients = blockList(setting.forwardEmail);
    if (recipients.length) forward = await prepareOutbound(env, {
      // Use our own authenticated From domain; preserve the original in Reply-To.
      accountEmail: `forwarder@${env.server?.bounceDomain || env.domain[0]}`,
      name: parsed.from?.name || parsed.from?.address || 'Cloud Mail', replyTo: parsed.from?.address,
      receiveEmail: [recipient], envelopeRecipients: recipients,
      subject: parsed.subject, text: parsed.text, html: parsed.html, attachments: parsed.attachments,
      headers: { 'X-Cloud-Mail-Forwarded': env.server?.hostname || 'Cloud Mail' }
    }).catch(error => {
      // A broken forwarding destination must not cause incoming mail to be retried.
      console.error('Preparing forwarded message failed:', error.message);
      return null;
    });
  }
  return env.db.transaction(() => {
    const existing = env.db.prepare('SELECT * FROM mail_ingress WHERE ingress_key = ?').get(key);
    if (existing) return { disposition: existing.disposition, emailId: existing.email_id, duplicate: true };
    const emailId = insertRow(env.db, 'email', row);
    for (const attachment of attachments) insertRow(env.db, 'attachments', {
      ...attachment, emailId, userId: row.userId, accountId: row.accountId
    });
    if (target.account) env.db.prepare('UPDATE account SET latest_email_time = CURRENT_TIMESTAMP WHERE account_id = ?').run(target.account.account_id);
    env.db.prepare(`INSERT INTO mail_ingress(ingress_key,recipient,email_id,disposition,created_at)
      VALUES (?,?,?,'stored',?)`).run(key, recipient, emailId, Date.now());
    if (forward) insertOutbox(env, forward);
    if (forwardingApplies(setting, recipient)) env.db.prepare('INSERT INTO mail_notification(email_id) VALUES (?)').run(emailId);
    return { disposition: 'stored', emailId };
  })();
}

export async function flushNotifications(env) {
  const notifications = env.db.prepare("SELECT * FROM mail_notification WHERE state = 'pending' AND next_attempt <= ? LIMIT 10").all(Date.now());
  const setting = camelRow(env.db.prepare('SELECT * FROM setting LIMIT 1').get());
  for (const job of notifications) {
    const email = camelRow(env.db.prepare('SELECT * FROM email WHERE email_id = ?').get(job.email_id));
    if (!email) { env.db.prepare('DELETE FROM mail_notification WHERE email_id = ?').run(job.email_id); continue; }
    try {
      if (setting.tgBotStatus === 0 && setting.tgChatId) await notificationDeadline(() => telegramService.sendEmailToBot({ env }, email));
      if (setting.webhookStatus === 0 && setting.webhookUrl) await notificationDeadline(() => webhookService.sendEmail({ env }, email, setting.webhookUrl, setting.webhookRetry, setting.webhookSecret));
      env.db.prepare("UPDATE mail_notification SET state = 'done' WHERE email_id = ?").run(job.email_id);
    } catch (error) {
      env.db.prepare('UPDATE mail_notification SET attempts = attempts+1,next_attempt = ?,last_error = ? WHERE email_id = ?')
        .run(Date.now() + 300000, error.message.slice(0, 4000), job.email_id);
    }
  }
}

async function notificationDeadline(action) {
  let timer;
  try {
    await Promise.race([action(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Notification request timed out')), 15000);
      timer.unref?.();
    })]);
  } finally { clearTimeout(timer); }
}
