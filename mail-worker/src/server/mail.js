import { SMTPServer } from 'smtp-server';
import { migrateMail } from './mail-schema.js';
import { startPolicyServer, MailError, isTrustedMailPeer } from './policy.js';
import { receiveInbound, flushNotifications } from './inbound.js';
import { flushOutbox, pollPostfixLog } from './delivery.js';

export async function startLmtpServer(env) {
  let closing = false, shutdown;
  const activeSessions = new Set(), deliveries = new Set();
  const server = new SMTPServer({
    lmtp: true, name: env.server?.hostname || 'localhost',
    authOptional: true, disabledCommands: ['AUTH', 'STARTTLS'],
    size: env.smtp?.maxMessageBytes || 25 * 1024 * 1024, logger: false,
    closeTimeout: 5000,
    onConnect(session, callback) {
      callback(!closing && isTrustedMailPeer(env, session.remoteAddress) ? null : new MailError('4.7.1 Connection not permitted', 421));
    },
    onMailFrom(address, session, callback) {
      callback(closing ? new MailError('4.3.2 Server shutting down', 421) : null);
    },
    onData(stream, session, callback) {
      if (closing) return callback(new MailError('4.3.2 Server shutting down', 451));
      activeSessions.add(session.id);
      let release;
      const delivery = new Promise(resolve => { release = resolve; });
      deliveries.add(delivery);
      const chunks = []; let size = 0, called = false;
      const done = (...args) => {
        if (called) return;
        called = true;
        try { callback(...args); }
        finally {
          activeSessions.delete(session.id);
          deliveries.delete(delivery);
          release();
          // callback synchronously writes the final per-recipient replies. Let
          // them flush before ending a persistent connection during shutdown.
          if (closing) for (const connection of server.connections) {
            if (connection.id === session.id) connection.close();
          }
        }
      };
      const maximum = env.smtp?.maxMessageBytes || 25 * 1024 * 1024;
      stream.on('data', chunk => { size += chunk.length; if (size <= maximum) chunks.push(chunk); });
      stream.once('error', () => done(new MailError('4.3.0 Cannot read message')));
      stream.once('end', async () => {
        if (stream.sizeExceeded || size > maximum) return done(new MailError('5.3.4 Message too large', 552));
        const raw = Buffer.concat(chunks), outcomes = [];
        for (const recipient of session.envelope.rcptTo) {
          try {
            await receiveInbound(env, { raw, recipient: recipient.address, sender: session.envelope.mailFrom?.address || '' });
            outcomes.push('2.0.0 Message stored');
          } catch (error) {
            console.error('LMTP delivery failed:', error.message);
            outcomes.push(error instanceof MailError ? error : new MailError('4.3.0 Storage temporarily unavailable'));
          }
        }
        done(null, outcomes);
      });
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(env.server?.lmtpPort ?? 2525, env.server?.lmtpHost || '0.0.0.0', resolve);
  });
  const close = server.close.bind(server);
  server.close = callback => {
    if (!shutdown) {
      closing = true;
      shutdown = (async () => {
        const stopped = new Promise(resolve => close(resolve));
        for (const connection of server.connections) {
          if (!activeSessions.has(connection.id)) {
            connection.send(421, 'Server shutting down');
            connection.close();
          }
        }
        await stopped;
        // smtp-server's timeout can close a socket while object I/O is still
        // pending. Never allow the caller to close SQLite before that I/O and
        // its transaction finish. A lost ACK is safely deduplicated on retry.
        await Promise.all([...deliveries]);
      })();
    }
    if (callback) shutdown.then(() => callback(), callback);
    return shutdown;
  };
  return server;
}

export async function startMailServices(env) {
  migrateMail(env.db);
  env.db.prepare(`UPDATE mail_outbox SET state='uncertain',last_error='Application restarted during SMTP submission; reconciling Postfix logs'
    WHERE state='submitting'`).run();
  const policy = await startPolicyServer(env);
  let lmtp;
  try { lmtp = await startLmtpServer(env); }
  catch (error) { policy.close(); throw error; }
  // A slow optional HTTP integration must never stop the MTA log reader or
  // submissions. Each loop has its own guard against concurrent executions.
  const loops = [
    backgroundLoop(() => pollPostfixLog(env), 'Postfix log reader'),
    backgroundLoop(() => flushOutbox(env), 'Mail submission'),
    backgroundLoop(() => flushNotifications(env), 'Mail notification')
  ];
  return { async close() {
    const pending = loops.map(loop => loop.stop());
    await Promise.all([new Promise(resolve => lmtp.close(resolve)), new Promise(resolve => policy.close(resolve))]);
    await Promise.all(pending);
  } };
}

function backgroundLoop(action, label) {
  let stopped = false, current;
  const tick = () => {
    if (stopped || current) return;
    current = Promise.resolve().then(action)
      .catch(error => console.error(`${label} failed:`, error.message))
      .finally(() => { current = null; });
  };
  tick();
  const timer = setInterval(tick, 2000); timer.unref();
  return { stop() { stopped = true; clearInterval(timer); return current; } };
}
