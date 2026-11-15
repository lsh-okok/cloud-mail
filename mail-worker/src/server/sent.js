import { attachmentBytes, prepareOutbound, insertOutbox, deliveriesForEmail } from './delivery.js';
import { persistAttachments, replaceCidImages, isBlocked } from './inbound.js';
import { insertRow, camelRow } from './mail-schema.js';
import kvConst from '../const/kv-const.js';
import { resolveRecipient, MailError } from './policy.js';

// Build MIME and persist immutable objects first, then reserve quota, save the
// visible email and insert its delivery task in one synchronous SQLite commit.
async function prepareSent(env, sendParams, saveParams) {
  const normalized = { ...sendParams, attachments: (sendParams.attachments || []).map(item => ({
    ...item, content: attachmentBytes(item)
  })) };
  const prepared = await prepareOutbound(env, normalized);
  const attachments = await persistAttachments(env, normalized.attachments);
  const content = replaceCidImages(saveParams.html, attachments);
  return { prepared, attachments, content };
}

function reserveSender(env, saveParams, recipientCount, internal = false) {
    const user = env.db.prepare('SELECT * FROM user WHERE user_id = ?').get(saveParams.userId);
    const role = user && env.db.prepare('SELECT * FROM role WHERE role_id = ?').get(user.type);
    const account = env.db.prepare('SELECT * FROM account WHERE account_id = ? AND user_id = ? AND is_del = 0')
      .get(saveParams.accountId, saveParams.userId);
    if (!user || user.is_del || user.status || !account || !role) throw new Error('Sender account is unavailable');
    const admin = user.email.toLowerCase() === String(env.admin).toLowerCase();
    if (!admin && (role.send_type === 'ban' || (!internal && role.send_type === 'internal'))) throw new Error('Sending is not permitted');
    const allowedDomains = String(role.avail_domain || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
    if (!admin && allowedDomains.length && !allowedDomains.includes(account.email.split('@')[1].toLowerCase())) throw new Error('Sender is not authorized to use this domain');
    if (env.db.prepare('SELECT send FROM setting LIMIT 1').get().send !== 0) throw new Error('Sending is temporarily suspended');
    if (!admin && role.send_count && Number(user.send_count) + recipientCount > role.send_count) throw new Error('Sending quota exceeded');
    if (role.send_count && role.send_type !== 'internal') {
      env.db.prepare('UPDATE user SET send_count = CAST(send_count AS INTEGER) + ? WHERE user_id = ?').run(recipientCount, user.user_id);
    }
    return { user, account };
}

function sentValues(sendParams, saveParams, prepared, content, user, account) {
  return {
      sendEmail: account.email, name: saveParams.name, subject: saveParams.subject || '',
      text: saveParams.text || '', content, accountId: account.account_id, userId: user.user_id,
      status: 1, type: 1, messageId: prepared.messageId,
      recipient: JSON.stringify(sendParams.receiveEmail.map(address => ({ address, name: '' }))),
      cc: JSON.stringify((sendParams.ccEmail || []).map(address => ({ address, name: '' }))),
      bcc: JSON.stringify((sendParams.bccEmail || []).map(address => ({ address, name: '' }))),
      inReplyTo: sendParams.sendType === 'reply' ? sendParams.messageId : '',
      relation: sendParams.sendType === 'reply' ? sendParams.messageId : '',
      message: ''
  };
}

async function countSent(env, count) {
  try {
    const key = kvConst.SEND_DAY_COUNT + new Date().toISOString().slice(0, 10);
    if (env.kv.increment) await env.kv.increment(key, count, { expirationTtl: 86400 });
  } catch (error) { console.error('Mail statistics update failed:', error.message); }
}

function sentResult(env, id) {
  const result = camelRow(env.db.prepare('SELECT * FROM email WHERE email_id = ?').get(id));
  result.attList = env.db.prepare('SELECT * FROM attachments WHERE email_id = ?').all(id).map(camelRow);
  return result;
}

export async function saveSmtpMessage(env, sendParams, saveParams) {
  const { prepared, attachments, content } = await prepareSent(env, sendParams, saveParams);
  const emailId = env.db.transaction(() => {
    const { user, account } = reserveSender(env, saveParams, prepared.recipients.length);
    const id = insertRow(env.db, 'email', {
      ...sentValues(sendParams, saveParams, prepared, content, user, account),
      resendEmailId: prepared.id,
      message: JSON.stringify({ message: 'Queued for SMTP submission', deliveryStatus: 'pending' })
    });
    for (const attachment of attachments) insertRow(env.db, 'attachments', {
      ...attachment, emailId: id, userId: user.user_id, accountId: account.account_id
    });
    insertOutbox(env, prepared, id);
    return id;
  })();
  // Analytics must not turn an already committed delivery into an API failure.
  await countSent(env, prepared.recipients.length);
  const result = sentResult(env, emailId);
  result.deliveries = deliveriesForEmail(env, emailId);
  result.deliveryStatus = 'pending';
  return result;
}

export async function saveLocalMessage(env, sendParams, saveParams) {
  const { prepared, attachments, content } = await prepareSent(env, sendParams, saveParams);
  const committed = env.db.transaction(() => {
    const { user, account } = reserveSender(env, saveParams, prepared.recipients.length, true);
    const values = sentValues(sendParams, saveParams, prepared, content, user, account);
    values.status = 2;
    const emailId = insertRow(env.db, 'email', values), inboxRows = [];
    for (const attachment of attachments) insertRow(env.db, 'attachments', {
      ...attachment, emailId, userId: user.user_id, accountId: account.account_id
    });
    const outcomes = [];
    for (const recipient of prepared.recipients) {
      let target;
      try { target = resolveRecipient(env, recipient, account.email); }
      catch (error) {
        if (!(error instanceof MailError)) throw error;
        outcomes.push({ recipient, state: 'bounced', detail: error.message });
        continue;
      }
      if (target.bounce || isBlocked(camelRow(target.setting), { from: { address: account.email },
        subject: values.subject, text: values.text, html: sendParams.html })) {
        outcomes.push({ recipient, state: 'sent', detail: 'Accepted by receiving policy' });
        continue;
      }
      const receiving = { ...values, type: 0, status: target.account ? 0 : 7, bcc: '[]',
        userId: target.account?.user_id || 0, accountId: target.account?.account_id || 0,
        toEmail: recipient, toName: recipient.split('@')[0] };
      const inboxId = insertRow(env.db, 'email', receiving);
      for (const attachment of attachments) insertRow(env.db, 'attachments', {
        ...attachment, emailId: inboxId, userId: receiving.userId, accountId: receiving.accountId
      });
      if (target.account) env.db.prepare('UPDATE account SET latest_email_time = CURRENT_TIMESTAMP WHERE account_id = ?').run(target.account.account_id);
      if (target.setting.rule_type !== 1 || String(target.setting.rule_email || '').split(',').map(value => value.trim().toLowerCase()).includes(recipient)) {
        env.db.prepare('INSERT INTO mail_notification(email_id) VALUES (?)').run(inboxId);
      }
      inboxRows.push({ ...receiving, emailId: inboxId });
      outcomes.push({ recipient, state: 'sent', detail: 'Delivered to local mailbox' });
    }
    env.db.prepare('UPDATE email SET status=?,message=? WHERE email_id=?').run(
      outcomes.some(outcome => outcome.state === 'bounced') ? 3 : 2,
      JSON.stringify({ message: 'Local delivery', recipients: outcomes }), emailId);
    return { emailId, inboxRows, outcomes };
  })();
  await countSent(env, prepared.recipients.length);
  const result = sentResult(env, committed.emailId);
  result.deliveries = committed.outcomes;
  result.deliveryStatus = result.status === 2 ? 'delivered' : 'failed';
  return { result, inboxRows: committed.inboxRows };
}
