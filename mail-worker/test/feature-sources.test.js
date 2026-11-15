import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase } from '../src/server/database.js';
import { BASELINE_SQL } from '../src/server/schema.js';
import { FOUNDATION_SCHEMA } from '../src/modules/shared/schema.js';
import { SOURCE_SCHEMA } from '../src/modules/mail-sources/schema.js';
import { getSourceMailbox, assertSourceReadable, saveSourceMailbox, readSourceMessages, matchesRecipient, matchesPlatform, normalizeEmail } from '../src/modules/mail-sources/service.js';

const databases = [];
function fixture() {
  const db = createDatabase(':memory:'); databases.push(db);
  db.exec(BASELINE_SQL); db.exec(FOUNDATION_SCHEMA); db.exec(SOURCE_SCHEMA);
  const user = Number(db.prepare("INSERT INTO user(email,password,salt) VALUES('admin@example.com','fixture','fixture')").run().lastInsertRowid);
  const account = Number(db.prepare("INSERT INTO account(email,user_id) VALUES('a@example.com',?)").run(user).lastInsertRowid);
  const env = { db, domain: ['example.com'], admin: 'admin@example.com' };
  const source = saveSourceMailbox(env, { provider: 'mx', email: 'a@example.com', localAccountId: account });
  const message = (recipient, subject, from = 'sender@platform.example', text = subject) => db.prepare(`INSERT INTO email
    (account_id,user_id,to_email,subject,send_email,text,create_time) VALUES(?,?,?,?,?,?,?)`).run(account, user, recipient, subject, from, text, '2026-11-13 01:00:00');
  return { env, db, account, source, user, message };
}
const counts = db => Object.fromEntries(['source_mailbox', 'source_secret', 'sync_event', 'feature_audit'].map(table =>
  [table, db.prepare(`SELECT count(*) count FROM ${table}`).get().count]));
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close(); });

