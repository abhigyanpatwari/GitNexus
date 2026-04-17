/**
 * Golden-file graph-parity test.
 *
 * Runs the full ingestion pipeline on the `mini-repo` fixture and compares
 * the resulting graph against a committed golden JSON. Guards against silent
 * behavioural drift from future refactors (post-U1–U7).
 *
 * Regenerate the golden file intentionally by running the test with
 * `UPDATE_GOLDEN=1` in the environment.
 *
 * The snapshot captures:
 *   - totalFileCount
 *   - symbols (node count) and relationships (edge count)
 *   - byType: sorted map of NodeLabel -> count
 *   - byRelType: sorted map of RelationshipType -> count
 *   - processes count
 *   - edgeDigest: sha256 of deterministically-sorted `"type|src|dst"` strings
 *
 * Nothing path-dependent, time-dependent, or id-opaque leaks into the snapshot.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

const FIXTURE_SRC = path.resolve(__dirname, '..', 'fixtures', 'mini-repo');
const GOLDEN_DIR = path.resolve(__dirname, '..', 'fixtures', 'pipeline-golden', 'mini-repo');
const GOLDEN_FILE = path.join(GOLDEN_DIR, 'expected-graph.json');

const UPDATE = process.env.UPDATE_GOLDEN === '1';

interface GraphSnapshot {
  /**
   * Tag to clarify provenance and to prime reviewers when the file first
   * lands. Rewriting this string has no semantic meaning — only drift of
   * the other fields matters for test pass/fail.
   */
  capture: string;
  fixture: string;
  totalFileCount: number;
  symbols: number;
  relationships: number;
  processes: number;
  byType: Record<string, number>;
  byRelType: Record<string, number>;
  edgeDigest: string;
}

/**
 * Build a deterministic snapshot from a pipeline result.
 *
 * All maps are sorted by key so JSON serialization is stable. Edge digest
 * is a sha256 over newline-joined, lexicographically-sorted `type|src|dst`
 * triples — where `src` and `dst` are symbolic names (node label + property
 * name + filePath for files) so that id generation changes don't cause
 * spurious digest churn if they don't change the semantic edge set.
 */
function buildSnapshot(result: PipelineResult): GraphSnapshot {
  const byType: Record<string, number> = {};
  const byRelType: Record<string, number> = {};

  // Node id -> stable symbolic key for digest
  const nodeKey = new Map<string, string>();

  result.graph.forEachNode((n) => {
    byType[n.label] = (byType[n.label] ?? 0) + 1;
    const props = n.properties as Record<string, unknown>;
    const fp = (props.filePath as string | undefined) ?? '';
    const nm = (props.name as string | undefined) ?? '';
    // Symbolic key: stable across id-format refactors as long as the
    // (label, name, filePath) tuple is unchanged.
    nodeKey.set(n.id, `${n.label}:${nm}@${fp}`);
  });

  const edgeTriples: string[] = [];
  for (const rel of result.graph.iterRelationships()) {
    byRelType[rel.type] = (byRelType[rel.type] ?? 0) + 1;
    const src = nodeKey.get(rel.sourceId) ?? `?:${rel.sourceId}`;
    const dst = nodeKey.get(rel.targetId) ?? `?:${rel.targetId}`;
    // step included for STEP_IN_PROCESS so the digest captures ordering
    const step = rel.step !== undefined ? `#${rel.step}` : '';
    edgeTriples.push(`${rel.type}${step}|${src}|${dst}`);
  }
  edgeTriples.sort();

  const digest = crypto.createHash('sha256').update(edgeTriples.join('\n')).digest('hex');

  return {
    capture: 'initial capture (U8, post-U1–U7)',
    fixture: 'mini-repo',
    totalFileCount: result.totalFileCount,
    symbols: result.graph.nodeCount,
    relationships: result.graph.relationshipCount,
    processes: result.processResult?.stats.totalProcesses ?? 0,
    byType: sortObject(byType),
    byRelType: sortObject(byRelType),
    edgeDigest: digest,
  };
}

