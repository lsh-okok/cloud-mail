import { BlockList, isIP } from 'node:net';

// Addresses advertised by a node are display metadata, never an authorization
// identity. Keep private, test and special-purpose ranges out of this field.
const privateV4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) privateV4.addSubnet(network, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
const specialV6 = new BlockList();
for (const [network, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) {
  specialV6.addSubnet(network, prefix, 'ipv6');
}

export function normalizePublicIp(value) {
  if (typeof value !== 'string' || value.length > 64) return null;
  const candidate = value.trim();
  if (candidate.includes('%')) return null;
  const family = isIP(candidate);
  if (family === 4) return privateV4.check(candidate, 'ipv4') ? null : candidate;
  if (family !== 6) return null;
  let normalized;
  try { normalized = new URL(`http://[${candidate}]/`).hostname.slice(1, -1).toLowerCase(); }
  catch { return null; }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
  if (mapped) {
    const first = parseInt(mapped[1], 16), second = parseInt(mapped[2], 16);
    return normalizePublicIp(`${first >>> 8}.${first & 255}.${second >>> 8}.${second & 255}`);
  }
  return globalV6.check(normalized, 'ipv6') && !specialV6.check(normalized, 'ipv6') ? normalized : null;
}

const endpoints = ['https://api4.ipify.org', 'https://checkip.amazonaws.com', 'https://api64.ipify.org'];
const aborted = () => new DOMException('The address lookup was aborted.', 'AbortError');

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(aborted());
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function addressFrom(fetcher, url, lifetime) {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 3000); timer.unref?.();
  const signal = AbortSignal.any([lifetime, timeout.signal]);
  let reader;
  try {
    const response = await abortable(fetcher(url, {
      method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', signal,
      headers: { accept: 'text/plain' },
    }), signal);
    if (!response.ok || response.redirected || Number(response.headers.get('content-length')) > 128) {
      void response.body?.cancel().catch(() => {});
      return null;
    }
    reader = response.body?.getReader();
    if (!reader) return null;
    const chunks = [];
    let bytes = 0;
    while (true) {
      const { value, done } = await abortable(reader.read(), signal);
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 128) return null;
      chunks.push(value);
    }
    return normalizePublicIp(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch { return null; }
  finally {
    clearTimeout(timer);
    if (reader) {
      void reader.cancel().catch(() => {});
      try { reader.releaseLock(); } catch {}
    }
  }
}

export function startPublicIpDiscovery({ fetcher = globalThis.fetch, signal, publicIp } = {}) {
  let current = publicIp ? normalizePublicIp(publicIp) : null;
  if (publicIp && !current) throw new Error('NODE_PUBLIC_IP must be a public IPv4 or IPv6 address.');
  const fixed = !!current, lifetime = new AbortController();
  let stopped = false, pending = null, timer;
  const stop = () => { stopped = true; clearTimeout(timer); lifetime.abort(); };
  signal?.addEventListener('abort', stop, { once: true });
  if (signal?.aborted) stop();

  function refresh() {
    if (stopped || fixed) return Promise.resolve();
    if (pending) return pending;
    clearTimeout(timer);
    pending = (async () => {
      let found = null;
      for (const endpoint of endpoints) {
        if (stopped) break;
        found = await addressFrom(fetcher, endpoint, lifetime.signal);
        if (found) break;
      }
      if (found && !stopped) current = found;
      return !!found;
    })().then(found => {
      if (!stopped) {
        timer = setTimeout(() => { void refresh(); }, found ? 600000 : 60000);
        timer.unref?.();
      }
      return found;
    }).finally(() => { pending = null; });
    return pending;
  }
  if (!fixed && !stopped) queueMicrotask(() => { void refresh(); });
  return {
    getIp: () => current,
    refresh,
    async close() { stop(); signal?.removeEventListener('abort', stop); await pending; },
  };
}
