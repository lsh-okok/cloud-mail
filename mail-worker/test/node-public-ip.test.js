import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizePublicIp, startPublicIpDiscovery } from '../src/modules/nodes/address.js';
import { startNodeRuntime } from '../src/modules/nodes/runtime.js';
import { NODE_SCHEMA } from '../src/modules/nodes/schema.js';
import { createDatabase } from '../src/server/database.js';

const closers = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  vi.useRealTimers();
});
function discovery(options) {
  const address = startPublicIpDiscovery(options);
  closers.push(() => address.close());
  return address;
}

describe('node public IP addresses', () => {
  it('normalizes global addresses and rejects private, reserved and malformed values', () => {
    for (const value of ['3.107.15.37', '8.8.8.8', '1.1.1.1']) expect(normalizePublicIp(value)).toBe(value);
    expect(normalizePublicIp(' 3.107.15.37\n')).toBe('3.107.15.37');
    expect(normalizePublicIp('2001:4860:4860:0000::8888')).toBe('2001:4860:4860::8888');
    expect(normalizePublicIp('::ffff:3.107.15.37')).toBe('3.107.15.37');
    for (const value of [null, {}, 123, '', '999.1.1.1', '03.107.15.37', 'ip.example.com', '3.107.15.37\n8.8.8.8',
      '0.0.0.0', '10.0.0.1', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.17.0.1', '192.168.1.1',
      '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
      '::', '::1', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '2002:0303:0303::1', '3fff::1',
      '::ffff:172.17.0.1', '::ffff:ac11:1', '2606:4700::1111%eth0']) expect(normalizePublicIp(value), String(value)).toBeNull();
  });

  it('uses only bounded HTTPS address requests, falls back, caches success and preserves it on failure', async () => {
    vi.useFakeTimers();
    const requests = [];
    let offline = false;
    const address = discovery({ fetcher: async (url, options) => {
      requests.push({ url, options });
      return offline || url.includes('ipify') ? new Response('', { status: 503 }) : new Response('3.107.15.37\n');
    } });
    await address.refresh();
    expect(address.getIp()).toBe('3.107.15.37');
    expect(requests.map(item => item.url)).toEqual(['https://api4.ipify.org', 'https://checkip.amazonaws.com']);
    for (const { options } of requests) {
      expect(options).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit', headers: { accept: 'text/plain' } });
      expect(options.headers).not.toHaveProperty('authorization');
      expect(options.headers).not.toHaveProperty('x-node-id');
    }
    await vi.advanceTimersByTimeAsync(599999);
    expect(requests).toHaveLength(2);
    offline = true;
    await vi.advanceTimersByTimeAsync(1);
    expect(requests).toHaveLength(5);
    expect(address.getIp()).toBe('3.107.15.37');
    await vi.advanceTimersByTimeAsync(60000);
    expect(requests).toHaveLength(8);
    await address.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('discovers a public IPv6 address when IPv4 lookup services are unreachable', async () => {
    const requests = [];
    const address = discovery({ fetcher: async url => {
      requests.push(url);
      if (url !== 'https://api64.ipify.org') throw new TypeError('IPv4 network is unreachable');
      return new Response('2606:4700:4700:0000::1111\n');
    } });
    await address.refresh();
    expect(requests).toEqual(['https://api4.ipify.org', 'https://checkip.amazonaws.com', 'https://api64.ipify.org']);
    expect(address.getIp()).toBe('2606:4700:4700::1111');
  });

  it('rejects oversized, non-public and redirected lookup responses', async () => {
    for (const makeBad of [
      () => new Response('a'.repeat(129)),
      () => new Response('3.107.15.37', { headers: { 'content-length': '129' } }),
      () => new Response('172.17.0.1'),
      () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }),
    ]) {
      const fetcher = vi.fn(async url => url.includes('ipify') ? makeBad() : new Response('8.8.8.8'));
      const address = discovery({ fetcher });
      await address.refresh();
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(address.getIp()).toBe('8.8.8.8');
      await address.close();
    }
  });

  it('bounds both stalled requests and stalled bodies and aborts promptly on close', async () => {
    vi.useFakeTimers();
    const signals = [];
    const address = discovery({ fetcher: (_url, options) => {
      signals.push(options.signal);
      return new Promise(() => {}); // Even a transport ignoring cancellation is bounded.
    } });
    const first = address.refresh();
    await vi.advanceTimersByTimeAsync(9000);
    await first;
    expect(signals).toHaveLength(3);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(address.getIp()).toBeNull();
    await address.close();
    expect(vi.getTimerCount()).toBe(0);

    let bodyCancelled = false;
    const stalled = discovery({ fetcher: async () => new Response(new ReadableStream({ cancel() { bodyCancelled = true; } })) });
    const pending = stalled.refresh();
    await vi.advanceTimersByTimeAsync(1);
    await stalled.close();
    await pending;
    expect(bodyCancelled).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses an explicit public IP without making any external requests', async () => {
    const fetcher = vi.fn();
    const address = discovery({ fetcher, publicIp: '3.107.15.37' });
    await address.refresh();
    expect(address.getIp()).toBe('3.107.15.37');
    expect(fetcher).not.toHaveBeenCalled();
    await address.close();
  });
});

