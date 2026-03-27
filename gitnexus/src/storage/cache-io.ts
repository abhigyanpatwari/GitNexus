/**
 * Shared cache I/O utilities.
 * Atomic JSON file read/write with version validation.
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

export function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export async function loadJsonCache<T extends { version: number }>(
  storagePath: string,
  filename: string,
  expectedVersion: number,
): Promise<T | null> {
  try {
    const raw = await fs.readFile(path.join(storagePath, filename), 'utf-8');
    const parsed = JSON.parse(raw) as T;
    if (parsed.version !== expectedVersion) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function saveJsonCache(
  storagePath: string,
  filename: string,
  data: unknown,
): Promise<void> {
  await fs.mkdir(storagePath, { recursive: true });
  const cachePath = path.join(storagePath, filename);
  const tmpPath = cachePath + '.tmp';
  await fs.writeFile(tmpPath, JSON.stringify(data), 'utf-8');
  await fs.rename(tmpPath, cachePath);
}

export async function deleteJsonCache(
  storagePath: string,
  filename: string,
): Promise<void> {
  try {
    await fs.rm(path.join(storagePath, filename), { force: true });
  } catch {
    // Already gone or never existed
  }
}
