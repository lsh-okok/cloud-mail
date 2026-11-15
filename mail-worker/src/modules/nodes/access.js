import { FeatureError } from '../shared/errors.js';

export const nodeRole = env => env.node_role ?? env.nodeRole ?? 'primary';

export function invalidateNodeCaches(env) {
  const state = env.mailSourceState?.coordinator;
  if (state) {
    state.cache.clear(); state.cacheBytes = 0;
    for (const job of state.jobs.values()) job.controller.abort();
  }
  if (env.publicMailState) { env.publicMailState.sessions.clear(); env.publicMailState.bytes = 0; }
}

export function assertReplicaReady(env) {
  if (nodeRole(env) === 'primary') return;
  const state = env.nodeState;
  if (!state?.ready || state.denied || !state.lastSuccessAt || Date.now() - state.lastSuccessAt > 120000) {
    if (state) state.ready = false;
    env.clusterReady = false;
    throw new FeatureError(503, 'NODE_NOT_READY', 'The node must synchronize with its primary before reading messages.');
  }
}
