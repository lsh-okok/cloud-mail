import { receiveInbound } from '../server/inbound.js';

// The server uses private LMTP; retain a compatibility entry for raw MIME callers.
export async function email(message, env) {
  const raw = message.raw instanceof ReadableStream
    ? Buffer.from(await new Response(message.raw).arrayBuffer()) : Buffer.from(message.raw);
  return receiveInbound(env, { raw, recipient: message.to, sender: message.from || '' });
}
