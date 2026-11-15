import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { domainToASCII } from 'node:url';
import { FeatureError } from '../shared/errors.js';

const denied = new BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],
  ['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],
  ['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) denied.addSubnet(address,prefix,'ipv4');
for (const [address,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]]) denied.addSubnet(address,prefix,'ipv6');
const globalV6 = new BlockList(); globalV6.addSubnet('2000::',3,'ipv6');
const unsafe = () => new FeatureError(400,'UNSAFE_DESTINATION','The destination is not an allowed public network address.');
const invalidUrl = () => new FeatureError(400,'INVALID_CUSTOM_URL','Use an absolute HTTP(S) URL without credentials or control characters.');

export function publicAddress(address) {
  const family = isIP(address);
  if (family === 4) return !denied.check(address,'ipv4');
  return family === 6 && globalV6.check(address,'ipv6') && !denied.check(address,'ipv6');
}
function allowedException(address, cidrs) {
  const allow = new BlockList();
  for (const cidr of cidrs || []) {
    const [network,prefix,...extra] = String(cidr).split('/'), family = isIP(network);
    if (!family || extra.length || (prefix!==undefined && (!/^\d+$/.test(prefix) || Number(prefix) > (family === 4 ? 32 : 128)))) throw new TypeError('Invalid verification SMTP CIDR allowlist.');
    allow.addSubnet(network,prefix===undefined?(family===4?32:128):Number(prefix),family === 4 ? 'ipv4' : 'ipv6');
  }
  return allow.check(address,isIP(address) === 4 ? 'ipv4' : 'ipv6');
}
export function normalizedHost(value) {
  if (typeof value !== 'string' || !value || value.length > 253 || /[\s\u0000-\u001f\u007f/@\\]/.test(value)) throw unsafe();
  const host = value.replace(/^\[|\]$/g,'').toLowerCase();
  if (isIP(host)) return host;
  const ascii = domainToASCII(host);
  if (!ascii || ascii.length > 253 || !ascii.includes('.') || !ascii.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) throw unsafe();
  return ascii;
}
export function validateCustomUrl(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\s\u0000-\u001f\u007f\\]/.test(value)) throw invalidUrl();
  let url; try { url = new URL(value); } catch { throw invalidUrl(); }
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw invalidUrl();
  const host = normalizedHost(url.hostname);
  if (isIP(host) && !publicAddress(host)) throw unsafe();
  url.hash = '';
  return url.href;
}
export async function resolveDestination(env, host, {smtp = false,signal} = {}) {
  host = normalizedHost(host);
  signal?.throwIfAborted();
  const records = isIP(host) ? [{address:host,family:isIP(host)}] : await (env.verificationTransports?.resolve || lookup)(host,{all:true,verbatim:true});
  signal?.throwIfAborted();
  if (!Array.isArray(records) || !records.length || records.length > 128 || records.some(row => !isIP(row.address) ||
    (!publicAddress(row.address) && !(smtp && allowedException(row.address,env.verificationSmtpAllowCidrs))))) throw unsafe();
  return {...records[0], family:isIP(records[0].address)};
}
function nativeRequest({url,address,family,signal}) {
  return new Promise((resolve,reject) => {
    const target = new URL(url), implementation = target.protocol === 'https:' ? https : http;
    const request = implementation.get(target,{signal,agent:false,headers:{'Accept-Encoding':'identity','User-Agent':'CloudMail-Verification/1'},
      minVersion:'TLSv1.2',rejectUnauthorized:true,lookup:(_hostname,options,callback) => {
        callback(null,options?.all ? [{address,family}] : address,family);
      }},response => {
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') { response.destroy(); reject(new FeatureError(502,'ENCODING_UNSUPPORTED','The custom page must use an uncompressed response.')); return; }
      const chunks=[]; let bytes=0;
      response.on('data',chunk => { bytes+=chunk.length; if(bytes>2*1024*1024) response.destroy(new FeatureError(502,'PAGE_TOO_LARGE','The custom response exceeds 2 MiB.')); else chunks.push(chunk); });
      response.on('end',() => resolve({status:response.statusCode,headers:response.headers,body:Buffer.concat(chunks)}));
      response.on('error',reject);
    });
    request.on('error',reject);
  });
}
export async function customGet(env,value,{signal,timeoutSeconds=10}={}) {
  const timeout = AbortSignal.timeout(timeoutSeconds*1000);
  const combined = signal ? AbortSignal.any([signal,timeout]) : timeout;
  let url = validateCustomUrl(value);
  for (let depth=0; depth<=5; depth++) {
    const target = new URL(url), destination = await resolveDestination(env,target.hostname,{signal:combined});
    combined.throwIfAborted();
    const response = await (env.verificationTransports?.request || nativeRequest)({url,...destination,signal:combined});
    combined.throwIfAborted();
    const body = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.body || '');
    if (body.length>2*1024*1024) throw new FeatureError(502,'PAGE_TOO_LARGE','The custom response exceeds 2 MiB.');
    const status = Number(response.status);
    if (!Number.isInteger(status) || status<100 || status>599) throw new FeatureError(502,'INVALID_HTTP_RESPONSE','The custom response is invalid.');
    const location = response.headers?.location || response.headers?.get?.('location');
    if ([301,302,303,307,308].includes(status) && location) {
      if(depth===5) throw new FeatureError(502,'REDIRECT_LIMIT','The custom page exceeds five redirects.');
      let next;try{next=new URL(location,url).href;}catch{throw new FeatureError(502,'INVALID_REDIRECT','The custom page returned an invalid redirect address.');}
      url=validateCustomUrl(next); continue;
    }
    return {status,body:body.toString('utf8')};
  }
}
