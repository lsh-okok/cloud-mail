const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const origin = 'http://127.0.0.1:3000';
const attachmentBody = 'Cloud Mail attachment fixture.\n';
const sinkDirectory = '/tmp/cloud-mail-smoke-sink';
const outgoingFile = '/tmp/cloud-mail-smoke-outgoing.json';

function database() {
  const Database = require('/app/mail-worker/node_modules/better-sqlite3');
  return new Database(process.env.SQLITE_PATH, { readonly: true, fileMustExist: true });
}

async function api(route, { token, data, method = data === undefined ? 'GET' : 'POST' } = {}) {
  const response = await fetch(origin + '/api' + route, {
    method, headers: { 'Content-Type': 'application/json', 'Accept-Language': 'en', ...(token ? { Authorization: token } : {}) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  assert.equal(response.status, 200, `HTTP API failure for ${route}`);
  const result = await response.json();
  assert.equal(result.code, 200, `API ${route}: ${result.message}`);
  return result.data;
}

async function login() {
  return (await api('/login', { data: { email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD } })).token;
}

async function startSink() {
  const { SMTPServer } = require('/app/mail-worker/node_modules/smtp-server');
  fs.mkdirSync(sinkDirectory, { recursive: true });
  const server = new SMTPServer({
    authOptional: true, disabledCommands: ['AUTH', 'STARTTLS'], logger: false, size: 1024 * 1024,
    onRcptTo(recipient, session, callback) {
      const address = recipient.address.toLowerCase();
      let code;
      if (!address.endsWith('@outside.example') || address.startsWith('reject@')) code = 550;
      else if (address.startsWith('defer@') && !fs.existsSync(path.join(sinkDirectory, 'release'))) code = 450;
      if (code) {
        const error = new Error(code === 450 ? '4.2.0 Synthetic temporary refusal' : '5.1.1 Synthetic permanent refusal');
        error.responseCode = code;
        callback(error);
      } else callback();
    },
    onData(stream, session, callback) {
      const chunks = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.once('error', callback);
      stream.once('end', () => {
        const record = { recipients: session.envelope.rcptTo.map(item => item.address.toLowerCase()), raw: Buffer.concat(chunks).toString('utf8') };
        fs.appendFileSync(path.join(sinkDirectory, 'messages.jsonl'), JSON.stringify(record) + '\n');
        callback(null, '2.0.0 Synthetic sink stored message');
      });
    },
  });
  server.on('error', error => {
    fs.writeFileSync(path.join(sinkDirectory, 'error'), error.message);
    process.exitCode = 1;
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(2526, '0.0.0.0', resolve); });
}

async function submitThroughApi(subject) {
  const token = await login();
  const current = await api('/my/loginUserInfo', { token });
  await api('/setting/set', { token, method: 'PUT', data: { send: 0 } });
  const result = await api('/email/send', { token, data: {
    accountId: current.account.accountId, name: 'Docker integration probe', sendType: 'send', manyType: 'together',
    receiveEmail: ['accept@outside.example', 'defer@outside.example', 'reject@outside.example'],
    bccEmail: ['blind@outside.example'], ccEmail: [], subject,
    text: 'Docker API outbound integration probe.', content: '<p>Docker API outbound integration probe.</p>',
  } });
  assert.equal(result.length, 1, 'API must return one persisted sent message');
  const db = database();
  try {
    const task = db.prepare('SELECT * FROM mail_outbox WHERE email_id = ?').get(result[0].emailId);
    assert.ok(task?.raw_mime?.length, 'API did not atomically persist raw MIME in its outbox');
    assert.equal(JSON.parse(task.recipients).length, 4);
    const headers = task.raw_mime.toString().split(/\r?\n\r?\n/, 1)[0];
    assert.doesNotMatch(headers, /^Bcc:/mi);
    const identity = { subject, emailId: result[0].emailId, accountId: current.account.accountId, deliveryId: task.outbox_id };
    fs.writeFileSync(outgoingFile, JSON.stringify(identity), { mode: 0o600 });
    console.info('Application API committed sent message, recipients and raw MIME to its durable outbox');
  } finally { db.close(); }
}

async function verifyOutgoing(final) {
  const identity = JSON.parse(fs.readFileSync(outgoingFile));
  const expected = {
    'accept@outside.example': 'sent', 'blind@outside.example': 'sent',
    'defer@outside.example': final ? 'sent' : 'deferred', 'reject@outside.example': 'bounced',
  };
  const db = database();
  try {
    const task = db.prepare('SELECT * FROM mail_outbox WHERE outbox_id = ?').get(identity.deliveryId);
    assert.ok(task.queue_id && task.attempts >= 1, 'Postfix queue ownership was not persisted');
    const deliveries = db.prepare('SELECT recipient,state,detail FROM mail_delivery WHERE outbox_id = ?').all(identity.deliveryId);
    assert.equal(deliveries.length, 4);
    for (const item of deliveries) assert.equal(item.state, expected[item.recipient], `SQLite state for ${item.recipient}: ${item.detail}`);
  } finally { db.close(); }
  const token = await login();
  const query = new URLSearchParams({ accountId: identity.accountId, type: 1, size: 50, text: identity.subject, searchType: 'subject', full: 1 });
  const list = await api('/email/list?' + query, { token });
  const row = list.list.find(item => item.emailId === identity.emailId);
  assert.ok(row, 'Sent message is missing from the authenticated API');
  assert.equal(row.deliveries.length, 4);
  for (const item of row.deliveries) assert.equal(item.state, expected[item.recipient], `API state for ${item.recipient}`);
  const records = fs.readFileSync(path.join(sinkDirectory, 'messages.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    .filter(item => item.raw.includes(identity.deliveryId));
  assert.ok(records.length, 'Private SMTP sink has not received the application message');
  const delivered = [];
  for (const record of records) {
    const headers = record.raw.split(/\r?\n\r?\n/, 1)[0].replace(/\r?\n[ \t]+/g, ' ');
    const signature = /^DKIM-Signature:.*$/mi.exec(headers)?.[0];
    assert.ok(signature, 'Postfix did not DKIM-sign application MIME');
    assert.match(signature, /\bd=smoke\.example(?:;|\s)/);
    assert.doesNotMatch(headers, /^Bcc:/mi);
    assert.ok(!headers.includes('blind@outside.example'), 'Blind recipient leaked into MIME headers');
    delivered.push(...record.recipients);
  }
  assert.deepEqual(delivered.sort(), (final ? ['accept@outside.example', 'blind@outside.example', 'defer@outside.example'] : ['accept@outside.example', 'blind@outside.example']).sort());
}

async function verifyAttachment(db, email, offline) {
  if (!email.subject.startsWith('smoke-inbound-')) return;
  const list = db.prepare('SELECT * FROM attachments WHERE email_id = ?').all(email.email_id);
  assert.equal(list.length, 1, 'Inbound attachment metadata was not stored');
  const item = list[0];
  assert.equal(item.filename, 'probe.txt');
  assert.equal(item.size, Buffer.byteLength(attachmentBody));
  if (offline) {
    const digest = createHash('sha256').update(item.key).digest('hex');
    const bytes = fs.readFileSync(path.join(process.env.OBJECTS_DIR, digest.slice(0, 2), digest));
    assert.equal(bytes.subarray(0, 8).toString(), 'CMOBJ001');
    assert.equal(bytes.subarray(12 + bytes.readUInt32BE(8)).toString(), attachmentBody);
  } else {
    const response = await fetch(origin + '/oss/' + item.key);
    assert.equal(response.status, 200, 'Inbound attachment download failed');
    assert.equal(await response.text(), attachmentBody);
  }
}

async function smtp(mode, subject, recipient = process.env.ADMIN_EMAIL) {
  const socket = net.createConnection({ host: 'mail', port: 25 });
  const responses = [], waiting = [];
  let buffer = '', lines = [];
  socket.setTimeout(mode === 'unavailable' ? 30000 : 15000, () => socket.destroy(new Error('SMTP response timed out')));
  socket.on('data', chunk => {
    buffer += chunk.toString();
    while (buffer.includes('\n')) {
      const boundary = buffer.indexOf('\n');
      const line = buffer.slice(0, boundary).replace(/\r$/, '');
      buffer = buffer.slice(boundary + 1);
      lines.push(line);
      if (/^\d{3} /.test(line)) {
        const result = { code: Number(line.slice(0, 3)), text: lines.join('\n') };
        lines = [];
        const waiter = waiting.shift();
        if (waiter) waiter.resolve(result); else responses.push(result);
      }
    }
  });
  socket.on('error', error => { while (waiting.length) waiting.shift().reject(error); });
  socket.on('close', () => { while (waiting.length) waiting.shift().reject(new Error('SMTP connection closed')); });
  const read = () => responses.length ? Promise.resolve(responses.shift())
    : new Promise((resolve, reject) => waiting.push({ resolve, reject }));
  const command = async (text, expected) => {
    socket.write(text + '\r\n');
    const response = await read();
    assert.ok([].concat(expected).includes(response.code), `Unexpected SMTP response: ${response.text}`);
    return response;
  };
  try {
    await once(socket, 'connect');
    assert.equal((await read()).code, 220);
    await command('EHLO probe.outside.example', 250);
    await command('MAIL FROM:<probe@outside.example>', 250);
    if (mode === 'relay') {
      const response = await command('RCPT TO:<nobody@another-outside.example>', [550, 554]);
      assert.match(response.text, /relay access denied/i);
      console.info('Public SMTP rejected external relaying');
    } else if (mode === 'unknown') {
      await command(`RCPT TO:<nobody@${process.env.MAIL_DOMAINS.split(',')[0]}>`, 550);
      console.info('Unknown local recipient was rejected');
    } else if (mode === 'unavailable') {
      await command(`RCPT TO:<${process.env.ADMIN_EMAIL}>`, [450, 451]);
      console.info('Unavailable app caused a temporary SMTP recipient failure');
    } else {
      await command(`RCPT TO:<${recipient}>`, 250);
      await command('DATA', 354);
      const message = [
        'From: Probe <probe@outside.example>', `To: ${recipient}`,
        `Subject: ${subject}`, `Message-ID: <${subject}@outside.example>`,
        `Date: ${new Date().toUTCString()}`, 'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="smoke-fixture"', '',
        '--smoke-fixture', 'Content-Type: text/plain; charset=utf-8', '', 'Docker SMTP integration probe.',
        '--smoke-fixture', 'Content-Type: text/plain; name="probe.txt"',
        'Content-Disposition: attachment; filename="probe.txt"', 'Content-Transfer-Encoding: base64', '',
        Buffer.from(attachmentBody).toString('base64'), '--smoke-fixture--', '.',
      ].join('\r\n');
      const response = await command(message, 250);
      const queue = /queued as ([A-Za-z0-9]+)/i.exec(response.text);
      assert.ok(queue, `Postfix did not return a queue ID: ${response.text}`);
      console.info(queue[1]);
    }
    await command('QUIT', 221);
  } finally {
    socket.destroy();
  }
}

async function dynamicDomain(action) {
  const domain = 'managed.smoke.example';
  const email = `reader@${domain}`;
  const token = await login();
  const session = await fetch(origin + '/api/admin/session', { headers: { Authorization: token } });
  assert.equal(session.status, 200);
  const csrfToken = (await session.json()).data.csrfToken;
  const request = async (route, method, data) => {
    const response = await fetch(origin + '/api' + route, {
      method, headers: { Authorization: token, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify(data),
    });
    const payload = await response.json();
    assert.ok(response.ok, `Domain management ${route}: ${payload.error?.message || response.status}`);
    return payload.data;
  };
  if (action === 'create') {
    await request('/admin/domains', 'POST', { domain });
    const batch = await request('/admin/mailboxes/batch', 'POST', { emails: [email] });
    assert.equal(batch.created, 1, 'The dynamically added domain must allow creating its first mailbox');
    console.info('Created a receiving domain absent from MAIL_DOMAINS without restarting either container');
  } else {
    await request(`/admin/domains/${domain}`, 'PUT', { enabled: false });
    console.info('Stopped creating mailboxes on the new domain; existing mailboxes must still receive');
  }
  return email;
}

async function main() {
  const [mode, subject] = process.argv.slice(2);
  if (mode === 'health') {
    const response = await fetch(origin + '/api/health');
    assert.equal(response.status, 200, await response.text());
    const page = await fetch(origin + '/');
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /<html[\s>]/i);
    const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(match => new URL(match[1], origin));
    const script = scripts.find(url => url.origin === origin && url.pathname.startsWith('/assets/') && url.pathname.endsWith('.js'));
    assert.ok(script, 'Production HTML does not reference a local built JS asset');
    const asset = await fetch(script);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type'), /javascript/i);
    assert.ok((await asset.text()).length > 20);
    assert.equal((await fetch(origin + '/assets/__cloud_mail_smoke_missing__.js')).status, 404);
  } else if (mode === 'sink') {
    await startSink();
  } else if (mode === 'sink-ready') {
    const socket = net.createConnection({ host: '127.0.0.1', port: 2526 });
    socket.setTimeout(2000, () => socket.destroy(new Error('SMTP sink not ready')));
    try { await once(socket, 'connect'); } finally { socket.destroy(); }
  } else if (mode === 'sink-release') {
    fs.writeFileSync(path.join(sinkDirectory, 'release'), 'accept deferred recipient\n');
  } else if (mode === 'api-send') {
    await submitThroughApi(subject);
  } else if (mode === 'domain-create' || mode === 'domain-disable') {
    await dynamicDomain(mode === 'domain-create' ? 'create' : 'disable');
  } else if (mode === 'domain-message') {
    await smtp('message', subject, 'reader@managed.smoke.example');
  } else if (mode === 'outbound-initial' || mode === 'outbound-final') {
    await verifyOutgoing(mode === 'outbound-final');
  } else if (mode === 'tls' || mode === 'submission') {
    const nodemailer = require('/app/mail-worker/node_modules/nodemailer');
    const transport = nodemailer.createTransport({
      host: 'mail', port: mode === 'tls' ? 25 : 587, secure: false,
      requireTLS: mode === 'tls', ignoreTLS: mode === 'submission',
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 15000,
      tls: { servername: process.env.MAIL_HOST, ca: fs.readFileSync('/smoke/certs/live/smoke/fullchain.pem') },
    });
    try {
      if (mode === 'tls') {
        assert.equal(await transport.verify(), true);
        console.info('SMTP STARTTLS certificate verified against the test CA');
      } else {
        const response = await transport.sendMail({
          from: process.env.ADMIN_EMAIL, to: process.env.ADMIN_EMAIL, subject,
          messageId: `<${subject}@${process.env.MAIL_DOMAINS}>`,
          text: 'Docker SMTP integration probe.',
        });
        const queue = /queued as ([A-Za-z0-9]+)/i.exec(response.response);
        assert.ok(queue, `Submission did not return a queue ID: ${response.response}`);
        console.info(queue[1]);
      }
    }
    finally { transport.close(); }
  } else if (mode === 'stored' || mode === 'stored-offline' || mode === 'absent') {
    const db = database();
    try {
      const rows = db.prepare('SELECT email_id, subject, text, to_email FROM email WHERE subject = ?').all(subject);
      if (mode === 'absent') {
        assert.equal(rows.length, 0, 'Deferred message was delivered before the queue recovery test');
        return;
      }
      assert.equal(rows.length, 1, `Expected one stored message for ${subject}, found ${rows.length}`);
      assert.match(rows[0].text, /Docker SMTP integration probe/);
      await verifyAttachment(db, rows[0], mode === 'stored-offline');
    } finally { db.close(); }
  } else if (['relay', 'message', 'unknown', 'unavailable'].includes(mode)) {
    await smtp(mode, subject);
  } else {
    throw new Error('Expected health, tls, submission, stored, absent, relay, unknown, unavailable or message probe');
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
