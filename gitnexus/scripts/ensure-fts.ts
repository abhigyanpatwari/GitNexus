/**
 * Install the LadybugDB FTS and VECTOR extensions into the shared home (~/.lbdb)
 * up front, so every test in a sharded CI run finds them regardless of shard.
 *
 * FTS-dependent tests split two ways: the LOAD-path gate (skipUnlessFtsAvailable)
 * self-installs on miss, but the FILE-path gate (requireFtsResourceOrSkip, e.g.
 * extension-binary-real.test.ts) resolves the extension path at module load and
 * cannot self-install. Sharding (and the balancing sequencer) can drop such a
 * test into a shard with no installer sibling — this step removes that ordering
 * dependency by installing FTS once before vitest starts. `auto` is LOAD-first,
 * so a cache-warmed extension costs no network.
 *
 * Best-effort: exits 0 on failure (offline etc.) — the per-test gates still
 * hard-fail under GITNEXUS_REQUIRE_FTS=1 if FTS is genuinely unavailable, which
 * is where the loud signal belongs.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initLbug,
  loadFTSExtension,
  loadVectorExtension,
  closeLbug,
} from '../src/core/lbug/lbug-adapter.js';

const dir = mkdtempSync(join(tmpdir(), 'gn-ensure-fts-'));
try {
  await initLbug(join(dir, 'ensure-fts.lbug'));
  const ok = await loadFTSExtension(undefined, { policy: 'auto' });
  console.log(ok ? 'FTS extension ready.' : 'FTS extension unavailable (continuing).');
  // VECTOR rides the same pre-install (#2623): the win32 gate is gone, so the
  // vector suites genuinely run on Windows/macOS — installing once here means
  // every sharded test process LOADs from ~/.lbdb instead of racing its own
  // out-of-process INSTALL (bounded 15s each when the server is unreachable).
  const vec = await loadVectorExtension(undefined, { policy: 'auto' });
  console.log(vec ? 'VECTOR extension ready.' : 'VECTOR extension unavailable (continuing).');
} catch (err) {
  console.warn(`ensure-fts: skipped (${err instanceof Error ? err.message : String(err)})`);
} finally {
  await closeLbug();
  rmSync(dir, { recursive: true, force: true });
}
