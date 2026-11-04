/** Filesystem-only embedding receipts; importing this never loads a model or DB. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_RECORD_BYTES = 32 * 1024;
const RECORD_NAMES = new Set([
  'manifest.json',
  'job.json',
  'space.json',
  'rebase.json',
  'legacy.json',
  'retained.json',
]);
const FAILED_RECORD_NAME = /^failed-\d{16}\.json$/;

export async function embeddingJobDirectory(directory: string): Promise<string> {
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('Embedding job directory must be an owned directory');
  return fs.realpath(directory);
}

/** Flush directory entries where the platform supports opening directories. */
export async function syncEmbeddingJobDirectory(directory: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writeEmbeddingJobRecord(
  directory: string,
  name: string,
  payload: unknown,
): Promise<void> {
  if (!RECORD_NAMES.has(name) && !FAILED_RECORD_NAME.test(name))
    throw new Error('Invalid embedding receipt name');
  const canonical = await embeddingJobDirectory(directory);
  const serialized = JSON.stringify(payload);
  if (serialized === undefined) throw new Error('Embedding receipt payload is not JSON');
  const checksum = createHash('sha256').update(serialized).digest('hex');
  const bytes = Buffer.from(JSON.stringify({ checksum, payload }), 'utf8');
  if (bytes.byteLength > MAX_RECORD_BYTES)
    throw new Error('Embedding receipt exceeds its fixed size limit');
  const temporary = path.join(canonical, `.${name}.${randomUUID()}.tmp`);
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, path.join(canonical, name));
    await syncEmbeddingJobDirectory(canonical);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/** Bounded read; malformed or untrusted receipts never become an empty job. */
export async function readEmbeddingJobRecord(directory: string, name: string): Promise<unknown> {
  if (!RECORD_NAMES.has(name) && !FAILED_RECORD_NAME.test(name))
    throw new Error('Invalid embedding receipt name');
  const canonical = await embeddingJobDirectory(directory);
  const target = path.join(canonical, name);
  if (!(await fs.lstat(target)).isFile())
    throw new Error('Embedding receipt must be a regular file');
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!(await handle.stat()).isFile())
      throw new Error('Embedding receipt must be a regular file');
    const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_RECORD_BYTES)
      throw new Error('Embedding receipt exceeds its fixed size limit');
    const parsed: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)),
    );
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !('checksum' in parsed) ||
      !('payload' in parsed)
    ) {
      throw new Error('Malformed embedding receipt');
    }
    const checksum = createHash('sha256').update(JSON.stringify(parsed.payload)).digest('hex');
    if (parsed.checksum !== checksum)
      throw new Error('Embedding receipt checksum mismatch; artifacts retained');
    return parsed.payload;
  } finally {
    await handle.close();
  }
}
