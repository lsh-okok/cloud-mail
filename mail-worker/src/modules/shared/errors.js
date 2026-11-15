export class FeatureError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'FeatureError';
    this.status = status;
    this.code = code;
  }
}

export function positiveInt(value, name = 'value', { max = Number.MAX_SAFE_INTEGER, fallback } = {}) {
  if ((value === undefined || value === null || value === '') && fallback !== undefined) return fallback;
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^[1-9]\d*$/.test(String(value))) {
    throw new FeatureError(400, 'INVALID_PARAMETER', `${name} must be a positive integer.`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > max) {
    throw new FeatureError(400, 'INVALID_PARAMETER', `${name} must be between 1 and ${max}.`);
  }
  return number;
}

// Read with an explicit bound, even if Content-Length is missing or incorrect.
export async function strictJson(c, allowedKeys, { maxBytes = 65536 } = {}) {
  const contentType = c.req.header('content-type') || '';
  if (!/^application\/json(?:\s*;|\s*$)/i.test(contentType)) {
    throw new FeatureError(415, 'JSON_REQUIRED', 'Use application/json for this request.');
  }
  const declared = c.req.header('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    throw new FeatureError(413, 'BODY_TOO_LARGE', `The request body must not exceed ${maxBytes} bytes.`);
  }
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new FeatureError(400, 'INVALID_JSON', 'A JSON object is required.');
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new FeatureError(413, 'BODY_TOO_LARGE', `The request body must not exceed ${maxBytes} bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let value;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new FeatureError(400, 'INVALID_JSON', 'The request must contain one valid JSON object.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new FeatureError(400, 'INVALID_JSON', 'A JSON object is required.');
  }
  const permitted = new Set(allowedKeys);
  if (Object.keys(value).some(key => !permitted.has(key))) {
    throw new FeatureError(400, 'UNKNOWN_FIELD', 'The request contains an unsupported field.');
  }
  return value;
}
