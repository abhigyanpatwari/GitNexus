/**
 * Golden capture-parity test for `emitPythonScopeCaptures`.
 *
 * Pins the exact capture output of `emitPythonScopeCaptures` across the whole
 * `test/fixtures/lang-resolution/python-*` corpus plus a synthetic DAO-style
 * source, so any future drift in the Python scope-capture path fails CI rather
 * than only being caught by a coarse perf tripwire or pipeline-level resolver
 * tests.
 *
 * This is the correctness anchor for the O(n^2) -> O(n) rewrite of
 * emitPythonScopeCaptures (threading the tree-sitter query's captured node
 * instead of re-deriving it with findNodeAtRange from the tree root — the same
 * fix shipped for Go in #1848). It is a FORWARD-DRIFT guard: it locks in the
 * current verified output as the baseline.
 *
 * Regenerate the golden intentionally with `UPDATE_GOLDEN=1` in the environment.
 *
 * Per fixture the snapshot stores `{ captureGroups, digest }`:
 *   - captureGroups: number of capture matches (makes a count change legible)
 *   - digest: sha256 of a match-grouped, order-independent canonicalization.
 *     Nothing path/time/id-dependent leaks in.
 *
 * Pattern: mirrors test/unit/scope-resolution/go/go-captures-golden.test.ts.
 */
import { describe, it, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { emitPythonScopeCaptures } from '../../../../src/core/ingestion/languages/python/index.js';
import type { CaptureMatch } from 'gitnexus-shared';

// This test lives at test/unit/scope-resolution/python/, so fixtures are FOUR
// levels up.
const FIXTURE_ROOT = path.resolve(__dirname, '..', '..', '..', 'fixtures', 'lang-resolution');
const GOLDEN_DIR = path.resolve(__dirname, '..', '..', '..', 'fixtures', 'python-captures-golden');
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

/** Order-independent digest of a full capture result (match-grouped). */
function digestCaptures(matches: readonly CaptureMatch[]): string {
  const matchStrings = matches.map(canonicalizeMatch).sort();
  return crypto.createHash('sha256').update(matchStrings.join('\n')).digest('hex');
}

function snapshotOf(src: string, filePath: string): FixtureSnapshot {
  const matches = emitPythonScopeCaptures(src, filePath);
  return { captureGroups: matches.length, digest: digestCaptures(matches) };
}

/** All `.py` files under `lang-resolution/python-*`, as sorted repo-relative-ish keys. */
function collectPythonFixtures(): { key: string; absPath: string }[] {
  const out: { key: string; absPath: string }[] = [];
  for (const entry of fs.readdirSync(FIXTURE_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('python-')) continue;
    const stack = [path.join(FIXTURE_ROOT, entry.name)];
    while (stack.length) {
      const dir = stack.pop()!;
      for (const c of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, c.name);
        if (c.isDirectory()) stack.push(p);
        else if (c.name.endsWith('.py')) {
          out.push({ key: path.relative(FIXTURE_ROOT, p).split(path.sep).join('/'), absPath: p });
        }
      }
    }
  }
  out.sort((a, b) => a.key.localeCompare(b.key));
  return out;
}

/**
 * Small deterministic generated-DAO source — exercises imports, class scopes,
 * methods (@scope.function / @declaration.function / receiver binding), and
 * module functions, the shape that stresses the scope-capture path at scale.
 */
function generateDao(entityCount: number): string {
  const lines: string[] = [];
  for (let i = 0; i < 4; i++) {
    lines.push(`from pkg.mod${i} import alpha${i}, beta${i} as b${i}`);
    lines.push(`import top.level.module${i}`);
  }
  lines.push('');
  for (let i = 0; i < entityCount; i++) {
    const n = String(i).padStart(4, '0');
    lines.push(
      `class Entity${n}:`,
      `    def __init__(self, id: int, name: str):`,
      `        self.id = id`,
      `        self.name = name`,
      `    def get_id(self) -> int:`,
      `        return self.id`,
      `    @classmethod`,
      `    def make(cls, id: int):`,
      `        return cls(id, "x")`,
      '',
      `def build_entity${n}(id: int) -> Entity${n}:`,
      `    return Entity${n}(id, "x")`,
      '',
    );
  }
  return lines.join('\n');
}

function buildSnapshot(): Snapshot {
  const snap: Snapshot = {};
  for (const { key, absPath } of collectPythonFixtures()) {
    snap[key] = snapshotOf(fs.readFileSync(absPath, 'utf8'), absPath);
  }
  snap['synthetic:dao-20'] = snapshotOf(generateDao(20), 'zz_generated_dao.py');
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

describe('Python scope captures — golden parity', () => {
  it('matches the committed golden snapshot across all python-* fixtures + DAO shape', () => {
    const snapshot = buildSnapshot();

    if (UPDATE || !fs.existsSync(GOLDEN_FILE)) {
      fs.mkdirSync(GOLDEN_DIR, { recursive: true });
      fs.writeFileSync(GOLDEN_FILE, formatGolden(snapshot), 'utf8');
      console.log(
        `[python-captures-golden] ${UPDATE ? 'Regenerated' : 'Created'} golden at ${GOLDEN_FILE}`,
      );
      return;
    }

    const expected: Snapshot = JSON.parse(fs.readFileSync(GOLDEN_FILE, 'utf8'));
    expect(
      snapshot,
      'emitPythonScopeCaptures output drifted from the committed golden. If this drift is ' +
        'intentional, regenerate with UPDATE_GOLDEN=1 npx vitest run ' +
        'test/unit/scope-resolution/python/python-captures-golden.test.ts',
    ).toEqual(expected);
  });

  it('produces a deterministic digest across repeated runs', () => {
    const src = generateDao(8);
    expect(digestCaptures(emitPythonScopeCaptures(src, 'a.py'))).toBe(
      digestCaptures(emitPythonScopeCaptures(src, 'a.py')),
    );
  });

  it('digest is independent of capture-match array order', () => {
    const matches = emitPythonScopeCaptures(generateDao(6), 'a.py');
    const reversed = [...matches].reverse();
    expect(digestCaptures(reversed)).toBe(digestCaptures(matches));
  });

  it('records a capture-group count for every fixture and the DAO shape', () => {
    const snapshot = buildSnapshot();
    const fixtureKeys = collectPythonFixtures().map((f) => f.key);
    for (const k of fixtureKeys) expect(snapshot[k]).toBeDefined();
    expect(snapshot['synthetic:dao-20']!.captureGroups).toBeGreaterThan(0);
  });
});
