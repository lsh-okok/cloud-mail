export function normalizeBasePath(value = '') {
  if (value === '' || value === '/') return '';
  if (typeof value !== 'string' || !/^\/(?:[a-zA-Z0-9_-]+\/?)+$/.test(value) || value.includes('//')) {
    throw new Error('APP_BASE_PATH must be an absolute path of plain URL segments');
  }
  return value.replace(/\/$/, '');
}

export function publicBaseUrl(env, requestUrl) {
  const saved = env.db.prepare('SELECT public_base_url FROM feature_settings WHERE id = 1').get()?.public_base_url;
  return String(saved || env.public_base_url || `${env.app_url || new URL(requestUrl).origin}${env.base_path || ''}`).replace(/\/+$/, '');
}

export function publicUrl(env, requestUrl, path) {
  return `${publicBaseUrl(env, requestUrl)}/${path.replace(/^\/+/, '')}`;
}
