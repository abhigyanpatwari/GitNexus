/**
 * P1 Integration Tests: CLI --limit flag E2E
 *
 * Verifies that the --limit flag correctly truncates results for all 5
 * tool commands: context, impact, cypher, detect-changes, query.
 *
 * Uses the same subprocess spawn pattern as cli-e2e.test.ts.
 * Copies mini-repo fixture to a temp dir, runs analyze, then tests
 * --limit truncation against each command.
 *
 * Assertions are exact (per DoD.md §"Assertions are meaningful") and
 * unconditional — no `if (status === null) return` / `if (Array.isArray)`
 * guards that would let a broken --limit slice pass vacuously. Targets are
 * chosen so the no-limit baseline genuinely exceeds the limit (e.g. `logMessage`
 * has 2 callers and 4 processes), so a no-op slice turns the test red.
 *
 * @see src/cli/tool.ts — limit application logic
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

import { cleanupTempDirSync } from '../helpers/test-db.js';
import { CLI_SPAWN_PREFIX } from '../helpers/cli-entry.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_SRC = path.resolve(testDir, '..', 'fixtures', 'mini-repo');

let MINI_REPO: string;
let tmpParent: string;
let suiteGitnexusHome: string;

function cliEnv(extraEnv: Record<string, string> = {}) {
  return {
    ...process.env,
    GITNEXUS_HOME: suiteGitnexusHome,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=8192`.trim(),
    ...extraEnv,
  };
}

function runCliRaw(extraArgs: string[], cwd: string, timeoutMs = 30000) {
  return spawnSync(process.execPath, [...CLI_SPAWN_PREFIX, ...extraArgs], {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: cliEnv(),
  });
}

/**
 * Parse stdout as JSON, returning null on failure (e.g., text output).
 */
function parseStdout(result: ReturnType<typeof runCliRaw>): unknown {
  try {
    return JSON.parse(result.stdout.trim());
  } catch {
    return null;
  }
}

// ─── Typed result shapes (avoid `any`; just the fields these tests read) ──────
type CallBuckets = { calls?: unknown[]; accesses?: unknown[] };
type ContextResult = { incoming?: CallBuckets; outgoing?: CallBuckets; processes?: unknown[] };
type ImpactResult = { affected_processes?: unknown[]; affected_modules?: unknown[] };
type CypherTabular = { markdown?: string; row_count?: number };
type QueryResult = { processes?: unknown[] };

/** Run a JSON tool command, asserting it exited 0 and produced parseable JSON. */
function runJson<T>(args: string[]): T {
  const r = runCliRaw(args, MINI_REPO);
  expect(r.status, `exit nonzero — stderr: ${r.stderr}`).toBe(0);
  const data = parseStdout(r);
  expect(data, `stdout not JSON: ${r.stdout.slice(0, 200)}`).toBeTruthy();
  return data as T;
}

/** Run a text-output tool command, asserting it exited 0. */
function runText(args: string[]): string {
  const r = runCliRaw(args, MINI_REPO);
  expect(r.status, `exit nonzero — stderr: ${r.stderr}`).toBe(0);
  return r.stdout;
}

/** detect-changes lists symbols as "  Symbol name → file"; count those lines. */
function countChangedSymbolLines(stdout: string): number {
  return stdout.split('\n').filter((line) => /^\s+\w+\s+\w+\s+→/.test(line)).length;
}

const len = (a?: unknown[]): number => (Array.isArray(a) ? a.length : 0);

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeAll(() => {
  tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-cli-limit-'));
  suiteGitnexusHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-cli-limit-home-'));
  MINI_REPO = path.join(tmpParent, 'mini-repo');
  fs.cpSync(FIXTURE_SRC, MINI_REPO, { recursive: true });

  // Initialize as git repo
  spawnSync('git', ['init'], { cwd: MINI_REPO, stdio: 'pipe' });
  spawnSync('git', ['add', '-A'], { cwd: MINI_REPO, stdio: 'pipe' });
  spawnSync('git', ['commit', '-m', 'initial commit'], {
    cwd: MINI_REPO,
    stdio: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@test',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@test',
    },
  });

  // Run analyze to populate .gitnexus/ index (required for all tool commands)
  const analyzeResult = runCliRaw(['analyze', '--force'], MINI_REPO, 60000);
  if (analyzeResult.status !== 0) {
    throw new Error(
      `Analyze failed (status ${analyzeResult.status}):\nstdout: ${analyzeResult.stdout}\nstderr: ${analyzeResult.stderr}`,
    );
  }
});

