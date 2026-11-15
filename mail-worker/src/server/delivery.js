import { createHash, randomUUID } from 'node:crypto';
import { open, stat, readdir } from 'node:fs/promises';
import path from 'node:path';
import nodemailer from 'nodemailer';

const transports = new WeakMap();
const hash = value => createHash('sha256').update(value).digest('hex');

export function smtpTransport(env) {
  if (!transports.has(env)) {
    const config = env.smtp || {};
    transports.set(env, nodemailer.createTransport({
      host: config.host || 'mail', port: config.port ?? 587, secure: !!config.secure,
      auth: config.auth, requireTLS: !!config.requireTLS,
      ignoreTLS: !config.secure && !config.requireTLS,
      tls: { servername: env.server?.hostname, ...config.tls },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 60000,
      name: env.server?.hostname || 'localhost'
    }));
  }
  return transports.get(env);
}

export function attachmentBytes(attachment) {
  const value = attachment.content ?? attachment.buff;
  if (typeof value === 'string') return Buffer.from(value.replace(/^data:[^,]*,/, ''), 'base64');
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new Error('Missing attachment data');
}

export async function prepareOutbound(env, params) {
  const id = randomUUID();
  const domain = env.server?.bounceDomain || env.domain[0];
  const messageId = `<cm.${id}@${env.server?.hostname || domain}>`;
  const recipients = [...new Set((params.envelopeRecipients || [
    ...(params.receiveEmail || []), ...(params.ccEmail || []), ...(params.bccEmail || [])
  ]).map(address => String(address).toLowerCase()))];
  if (!recipients.length || recipients.some(address => /[\r\n<>\s]/.test(address) || !address.includes('@'))) {
    throw new Error('Invalid SMTP envelope recipients');
  }
  const envelopeFrom = `bounce+${id}@${domain}`;
  const attachments = (params.attachments || []).map(attachment => ({
    filename: attachment.filename || 'attachment', content: attachmentBytes(attachment),
    contentType: attachment.mimeType || attachment.contentType || attachment.type || 'application/octet-stream',
    cid: attachment.contentId?.replace(/^<|>$/g, ''),
    contentDisposition: attachment.contentId ? 'inline' : 'attachment'
  }));
  const result = await nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' }).sendMail({
    from: { address: params.accountEmail, name: params.name || '' },
    // Stream transport deliberately retains Bcc headers. Keep blind recipients
    // exclusively in the explicit SMTP envelope so raw MIME cannot disclose them.
    to: params.receiveEmail, cc: params.ccEmail,
    replyTo: params.replyTo,
    subject: params.subject || '', text: params.text || '', html: params.html || undefined,
    messageId, inReplyTo: params.sendType === 'reply' ? params.messageId : undefined,
    references: params.sendType === 'reply' ? params.messageId : undefined,
    headers: { 'X-Cloud-Mail-Delivery-ID': id, ...params.headers },
    envelope: { from: envelopeFrom, to: recipients }, attachments,
    disableFileAccess: true, disableUrlAccess: true
  });
  const raw = Buffer.from(result.message);
  if (raw.length > (env.smtp?.maxMessageBytes || 25 * 1024 * 1024)) throw new Error('Message exceeds the SMTP size limit');
  return { id, messageId, envelopeFrom, recipients, raw };
}

