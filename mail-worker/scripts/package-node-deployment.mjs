import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const sourcePaths = [
  'Dockerfile', 'docker/app-entrypoint.sh',
  'mail-worker/package.json', 'mail-worker/pnpm-lock.yaml', 'mail-worker/pnpm-workspace.yaml',
  'mail-worker/src', 'mail-worker/scripts',
  'mail-vue/package.json', 'mail-vue/pnpm-lock.yaml', 'mail-vue/pnpm-workspace.yaml',
  'mail-vue/index.html', 'mail-vue/vite.config.js', 'mail-vue/src', 'mail-vue/public',
];
const excludedName = name => name === '.git' || name === 'data' || name === 'node_modules'
  || name === '.env' || name.startsWith('.env.') || name === 'node.env' || name.endsWith('.node.env');

async function collectFiles(root) {
  const files = [];
  async function visit(relative) {
    if (relative.split('/').some(excludedName)) return;
    if (/[\r\n\0]/.test(relative)) throw new Error('Invalid deployment source filename.');
    const stat = await lstat(join(root, relative));
    if (stat.isSymbolicLink()) throw new Error(`Deployment source cannot contain symbolic links: ${relative}`);
    if (stat.isDirectory()) {
      for (const entry of (await readdir(join(root, relative))).sort()) await visit(`${relative}/${entry}`);
    } else if (stat.isFile()) files.push({ path: relative, size: stat.size, mtime: stat.mtimeMs });
    else throw new Error(`Deployment source must be a regular file: ${relative}`);
  }
  for (const relative of sourcePaths) await visit(relative);
  return files;
}

// Node's built-in gzip plus USTAR keeps local builds working if tar is unavailable.
function tarHeader(file) {
  const header = Buffer.alloc(512);
  const pathBytes = Buffer.from(file.path);
  let name = file.path, prefix = '';
  if (pathBytes.length > 100) {
    const split = file.path.lastIndexOf('/');
    name = file.path.slice(split + 1); prefix = file.path.slice(0, split);
    if (Buffer.byteLength(name) > 100 || Buffer.byteLength(prefix) > 155) throw new Error(`Deployment source path is too long: ${file.path}`);
  }
  const text = (value, offset, length) => header.write(value, offset, length, 'utf8');
  const octal = (value, offset, length) => {
    const digits = Math.floor(value).toString(8);
    if (digits.length >= length) throw new Error('Deployment source exceeds USTAR limits.');
    text(`${digits.padStart(length - 1, '0')}\0`, offset, length);
  };
  text(name, 0, 100);
  octal(file.path.endsWith('.sh') ? 0o755 : 0o644, 100, 8);
  octal(0, 108, 8); octal(0, 116, 8);
  octal(file.size, 124, 12); octal(file.mtime / 1000, 136, 12);
  header.fill(32, 148, 156);
  text('0', 156, 1); text('ustar\0', 257, 6); text('00', 263, 2);
  text('root', 265, 32); text('root', 297, 32); text(prefix, 345, 155);
  const checksum = header.reduce((sum, value) => sum + value, 0);
  text(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return header;
}

async function writePortableArchive(root, files, destination) {
  async function* blocks() {
    for (const file of files) {
      yield tarHeader(file);
      let bytes = 0;
      for await (const chunk of createReadStream(join(root, file.path))) { bytes += chunk.length; yield chunk; }
      if (bytes !== file.size) throw new Error(`Deployment source changed while packaging: ${file.path}`);
      if (bytes % 512) yield Buffer.alloc(512 - bytes % 512);
    }
    yield Buffer.alloc(1024);
  }
  await pipeline(Readable.from(blocks()), createGzip({ level: 9 }), createWriteStream(destination));
}

export async function packageNodeDeployment({ root = repositoryRoot,
  output = join(root, 'mail-worker/server-dist/node-deploy.tar.gz') } = {}) {
  const files = await collectFiles(root);
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${randomUUID()}.tmp`;
  const list = `${temporary}.files`;
  try {
    await writeFile(list, `${files.map(file => file.path).join('\n')}\n`);
    const result = spawnSync('tar', ['-czf', temporary, '-C', root, '-T', list], {
      encoding: 'utf8', windowsHide: true,
    });
    if (result.error?.code === 'ENOENT') await writePortableArchive(root, files, temporary);
    else if (result.error || result.status !== 0) throw new Error(`Cannot package node deployment: ${result.error?.message || result.stderr.trim()}`);
    await rename(temporary, output);
    console.log(`Node deployment source: ${files.length} files packaged in ${output}`);
    return output;
  } finally {
    await rm(list, { force: true });
    await rm(temporary, { force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await packageNodeDeployment();
