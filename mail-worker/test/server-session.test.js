import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { loadConfig } from '../src/server/config.js';
import { createEnvironment } from '../src/server/environment.js';
import { createApp } from '../src/server/app.js';

const resources = [];

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cloud-mail-session-'));
  const config = loadConfig({
    MAIL_DOMAINS: 'example.com', MAIL_HOST: 'mail.example.com', ADMIN_EMAIL: 'admin@example.com',
    ADMIN_PASSWORD: 'session-test-password-123', JWT_SECRET: 'session-test-secret-at-least-32-characters',
    APP_URL: 'https://mail.example.com', DATA_DIR: root, STATIC_DIR: root,
  });
  const resource = { root, env: await createEnvironment(config) };
  resources.push(resource);
  let app = createApp(resource.env);

  async function request(path, { method = 'GET', token, data } = {}) {
    const response = await app.request(`https://mail.example.com/api${path}`, {
      method,
      headers: {
        'content-type': 'application/json', 'accept-language': 'en',
        ...(token ? { Authorization: token } : {}),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    }, resource.env);
    return response.json();
  }

  async function login() {
    const result = await request('/login', {
      method: 'POST', data: { email: config.admin, password: config.admin_password },
    });
    expect(result.code, result.message).toBe(200);
    return result.data.token;
  }

  async function restart() {
    resource.env.db.close();
    // Existing databases restart without repeating the initial administrator password.
    resource.env = await createEnvironment({ ...config, admin_password: undefined });
    app = createApp(resource.env);
  }

  return { request, login, restart };
}

afterEach(() => {
  for (const { root, env } of resources.splice(0)) {
    if (env.db.open) env.db.close();
    if (!resolve(root).startsWith(`${resolve(tmpdir())}${sep}`) || !basename(root).startsWith('cloud-mail-session-')) {
      throw new Error('Unexpected session test directory.');
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe('login session persistence through application restarts', () => {
  it('preserves active sessions and keeps a selectively logged-out token revoked after reopening SQLite', async () => {
    const { request, login, restart } = await fixture();
    const first = await login();
    const second = await login();
    expect(first).not.toBe(second);

    await restart();
    for (const token of [first, second]) {
      const current = await request('/my/loginUserInfo', { token });
      expect(current.code, current.message).toBe(200);
      expect(current.data.email).toBe('admin@example.com');
      expect(current.data.permKeys).toEqual(['*']);
    }

    const loggedOut = await request('/logout', { method: 'DELETE', token: first });
    expect(loggedOut.code, loggedOut.message).toBe(200);
    expect((await request('/my/loginUserInfo', { token: first })).code).toBe(401);
    expect((await request('/my/loginUserInfo', { token: second })).code).toBe(200);

    await restart();
    expect((await request('/my/loginUserInfo', { token: first })).code).toBe(401);
    expect((await request('/my/loginUserInfo', { token: second })).code).toBe(200);
    const third = await login();
    expect((await request('/my/loginUserInfo', { token: third })).code).toBe(200);
  });
});