// Call inside the same transaction which saves the sent email and quota reservation.
export function insertOutbox(env, prepared, emailId = null) {
  const now = Date.now();
  env.db.prepare(`INSERT INTO mail_outbox
    (outbox_id,email_id,message_id,envelope_from,recipients,raw_mime,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(prepared.id, emailId, prepared.messageId, prepared.envelopeFrom,
      JSON.stringify(prepared.recipients), prepared.raw, now, now);
  const insert = env.db.prepare('INSERT INTO mail_delivery(outbox_id,recipient,updated_at) VALUES (?,?,?)');
  for (const recipient of prepared.recipients) insert.run(prepared.id, recipient, now);
  return prepared.id;
}

export async function enqueueOutbound(env, params, emailId = null) {
  const prepared = await prepareOutbound(env, params);
  env.db.transaction(() => insertOutbox(env, prepared, emailId))();
  return { data: { id: prepared.id }, messageId: prepared.messageId };
}

export function deliveriesForEmail(env, emailId) {
  return env.db.prepare(`SELECT d.recipient,d.state,d.detail,o.queue_id AS queueId,o.outbox_id AS deliveryId
    FROM mail_delivery d JOIN mail_outbox o USING(outbox_id) WHERE o.email_id = ?`).all(emailId);
}

export function outboxStatus(env, id) {
  const row = env.db.prepare(`SELECT outbox_id AS id,email_id AS emailId,message_id AS messageId,
    state,queue_id AS queueId,attempts,last_error AS lastError,created_at AS createdAt,updated_at AS updatedAt
    FROM mail_outbox WHERE outbox_id = ?`).get(id);
  if (!row) throw new Error('Delivery task not found');
  return { ...row, deliveries: env.db.prepare('SELECT recipient,state,detail FROM mail_delivery WHERE outbox_id = ?').all(id) };
}

// Operators inspect the MTA queue/logs before explicitly retrying an uncertain task.
export function retryUncertainOutbox(env, id) {
  const result = env.db.prepare(`UPDATE mail_outbox SET state='pending',next_attempt=0,last_error='',updated_at=?
    WHERE outbox_id=? AND state='uncertain' AND queue_id IS NULL AND raw_mime IS NOT NULL`).run(Date.now(), id);
  if (!result.changes) throw new Error('Only an uncertain task without a known Postfix queue ID can be retried');
  return outboxStatus(env, id);
}

function aggregateDelivery(env, outboxId) {
  const outbox = env.db.prepare('SELECT * FROM mail_outbox WHERE outbox_id = ?').get(outboxId);
  if (!outbox) return;
  const deliveries = env.db.prepare('SELECT recipient,state,detail FROM mail_delivery WHERE outbox_id = ?').all(outboxId);
  let state = 'queued', status = 1;
  if (deliveries.some(item => item.state === 'bounced' || item.state === 'failed')) {
    state = 'failed'; status = deliveries.some(item => item.state === 'bounced') ? 3 : 8;
  } else if (deliveries.every(item => item.state === 'sent')) {
    state = 'delivered'; status = 2;
  } else if (deliveries.some(item => item.state === 'deferred')) {
    state = 'deferred'; status = 5;
  }
  env.db.prepare('UPDATE mail_outbox SET state = ?,updated_at = ? WHERE outbox_id = ?').run(state, Date.now(), outboxId);
  if (outbox.email_id) env.db.prepare('UPDATE email SET status = ?,message = ? WHERE email_id = ?')
    .run(status, JSON.stringify({ message: state, deliveryStatus: state, recipients: deliveries }), outbox.email_id);
  // Once Postfix owns every recipient, its durable spool is the source of retries.
  if (['delivered', 'failed'].includes(state)) env.db.prepare('UPDATE mail_outbox SET raw_mime = NULL WHERE outbox_id = ?').run(outboxId);
}

export function updateDelivery(env, outboxId, recipient, state, detail = '') {
  recipient = recipient.toLowerCase();
  const current = env.db.prepare('SELECT state FROM mail_delivery WHERE outbox_id = ? AND recipient = ?').get(outboxId, recipient);
  if (!current) return false;
  if (current.state === 'bounced' && state !== 'bounced') return false;
  if (current.state === 'sent' && ['deferred', 'queued', 'pending'].includes(state)) return false;
  env.db.prepare('UPDATE mail_delivery SET state = ?,detail = ?,updated_at = ? WHERE outbox_id = ? AND recipient = ?')
    .run(state, String(detail).slice(0, 4000), Date.now(), outboxId, recipient);
  aggregateDelivery(env, outboxId);
  return true;
}

export function parsePostfixLine(line) {
  const prefix = /\/(cleanup|qmgr|smtp|lmtp|error)\[\d+\]:\s+([A-Za-z0-9]+):\s+/.exec(line);
  if (!prefix) return null;
  const [, service, queueId] = prefix;
  const content = line.slice(prefix.index + prefix[0].length);
  if (service === 'cleanup') {
    const message = /message-id=(<[^>]+>)/.exec(content);
    return message ? { type: 'queue', queueId, messageId: message[1] } : null;
  }
  if (service === 'qmgr') return /\(queue active\)/.test(content) ? { type: 'accepted', queueId } : null;
  // Only events mapped to an application outbox affect state. LMTP is necessary
  // for mixed messages which include one of our own mailbox domains.
  const result = /to=<([^>]+)>.*?status=(sent|deferred|bounced)\s*(.*)/.exec(content);
  return result ? { type: 'delivery', queueId, recipient: result[1].toLowerCase(), state: result[2], detail: result[3] } : null;
}

function reconcileQueue(env, queueId) {
  const queue = env.db.prepare('SELECT * FROM mail_queue WHERE queue_id = ?').get(queueId);
  if (!queue) return;
  const outbox = env.db.prepare('SELECT * FROM mail_outbox WHERE message_id = ?').get(queue.message_id);
  if (!outbox) return;
  env.db.prepare('UPDATE mail_queue SET outbox_id = ? WHERE queue_id = ?').run(outbox.outbox_id, queueId);
  // cleanup logs the ID while SMTP DATA is still in progress. Only a qmgr
  // ownership record, an actual delivery attempt or final SMTP 250 proves that
  // Postfix accepted responsibility for delivery.
  if (!queue.accepted) return;
  env.db.prepare(`UPDATE mail_outbox SET queue_id = ?,state = CASE
    WHEN state IN ('pending','submitting','uncertain') THEN 'queued' ELSE state END,updated_at = ?
    WHERE outbox_id = ?`).run(queueId, Date.now(), outbox.outbox_id);
  env.db.prepare("UPDATE mail_delivery SET state = 'queued' WHERE outbox_id = ? AND state = 'pending'")
    .run(outbox.outbox_id);
  const events = env.db.prepare('SELECT * FROM mail_event WHERE queue_id = ? AND processed = 0 ORDER BY created_at,rowid').all(queueId);
  for (const event of events) {
    updateDelivery(env, outbox.outbox_id, event.recipient, event.state, event.detail);
    env.db.prepare('UPDATE mail_event SET processed = 1 WHERE event_key = ?').run(event.event_key);
  }
}

export function applyPostfixLine(env, line) {
  const event = parsePostfixLine(line);
  if (!event) return false;
  env.db.transaction(() => {
    if (event.type === 'queue') {
      env.db.prepare(`INSERT INTO mail_queue(queue_id,message_id) VALUES (?,?)
        ON CONFLICT(queue_id) DO UPDATE SET message_id=excluded.message_id`).run(event.queueId, event.messageId);
    } else if (event.type === 'accepted') {
      env.db.prepare(`INSERT INTO mail_queue(queue_id,message_id,accepted) VALUES (?,'',1)
        ON CONFLICT(queue_id) DO UPDATE SET accepted=1`).run(event.queueId);
    } else {
      env.db.prepare(`INSERT OR IGNORE INTO mail_event(event_key,queue_id,recipient,state,detail,created_at)
        VALUES (?,?,?,?,?,?)`).run(hash(line), event.queueId, event.recipient, event.state, event.detail, Date.now());
      env.db.prepare(`INSERT INTO mail_queue(queue_id,message_id,accepted) VALUES (?,'',1)
        ON CONFLICT(queue_id) DO UPDATE SET accepted=1`).run(event.queueId);
    }
    reconcileQueue(env, event.queueId);
  })();
  return true;
}

export function applyDeliveryReport(env, outboxId, raw) {
  // Only structured RFC 3464 per-recipient reports change delivery state.
  if (!/content-type:\s*(?:message\/delivery-status|multipart\/report)/i.test(raw)) return 0;
  const unfolded = raw.replace(/\r?\n[\t ]+/g, ' ');
  const blocks = unfolded.split(/\r?\n\r?\n/);
  let changed = 0;
  for (const block of blocks) {
    const recipient = /(?:^|\n)Final-Recipient:\s*rfc822;\s*([^\r\n ]+)/i.exec(block)?.[1];
    const action = /(?:^|\n)Action:\s*(failed|delayed|delivered|relayed|expanded)/i.exec(block)?.[1]?.toLowerCase();
    if (!recipient || !action) continue;
    const state = action === 'failed' ? 'bounced' : action === 'delayed' ? 'deferred' : 'sent';
    const detail = /(?:^|\n)Diagnostic-Code:\s*([^\r\n]+)/i.exec(block)?.[1] || action;
    if (updateDelivery(env, outboxId, recipient, state, detail)) changed++;
  }
  return changed;
}

export async function flushOutbox(env, transport = smtpTransport(env)) {
  const rows = env.db.prepare("SELECT * FROM mail_outbox WHERE state = 'pending' AND next_attempt <= ? ORDER BY created_at LIMIT 20").all(Date.now());
  for (const row of rows) {
    const claimed = env.db.prepare("UPDATE mail_outbox SET state = 'submitting',attempts = attempts + 1,updated_at = ? WHERE outbox_id = ? AND state = 'pending'")
      .run(Date.now(), row.outbox_id);
    if (!claimed.changes) continue;
    try {
      const result = await transport.sendMail({ envelope: { from: row.envelope_from, to: JSON.parse(row.recipients) }, raw: row.raw_mime });
      const queueId = /queued as\s+([A-Za-z0-9]+)/i.exec(result.response || '')?.[1];
      env.db.transaction(() => {
        env.db.prepare(`UPDATE mail_outbox SET state = CASE WHEN state IN ('submitting','uncertain','pending') THEN ? ELSE state END,
          queue_id = COALESCE(?,queue_id),last_error = '',updated_at = ? WHERE outbox_id = ?`)
          .run(queueId ? 'queued' : 'uncertain', queueId || null, Date.now(), row.outbox_id);
        env.db.prepare("UPDATE mail_delivery SET state = 'queued',updated_at = ? WHERE outbox_id = ? AND state = 'pending'").run(Date.now(), row.outbox_id);
        if (queueId) {
          env.db.prepare('INSERT OR REPLACE INTO mail_queue(queue_id,message_id,outbox_id,accepted) VALUES (?,?,?,1)').run(queueId, row.message_id, row.outbox_id);
          reconcileQueue(env, queueId);
        }
        for (const rejected of result.rejected || []) updateDelivery(env, row.outbox_id, String(rejected), 'failed', 'Recipient refused by submission server');
      })();
    } catch (error) {
      // A disconnect during/after DATA is ambiguous. Preserve it for log reconciliation;
      // never blindly resubmit a possibly accepted message after a process crash.
      const definite = !!error.responseCode || ['CONN', 'EHLO', 'HELO', 'MAIL FROM', 'RCPT TO', 'STARTTLS', 'AUTH'].includes(error.command);
      const permanent = definite && error.responseCode >= 500;
      const state = permanent ? 'failed' : definite ? 'pending' : 'uncertain';
      const delay = Math.min(3600000, 30000 * 2 ** Math.min(row.attempts, 7));
      env.db.transaction(() => {
        const reported = env.db.prepare('SELECT queue_id,state FROM mail_outbox WHERE outbox_id=?').get(row.outbox_id);
        if (reported.queue_id || ['delivered', 'failed', 'deferred'].includes(reported.state)) return;
        env.db.prepare('UPDATE mail_outbox SET state = ?,next_attempt = ?,last_error = ?,updated_at = ? WHERE outbox_id = ?')
          .run(state, Date.now() + delay, error.message.slice(0, 4000), Date.now(), row.outbox_id);
        if (permanent) for (const recipient of JSON.parse(row.recipients)) updateDelivery(env, row.outbox_id, recipient, 'failed', error.message);
        if (row.email_id && !permanent) env.db.prepare('UPDATE email SET status = 5,message = ? WHERE email_id = ?')
          .run(JSON.stringify({ message: state === 'uncertain' ? 'Submission outcome unknown; waiting for Postfix logs. Do not resend automatically.' : error.message,
            deliveryStatus: state }), row.email_id);
      })();
    }
  }
}

const LOG_READ_LIMIT = 1024 * 1024;

async function readLogFile(env, entry, cursorPath, maximum) {
  const handle = await open(entry.path, 'r');
  try {
    const info = await handle.stat();
    const inode = String(info.ino);
    // A rotation raced the directory snapshot. Retry with a fresh snapshot next poll.
    if (inode !== entry.inode) return { read: 0, finished: false };
    const stored = env.db.prepare('SELECT * FROM mail_log_cursor WHERE path = ?').get(cursorPath);
    let offset = stored?.inode === inode ? stored.offset : 0;
    if (offset > info.size) offset = 0;
    const skipPath = cursorPath + '\0oversized-line';
    const skipping = env.db.prepare('SELECT inode FROM mail_log_cursor WHERE path = ?').get(skipPath)?.inode === inode;
    const count = Math.min(info.size - offset, maximum);
    const saveCursor = (position, skip) => {
      env.db.prepare(`INSERT INTO mail_log_cursor(path,inode,offset) VALUES (?,?,?)
        ON CONFLICT(path) DO UPDATE SET inode=excluded.inode,offset=excluded.offset`).run(cursorPath, inode, position);
      if (skip) env.db.prepare(`INSERT INTO mail_log_cursor(path,inode,offset) VALUES (?,?,0)
        ON CONFLICT(path) DO UPDATE SET inode=excluded.inode`).run(skipPath, inode);
      else env.db.prepare('DELETE FROM mail_log_cursor WHERE path = ?').run(skipPath);
    };
    if (!count) {
      saveCursor(offset, false);
      return { read: 0, finished: true };
    }
    const buffer = Buffer.alloc(count);
    const { bytesRead } = await handle.read(buffer, 0, count, offset);
    const bytes = buffer.subarray(0, bytesRead);
    const start = skipping ? bytes.indexOf(10) + 1 : 0;
    const atEnd = offset + bytesRead >= info.size;
    let complete = bytes.lastIndexOf(10) + 1;
    if (entry.archived && atEnd) complete = bytesRead; // An immutable tail cannot gain a newline.
    if ((skipping && !start) || !complete) {
      // Keep short partial lines in the live file. Oversized lines are consumed
      // in bounded chunks, remembering to discard their remainder after restart.
      if (skipping || bytesRead >= LOG_READ_LIMIT || (entry.archived && atEnd)) {
        if (!skipping) console.warn('Postfix log reader skipped an oversized or incomplete log line:', entry.path);
        saveCursor(offset + bytesRead, !atEnd || !entry.archived);
        return { read: bytesRead, finished: entry.archived && atEnd };
      }
      return { read: bytesRead, finished: false };
    }
    const lines = bytes.subarray(start, complete).toString('utf8').split('\n');
    env.db.transaction(() => {
      for (const line of lines) if (line) applyPostfixLine(env, line);
      saveCursor(offset + complete, false);
    })();
    return { read: bytesRead, finished: offset + complete >= info.size };
  } finally { await handle.close(); }
}

export async function pollPostfixLog(env) {
  const file = env.server?.mailLogPath;
  if (!file) return;
  try {
    const names = await readdir(path.dirname(file));
    const archives = [];
    let current;
    for (const name of names.filter(name => name === path.basename(file) ||
      (name.startsWith(path.basename(file) + '.') && !/\.(?:gz|bz2|xz|zst|zip)$/i.test(name)))) {
      const candidate = path.join(path.dirname(file), name);
      let info;
      try { info = await stat(candidate); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (!info.isFile()) continue;
      const entry = { path: candidate, inode: String(info.ino), time: info.mtimeMs, archived: candidate !== file };
      if (entry.archived) archives.push(entry); else current = entry;
    }
    archives.sort((left, right) => left.time - right.time || left.path.localeCompare(right.path));
    const entries = current ? [...archives, current] : archives;
    if (!entries.length) return;
    const cursor = env.db.prepare('SELECT * FROM mail_log_cursor WHERE path = ?').get(file);
    let start = cursor ? entries.findIndex(entry => entry.inode === cursor.inode) : 0;
    if (start < 0) {
      console.warn('Postfix log cursor file was removed by retention; replaying all retained logs. Missing delivery reports remain unknown; messages will not be resubmitted.');
      start = 0;
    }
    let remaining = LOG_READ_LIMIT;
    for (const entry of entries.slice(start)) {
      if (remaining <= 0) break;
      const result = await readLogFile(env, entry, file, remaining);
      remaining -= result.read;
      if (!result.finished) break;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
