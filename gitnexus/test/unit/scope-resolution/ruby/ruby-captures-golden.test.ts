/**
 * Golden capture-parity test for `emitRubyScopeCaptures` (issue #1848 follow-up,
 * PR #1918).
 *
 * Pins the exact capture output of `emitRubyScopeCaptures` across the whole
 * `test/fixtures/lang-resolution/ruby-*` corpus plus a synthetic generated-DAO
 * source, so any future drift in the Ruby scope-capture path fails CI rather
 * than only being caught by a coarse perf tripwire or the bench-harness
 * fingerprint (which is not committed as a test).
 *
 * This is a FORWARD-DRIFT guard: it locks in the current (post-#1918, verified)
 * output as the baseline. It does not independently re-prove the original
 * pre-fix parity — that was established during PR #1918.
 *
 * Regenerate the golden intentionally with `UPDATE_GOLDEN=1` in the environment.
 *
 * Per fixture the snapshot stores `{ captureGroups, digest }`:
 *   - captureGroups: number of capture matches (makes a count change legible)
 *   - digest: sha256 of a match-grouped, order-sensitive (emission-order)
 *     canonicalization (see canonicalize* below). Order-sensitivity is safe
 *     because emitRubyScopeCaptures output is deterministic, and it makes the
 *     digest a true byte-identical guard (a reordering refactor is real drift).
 *     Nothing path/time/id-dependent leaks in.
 *
 * Pattern: mirrors test/unit/scope-resolution/go/go-captures-golden.test.ts.
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { emitRubyScopeCaptures } from '../../../../src/core/ingestion/languages/ruby/index.js';
import type { CaptureMatch } from 'gitnexus-shared';

// This test lives at test/unit/scope-resolution/ruby/, so fixtures are THREE
// levels up (like the sibling go-captures-golden.test.ts).
const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', '..', 'fixtures', 'lang-resolution');
const GOLDEN_DIR = path.resolve(__dirname, '..', '..', '..', 'fixtures', 'ruby-captures-golden');
const GOLDEN_FILE = path.join(GOLDEN_DIR, 'expected-captures.json');

const UPDATE = process.env.UPDATE_GOLDEN === '1';

interface FixtureSnapshot {
  captureGroups: number;
  digest: string;
}
type Snapshot = Record<string, FixtureSnapshot>;

/**
 * Canonicalize ONE match. A CaptureMatch is a Record<tag, Capture> (multiple
 * captures per match), so we group by match to preserve match identity:
 * build one `tag|text|startLine:startCol-endLine:endCol` string per capture,
 * sort them within the match, and join. We deliberately do NOT flatten every
 * capture into one global list — that would lose match boundaries.
 */
function canonicalizeMatch(match: CaptureMatch): string {
  const parts: string[] = [];
  for (const tag of Object.keys(match)) {
    const cap = match[tag]!;
    const r = cap.range;
    parts.push(`${tag}|${cap.text}|${r.startLine}:${r.startCol}-${r.endLine}:${r.endCol}`);
  }
  parts.sort();
  return parts.join(';');
}

/** Order-sensitive (emission-order) digest of a full capture result (match-grouped). */
function digestCaptures(matches: readonly CaptureMatch[]): string {
  // No cross-match sort: the digest reflects emission order so a reordering
  // refactor surfaces as drift. Within-match key order IS normalized
  // (canonicalizeMatch sorts), since a CaptureMatch is an unordered Record.
  const matchStrings = matches.map(canonicalizeMatch);
  return crypto.createHash('sha256').update(matchStrings.join('\n')).digest('hex');
}

function snapshotOf(src: string, filePath: string): FixtureSnapshot {
  const matches = emitRubyScopeCaptures(src, filePath);
  return { captureGroups: matches.length, digest: digestCaptures(matches) };
}

/** All `.rb` files under `lang-resolution/ruby-*`, as sorted repo-relative-ish keys. */
function collectRubyFixtures(): { key: string; absPath: string }[] {
  const out: { key: string; absPath: string }[] = [];
  for (const entry of fs.readdirSync(FIXTURE_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('ruby-')) continue;
    const stack = [path.join(FIXTURE_ROOT, entry.name)];
    while (stack.length) {
      const dir = stack.pop()!;
      for (const c of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, c.name);
        if (c.isDirectory()) stack.push(p);
        else if (c.name.endsWith('.rb')) {
          out.push({ key: path.relative(FIXTURE_ROOT, p).split(path.sep).join('/'), absPath: p });
        }
      }
    }
  }
  out.sort((a, b) => a.key.localeCompare(b.key));
  return out;
}

/**
 * Small deterministic generated-DAO source — the #1848 shape at correctness
 * scale. Mirrors the `ruby` unit shape in bench/scope-capture/measure.mjs.
 */
function generateDao(entityCount: number): string {
  let src = '';
  for (let i = 0; i < entityCount; i++) {
    src +=
      `class Entity${i}\n` +
      `  def get_id\n    @id\n  end\n` +
      `  def set_name(v)\n    @name = v\n  end\nend\n\n`;
  }
  return src;
}

function buildSnapshot(): Snapshot {
  const snap: Snapshot = {};
  for (const { key, absPath } of collectRubyFixtures()) {
    snap[key] = snapshotOf(fs.readFileSync(absPath, 'utf8'), absPath);
  }
  snap['synthetic:dao-20'] = snapshotOf(generateDao(20), 'zz_generated_dao.rb');
  // Stable key order for deterministic JSON serialization.
  return Object.fromEntries(
    Object.keys(snap)
      .sort()
      .map((k) => [k, snap[k]!]),
  );
}

