function asBuffer(value) {
	if (typeof value === 'string') return Buffer.from(value);
	if (value instanceof ArrayBuffer) return Buffer.from(value);
	if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
	return null;
}

function decodeValue(value, options) {
	const type = typeof options === 'string' ? options : options?.type || 'text';
	if (type === 'text') return value.toString('utf8');
	if (type === 'json') return JSON.parse(value.toString('utf8'));
	if (type === 'arrayBuffer') return Uint8Array.from(value).buffer;
	if (type === 'stream') return new Response(Uint8Array.from(value)).body;
	throw new TypeError(`Unsupported KV value type: ${type}`);
}

export function createKV(db, { now = () => Date.now() } = {}) {
	const select = db.prepare('SELECT value, metadata, expiration FROM server_kv WHERE key = ?');
	const remove = db.prepare('DELETE FROM server_kv WHERE key = ?');
	const put = db.prepare(`INSERT INTO server_kv (key, value, metadata, expiration) VALUES (?, ?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, metadata = excluded.metadata, expiration = excluded.expiration`);
	const seconds = () => Math.floor(now() / 1000);
	const read = (key) => {
		const row = select.get(key);
		if (row?.expiration != null && row.expiration <= seconds()) {
			remove.run(key);
			return undefined;
		}
		return row;
	};

	return {
		async get(key, options) {
			const row = read(key);
			return row ? decodeValue(row.value, options) : null;
		},
		async getWithMetadata(key, options) {
			const row = read(key);
			return row ? {
				value: decodeValue(row.value, options),
				metadata: row.metadata == null ? null : JSON.parse(row.metadata)
			} : { value: null, metadata: null };
		},
		async put(key, value, options = {}) {
			if (typeof key !== 'string' || !key) throw new TypeError('KV keys must be nonempty strings.');
			let data = asBuffer(value);
			if (!data && (value instanceof ReadableStream || value instanceof Blob)) {
				data = Buffer.from(await new Response(value).arrayBuffer());
			}
			if (!data) throw new TypeError('KV values must be text or binary data.');
			let expiration = options.expiration == null ? null : Number(options.expiration);
			if (options.expirationTtl != null) {
				const ttl = Number(options.expirationTtl);
				if (!Number.isFinite(ttl) || ttl <= 0) throw new TypeError('KV expirationTtl must be positive.');
				expiration = seconds() + Math.ceil(ttl);
			}
			if (expiration != null && (!Number.isFinite(expiration) || expiration <= seconds())) {
				throw new TypeError('KV expiration must be a future Unix timestamp.');
			}
			put.run(key, data, options.metadata == null ? null : JSON.stringify(options.metadata), expiration);
		},
		async delete(key) {
			remove.run(key);
		},
		async increment(key, delta = 1, options = {}) {
			if (!Number.isSafeInteger(delta)) throw new TypeError('KV increments must be safe integers.');
			return db.transaction(() => {
				const row = read(key);
				const previous = row ? Number(row.value.toString('utf8')) : 0;
				const value = previous + delta;
				if (!Number.isSafeInteger(previous) || !Number.isSafeInteger(value)) throw new TypeError('KV counter must be a safe integer.');
				let expiration = row?.expiration ?? null;
				if (!row && options.expirationTtl != null) {
					const ttl = Number(options.expirationTtl);
					if (!Number.isFinite(ttl) || ttl <= 0) throw new TypeError('KV expirationTtl must be positive.');
					expiration = seconds() + Math.ceil(ttl);
				}
				put.run(key, Buffer.from(String(value)), row?.metadata ?? null, expiration);
				return value;
			}).immediate();
		},
		async list({ prefix = '', limit = 1000, cursor = '' } = {}) {
			if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('KV list limit must be between 1 and 1000.');
			let after = '';
			if (cursor) {
				try {
					const position = JSON.parse(Buffer.from(cursor, 'base64url').toString());
					if (position.prefix !== prefix || typeof position.after !== 'string') throw new Error();
					after = position.after;
				} catch {
					throw new TypeError('Invalid KV list cursor.');
				}
			}
			const rows = db.prepare(`SELECT key, metadata, expiration FROM server_kv
				WHERE substr(key, 1, length(?)) = ? AND key > ? AND (expiration IS NULL OR expiration > ?)
				ORDER BY key LIMIT ?`).all(prefix, prefix, after, seconds(), limit + 1);
			const complete = rows.length <= limit;
			const page = rows.slice(0, limit);
			return {
				keys: page.map(row => ({
					name: row.key,
					...(row.expiration == null ? {} : { expiration: row.expiration }),
					...(row.metadata == null ? {} : { metadata: JSON.parse(row.metadata) })
				})),
				list_complete: complete,
				cursor: complete ? '' : Buffer.from(JSON.stringify({ prefix, after: page.at(-1).key })).toString('base64url')
			};
		},
		async purgeExpired() {
			return db.prepare('DELETE FROM server_kv WHERE expiration IS NOT NULL AND expiration <= ?').run(seconds()).changes;
		}
	};
}