describe('main MX mailbox and child recipient sources', () => {
  it('reads a1/a2/a3 through one main account while isolating exact envelope addresses and plus tags', async () => {
    const { env, source, message } = fixture();
    message('a1@example.com', 'A1 private'); message('a2@example.com', 'A2 private'); message('a3@example.com', 'A3 private');
    message('a1+other@example.com', 'Other plus address'); message('a1+tag@example.com', 'Exact plus address');
    for (const name of ['a1', 'a2', 'a3']) {
      const result = await readSourceMessages(env, source.id, { recipient: `${name}@example.com` });
      expect(result.messages.map(row => row.subject)).toEqual([`${name.toUpperCase()} private`]);
    }
    expect((await readSourceMessages(env, source.id, { recipient: 'A1+TAG@example.com' })).messages.map(row => row.subject)).toEqual(['Exact plus address']);
    expect((await readSourceMessages(env, source.id, { recipient: 'none@example.com' })).messages).toEqual([]);
  });

  it('excludes other local accounts, sent mail and deleted mail even when the envelope matches', async () => {
    const { env, db, user, source, message } = fixture();
    const other = Number(db.prepare("INSERT INTO account(email,user_id) VALUES('b@example.com',?)").run(user).lastInsertRowid);
    message('a1@example.com', 'Allowed');
    const wrongAccount = message('a1@example.com', 'Other main account').lastInsertRowid;
    const sent = message('a1@example.com', 'Sent mail').lastInsertRowid;
    const deleted = message('a1@example.com', 'Deleted mail').lastInsertRowid;
    db.prepare('UPDATE email SET account_id=? WHERE email_id=?').run(other, wrongAccount);
    db.prepare('UPDATE email SET type=1 WHERE email_id=?').run(sent);
    db.prepare('UPDATE email SET is_del=1 WHERE email_id=?').run(deleted);
    expect((await readSourceMessages(env, source.id, { recipient: 'a1@example.com' })).messages.map(row => row.subject)).toEqual(['Allowed']);
  });

  it('filters platform before choosing latest and rejects similar domain suffixes', async () => {
    const { env, source, message } = fixture();
    message('a1@example.com', 'Code older valid', 'verify@login.platform.example');
    message('a1@example.com', 'Code lookalike', 'verify@fakeplatform.example');
    message('a1@example.com', 'Unrelated newer', 'verify@platform.example');
    message('a2@example.com', 'Code wrong recipient', 'verify@platform.example');
    const result = await readSourceMessages(env, source.id, { recipient: 'a1@example.com', limit: 1,
      platform: { domains: ['platform.example'], keywords: ['CODE'] } });
    expect(result.messages.map(row => row.subject)).toEqual(['Code older valid']);
  });

  it('returns stable message IDs and follows requested latest or oldest order', async () => {
    const { env, source, message } = fixture();
    const older = message('a1@example.com', 'Older').lastInsertRowid;
    const newer = message('a1@example.com', 'Newer').lastInsertRowid;
    expect((await readSourceMessages(env, source.id, { recipient: 'a1@example.com', limit: 1 })).messages[0].id).toBe(`mx:${newer}`);
    const result = await readSourceMessages(env, source.id, { recipient: 'a1@example.com', order: 'oldest', limit: 1 });
    expect(result.messages[0]).toMatchObject({ id: `mx:${older}`, receivedAt: '2026-11-13T01:00:00.000Z' });
  });

  it('keeps public identity stable, emits safe events, and rejects stale updates', async () => {
    const { env, source, db } = fixture();
    const changed = saveSourceMailbox(env, { enabled: false, revision: source.revision }, { id: source.id });
    expect(changed.publicId).toBe(source.publicId);
    expect(changed.publicId).toMatch(/^[a-z0-9]{10}$/);
    expect(changed).toMatchObject({ revision: 2, generation: 2 });
    expect(() => saveSourceMailbox(env, { enabled: true, revision: 1 }, { id: source.id })).toThrow('changed');
    await expect(readSourceMessages(env, source.id, { recipient: 'a1@example.com' })).rejects.toMatchObject({ status: 404 });
    expect(counts(db)).toMatchObject({ sync_event: 2, feature_audit: 2, source_secret: 0 });
    const events = db.prepare('SELECT payload_json FROM sync_event ORDER BY cursor').all().map(row => JSON.parse(row.payload_json));
    expect(events[1]).toEqual(changed);
    expect(changed).not.toHaveProperty('hasCredentials');
    expect(changed).not.toHaveProperty('credentials');
  });

  it.each(['outlook', 'icloud'])('rejects %s creation and provider updates without any partial writes', provider => {
    const { env, source, db } = fixture();
    const before = counts(db);
    expect(() => saveSourceMailbox(env, { provider, email: `main@${provider}.com`, credentials: { private: 'must-not-persist' } }))
      .toThrow(expect.objectContaining({ status: 400, code: 'UNSUPPORTED_PROVIDER' }));
    expect(() => saveSourceMailbox(env, { provider, revision: source.revision }, { id: source.id }))
      .toThrow(expect.objectContaining({ status: 400, code: 'UNSUPPORTED_PROVIDER' }));
    expect(counts(db)).toEqual(before);
    expect(getSourceMailbox(env, source.id)).toEqual(source);
  });

  it('rejects external credentials on an MX source without writing secrets or changing its revision', () => {
    const { env, source, db } = fixture();
    const before = counts(db);
    expect(() => saveSourceMailbox(env, { email: 'b@example.com', mxDomain: 'example.com', credentials: { password: 'private' } }))
      .toThrow(expect.objectContaining({ code: 'MX_CREDENTIALS_UNSUPPORTED' }));
    expect(() => saveSourceMailbox(env, { revision: source.revision, credentials: {} }, { id: source.id }))
      .toThrow(expect.objectContaining({ code: 'MX_CREDENTIALS_UNSUPPORTED' }));
    expect(counts(db)).toEqual(before);
    expect(getSourceMailbox(env, source.id)).toEqual(source);
  });

  it.each(['outlook', 'icloud'])('preserves historical %s records and secret bytes while denying service reads and edits', async provider => {
    const { env, db } = fixture();
    const id = `legacy-${provider}`;
    db.prepare(`INSERT INTO source_mailbox(id,email,provider,public_id,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).run(id, `main@${provider}.com`, provider, provider === 'outlook' ? 'legacy0001' : 'legacy0002', 123, 456);
    db.prepare('INSERT INTO source_secret(mailbox_id,envelope_json,updated_at) VALUES(?,?,?)')
      .run(id, '{"version":1,"ciphertext":"historical-bytes"}', 789);
    const before = db.prepare('SELECT * FROM source_mailbox WHERE id=?').get(id);
    const secret = db.prepare('SELECT * FROM source_secret WHERE mailbox_id=?').get(id);
    const beforeCounts = counts(db);
    expect(() => getSourceMailbox(env, id)).toThrow(expect.objectContaining({ status: 400, code: 'UNSUPPORTED_PROVIDER' }));
    expect(() => assertSourceReadable(env, id)).toThrow(expect.objectContaining({ status: 404, code: 'MAILBOX_UNAVAILABLE' }));
    await expect(readSourceMessages(env, id, { recipient: `child@${provider}.com` })).rejects.toMatchObject({ status: 404, code: 'MAILBOX_UNAVAILABLE' });
    expect(() => saveSourceMailbox(env, { enabled: false, revision: 1 }, { id })).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_PROVIDER' }));
    expect(() => saveSourceMailbox(env, { provider: 'mx', email: 'b@example.com', mxDomain: 'example.com', revision: 1 }, { id }))
      .toThrow(expect.objectContaining({ code: 'UNSUPPORTED_PROVIDER' }));
    expect(db.prepare('SELECT * FROM source_mailbox WHERE id=?').get(id)).toEqual(before);
    expect(db.prepare('SELECT * FROM source_secret WHERE mailbox_id=?').get(id)).toEqual(secret);
    expect(counts(db)).toEqual(beforeCounts);
  });

  it('rolls back the source, revision and event when an audit write fails', () => {
    const { env, db, source } = fixture();
    const before = counts(db);
    db.exec("CREATE TRIGGER prevent_source_audit BEFORE INSERT ON feature_audit BEGIN SELECT RAISE(ABORT,'audit failure'); END");
    expect(() => saveSourceMailbox(env, { email: 'b@example.com', mxDomain: 'example.com' })).toThrow('audit failure');
    expect(() => saveSourceMailbox(env, { enabled: false, revision: 1 }, { id: source.id })).toThrow('audit failure');
    expect(counts(db)).toEqual(before);
    expect(getSourceMailbox(env, source.id)).toEqual(source);
  });

  it('accepts recipient evidence only from exact SMTP envelopes', () => {
    const source = { provider: 'mx' }, target = 'a1+tag@example.com';
    expect(matchesRecipient({ envelopeRecipients: ['A1+TAG@example.com'] }, target, source)).toBe(true);
    expect(matchesRecipient({ envelopeRecipients: ['a1@example.com', 'a1+other@example.com'] }, target, source)).toBe(false);
    expect(matchesRecipient({ to: [target], cc: [target], text: target, headers: { 'delivered-to': [target] } }, target, source)).toBe(false);
    expect(matchesRecipient({ envelopeRecipients: [target] }, target, { provider: 'outlook' })).toBe(false);
    expect(matchesRecipient({ envelopeRecipients: [target] }, 'invalid', source)).toBe(false);
    expect(matchesPlatform({ from: '"Verification" <verify@login.platform.example>', subject: 'Your CODE' }, { domains: ['platform.example'], keywords: ['code'] })).toBe(true);
    expect(matchesPlatform({ from: { address: 'verify@platform.example' }, subject: 'Code' }, { emails: ['verify@platform.example'] })).toBe(true);
    expect(matchesPlatform({ from: 'a@fakeplatform.example', subject: 'Code' }, { domains: ['platform.example'] })).toBe(false);
  });

  it('respects cancellation and rejects oversized bodies instead of returning truncated content', async () => {
    const { env, source, message } = fixture();
    const controller = new AbortController(); controller.abort();
    await expect(readSourceMessages(env, source.id, { recipient: 'a1@example.com', signal: controller.signal })).rejects.toMatchObject({ code: 'READ_CANCELLED' });
    message('a1@example.com', 'Too large', 'a@example.com', 'x'.repeat(2 * 1024 * 1024 + 1));
    await expect(readSourceMessages(env, source.id, { recipient: 'a1@example.com' })).rejects.toMatchObject({ code: 'MESSAGE_TOO_LARGE' });
  });

  it('bounds the complete recipient snapshot instead of returning a partial batch', async () => {
    const { env, db, source, message } = fixture();
    const body = 'x'.repeat(2 * 1024 * 1024);
    db.transaction(() => { for (let index = 0; index < 8; index++) message('a1@example.com', `Message ${index}`, 'a@example.com', body); })();
    await expect(readSourceMessages(env, source.id, { recipient: 'a1@example.com' })).rejects.toMatchObject({ code: 'MAILBOX_SNAPSHOT_TOO_LARGE' });
  });

  it('validates source IDs and domain labels and can explicitly switch MX scope', () => {
    const { env, source, account } = fixture();
    for (const input of [undefined, null, {}, 123, 'a/b']) expect(() => getSourceMailbox(env, input)).toThrow('valid source mailbox ID');
    for (const email of ['a@-invalid.example', 'a@invalid-.example', 'a@invalid..example', 'a@example.com.', 'a..b@example.com']) expect(normalizeEmail(email)).toBeNull();
    expect(normalizeEmail('A+TAG@例子.中国')).toBe('a+tag@xn--fsqu00a.xn--fiqs8s');
    const domain = saveSourceMailbox(env, { revision: source.revision, mxDomain: 'example.com' }, { id: source.id });
    expect(domain.localAccountId).toBeNull(); expect(domain.mxDomain).toBe('example.com');
    const local = saveSourceMailbox(env, { revision: domain.revision, localAccountId: account }, { id: source.id });
    expect(local.mxDomain).toBeNull(); expect(local.localAccountId).toBe(account);
  });

  it('requires a matching local account or configured domain and excludes foreign envelopes outside the main mailbox', async () => {
    const { env, source, account, message } = fixture();
    expect(() => saveSourceMailbox(env, { email: 'b@example.com', localAccountId: account })).toThrow(expect.objectContaining({ code: 'INVALID_LOCAL_ACCOUNT' }));
    expect(() => saveSourceMailbox(env, { email: 'b@example.com' })).toThrow(expect.objectContaining({ code: 'MX_SCOPE_REQUIRED' }));
    expect(() => saveSourceMailbox(env, { email: 'b@example.com', localAccountId: account, mxDomain: 'example.com' })).toThrow(expect.objectContaining({ code: 'MX_SCOPE_REQUIRED' }));
    expect(() => saveSourceMailbox(env, { email: 'b@other.example', mxDomain: 'other.example' })).toThrow(expect.objectContaining({ code: 'INVALID_MX_DOMAIN' }));
    message('a1@other.example', 'Wrong domain');
    expect((await readSourceMessages(env, source.id, { recipient: 'a1@other.example' })).messages).toEqual([]);
    const domain = saveSourceMailbox(env, { email: 'domain@example.com', mxDomain: 'example.com' });
    message('a1@example.com', 'Domain scoped message');
    expect((await readSourceMessages(env, domain.id, { recipient: 'a1@example.com' })).messages.map(row => row.subject)).toEqual(['Domain scoped message']);
    env.domain = [];
    expect(() => assertSourceReadable(env, domain.id)).toThrow(expect.objectContaining({ code: 'MAILBOX_UNAVAILABLE' }));
  });

  it('revalidates linked account and user lifecycle without relying on a source revision change', () => {
    const { env, db, source, account, user } = fixture();
    expect(assertSourceReadable(env, source.id).id).toBe(source.id);
    for (const [table, column, id, key] of [
      ['account', 'status', account, 'account_id'], ['account', 'is_del', account, 'account_id'],
      ['user', 'status', user, 'user_id'], ['user', 'is_del', user, 'user_id'],
    ]) {
      db.prepare(`UPDATE ${table} SET ${column}=1 WHERE ${key}=?`).run(id);
      expect(() => assertSourceReadable(env, source.id)).toThrow('unavailable');
      expect(getSourceMailbox(env, source.id).revision).toBe(source.revision);
      expect(() => saveSourceMailbox(env, { revision: source.revision }, { id: source.id })).toThrow(expect.objectContaining({ code: 'INVALID_LOCAL_ACCOUNT' }));
      db.prepare(`UPDATE ${table} SET ${column}=0 WHERE ${key}=?`).run(id);
    }
    db.prepare('DELETE FROM account WHERE account_id=?').run(account);
    expect(() => assertSourceReadable(env, source.id)).toThrow('unavailable');
  });
});
