import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWatchFileLoop } from '../../dist/cli/analyze-watch.js';
import { loadWatch } from '../../dist/cli/watch-backend.js';

const expected = await import(process.argv[2]);
assert.equal(await loadWatch(), expected.watch);

const dir = await mkdtemp(join(tmpdir(), 'gitnexus-watch-backend-'));
try {
  const loop = await startWatchFileLoop(dir, 25, async () => {}, assert.fail);
  await loop.close();
} finally {
  await rm(dir, { recursive: true, force: true });
}
