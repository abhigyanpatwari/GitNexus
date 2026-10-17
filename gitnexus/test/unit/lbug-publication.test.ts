import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { assertLbugPublicationReady } from '../../src/core/lbug/publication.js';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-publication-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

it('allows a settling sidecar to disappear before the bounded publication check', async () => {
  const db = path.join(root, 'lbug');
  await fs.writeFile(`${db}.wal`, 'settling');
  const removal = new Promise<void>((resolve, reject) =>
    setTimeout(() => {
      fs.unlink(`${db}.wal`).then(resolve, reject);
    }, 10),
  );
  await assertLbugPublicationReady(db);
  await removal;
});

it.each([
  '.wal',
  '.shadow',
  '.wal.checkpoint',
  '.checkpoint.intent.lock',
  '.checkpoint.apply.lock',
  '.wal.missing-shadow.1234-abcd',
  '.shadow.orphan.1234',
])('refuses a persistent %s and names the affected database', async (suffix) => {
  const db = path.join(root, 'lbug');
  await fs.writeFile(`${db}${suffix}`, 'pending recovery');
  await expect(assertLbugPublicationReady(db)).rejects.toThrow(db);
  expect(await fs.readFile(`${db}${suffix}`, 'utf8')).toBe('pending recovery');
});