afterAll(() => {
  if (tmpParent) cleanupTempDirSync(tmpParent);
  if (suiteGitnexusHome) cleanupTempDirSync(suiteGitnexusHome);
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('CLI --limit flag E2E', () => {
  // `logMessage` has 2 callers (processRequest, errorMiddleware) and participates
  // in 4 processes — so its baseline genuinely exceeds `--limit 1`, making the
  // truncation assertions non-vacuous.

  // ─── context ────────────────────────────────────────────────────────────

  describe('context --limit', () => {
    it('truncates incoming/outgoing calls and processes to --limit 1', () => {
      const limited = runJson<ContextResult>([
        'context',
        'logMessage',
        '--limit',
        '1',
        '--repo',
        'mini-repo',
      ]);
      expect(len(limited.incoming?.calls)).toBe(1);
      expect(len(limited.outgoing?.calls)).toBe(1);
      expect(len(limited.processes)).toBe(1);
    });

    it('returns the full set without --limit (baseline exceeds the limit)', () => {
      const base = runJson<ContextResult>(['context', 'logMessage', '--repo', 'mini-repo']);
      expect(len(base.incoming?.calls)).toBe(2);
      expect(len(base.outgoing?.calls)).toBe(2);
      expect(len(base.processes)).toBe(4);
    });

    it('treats --limit 0 as no limit (resolves to undefined)', () => {
      const zero = runJson<ContextResult>([
        'context',
        'logMessage',
        '--limit',
        '0',
        '--repo',
        'mini-repo',
      ]);
      const base = runJson<ContextResult>(['context', 'logMessage', '--repo', 'mini-repo']);
      expect(len(zero.processes)).toBe(len(base.processes));
      expect(len(zero.incoming?.calls)).toBe(len(base.incoming?.calls));
    });

    it('treats a non-numeric --limit as no limit (no silent empty)', () => {
      // Regression for the headline bug: `--limit abc` used to parse to NaN →
      // slice(0, NaN) === [] → results silently emptied with exit 0. parseLimit()
      // now rejects non-numeric input, so it must behave exactly like no --limit.
      const invalid = runJson<ContextResult>([
        'context',
        'logMessage',
        '--limit',
        'abc',
        '--repo',
        'mini-repo',
      ]);
      const base = runJson<ContextResult>(['context', 'logMessage', '--repo', 'mini-repo']);
      const total = (d: ContextResult) =>
        len(d.incoming?.calls) +
        len(d.outgoing?.calls) +
        len(d.outgoing?.accesses) +
        len(d.processes);
      expect(total(invalid)).toBe(total(base));
      expect(total(invalid)).toBeGreaterThan(0); // not the old silent-empty
    });
  });

  // ─── impact ─────────────────────────────────────────────────────────────

  describe('impact --limit', () => {
    it('truncates affected_processes/modules to --limit 1', () => {
      const limited = runJson<ImpactResult>([
        'impact',
        'logMessage',
        '--direction',
        'upstream',
        '--limit',
        '1',
        '--repo',
        'mini-repo',
      ]);
      expect(len(limited.affected_processes)).toBe(1);
      expect(len(limited.affected_modules)).toBe(1);
    });

    it('returns the full affected set without --limit (baseline exceeds the limit)', () => {
      const base = runJson<ImpactResult>([
        'impact',
        'logMessage',
        '--direction',
        'upstream',
        '--repo',
        'mini-repo',
      ]);
      expect(len(base.affected_processes)).toBe(2);
      expect(len(base.affected_modules)).toBe(2);
    });

    it('treats --limit 0 as no limit', () => {
      const zero = runJson<ImpactResult>([
        'impact',
        'logMessage',
        '--direction',
        'upstream',
        '--limit',
        '0',
        '--repo',
        'mini-repo',
      ]);
      const base = runJson<ImpactResult>([
        'impact',
        'logMessage',
        '--direction',
        'upstream',
        '--repo',
        'mini-repo',
      ]);
      expect(len(zero.affected_processes)).toBe(len(base.affected_processes));
      expect(len(zero.affected_modules)).toBe(len(base.affected_modules));
    });
  });

  // ─── cypher ───────────────────────────────────────────────────────────────

  describe('cypher --limit', () => {
    it('truncates tabular result rows to --limit and keeps row_count honest', () => {
      const limited = runJson<CypherTabular>([
        'cypher',
        'MATCH (n:Function) RETURN n.name AS name LIMIT 100',
        '--limit',
        '2',
        '--repo',
        'mini-repo',
      ]);
      expect(limited.row_count).toBe(2);
      // header + separator + exactly 2 data rows
      expect((limited.markdown ?? '').split('\n')).toHaveLength(4);
    });

    it('slices multi-line-cell rows by logical row, not physical line (#2310)', () => {
      // n.content holds multi-line source; the markdown table must still slice to
      // exactly `--limit` complete rows (regression for the corruption fix).
      const limited = runJson<CypherTabular>([
        'cypher',
        'MATCH (n:Function) RETURN n.name AS name, n.content AS content LIMIT 8',
        '--limit',
        '3',
        '--repo',
        'mini-repo',
      ]);
      expect(limited.row_count).toBe(3);
      const lines = (limited.markdown ?? '').split('\n');
      expect(lines).toHaveLength(5); // header + separator + 3 rows, no row spanning lines
      expect(limited.markdown ?? '').not.toMatch(/\n[^|]/);
    });

    it('returns more rows without --limit (baseline exceeds the limit)', () => {
      const base = runJson<CypherTabular>([
        'cypher',
        'MATCH (n:Function) RETURN n.name AS name LIMIT 100',
        '--repo',
        'mini-repo',
      ]);
      expect(base.row_count).toBeGreaterThan(2);
    });
  });

  // ─── detect-changes ───────────────────────────────────────────────────────

  describe('detect-changes --limit', () => {
    // Modify two exported functions in two files → two changed symbols, so
    // `--limit 1` truncates the listed symbols from 2 to 1. Idempotent: re-runs
    // don't change the symbol set. (Edits land in the temp copy only.)
    function makeTwoSymbolChange() {
      const edits: Array<[string, RegExp, string]> = [
        ['src/logger.ts', /export function logMessage\([^)]*\)[^{]*\{/, '\n  const _touchLog = 1;'],
        [
          'src/middleware.ts',
          /export function processRequest\([^)]*\)[^{]*\{/,
          '\n  const _touchMw = 1;',
        ],
      ];
      for (const [rel, re, insert] of edits) {
        const p = path.join(MINI_REPO, rel);
        const src = fs.readFileSync(p, 'utf8');
        if (src.includes(insert.trim())) continue; // idempotent
        fs.writeFileSync(
          p,
          src.replace(re, (m) => m + insert),
        );
      }
    }

    it('truncates changed_symbols to --limit 1', () => {
      makeTwoSymbolChange();
      const stdout = runText(['detect-changes', '--limit', '1', '--repo', 'mini-repo']);
      expect(countChangedSymbolLines(stdout)).toBe(1);
    });

    it('lists both changed symbols without --limit (baseline exceeds the limit)', () => {
      makeTwoSymbolChange();
      const stdout = runText(['detect-changes', '--repo', 'mini-repo']);
      expect(countChangedSymbolLines(stdout)).toBe(2);
    });

    it('treats --limit 0 as no limit', () => {
      makeTwoSymbolChange();
      const zero = runText(['detect-changes', '--limit', '0', '--repo', 'mini-repo']);
      const base = runText(['detect-changes', '--repo', 'mini-repo']);
      expect(countChangedSymbolLines(zero)).toBe(countChangedSymbolLines(base));
    });

    it('header total, listed count, and overflow marker stay consistent under --limit', () => {
      // Header keeps the TRUE total (2 symbols), the list is capped to 1, and the
      // overflow marker reports the real remainder (1) — not the sliced length.
      makeTwoSymbolChange();
      const stdout = runText(['detect-changes', '--limit', '1', '--repo', 'mini-repo']);
      expect(countChangedSymbolLines(stdout)).toBe(1);
      expect(stdout).toMatch(/2 symbols/);
      expect(stdout).toMatch(/and 1 more/);
    });
  });

  // ─── query ──────────────────────────────────────────────────────────────

  describe('query --limit', () => {
    it('truncates processes to --limit 1', () => {
      // "message" matches logMessage / createLogEntry / formatLogEntry → 4 processes
      const limited = runJson<QueryResult>([
        'query',
        'message',
        '--limit',
        '1',
        '--repo',
        'mini-repo',
      ]);
      expect(len(limited.processes)).toBe(1);
    });

    it('returns more processes without --limit (baseline exceeds the limit)', () => {
      const base = runJson<QueryResult>(['query', 'message', '--repo', 'mini-repo']);
      expect(len(base.processes)).toBeGreaterThan(1);
    });
  });
});
