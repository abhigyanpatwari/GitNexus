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
import assert from 'node:assert/strict';
import { describe, it, before, after, type TestContext } from 'node:test';
import { expect } from 'expect';
import { registerCases } from '../support/cases.mjs';
import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

import { cleanupTempDirSync } from '../../../../test/helpers/test-db.js';
import { cliAnalysisEnv, CLI_SPAWN_PREFIX } from '../../../../test/helpers/cli-entry.js';

const FIXTURE_SRC = fileURLToPath(new URL('../../../../test/fixtures/mini-repo', import.meta.url));

let MINI_REPO: string;
let tmpParent: string;
let suiteGitnexusHome: string;
/** False when setup analyze fell back to `--skip-fts` after CREATE_FTS_INDEX native-aborted. */
let ftsIndexed = false;

function cliEnv(extraEnv: Record<string, string> = {}) {
  return cliAnalysisEnv({
    GITNEXUS_HOME: suiteGitnexusHome,
    // Cold parse-worker loads every tree-sitter grammar before the ready
    // handshake. The default 5s budget classifies that as a deterministic
    // crash-loop on a loaded WSL/CI host (status 1) or the 60s spawnSync
    // timeout kills the child first (status null). Sibling integration
    // suites pin 60s.
    GITNEXUS_WORKER_READY_TIMEOUT_MS: process.env.GITNEXUS_WORKER_READY_TIMEOUT_MS || '60000',
    ...extraEnv,
  });
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

function isNativeAbort(result: ReturnType<typeof runCliRaw>): boolean {
  return (
    result.signal === 'SIGSEGV' ||
    result.signal === 'SIGABRT' ||
    result.signal === 'SIGBUS' ||
    result.status === 139
  );
}

function isFatalAnalyzeHarness(result: ReturnType<typeof runCliRaw>): boolean {
  return (
    result.stderr?.includes('Worker script not found') === true ||
    result.stderr?.includes('deterministic crash-loop') === true
  );
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
type ImpactResult = {
  affected_processes?: unknown[];
  affected_modules?: unknown[];
  affected_routes?: Array<{ url: string; method?: string }>;
};
type CypherTabular = { markdown?: string; row_count?: number };
type QueryResult = { processes?: unknown[] };

/** Run a JSON tool command, asserting it exited 0 and produced parseable JSON. */
function runJson<T>(args: string[]): T {
  const r = runCliRaw(args, MINI_REPO);
  assert.equal(r.status, 0, `exit nonzero — stderr: ${r.stderr}`);
  const data = parseStdout(r);
  assert.ok(data, `stdout not JSON: ${r.stdout.slice(0, 200)}`);
  return data as T;
}

/** Run a text-output tool command, asserting it exited 0. */
function runText(args: string[]): string {
  const r = runCliRaw(args, MINI_REPO);
  assert.equal(r.status, 0, `exit nonzero — stderr: ${r.stderr}`);
  return r.stdout;
}

/** detect-changes lists symbols as "  Symbol name → file"; count those lines. */
function countChangedSymbolLines(stdout: string): number {
  return stdout.split('\n').filter((line) => /^\s+\w+\s+\w+\s+→/.test(line)).length;
}

const len = (a?: unknown[]): number => (Array.isArray(a) ? a.length : 0);

// ─── Setup ───────────────────────────────────────────────────────────────────

before(
  () => {
    tmpParent = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-cli-limit-'));
    suiteGitnexusHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-cli-limit-home-'));
    MINI_REPO = path.join(tmpParent, 'mini-repo');
    fs.cpSync(FIXTURE_SRC, MINI_REPO, { recursive: true });
    // A separate handler serves two routes so the route cap cannot pass vacuously.
    // Keep it independent of logMessage's existing caller/process baselines.
    fs.writeFileSync(
      path.join(MINI_REPO, 'routes.go'),
      `package routes

import "github.com/gin-gonic/gin"

func RegisterRoutes(r *gin.Engine) {
  r.GET("/health", Health)
  r.GET("/ready", Health)
}

func Health(c *gin.Context) {
  c.String(200, "ok")
}
`,
    );

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

    // Index once so every --limit command has a registered repo. Match cli-e2e:
    // a tiny fixture analyzes in seconds on a quiet machine, but spawnSync
    // status null is SIGTERM from the timeout under load (not an analyze
    // exit). Retry timeouts; alreadyUpToDate makes a repeat cheap.
    //
    // CREATE_FTS_INDEX can SIGSEGV the analyze process on some WSL/native
    // hosts (status null, signal SIGSEGV) even when `doctor` reports FTS
    // LOAD-able. Do not retry that path — rebuild with --skip-fts so graph
    // tools still run. query --limit needs BM25 and is skipped in that case.
    let analyzeResult: ReturnType<typeof runCliRaw> | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      analyzeResult = runCliRaw(['analyze', '--force'], MINI_REPO, 90_000);
      if (analyzeResult.status === 0) {
        ftsIndexed = true;
        break;
      }
      if (isFatalAnalyzeHarness(analyzeResult) || isNativeAbort(analyzeResult)) break;
    }
    if (
      analyzeResult &&
      !ftsIndexed &&
      isNativeAbort(analyzeResult) &&
      !isFatalAnalyzeHarness(analyzeResult)
    ) {
      analyzeResult = runCliRaw(['analyze', '--force', '--skip-fts'], MINI_REPO, 90_000);
    }
    if (!analyzeResult || analyzeResult.status !== 0) {
      const err = analyzeResult?.error;
      throw new Error(
        `Analyze failed (status ${analyzeResult?.status}, signal ${analyzeResult?.signal}, error ${err?.message ?? 'none'}):\nstdout: ${analyzeResult?.stdout}\nstderr: ${analyzeResult?.stderr}`,
      );
    }
  },
  { timeout: 300_000 },
);

after(() => {
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
    it('caps affected_routes at --limit 1 while omitted and zero limits retain both routes', () => {
      const args = ['impact', 'Health', '--direction', 'upstream', '--repo', 'mini-repo'];
      const base = runJson<ImpactResult>(args);
      expect(base.affected_routes).toHaveLength(2);
      expect(base.affected_routes).toEqual(
        expect.arrayContaining([
          { url: '/health', method: 'GET' },
          { url: '/ready', method: 'GET' },
        ]),
      );

      const limited = runJson<ImpactResult>([...args, '--limit', '1']);
      expect(limited.affected_routes).toHaveLength(1);
      expect(base.affected_routes).toContainEqual(limited.affected_routes?.[0]);

      const zero = runJson<ImpactResult>([...args, '--limit', '0']);
      expect(zero.affected_routes).toEqual(base.affected_routes);
    });

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
    registerCases(
      it,
      [{ options: [] }, { options: ['--limit', '2'] }],
      'keeps the zero-row result object with options $options (#3952)',
      ({ options }) => {
        const result = runJson<CypherTabular>([
          'cypher',
          "MATCH (n:Function) WHERE n.name = '__missing__' RETURN n.name AS name",
          ...options,
          '--repo',
          'mini-repo',
        ]);
        expect(result).toMatchObject({ markdown: '', row_count: 0 });
      },
    );

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

  // ─── piped stdout (#3947) ─────────────────────────────────────────────────

  describe('piped stdout (#3947)', () => {
    // A real pipe(2), whose buffer is a fixed 64 KiB. On POSIX the CLI's fd 1 is
    // non-blocking when it is a pipe, so one write of a larger payload stops
    // short. spawnSync's own 'pipe' stdio is a socketpair with a larger,
    // host-dependent buffer, which is why the suites above never hit this.
    const ROWS = 5000;
    const query = `UNWIND range(1, ${ROWS}) AS i RETURN i AS n, '${'x'.repeat(60)}' AS pad ORDER BY n`;
    const args = [...CLI_SPAWN_PREFIX, 'cypher', query, '--repo', 'mini-repo'];
    // "$0" "$@" hands the argv to the CLI untouched by shell quoting. A pipeline
    // reports the reader's status, so the CLI's own status goes to stderr.
    const pipeTo = (reader: string) =>
      spawnSync(
        'sh',
        ['-c', `{ "$0" "$@"; echo "cli-exit=$?" >&2; } | ${reader}`, process.execPath, ...args],
        { cwd: MINI_REPO, encoding: 'utf8', env: cliEnv(), timeout: 60_000 },
      );

    it(
      'delivers the same >256 KiB result through a pipe as to a file',
      { skip: process.platform === 'win32' },
      () => {
        const outFile = path.join(tmpParent, 'cypher-3947.json');
        const fd = fs.openSync(outFile, 'w');
        const toFile = spawnSync(process.execPath, args, {
          cwd: MINI_REPO,
          stdio: ['ignore', fd, 'pipe'],
          env: cliEnv(),
          timeout: 60_000,
        });
        fs.closeSync(fd);
        const piped = pipeTo('cat');

        assert.equal(toFile.status, 0, toFile.stderr?.toString());
        expect(piped.stderr).toContain('cli-exit=0');
        const fileText = fs.readFileSync(outFile, 'utf8');
        expect(Buffer.byteLength(fileText)).toBeGreaterThan(256 * 1024);
        assert.ok(Buffer.byteLength(piped.stdout) > 256 * 1024, piped.stderr);
        // Compare the result, not raw bytes: each run probes its own staleness
        // envelope, so those fields may legitimately differ between the runs.
        const fromFile = JSON.parse(fileText) as CypherTabular;
        const fromPipe = JSON.parse(piped.stdout) as CypherTabular;
        expect(fromFile.row_count).toBe(ROWS);
        expect(fromPipe.row_count).toBe(ROWS);
        expect(fromPipe.markdown).toBe(fromFile.markdown);
      },
    );

    it(
      'exits 0 without a stderr copy when the reader closes early (EPIPE)',
      { skip: process.platform === 'win32' },
      () => {
        // The result is far larger than the pipe buffer, so the CLI is still
        // writing when `head` exits: the next write fails with EPIPE.
        const early = pipeTo('head -c 1');

        expect(early.stdout).toHaveLength(1);
        expect(early.stderr).toContain('cli-exit=0');
        expect(early.stderr).not.toContain('row_count');
      },
    );
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
    function hasSearchIndex(ctx: TestContext) {
      if (ftsIndexed) return true;
      if (process.env.GITNEXUS_REQUIRE_FTS === '1') {
        throw new Error(
          'GITNEXUS_REQUIRE_FTS=1 but setup analyze native-aborted during CREATE_FTS_INDEX; ' +
            'query --limit cannot be verified without BM25.',
        );
      }
      ctx.skip(
        'query --limit needs BM25; CREATE_FTS_INDEX native-aborted and analyze fell back to --skip-fts',
      );
      return false;
    }
    it('truncates processes to --limit 1', (ctx) => {
      if (!hasSearchIndex(ctx)) return;
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

    it('returns more processes without --limit (baseline exceeds the limit)', (ctx) => {
      if (!hasSearchIndex(ctx)) return;
      const base = runJson<QueryResult>(['query', 'message', '--repo', 'mini-repo']);
      expect(len(base.processes)).toBeGreaterThan(1);
    });
  });
});