function runtime({ supportsIp = true, fetcher, publicIp = '3.107.15.37' } = {}) {
  const db = createDatabase(':memory:'); db.exec(NODE_SCHEMA);
  db.prepare("UPDATE node_replica_state SET phase='events',initialized=1 WHERE id=1").run();
  const heartbeats = [];
  let support = supportsIp;
  const env = { db, node_role: 'replica', node_primary_url: 'https://primary.example.com', node_id: 'replica-one',
    node_credential: 'c'.repeat(43), node_public_ip: publicIp, node_public_ip_fetch: fetcher || vi.fn(),
    node_fetch: async (url, init) => {
      if (url.includes('/events?')) return Response.json({ data: { after: 0, cursor: 0, primaryCursor: 0, hasMore: false, events: [] } });
      const body = JSON.parse(init.body); heartbeats.push(body);
      if (!support && Object.hasOwn(body, 'publicIp')) return Response.json({ error: { code: 'UNKNOWN_FIELD' } }, { status: 400 });
      return Response.json({ data: { primaryCursor: 0, ready: true, nodeId: 'replica-one', ...(support ? { publicIpReporting: true } : {}) } });
    } };
  const stop = startNodeRuntime(env);
  closers.push(async () => { await stop(); db.close(); });
  return { env, stop, heartbeats, setSupport: value => { support = value; } };
}

describe('public IP heartbeat compatibility', () => {
  it('negotiates before advertising and keeps working against an older or rolled-back primary', async () => {
    const replica = runtime();
    await replica.stop.tick();
    expect(replica.heartbeats[0]).not.toHaveProperty('publicIp');
    await replica.stop.tick();
    expect(replica.heartbeats.at(-1).publicIp).toBe('3.107.15.37');
    expect(replica.env.clusterReady).toBe(true);
    replica.setSupport(false);
    const count = replica.heartbeats.length;
    await replica.stop.tick();
    expect(replica.heartbeats.slice(count).map(body => body.publicIp)).toEqual(['3.107.15.37', undefined]);
    expect(replica.env.clusterReady).toBe(true);
    await replica.stop.tick();
    expect(replica.heartbeats.at(-1)).not.toHaveProperty('publicIp');

    const oldPrimary = runtime({ supportsIp: false });
    await oldPrimary.stop.tick(); await oldPrimary.stop.tick();
    expect(oldPrimary.heartbeats.every(body => !Object.hasOwn(body, 'publicIp'))).toBe(true);
    expect(oldPrimary.env.clusterReady).toBe(true);
  });

  it('synchronizes without waiting for a public lookup and closes an in-flight lookup without hanging', async () => {
    const signals = [];
    const replica = runtime({ publicIp: null, fetcher: (_url, options) => {
      signals.push(options.signal); return new Promise(() => {});
    } });
    await replica.stop.tick();
    expect(replica.env.clusterReady).toBe(true);
    expect(replica.heartbeats.at(-1)).not.toHaveProperty('publicIp');
    expect(signals).toHaveLength(1);
    await replica.stop();
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(replica.env.nodeState.runtime).toBeNull();
  });
});
