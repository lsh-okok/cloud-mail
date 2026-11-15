import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const MAGIC = Buffer.from('CMOBJ001');

async function syncDirectory(directory) {
	let handle;
	try {
		handle = await open(directory, 'r');
		await handle.sync();
	} catch (error) {
		if (process.platform !== 'win32' || !['EISDIR', 'EPERM', 'EACCES', 'EINVAL', 'ENOTSUP', 'EBADF'].includes(error.code)) throw error;
	} finally {
		await handle?.close();
	}
}

function validateKey(key) {
	if (typeof key !== 'string' || !key || key.includes('\\') || key.includes('\0') || key.startsWith('/') || key.split('/').some(part => !part || part === '.' || part === '..')) {
		throw new TypeError('Invalid storage object key.');
	}
}

function metadataHeaders(metadata = {}) {
	const headers = new Headers();
	for (const [property, name] of [['contentType', 'Content-Type'], ['contentDisposition', 'Content-Disposition'], ['cacheControl', 'Cache-Control']]) {
		if (!metadata[property]) continue;
		let value = String(metadata[property]);
		if (property === 'contentDisposition') {
			const filename = /;\s*filename=(?:"([^"]*)"|([^;]*))/i.exec(value);
			if (filename && /[^\x20-\x7e]/.test(filename[1] ?? filename[2])) {
				const original = filename[1] ?? filename[2];
				const fallback = original.replace(/[^\x20-\x7e]|["\\]/g, '_');
				const encoded = encodeURIComponent(original).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
				value = value.replace(filename[0], `; filename="${fallback}"; filename*=UTF-8''${encoded}`);
			}
		}
		headers.set(name, value);
	}
	if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/octet-stream');
	return Object.fromEntries(headers);
}

export function createStorage(rootDirectory) {
	if (!rootDirectory) throw new Error('A storage directory is required.');
	const root = resolve(rootDirectory);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const objectPath = key => {
		validateKey(key);
		const digest = createHash('sha256').update(key).digest('hex');
		return join(root, digest.slice(0, 2), digest);
	};
	return {
		async put(key, content, metadata = {}) {
			const target = objectPath(key);
			const body = Buffer.from(await new Response(content).arrayBuffer());
			const etag = `"${createHash('sha256').update(body).digest('hex')}"`;
			const encodedMetadata = Buffer.from(JSON.stringify({ key, headers: metadataHeaders(metadata), etag }));
			const header = Buffer.alloc(MAGIC.length + 4);
			MAGIC.copy(header);
			header.writeUInt32BE(encodedMetadata.length, MAGIC.length);
			const temporary = `${target}.${randomUUID()}.tmp`;
			await mkdir(dirname(target), { recursive: true, mode: 0o700 });
			try {
				// One atomic object contains metadata and bytes, so a reader cannot see
				// a new body paired with the previous object's headers after overwrite.
				const handle = await open(temporary, 'wx', 0o600);
				try {
					await handle.writeFile(Buffer.concat([header, encodedMetadata, body]));
					await handle.sync();
				} finally {
					await handle.close();
				}
				await rename(temporary, target);
				// The receiving mail service acknowledges only after this completes.
				// Persist both the object rename and newly created shard/root entries.
				await syncDirectory(dirname(target));
				await syncDirectory(root);
				await syncDirectory(dirname(root));
			} finally {
				await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
			}
			return { key, size: body.length, etag };
		},
		async get(key) {
			let bytes;
			try {
				bytes = await readFile(objectPath(key));
			} catch (error) {
				if (error.code === 'ENOENT') return null;
				throw error;
			}
			if (bytes.length < 12 || !bytes.subarray(0, 8).equals(MAGIC)) throw new Error('Invalid stored object.');
			const offset = 12 + bytes.readUInt32BE(8);
			if (offset > bytes.length) throw new Error('Truncated stored object.');
			const metadata = JSON.parse(bytes.subarray(12, offset).toString());
			if (metadata.key !== key) throw new Error('Stored object key mismatch.');
			return new Response(bytes.subarray(offset), {
				headers: { ...metadata.headers, ETag: metadata.etag, 'Content-Length': String(bytes.length - offset) }
			});
		},
		async delete(keys) {
			for (const key of typeof keys === 'string' ? [keys] : keys) {
				try { await unlink(objectPath(key)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
			}
		}
	};
}