function sortObject(obj: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}

function formatGolden(snapshot: GraphSnapshot): string {
  return JSON.stringify(snapshot, null, 2) + '\n';
}

function diffCounts(
  label: string,
  actual: Record<string, number>,
  expected: Record<string, number>,
): string[] {
  const lines: string[] = [];
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  for (const k of [...keys].sort()) {
    const a = actual[k] ?? 0;
    const e = expected[k] ?? 0;
    if (a !== e) lines.push(`  ${label}.${k}: expected ${e}, got ${a}`);
  }
  return lines;
}

describe('pipeline graph golden', () => {
  let result: PipelineResult;
  let snapshot: GraphSnapshot;
  let tmpDir: string;

  beforeAll(async () => {
    // Copy the fixture to a temp directory so parallel tests (cli-e2e)
    // that create AGENTS.md / CLAUDE.md / .claude/ in the shared fixture
    // don't pollute the golden snapshot.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-golden-'));
    fs.cpSync(FIXTURE_SRC, tmpDir, { recursive: true });

    result = await runPipelineFromRepo(tmpDir, () => {});
    snapshot = buildSnapshot(result);
  }, 60000);

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('matches committed golden snapshot on mini-repo', () => {
    if (UPDATE || !fs.existsSync(GOLDEN_FILE)) {
      fs.mkdirSync(GOLDEN_DIR, { recursive: true });
      fs.writeFileSync(GOLDEN_FILE, formatGolden(snapshot), 'utf8');
      // First run / intentional regen: succeed and report.
      // Subsequent CI runs without UPDATE_GOLDEN will diff against this file.
      console.log(
        `[pipeline-graph-golden] ${UPDATE ? 'Regenerated' : 'Created'} golden file at ${GOLDEN_FILE}`,
      );
      return;
    }

    const rawExpected = fs.readFileSync(GOLDEN_FILE, 'utf8');
    const expected = JSON.parse(rawExpected) as GraphSnapshot;

    const diffs: string[] = [];
    if (snapshot.totalFileCount !== expected.totalFileCount) {
      diffs.push(
        `  totalFileCount: expected ${expected.totalFileCount}, got ${snapshot.totalFileCount}`,
      );
    }
    if (snapshot.symbols !== expected.symbols) {
      diffs.push(`  symbols (nodeCount): expected ${expected.symbols}, got ${snapshot.symbols}`);
    }
    if (snapshot.relationships !== expected.relationships) {
      diffs.push(
        `  relationships (edgeCount): expected ${expected.relationships}, got ${snapshot.relationships}`,
      );
    }
    if (snapshot.processes !== expected.processes) {
      diffs.push(`  processes: expected ${expected.processes}, got ${snapshot.processes}`);
    }
    diffs.push(...diffCounts('byType', snapshot.byType, expected.byType));
    diffs.push(...diffCounts('byRelType', snapshot.byRelType, expected.byRelType));
    if (snapshot.edgeDigest !== expected.edgeDigest) {
      diffs.push(
        `  edgeDigest changed: the set of (type, source-symbol, target-symbol) edge triples differs from golden. ` +
          `Counts may match while edges are rewired — inspect graph manually or re-run with UPDATE_GOLDEN=1 if the change is intentional.`,
      );
    }

    if (diffs.length > 0) {
      const msg = [
        'Pipeline graph output drifted from golden snapshot.',
        `Golden file: ${GOLDEN_FILE}`,
        'Changes:',
        ...diffs,
        '',
        'If this drift is intentional, regenerate the golden file with:',
        '  UPDATE_GOLDEN=1 npm --prefix gitnexus test -- pipeline-graph-golden',
      ].join('\n');
      throw new Error(msg);
    }

    // Belt-and-suspenders: if nothing diffed, the serialized forms should match too.
    expect(formatGolden(snapshot)).toBe(rawExpected);
  });
});
