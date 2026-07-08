/**
 * Install the LadybugDB FTS extension into the shared home (~/.lbdb) up front, so
 * every test in a sharded CI run finds it regardless of which shard it lands in.
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
import { initLbug, loadFTSExtension, closeLbug } from '../src/core/lbug/lbug-adapter.js';

const dir = mkdtempSync(join(tmpdir(), 'gn-ensure-fts-'));
try {
  await initLbug(join(dir, 'ensure-fts.lbug'));
  const ok = await loadFTSExtension(undefined, { policy: 'auto' });
  console.log(ok ? 'FTS extension ready.' : 'FTS extension unavailable (continuing).');
} catch (err) {
  console.warn(`ensure-fts: skipped (${err instanceof Error ? err.message : String(err)})`);
} finally {
  await closeLbug();
  rmSync(dir, { recursive: true, force: true });
}
