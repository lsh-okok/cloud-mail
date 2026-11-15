import { afterEach, describe, expect, it, vi } from 'vitest';
import { coordinatedSourceRead } from '../src/modules/mail-sources/coordinator.js';

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const turn = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
afterEach(() => vi.useRealTimers());

describe('coordinated source reads', () => {
  it('coalesces matching reads, keeps recipients separate and returns independent cached results for eight seconds', async () => {
    vi.useFakeTimers();
    const env = {}, gate = deferred();
    const read = vi.fn(() => gate.promise);
    const first = coordinatedSourceRead(env, { sourceId: 'A', key: 'a1:revision1' }, read);
    const second = coordinatedSourceRead(env, { sourceId: 'A', key: 'a1:revision1' }, read);
    await turn(); expect(read).toHaveBeenCalledTimes(1);
    gate.resolve({ messages: [{ subject: 'A1 private' }] });
    const [a, b] = await Promise.all([first, second]);
    a.messages[0].subject = 'Caller mutation';
    expect(b.messages[0].subject).toBe('A1 private');
    const cached = await coordinatedSourceRead(env, { sourceId: 'A', key: 'a1:revision1' }, read);
    expect(cached.messages[0].subject).toBe('A1 private');
    const other = await coordinatedSourceRead(env, { sourceId: 'A', key: 'a2:revision1' }, async () => ({ messages: [{ subject: 'A2 private' }] }));
    expect(other.messages[0].subject).toBe('A2 private');
    await vi.advanceTimersByTimeAsync(8001);
    await coordinatedSourceRead(env, { sourceId: 'A', key: 'a1:revision1' }, async () => ({ messages: [{ subject: 'Fresh' }] }));
    expect((await coordinatedSourceRead(env, { sourceId: 'A', key: 'a1:revision1' }, read)).messages[0].subject).toBe('Fresh');
  });

  it('serializes one main mailbox while letting other sources use the global pool', async () => {
    const env = { upstream_limit: 2 }, a1 = deferred(), a2 = deferred(), b1 = deferred();
    const starts = [];
    const first = coordinatedSourceRead(env, { sourceId: 'A', key: 'a1' }, () => { starts.push('a1'); return a1.promise; });
    const next = coordinatedSourceRead(env, { sourceId: 'A', key: 'a2' }, () => { starts.push('a2'); return a2.promise; });
    const other = coordinatedSourceRead(env, { sourceId: 'B', key: 'b1' }, () => { starts.push('b1'); return b1.promise; });
    await turn(); expect(starts).toEqual(['a1', 'b1']);
    a1.resolve('first'); await first; await turn();
    expect(starts).toEqual(['a1', 'b1', 'a2']);
    a2.resolve('next'); b1.resolve('other');
    expect(await Promise.all([next, other])).toEqual(['next', 'other']);
    expect(env.mailSourceState.coordinator.running).toBe(0);
  });

  it('rejects a queued read after three seconds without cancelling the active upstream read', async () => {
    vi.useFakeTimers();
    const env = { upstream_limit: 1 }, gate = deferred();
    let activeSignal;
    const active = coordinatedSourceRead(env, { sourceId: 'A', key: 'one' }, signal => { activeSignal = signal; return gate.promise; });
    const queuedRead = vi.fn();
    const queued = coordinatedSourceRead(env, { sourceId: 'B', key: 'two' }, queuedRead).catch(error => error);
    await vi.advanceTimersByTimeAsync(3001);
    expect(await queued).toMatchObject({ status: 429, code: 'UPSTREAM_BUSY' });
    expect(queuedRead).not.toHaveBeenCalled(); expect(activeSignal.aborted).toBe(false);
    gate.resolve('done'); expect(await active).toBe('done');
    expect(env.mailSourceState.coordinator.queue).toHaveLength(0);
  });

  it('does not cancel shared work until the last waiter leaves', async () => {
    const env = {}, gate = deferred(), one = new AbortController(), two = new AbortController();
    let upstreamSignal;
    const work = signal => { upstreamSignal = signal; return gate.promise; };
    const first = coordinatedSourceRead(env, { sourceId: 'A', key: 'shared', signal: one.signal }, work).catch(error => error);
    const second = coordinatedSourceRead(env, { sourceId: 'A', key: 'shared', signal: two.signal }, work);
    await turn(); one.abort();
    expect(await first).toMatchObject({ code: 'READ_CANCELLED' });
    expect(upstreamSignal.aborted).toBe(false);
    gate.resolve({ messages: ['Only the remaining waiter receives this'] });
    expect(await second).toEqual({ messages: ['Only the remaining waiter receives this'] });
  });

  it('keeps a source occupied until cancelled upstream work actually exits and never caches its late result', async () => {
    const env = {}, gate = deferred(), controller = new AbortController();
    let signal;
    const cancelled = coordinatedSourceRead(env, { sourceId: 'A', key: 'same', signal: controller.signal }, input => { signal = input; return gate.promise; }).catch(error => error);
    await turn(); controller.abort();
    expect(await cancelled).toMatchObject({ code: 'READ_CANCELLED' }); expect(signal.aborted).toBe(true);
    const newRead = vi.fn(async () => ({ messages: ['Fresh allowed result'] }));
    const next = coordinatedSourceRead(env, { sourceId: 'A', key: 'same' }, newRead);
    await turn(); expect(newRead).not.toHaveBeenCalled();
    gate.resolve({ messages: ['Discarded late result'] });
    expect(await next).toEqual({ messages: ['Fresh allowed result'] });
    expect((await coordinatedSourceRead(env, { sourceId: 'A', key: 'same' }, newRead)).messages).toEqual(['Fresh allowed result']);
    expect(newRead).toHaveBeenCalledTimes(1);
  });

  it('bounds the pending queue and releases every queued waiter when cancelled', async () => {
    const env = { upstream_limit: 1 }, gate = deferred();
    const active = coordinatedSourceRead(env, { sourceId: 'A', key: 'active' }, () => gate.promise);
    const controller = new AbortController();
    const pending = Array.from({ length: 512 }, (_, index) => coordinatedSourceRead(env,
      { sourceId: 'A', key: `queued-${index}`, signal: controller.signal }, async () => index).catch(error => error));
    await expect(coordinatedSourceRead(env, { sourceId: 'B', key: 'overload' }, async () => 'not started')).rejects.toMatchObject({ status: 429 });
    controller.abort();
    expect((await Promise.all(pending)).every(error => error.code === 'READ_CANCELLED')).toBe(true);
    gate.resolve('done'); await active;
    expect(env.mailSourceState.coordinator.queue).toHaveLength(0);
    expect(env.mailSourceState.coordinator.waiterCount).toBe(0);
  });

  it('does not cache errors or oversized snapshots and evicts bounded cache entries', async () => {
    const env = {};
    await expect(coordinatedSourceRead(env, { sourceId: 'A', key: 'error' }, async () => { throw new Error('provider failure'); })).rejects.toThrow('provider failure');
    expect(await coordinatedSourceRead(env, { sourceId: 'A', key: 'error' }, async () => 'retry')).toBe('retry');
    await expect(coordinatedSourceRead(env, { sourceId: 'A', key: 'oversized' }, async () => 'x'.repeat(16 * 1024 * 1024))).rejects.toMatchObject({ code: 'MAILBOX_SNAPSHOT_TOO_LARGE' });
    for (let index = 0; index < 260; index++) await coordinatedSourceRead(env, { sourceId: 'A', key: `entry-${index}` }, async () => index);
    expect(env.mailSourceState.coordinator.cache.size).toBe(256);
    expect(env.mailSourceState.coordinator.cache.has('A:entry-0')).toBe(false);
  });
});
