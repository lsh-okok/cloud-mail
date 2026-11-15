import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { FeatureError } from './errors.js';

function keyBytes(value) {
  if (Buffer.isBuffer(value) && value.length === 32) return Buffer.from(value);
  if (typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  throw new TypeError('Every data encryption key must contain exactly 32 bytes (64 hexadecimal characters).');
}

function aadBytes(aad) {
  if (typeof aad !== 'string' || !aad || aad.length > 1024) throw new TypeError('A nonempty, bounded purpose and object binding is required.');
  return Buffer.from(aad, 'utf8');
}

export function createSecretVault(keyring, { activeKeyId } = {}) {
  if (keyring == null) return null;
  if (typeof keyring !== 'object' || Array.isArray(keyring)) throw new TypeError('The data keyring must be an object.');
  if (Object.keys(keyring).length === 0) return null;
  const keys = new Map(Object.entries(keyring).map(([id, value]) => {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) throw new TypeError('Invalid data key ID.');
    return [id, keyBytes(value)];
  }));
  const active = activeKeyId || keys.keys().next().value;
  if (!keys.has(active)) throw new TypeError('The active data key is missing from the keyring.');
  return Object.freeze({
    activeKeyId: active,
    keyIds: Object.freeze([...keys.keys()]),
    encrypt(value, aad) {
      if (typeof value !== 'string') throw new TypeError('The secret must be a string.');
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', keys.get(active), nonce);
      cipher.setAAD(aadBytes(aad));
      const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return JSON.stringify({ v: 1, keyId: active, nonce: nonce.toString('base64url'),
        ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') });
    },
    decrypt(envelope, aad) {
      const binding = aadBytes(aad);
      try {
        const item = typeof envelope === 'string' ? JSON.parse(envelope) : envelope;
        if (!item || item.v !== 1 || !keys.has(item.keyId) ||
            ![item.nonce, item.ciphertext, item.tag].every(value => typeof value === 'string' && /^[A-Za-z0-9_-]*$/.test(value))) throw new Error();
        const nonce = Buffer.from(item.nonce, 'base64url'), tag = Buffer.from(item.tag, 'base64url');
        if (nonce.length !== 12 || tag.length !== 16) throw new Error();
        const decipher = createDecipheriv('aes-256-gcm', keys.get(item.keyId), nonce);
        decipher.setAAD(binding);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(Buffer.from(item.ciphertext, 'base64url')), decipher.final()]).toString('utf8');
      } catch {
        throw new FeatureError(503, 'SECRET_UNAVAILABLE', 'The protected credential cannot be opened with the configured data keys.');
      }
    },
    // Separate purpose-derived keys prevent the lookup digest from reusing AES key material directly.
    // Callers retaining digest indexes across rotations must preserve their original key ID.
    digest(value, purpose, keyId = active) {
      if (typeof value !== 'string' || !keys.has(keyId)) throw new TypeError('Invalid digest input or data key ID.');
      aadBytes(purpose);
      const derived = hkdfSync('sha256', keys.get(keyId), Buffer.from('cloud-mail-secret-index-v1'), Buffer.from(purpose), 32);
      return createHmac('sha256', derived).update(value, 'utf8').digest('hex');
    },
  });
}
