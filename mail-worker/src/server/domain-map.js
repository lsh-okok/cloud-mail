import net from 'node:net';
import { knownDomains } from '../modules/domains/service.js';
import { isTrustedMailPeer } from './policy.js';

const MAX_REQUEST_BYTES = 1024;
const netstring = value => `${Buffer.byteLength(value)}:${value},`;

// Postfix queries this map for routing, including domains retired from new
// mailbox creation. Recipient authorization remains in the RCPT policy/LMTP.
export function domainMapResult(env, request) {
  const separator = request.indexOf(' ');
  if (separator === -1 || request.slice(0, separator) !== 'domains') return 'PERM Unsupported domain map';
  const domain = request.slice(separator + 1).toLowerCase();
  if (domain.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)) {
    return 'NOTFOUND Invalid receiving domain';
  }
  try {
    return knownDomains(env).includes(domain) ? `OK ${domain}` : 'NOTFOUND Domain not configured';
  } catch (error) {
    console.error('SMTP domain lookup failed:', error.message);
    return 'TEMP Domain lookup temporarily unavailable';
  }
}

export async function startDomainMapServer(env) {
  const sockets = new Set();
  const server = net.createServer(socket => {
    if (!isTrustedMailPeer(env, socket.remoteAddress)) return socket.destroy();
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(15000, () => socket.destroy());
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 4096) return socket.destroy();
      while (buffer.length) {
        const colon = buffer.indexOf(58);
        if (colon === -1) {
          if (buffer.length > 4 || !/^[0-9]+$/.test(buffer.toString('utf8'))) socket.destroy();
          return;
        }
        const prefix = buffer.subarray(0, colon).toString('utf8');
        if (!/^(?:0|[1-9][0-9]{0,3})$/.test(prefix)) return socket.destroy();
        const length = Number(prefix);
        if (length < 1 || length > MAX_REQUEST_BYTES) return socket.destroy();
        const end = colon + 1 + length;
        if (buffer.length < end + 1) return;
        if (buffer[end] !== 44) return socket.destroy();
        const request = buffer.subarray(colon + 1, end).toString('utf8');
        buffer = buffer.subarray(end + 1);
        socket.write(netstring(domainMapResult(env, request)));
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(env.server?.domainMapPort ?? 10041, env.server?.domainMapHost || '0.0.0.0', resolve);
  });
  const close = server.close.bind(server);
  let shutdown;
  server.close = callback => {
    if (!shutdown) shutdown = new Promise((resolve, reject) => {
      close(error => error ? reject(error) : resolve());
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
