import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/server/database.js';
import { loadConfig } from '../src/server/config.js';
import { createSecretVault } from '../src/modules/shared/secrets.js';
import { FOUNDATION_SCHEMA } from '../src/modules/shared/schema.js';
import { parseTrustedProxies, resolveClientIp } from '../src/modules/shared/proxy.js';
import { normalizeBasePath, publicBaseUrl, publicUrl } from '../src/modules/shared/urls.js';

const databases = [];
const request = headers => ({ header: name => headers[name] });
const base = { MAIL_DOMAINS: 'example.com', JWT_SECRET: 'test-secret-with-at-least-32-characters' };
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close(); });

describe('trusted reverse proxy boundary', () => {
  it('uses the socket identity for untrusted peers even when they forge forwarding headers', () => {
    const headers = request({ 'x-real-ip': '198.51.100.1', 'x-forwarded-for': '198.51.100.2, 10.0.0.4' });
    expect(resolveClientIp({ trust_proxy: true, trusted_proxies: ['10.0.0.0/8'] }, headers, '203.0.113.8')).toBe('203.0.113.8');
    expect(resolveClientIp({ trust_proxy: false, trusted_proxies: ['10.0.0.0/8'] }, headers, '10.0.0.4')).toBe('10.0.0.4');
    expect(resolveClientIp({ trust_proxy: true, trusted_proxies: [] }, headers, '10.0.0.4')).toBe('10.0.0.4');
    expect(resolveClientIp({ trust_proxy: true, trusted_proxies: ['10.0.0.0/8'] }, headers, undefined)).toBe('Unknown');
  });

  it('walks trusted IPv4/IPv6 hops from the socket and stops at the nearest untrusted address', () => {
    const env = { trust_proxy: true, trusted_proxies: ['10.0.0.0/8', '2001:db8:1::/48'] };
    expect(resolveClientIp(env, request({ 'x-forwarded-for': '198.51.100.9, 203.0.113.5, 10.0.0.2' }), '10.0.0.3')).toBe('203.0.113.5');
    expect(resolveClientIp(env, request({ 'x-forwarded-for': '2001:db8:2::7, 2001:db8:1::2' }), '2001:db8:1::3')).toBe('2001:db8:2::7');
    expect(resolveClientIp(env, request({ 'x-forwarded-for': '198.51.100.9, ::ffff:10.0.0.2' }), '::ffff:10.0.0.3')).toBe('198.51.100.9');
    expect(resolveClientIp(env, request({ 'x-forwarded-for': '198.51.100.9' }), '::ffff:a00:3')).toBe('198.51.100.9');
  });

  it('rejects malformed and oversized forwarding chains instead of trusting another forged header', () => {
    const env = { trust_proxy: true, trusted_proxies: ['10.0.0.0/8'] };
    for (const header of ['198.51.100.9, garbage', 'unknown', '198.51.100.9,,10.0.0.2', '198.51.100.9:1234', 'x'.repeat(4097), Array(33).fill('10.0.0.2').join(',')]) {
      expect(resolveClientIp(env, request({ 'x-forwarded-for': header, 'x-real-ip': '203.0.113.99' }), '10.0.0.1')).toBe('10.0.0.1');
    }
    expect(resolveClientIp(env, request({ 'x-real-ip': '198.51.100.9' }), '10.0.0.1')).toBe('198.51.100.9');
    expect(resolveClientIp(env, request({ 'x-real-ip': 'invalid' }), '10.0.0.1')).toBe('10.0.0.1');
  });

  it('validates explicit CIDR configuration and defaults to no proxy trust', () => {
    for (const entry of ['example.com', '10.0.0.1/33', '2001:db8::/129', '10.0.0.1/-1', '10.0.0.1/', '10.0.0.1/8/9']) {
      expect(() => parseTrustedProxies(entry)).toThrow('TRUSTED_PROXIES');
    }
    expect(loadConfig(base).trust_proxy).toBe(false);
    expect(loadConfig({ ...base, TRUST_PROXY: 'true' }).trust_proxy).toBe(false);
    expect(loadConfig({ ...base, TRUSTED_PROXIES: '10.0.0.0/8,2001:db8:1::/48' }).trust_proxy).toBe(true);
    expect(loadConfig({ ...base, TRUSTED_PROXIES: '10.0.0.0/8', TRUST_PROXY: 'false' }).trust_proxy).toBe(false);
  });
});

