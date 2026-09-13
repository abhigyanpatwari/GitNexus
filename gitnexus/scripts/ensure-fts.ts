/**
 * Make FTS and VECTOR resolvable for every shard before vitest starts.
 *
 * After vendoring, FTS is ready when the packaged artifact exists — LOAD
 * no longer writes `~/.lbdb`, and the FILE-path gates resolve that artifact
 * (or a leftover home install). When no artifact is present yet, fall back
 * to one bounded `auto` INSTALL so shards without an installer sibling still
 * find a file.
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
import { resolveVendoredFtsPath } from '../src/core/lbug/vendored-extension-path.js';

const dir = mkdtempSync(join(tmpdir(), 'gn-ensure-fts-'));
try {
  await initLbug(join(dir, 'ensure-fts.lbug'));
  if (resolveVendoredFtsPath()) {
    console.log('FTS extension ready (vendored artifact).');
  } else {
    const ok = await loadFTSExtension(undefined, { policy: 'auto' });
    console.log(ok ? 'FTS extension ready.' : 'FTS extension unavailable (continuing).');
  }
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