function formatGolden(snap: Snapshot): string {
  return JSON.stringify(snap, null, 2) + '\n';
}

/**
 * Pure decision for what the golden test should do — extracted so the
 * fail-on-missing-in-CI rule is unit-testable without touching the filesystem
 * (and can never corrupt the committed golden). A missing golden must NOT
 * self-heal in CI; locally it regenerates as a first-run convenience.
 */
type GoldenAction = 'regenerate' | 'compare' | 'fail';
function resolveGoldenAction(opts: {
  update: boolean;
  exists: boolean;
  isCI: boolean;
}): GoldenAction {
  if (opts.update) return 'regenerate';
  if (!opts.exists) return opts.isCI ? 'fail' : 'regenerate';
  return 'compare';
}

describe('Ruby scope captures — golden parity', () => {
  it('matches the committed golden snapshot across all ruby-* fixtures + DAO shape', () => {
    const snapshot = buildSnapshot();

    // Read the golden once (no existsSync-then-use, which is a TOCTOU race):
    // ENOENT means the golden is missing; reuse `existing` for the compare path.
    let existing: string | undefined;
    try {
      existing = fs.readFileSync(GOLDEN_FILE, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    const action = resolveGoldenAction({
      update: UPDATE,
      exists: existing !== undefined,
      isCI: !!process.env.CI, // truthy check: fires on any CI runner, not just CI==='true'
    });

    if (action === 'fail') {
      throw new Error(
        `[ruby-captures-golden] golden file missing at ${GOLDEN_FILE} in CI. A missing golden must ` +
          `not self-heal in CI — regenerate it locally with UPDATE_GOLDEN=1 and commit it.`,
      );
    }

    if (action === 'regenerate') {
      fs.mkdirSync(GOLDEN_DIR, { recursive: true });
      fs.writeFileSync(GOLDEN_FILE, formatGolden(snapshot), 'utf8');
      console.log(
        `[ruby-captures-golden] ${UPDATE ? 'Regenerated' : 'Created'} golden at ${GOLDEN_FILE}`,
      );
      return;
    }

    const expected: Snapshot = JSON.parse(existing!);
    expect(
      snapshot,
      'emitRubyScopeCaptures output drifted from the committed golden. If this drift is intentional ' +
        '(or the digest scheme changed), regenerate with ' +
        'UPDATE_GOLDEN=1 npx vitest run test/unit/scope-resolution/ruby/ruby-captures-golden.test.ts',
    ).toEqual(expected);
  });

  // The fail-on-missing-in-CI rule, asserted purely (no filesystem mutation).
  it.each([
    { update: true, exists: false, isCI: true, expected: 'regenerate' },
    { update: false, exists: false, isCI: true, expected: 'fail' },
    { update: false, exists: false, isCI: false, expected: 'regenerate' },
    { update: false, exists: true, isCI: true, expected: 'compare' },
    { update: false, exists: true, isCI: false, expected: 'compare' },
  ])(
    'resolveGoldenAction($update,$exists,$isCI) -> $expected',
    ({ update, exists, isCI, expected }) => {
      expect(resolveGoldenAction({ update, exists, isCI })).toBe(expected);
    },
  );

  it('produces a deterministic digest across repeated runs', () => {
    const src = generateDao(8);
    expect(digestCaptures(emitRubyScopeCaptures(src, 'a.rb'))).toBe(
      digestCaptures(emitRubyScopeCaptures(src, 'a.rb')),
    );
  });

  it('digest is sensitive to capture-match emission order', () => {
    const matches = emitRubyScopeCaptures(generateDao(6), 'a.rb');
    expect(matches.length).toBeGreaterThan(1);
    const reversed = [...matches].reverse();
    // Reordering the emission changes the digest — the true byte-identical guard.
    expect(digestCaptures(reversed)).not.toBe(digestCaptures(matches));
  });

  it('records a capture-group count for every fixture and the DAO shape', () => {
    const snapshot = buildSnapshot();
    const fixtureKeys = collectRubyFixtures().map((f) => f.key);
    // Every collected fixture is present in the snapshot.
    for (const k of fixtureKeys) expect(snapshot[k]).toBeDefined();
    // The DAO shape (which has symbols) yields a non-empty capture set.
    expect(snapshot['synthetic:dao-20']!.captureGroups).toBeGreaterThan(0);
  });

  // PR #1918 P3 dedup regression: the constructor-return inference dedup is now
  // computed from a snapshot of the YARD-pass return keys, not a LIVE `out.some`
  // that also saw bindings this very loop pushed. The old code could
  // cross-suppress the 2nd of two same-named methods one source row apart whose
  // bodies both end in `Const.new`. Pin that BOTH bindings are emitted now.
  it('emits both constructor-return bindings for two same-named methods (no cross-suppression)', () => {
    const src =
      'class A\n  def foo\n    X.new\n  end\nend\n' + 'class B\n  def foo\n    Y.new\n  end\nend\n';
    const matches = emitRubyScopeCaptures(src, 'dedup.rb');

    const returnBindings = matches.filter(
      (m) =>
        m['@type-binding.return'] !== undefined &&
        m['@type-binding.name'] !== undefined &&
        m['@type-binding.name']!.text === 'foo',
    );
    // Both foo->X and foo->Y must survive; the old live-some dedup dropped one.
    expect(returnBindings.length).toBe(2);
    const boundTypes = returnBindings.map((m) => m['@type-binding.type']!.text).sort();
    expect(boundTypes).toEqual(['X', 'Y']);
  });
});
