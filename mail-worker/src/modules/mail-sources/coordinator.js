import { FeatureError } from '../shared/errors.js';

const CACHE_TTL_MS = 8000;
const CACHE_BYTES = 64 * 1024 * 1024;
const ENTRY_BYTES = 16 * 1024 * 1024;
const CACHE_ENTRIES = 256;
const QUEUE_CAPACITY = 512;
const WAITERS_CAPACITY = 2048;
const JOB_WAITERS_CAPACITY = 512;
const PERMIT_WAIT_MS = 3000;

const busy = () => new FeatureError(429, 'UPSTREAM_BUSY', 'Mailbox reads are busy. Please retry shortly.');
const cancelled = () => new FeatureError(503, 'READ_CANCELLED', 'The mailbox read was cancelled.');

function stateFor(env) {
  const limit = env.upstream_limit ?? 16;
  if (!Number.isInteger(limit) || limit < 1 || limit > 128) throw new TypeError('upstream_limit must be an integer from 1 to 128.');
  // createEnvironment supplies this stable owner to all request bindings. The
  // fallback also keeps callers using a single environment object independent.
  const owner = env.mailSourceState ||= {};
  const state = owner.coordinator ||= { cache: new Map(), cacheBytes: 0, jobs: new Map(), queue: [],
    activeSources: new Set(), running: 0, waiterCount: 0, limit };
  state.limit = limit;
  const now = Date.now();
  for (const [key, entry] of state.cache) if (entry.expiresAt <= now) {
    state.cache.delete(key); state.cacheBytes -= entry.bytes;
  }
  return state;
}

function removeQueued(state, job) {
  const index = state.queue.indexOf(job);
  if (index !== -1) state.queue.splice(index, 1);
  clearTimeout(job.timer);
}

function dropJobIndex(state, job) {
  if (state.jobs.get(job.key) === job) state.jobs.delete(job.key);
}

function cacheResult(state, job, value) {
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(value)); }
  catch { throw new FeatureError(502, 'UPSTREAM_INVALID_RESPONSE', 'The mailbox read returned an invalid result.'); }
  if (bytes > ENTRY_BYTES) throw new FeatureError(429, 'MAILBOX_SNAPSHOT_TOO_LARGE', 'The message snapshot exceeds its supported capacity.');
  const old = state.cache.get(job.key);
  if (old) { state.cache.delete(job.key); state.cacheBytes -= old.bytes; }
  while (state.cache.size && (state.cache.size >= CACHE_ENTRIES || state.cacheBytes + bytes > CACHE_BYTES)) {
    const oldestKey = state.cache.keys().next().value;
    state.cacheBytes -= state.cache.get(oldestKey).bytes;
    state.cache.delete(oldestKey);
  }
  const saved = structuredClone(value);
  state.cache.set(job.key, { value: saved, bytes, expiresAt: Date.now() + CACHE_TTL_MS });
  state.cacheBytes += bytes;
  return saved;
}

function releaseWaiter(state, job, waiter) {
  if (!job.waiters.delete(waiter)) return false;
  waiter.signal?.removeEventListener('abort', waiter.onAbort);
  state.waiterCount--;
  return true;
}

function settle(state, job, error, value) {
  if (job.phase === 'settled') return;
  const wasRunning = job.phase === 'running';
  removeQueued(state, job);
  dropJobIndex(state, job);
  job.phase = 'settled';
  if (wasRunning) { state.running--; state.activeSources.delete(job.sourceId); }
  if (!error && !job.controller.signal.aborted && job.waiters.size) {
    try { value = cacheResult(state, job, value); } catch (failure) { error = failure; }
  }
  for (const waiter of [...job.waiters]) {
    releaseWaiter(state, job, waiter);
    if (error) waiter.reject(error);
    else if (job.controller.signal.aborted) waiter.reject(cancelled());
    else waiter.resolve(structuredClone(value));
  }
  pump(state);
}

function pump(state) {
  while (state.running < state.limit) {
    const index = state.queue.findIndex(job => !state.activeSources.has(job.sourceId));
    if (index === -1) return;
    const job = state.queue.splice(index, 1)[0];
    clearTimeout(job.timer);
    if (!job.waiters.size || job.controller.signal.aborted) { settle(state, job, cancelled()); continue; }
    job.phase = 'running';
    state.running++;
    state.activeSources.add(job.sourceId);
    Promise.resolve().then(() => {
      if (job.controller.signal.aborted) throw cancelled();
      return job.execute(job.controller.signal);
    }).then(value => settle(state, job, null, value), error => settle(state, job, error));
  }
}

function subscribe(state, job, signal) {
  return new Promise((resolve, reject) => {
    const waiter = { resolve, reject, signal, onAbort: null };
    waiter.onAbort = () => {
      if (!releaseWaiter(state, job, waiter)) return;
      reject(cancelled());
      if (job.waiters.size) return;
      job.controller.abort();
      dropJobIndex(state, job);
      if (job.phase === 'queued') settle(state, job, cancelled());
      // Running work keeps its source permit until it actually exits, even
      // when an upstream library ignores cancellation. Its late result is not
      // cached and cannot overlap a later operation on the same source.
    };
    job.waiters.add(waiter); state.waiterCount++;
    signal?.addEventListener('abort', waiter.onAbort, { once: true });
    // The signal may have been cancelled between the caller check and listener
    // installation; explicitly inspect it after subscribing.
    if (signal?.aborted) waiter.onAbort();
  });
}

/**
 * Coalesce identical policy-bound reads, with per-source serialization and a
 * bounded global upstream pool. Callers must validate policy before and after
 * this operation; its key must include every policy revision and read option.
 */
export function coordinatedSourceRead(env, { key, sourceId, signal }, execute) {
  if (typeof sourceId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(sourceId) ||
      typeof key !== 'string' || !key || key.length > 8192 || typeof execute !== 'function') {
    return Promise.reject(new TypeError('A bounded source ID, policy key and read operation are required.'));
  }
  if (signal?.aborted) return Promise.reject(cancelled());
  const state = stateFor(env);
  const combinedKey = `${sourceId}:${key}`;
  const cached = state.cache.get(combinedKey);
  if (cached) {
    state.cache.delete(combinedKey); state.cache.set(combinedKey, cached);
    return Promise.resolve(structuredClone(cached.value));
  }
  if (state.waiterCount >= WAITERS_CAPACITY) return Promise.reject(busy());
  let job = state.jobs.get(combinedKey);
  if (job) {
    if (job.waiters.size >= JOB_WAITERS_CAPACITY) return Promise.reject(busy());
    return subscribe(state, job, signal);
  }
  if (state.queue.length >= QUEUE_CAPACITY) return Promise.reject(busy());
  job = { key: combinedKey, sourceId, execute, waiters: new Set(), phase: 'queued',
    controller: new AbortController(), timer: null };
  state.jobs.set(combinedKey, job);
  state.queue.push(job);
  const result = subscribe(state, job, signal);
  if (job.phase !== 'settled') {
    job.timer = setTimeout(() => {
      if (job.phase !== 'queued') return;
      job.controller.abort(); settle(state, job, busy());
    }, PERMIT_WAIT_MS);
    job.timer.unref?.();
    pump(state);
  }
  return result;
}
