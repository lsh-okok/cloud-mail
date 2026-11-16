import { deflateRawSync, crc32 } from 'node:zlib';
import { FeatureError } from '../shared/errors.js';

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_LINKS = 5000;

function limit() {
  throw new FeatureError(413, 'DELIVERY_TOO_LARGE', '交付内容超出单次容量，请减少兑换码数量或联系管理员。');
}

function safeName(value, fallback) {
  const name = String(value || '').normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
    .replace(/[. ]+$/g, '').slice(0, 120).replace(/[. ]+$/g, '');
  return !name || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? fallback : name;
}

function textContent(links) {
  const seen = new Set(), lines = [];
  for (const { recipient, url } of links) {
    if (typeof recipient !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(recipient) ||
        typeof url !== 'string' || /[\s\u0000-\u001f\u007f]/.test(url)) {
      throw new FeatureError(409, 'INVALID_DELIVERY_LINK', '子邮箱或取码链接数据异常，未核销兑换码。');
    }
    let address;
    try { address = new URL(url); } catch {
      throw new FeatureError(409, 'INVALID_DELIVERY_LINK', '取码链接数据异常，未核销兑换码。');
    }
    if (!['https:', 'http:'].includes(address.protocol) || address.username || address.password) {
      throw new FeatureError(409, 'INVALID_DELIVERY_LINK', '取码链接数据异常，未核销兑换码。');
    }
    const line = `${recipient}----${url}`;
    if (!seen.has(line)) { seen.add(line); lines.push(line); }
  }
  return Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
}

// Bounded ZIP32 writer: UTF-8 names, raw DEFLATE and the CRC32 from Node 24.
// A fixed DOS timestamp makes repeated downloads byte-for-byte identical.
function zip(entries) {
  const localParts = [], centralParts = [];
  let offset = 0, centralSize = 0;
  for (const { filename, content } of entries) {
    const name = Buffer.from(filename, 'utf8');
    const compressed = deflateRawSync(content), checksum = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(33, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    localParts.push(local, name, compressed);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
    centralSize += central.length + name.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

export function createDelivery(orderNo, files, { batch = files.length > 1 } = {}) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 100) {
    throw new TypeError('A delivery must contain between 1 and 100 mailbox files.');
  }
  const names = new Set(), mailboxes = new Set(), entries = [];
  let bytes = 0, linkCount = 0;
  for (const file of files) {
    if (!Array.isArray(file.links) || file.links.length === 0) throw new TypeError('Every mailbox file needs recipient links.');
    if (mailboxes.has(file.mailboxId)) throw new TypeError('A mailbox may appear only once in an order.');
    mailboxes.add(file.mailboxId);
    linkCount += file.links.length;
    if (file.links.length > 1000 || linkCount > MAX_LINKS) limit();
    const content = textContent(file.links);
    bytes += content.length;
    if (bytes > MAX_BYTES) limit();
    const label = safeName(file.mailboxEmail, 'mailbox');
    const id = safeName(file.mailboxId, 'id').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16) || 'id';
    let filename = `${label}-${id}.txt`, suffix = 1;
    while (names.has(filename.toLowerCase())) filename = `${label}-${id}-${suffix++}.txt`;
    names.add(filename.toLowerCase());
    entries.push({ filename, content });
  }
  if (!batch && entries.length !== 1) throw new TypeError('A single-code delivery contains one mailbox.');
  const buffer = batch ? zip(entries) : entries[0].content;
  if (buffer.length > MAX_BYTES + 128 * 1024) limit();
  return {
    buffer,
    filename: batch ? `redemption-${safeName(orderNo, 'order')}.zip` : entries[0].filename,
    contentType: batch ? 'application/zip' : 'text/plain;charset=utf-8',
  };
}