describe('public roots and deployment prefixes', () => {
  it('accepts only normalized deployment path segments and rejects path escape syntax', () => {
    expect(normalizeBasePath()).toBe('');
    expect(normalizeBasePath('/')).toBe('');
    expect(normalizeBasePath('/mail/')).toBe('/mail');
    expect(normalizeBasePath('/team/mail_box-1')).toBe('/team/mail_box-1');
    for (const path of ['mail', '//mail', '/mail//x', '/mail/../admin', '/mail/%2fadmin', '/mail?q=1', '/mail#x', '/mail\\x']) {
      expect(() => normalizeBasePath(path)).toThrow('APP_BASE_PATH');
    }
    const config = loadConfig({ ...base, APP_BASE_PATH: '/mail/' });
    expect(config.base_path).toBe('/mail');
    expect(() => loadConfig({ ...base, APP_BASE_PATH: '/mail/../x' })).toThrow('APP_BASE_PATH');
  });

  it('preserves public prefixes and prefers saved settings over environment and request origins', () => {
    const db = createDatabase(':memory:'); databases.push(db); db.exec(FOUNDATION_SCHEMA);
    const env = { db, app_url: 'https://mail.example.com', base_path: '/mail' };
    expect(publicUrl(env, 'https://forged.example/path', '/m/token')).toBe('https://mail.example.com/mail/m/token');
    env.public_base_url = 'https://public.example.com/receive/';
    expect(publicUrl(env, 'https://forged.example/path', 'm/token')).toBe('https://public.example.com/receive/m/token');
    db.prepare('UPDATE feature_settings SET public_base_url=?').run('https://saved.example.com/inbox/');
    expect(publicBaseUrl(env, 'https://forged.example/path')).toBe('https://saved.example.com/inbox');
    expect(publicUrl(env, 'https://forged.example/path', 'api/mailboxes/token/messages')).toBe('https://saved.example.com/inbox/api/mailboxes/token/messages');
  });

  it('validates explicit public roots without silently allowing credentials or insecure public destinations', () => {
    expect(loadConfig({ ...base, PUBLIC_BASE_URL: 'https://public.example.com/mail/' }).public_base_url).toBe('https://public.example.com/mail');
    expect(loadConfig({ ...base, PUBLIC_BASE_URL: 'http://127.0.0.1:3000/mail' }).public_base_url).toBe('http://127.0.0.1:3000/mail');
    for (const url of ['http://public.example.com/mail', 'https://user:secret@public.example.com/mail', 'https://public.example.com/mail?q=1', 'https://public.example.com/mail#fragment', 'file:///mail']) {
      expect(() => loadConfig({ ...base, PUBLIC_BASE_URL: url })).toThrow('PUBLIC_BASE_URL');
    }
  });
});

describe('data key deployment validation', () => {
  it('supports an explicit active key and previous keys while keeping legacy deployments optional', () => {
    expect(loadConfig(base).data_keys).toEqual({});
    const key = '11'.repeat(32), oldKey = '22'.repeat(32);
    const config = loadConfig({ ...base, DATA_ENCRYPTION_KEY: key, DATA_ENCRYPTION_KEY_ID: 'next', DATA_ENCRYPTION_PREVIOUS_KEYS: JSON.stringify({ old: oldKey }) });
    expect(config.data_key_id).toBe('next');
    expect(config.data_keys).toEqual({ old: oldKey, next: key });
    const vault = createSecretVault(config.data_keys, { activeKeyId: config.data_key_id });
    expect(vault.activeKeyId).toBe('next');
  });

  it('rejects malformed key maps, missing active keys, invalid identifiers and non-32-byte keys', () => {
    for (const value of ['[]', 'null', '123', 'invalid-json']) {
      expect(() => loadConfig({ ...base, DATA_ENCRYPTION_PREVIOUS_KEYS: value })).toThrow('DATA_ENCRYPTION_PREVIOUS_KEYS');
    }
    expect(() => loadConfig({ ...base, DATA_ENCRYPTION_PREVIOUS_KEYS: JSON.stringify({ old: '22'.repeat(32) }) })).toThrow('active data encryption key');
    expect(() => loadConfig({ ...base, DATA_ENCRYPTION_KEY_ID: 'has space', DATA_ENCRYPTION_KEY: '11'.repeat(32) })).toThrow('DATA_ENCRYPTION_KEY_ID');
    for (const key of ['short', 'xx'.repeat(32), '11'.repeat(31)]) {
      expect(() => loadConfig({ ...base, DATA_ENCRYPTION_KEY: key })).toThrow('64 hexadecimal');
    }
  });

  it('rejects prototype-related key IDs instead of silently losing the configured encryption key', () => {
    for (const id of ['__proto__', 'constructor', 'prototype']) {
      expect(() => loadConfig({ ...base, DATA_ENCRYPTION_KEY_ID: id, DATA_ENCRYPTION_KEY: '11'.repeat(32) })).toThrow('DATA_ENCRYPTION_KEY_ID');
      const previous = `{"${id}":"${'22'.repeat(32)}"}`;
      expect(() => loadConfig({ ...base, DATA_ENCRYPTION_KEY: '11'.repeat(32), DATA_ENCRYPTION_PREVIOUS_KEYS: previous })).toThrow('safe key IDs');
    }
  });
});
