import { BlockList, isIP } from 'node:net';

function address(value) {
  return String(value || '').replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1');
}

export function parseTrustedProxies(value = '') {
  const entries = Array.isArray(value) ? value : value.split(',').map(item => item.trim()).filter(Boolean);
  const block = new BlockList();
  for (const entry of entries) {
    const [network, prefix, ...extra] = entry.split('/');
    const family = isIP(network);
    if (!family || extra.length || (prefix !== undefined && (!/^\d+$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)))) {
      throw new Error('TRUSTED_PROXIES must contain valid IP addresses or CIDR networks');
    }
    if (prefix === undefined) block.addAddress(network, family === 4 ? 'ipv4' : 'ipv6');
    else block.addSubnet(network, Number(prefix), family === 4 ? 'ipv4' : 'ipv6');
  }
  return block;
}

export function resolveClientIp(env, request, remoteAddress) {
  const remote = address(remoteAddress);
  if (!isIP(remote)) return 'Unknown';
  const trusted = parseTrustedProxies(env.trusted_proxies || []);
  const isTrusted = ip => !!isIP(ip) && trusted.check(ip, isIP(ip) === 4 ? 'ipv4' : 'ipv6');
  if (env.trust_proxy === false || !isTrusted(remote)) return remote;
  const header = request.header('x-forwarded-for');
  if (header) {
    if (header.length > 4096) return remote;
    const chain = header.split(',').map(item => address(item.trim()));
    if (!chain.length || chain.length > 32 || chain.some(item => !isIP(item))) return remote;
    chain.push(remote);
    while (chain.length > 1 && isTrusted(chain.at(-1))) chain.pop();
    return chain.at(-1);
  }
  const real = address(request.header('x-real-ip'));
  return isIP(real) ? real : remote;
}
