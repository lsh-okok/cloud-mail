import { addressParser } from 'postal-mime';
import { domainToASCII } from 'node:url';

export function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const parts = value.trim().toLowerCase().split('@');
  if (parts.length !== 2) return null;
  const local = parts[0];
  if (local.length < 1 || local.length > 64 || !/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+$/i.test(local) ||
      local.includes('..') || local.startsWith('.') || local.endsWith('.')) return null;
  let domain;
  try { domain = domainToASCII(parts[1]); } catch { return null; }
  if (!domain || domain.length > 253 || !domain.includes('.') || !domain.split('.').every(label =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) return null;
  const email = `${local}@${domain}`;
  return email.length <= 254 ? email : null;
}

export function recipientAddresses(values, depth = 0) {
  if (!Array.isArray(values) || depth > 10) return [];
  const addresses = values.flatMap(value => {
    const email = normalizeEmail(typeof value === 'string' ? value : value?.address);
    return email ? [email] : recipientAddresses(value?.group, depth + 1);
  });
  return [...new Set(addresses)];
}

// Local children retain exact SMTP-envelope isolation. Forwarded children in
// another domain are classified by their original To/Cc, only after confirming
// that the actual envelope delivered this message to the selected main mailbox.
export function matchesRecipient(message, target, source) {
  target = normalizeEmail(target);
  if (!target || source?.provider !== 'mx') return false;
  const envelopes = recipientAddresses(message.envelopeRecipients);
  const main = normalizeEmail(source.email);
  const domain = source.mxDomain || source.mx_domain || main?.split('@')[1];
  if (!domain || target.split('@')[1] === domain) return envelopes.includes(target);
  return !!main && envelopes.includes(main) &&
    [...recipientAddresses(message.to), ...recipientAddresses(message.cc)].includes(target);
}

export function matchesPlatform(message, platform) {
  if (!platform) return true;
  let email;
  try {
    const from = message.from;
    email = normalizeEmail(typeof from === 'object' ? from?.address : addressParser(String(from || ''), { flatten: true })[0]?.address);
  } catch { return false; }
  if (!email) return false;
  const domain = email.split('@')[1];
  const emails = platform.emails || platform.senderEmails || [];
  const domains = platform.domains || platform.senderDomains || [];
  const keywords = platform.keywords || platform.subjectKeywords || [];
  const senderMatches = emails.some(item => String(item).toLowerCase() === email) || domains.some(item => {
    const rule = String(item).toLowerCase();
    return domain === rule || domain.endsWith(`.${rule}`);
  });
  return senderMatches && (!keywords.length || keywords.some(item => String(message.subject || '').toLowerCase().includes(String(item).toLowerCase())));
}
