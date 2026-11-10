import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

/** Bind each source path and byte length before adding its contents. */
export async function sourceDigest(directory, sources) {
  const hash = createHash('sha256');
  for (const file of sources) {
    const bytes = await fs.readFile(path.join(directory, file));
    hash.update(JSON.stringify([file, bytes.length])).update(bytes);
  }
  return hash.digest('hex');
}
