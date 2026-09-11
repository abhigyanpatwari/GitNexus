/**
 * Build-free bench for Python workspace from-import scanning (#3254).
 *
 * WHY THIS EXISTS. `scanPythonImports` now tree-sitter-parses every `.py` file
 * that looks like it has a `from` import. Graph output does not show "how many
 * files we parsed" or "we skipped an unclosed-docstring lookalike" — a revert
 * to column-0 regex, a dropped `parseHadErrors` guard, or a removed `from`
 * prefilter can still emit the same one contract on a tiny fixture. This file
 * is the same shape as `bench/parse-dispatch-rounds`: exact floors first, one
 * ratio timing arm, never a millisecond ceiling.
 *
 * ARMS:
 *
 * - `from_links` / `lookalike_links` / `no_from_links` — EXACT. The
 *   correctness floor. The from-corpus must still discover `datalib::Record`.
 *   Closed + unclosed docstring lookalikes must stay at 0. Files with no
 *   `from` token must stay at 0.
 *
 * - `from_files` / `no_from_files` / `lookalike_files` — EXACT, and they are
 *   the FLOOR. `from_links === 1` only asserts something while the corpus
 *   still has many files to walk. Shrink it to one happy-path file and the
 *   link arm still passes, gating a property the corpus no longer has.
 *
 * - `layout_fingerprint` — EXACT. sha256 over sorted `from|to|contract` rows
 *   on the from-corpus. Catches a contract-set change that leaves the count
 *   intact.
 *
 * - `scan_scaling_ratio` — the only mixed-corpus timing arm, a RATIO not a
 *   millisecond ceiling. `(t_4n / t_n) / 4` divides the machine out; ~1.0 is
 *   linear. Superlinear AST work over file count lands here.
 *
 * - `prefilter_advantage` — `t_from / t_nofrom` at the same file count. The
 *   no-from corpus is large Python with no `from` token. A working prefilter
 *   keeps that arm cheap; removing it collapses the ratio toward 1 because
 *   both sides parse.
 *
 * Usage:
 *   node --import tsx bench/python-workspace-import-scan/measure.mjs
 *   node --import tsx bench/python-workspace-import-scan/measure.mjs --check
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { extractPythonWorkspaceLinks } from '../../src/core/group/extractors/python-workspace-extractor.ts';

const baselines = JSON.parse(
  readFileSync(new URL('./baselines.json', import.meta.url), 'utf8'),
);

const REPS = 15;
const FROM_FILES = 40;
const NO_FROM_FILES = 40;
const LOOKALIKE_FILES = 8;
const NO_FROM_BODY = Array.from(
  { length: 80 },
  (_, i) => `def helper_${i}(x):\n    return x + ${i}\n`,
).join('\n');

function writeWorkspace(root, { fromCount, noFromCount, lookalikeCount }) {
  mkdirSync(path.join(root, 'lib', 'datalib'), { recursive: true });
  writeFileSync(
    path.join(root, 'lib', 'pyproject.toml'),
    '[project]\nname = "datalib"\nversion = "0.1.0"\ndependencies = []\n',
  );
  writeFileSync(path.join(root, 'lib', 'datalib', 'models.py'), 'class Record: pass\n');

  mkdirSync(path.join(root, 'app', 'myapp'), { recursive: true });
  writeFileSync(
    path.join(root, 'app', 'pyproject.toml'),
    '[project]\nname = "myapp"\nversion = "0.1.0"\ndependencies = ["datalib"]\n',
  );

  for (let i = 0; i < fromCount; i++) {
    writeFileSync(
      path.join(root, 'app', 'myapp', `from_${i}.py`),
      `${NO_FROM_BODY}\ndef load_${i}():\n    from datalib.models import Record\n    return Record()\n`,
    );
  }
  for (let i = 0; i < noFromCount; i++) {
    writeFileSync(path.join(root, 'app', 'myapp', `plain_${i}.py`), NO_FROM_BODY);
  }
  for (let i = 0; i < lookalikeCount; i++) {
    const closed = i % 2 === 0;
    writeFileSync(
      path.join(root, 'app', 'myapp', `doc_${i}.py`),
      closed
        ? `def describe_${i}():\n    """Example:\n    from datalib.models import Record\n    """\n    return None\n`
        : `def describe_${i}():\n    """\n    from datalib.models import Record\n`,
    );
  }

  return {
    repos: { lib: 'datalib', app: 'myapp' },
    repoPaths: new Map([
      ['lib', path.join(root, 'lib')],
      ['app', path.join(root, 'app')],
    ]),
  };
}

async function scan(workspace) {
  return extractPythonWorkspaceLinks(workspace.repos, workspace.repoPaths);
}

function fingerprint(links) {
  return createHash('sha256')
    .update(
      links
        .map((l) => `${l.from}|${l.to}|${l.contract}`)
        .sort()
        .join('\n'),
    )
    .digest('hex');
}

async function fastest(fn, reps) {
  await fn();
  let best = Infinity;
  for (let r = 0; r < reps; r++) {
    const t0 = performance.now();
    await fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

const roots = [];
function workspace(opts) {
  const root = mkdtempSync(path.join(tmpdir(), 'gn-py-ws-bench-'));
  roots.push(root);
  return writeWorkspace(root, opts);
}

try {
  const fromWs = workspace({
    fromCount: FROM_FILES,
    noFromCount: 0,
    lookalikeCount: 0,
  });
  const noFromWs = workspace({
    fromCount: 0,
    noFromCount: NO_FROM_FILES,
    lookalikeCount: 0,
  });
  const lookalikeWs = workspace({
    fromCount: 0,
    noFromCount: 0,
    lookalikeCount: LOOKALIKE_FILES,
  });
  const mixedWs = workspace({
    fromCount: FROM_FILES,
    noFromCount: NO_FROM_FILES,
    lookalikeCount: LOOKALIKE_FILES,
  });
  const mixed4x = workspace({
    fromCount: FROM_FILES * 4,
    noFromCount: NO_FROM_FILES * 4,
    lookalikeCount: LOOKALIKE_FILES * 4,
  });

  const [fromResult, noFromResult, lookalikeResult] = await Promise.all([
    scan(fromWs),
    scan(noFromWs),
    scan(lookalikeWs),
  ]);
  const layoutFingerprint = fingerprint(fromResult.links);

  const fromMs = await fastest(() => scan(fromWs), REPS);
  const noFromMs = await fastest(() => scan(noFromWs), REPS);
  const smallMs = await fastest(() => scan(mixedWs), REPS);
  const largeMs = await fastest(() => scan(mixed4x), REPS);
  const scanScaling = largeMs / smallMs / 4;
  const prefilterAdvantage = noFromMs === 0 ? Infinity : fromMs / noFromMs;

  console.log(`from_files             : ${FROM_FILES}  (expect ${baselines.from_files})`);
  console.log(`no_from_files          : ${NO_FROM_FILES}  (expect ${baselines.no_from_files})`);
  console.log(
    `lookalike_files        : ${LOOKALIKE_FILES}  (expect ${baselines.lookalike_files})`,
  );
  console.log(`from_links             : ${fromResult.links.length}  (expect ${baselines.from_links})`);
  console.log(
    `lookalike_links        : ${lookalikeResult.links.length}  (expect ${baselines.lookalike_links})`,
  );
  console.log(
    `no_from_links          : ${noFromResult.links.length}  (expect ${baselines.no_from_links})`,
  );
  console.log(`layout_fingerprint     : ${layoutFingerprint}`);
  console.log(
    `scan_scaling_ratio     : ${scanScaling.toFixed(3)}  (budget <= ${baselines.scan_scaling_budget}; ~1.0 is linear)`,
  );
  console.log(
    `prefilter_advantage    : ${prefilterAdvantage.toFixed(3)}  (floor >= ${baselines.prefilter_advantage_floor})`,
  );
  console.log(
    `reps                   : ${REPS}   from ${fromMs.toFixed(2)}ms / no_from ${noFromMs.toFixed(2)}ms / mixed ${smallMs.toFixed(2)}ms / 4x ${largeMs.toFixed(2)}ms`,
  );

  if (process.argv.includes('--check')) {
    let failed = false;

    if (layoutFingerprint !== baselines.layout_fingerprint) {
      failed = true;
      console.error(
        `\nFAIL layout_fingerprint: ${layoutFingerprint}\n` +
          `  expected ${baselines.layout_fingerprint}\n` +
          `  The from-corpus contract set moved. Explain it; do not re-baseline alone.`,
      );
    }

    if (fromResult.links.length !== baselines.from_links) {
      failed = true;
      console.error(
        `\nFAIL from_links: ${fromResult.links.length}, expected exactly ${baselines.from_links}.`,
      );
    }
    if (lookalikeResult.links.length !== baselines.lookalike_links) {
      failed = true;
      console.error(
        `\nFAIL lookalike_links: ${lookalikeResult.links.length}, expected exactly ${baselines.lookalike_links}.\n` +
          `  Closed or unclosed docstring lookalikes leaked a workspace contract.`,
      );
    }
    if (noFromResult.links.length !== baselines.no_from_links) {
      failed = true;
      console.error(
        `\nFAIL no_from_links: ${noFromResult.links.length}, expected exactly ${baselines.no_from_links}.`,
      );
    }

    if (
      FROM_FILES !== baselines.from_files ||
      NO_FROM_FILES !== baselines.no_from_files ||
      LOOKALIKE_FILES !== baselines.lookalike_files
    ) {
      failed = true;
      console.error(
        `\nFAIL shape: from_files ${FROM_FILES} (expected ${baselines.from_files}), ` +
          `no_from_files ${NO_FROM_FILES} (expected ${baselines.no_from_files}), ` +
          `lookalike_files ${LOOKALIKE_FILES} (expected ${baselines.lookalike_files}).\n` +
          `  The corpus must stay large enough that the link arms still measure a walk.`,
      );
    }

    if (scanScaling > baselines.scan_scaling_budget) {
      failed = true;
      console.error(
        `\nFAIL scan_scaling_ratio: ${scanScaling.toFixed(3)} exceeds ` +
          `${baselines.scan_scaling_budget} (~1.0 is linear).\n` +
          `  Re-run on an idle machine before investigating, and check \`reps\` first.`,
      );
    }

    if (prefilterAdvantage < baselines.prefilter_advantage_floor) {
      failed = true;
      console.error(
        `\nFAIL prefilter_advantage: ${prefilterAdvantage.toFixed(3)} below ` +
          `${baselines.prefilter_advantage_floor}.\n` +
          `  The no-from corpus should stay cheaper than the from-corpus. A collapse\n` +
          `  toward 1.0 usually means every file is being tree-sitter parsed again.`,
      );
    }

    if (failed) process.exit(1);
    console.log('\nOK — within budget.');
  }
} finally {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
}
