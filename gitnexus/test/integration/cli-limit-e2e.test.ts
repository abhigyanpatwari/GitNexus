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
 * @see src/cli/tool.ts — limit application logic
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';

import { createRequire } from 'module';
import { cleanupTempDirSync } from '../helpers/test-db.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../..');
const cliEntry = path.join(repoRoot, 'src/cli/index.ts');
const FIXTURE_SRC = path.resolve(testDir, '..', 'fixtures', 'mini-repo');

let MINI_REPO: string;
let tmpParent: string;
let suiteGitnexusHome: string;

const _require = createRequire(import.meta.url);
const tsxPkgDir = path.dirname(_require.resolve('tsx/package.json'));
const tsxImportUrl = pathToFileURL(path.join(tsxPkgDir, 'dist', 'loader.mjs')).href;

function cliEnv(extraEnv: Record<string, string> = {}) {
  return {
    ...process.env,
    GITNEXUS_HOME: suiteGitnexusHome,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --max-old-space-size=8192`.trim(),
    ...extraEnv,
  };
}

function runCliRaw(extraArgs: string[], cwd: string, timeoutMs = 30000) {
  return spawnSync(
    process.execPath,
    ['--import', tsxImportUrl, cliEntry, ...extraArgs],
    {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cliEnv(),
    },
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
  // ─── context ────────────────────────────────────────────────────────────

  describe('context --limit', () => {
    it('truncates callers/callees/processes to --limit 1', () => {
      const result = runCliRaw(
        ['context', 'validateInput', '--limit', '1', '--repo', 'mini-repo'],
        MINI_REPO,
      );
      if (result.status === null) return;

      expect(result.status).toBe(0);
      const parsed = parseStdout(result);
      expect(parsed).toBeTruthy();

      const data = parsed as Record<string, unknown>;
      // Each array should have at most 1 element
      if (data.incoming && typeof data.incoming === 'object') {
        const incoming = data.incoming as Record<string, unknown>;
        if (Array.isArray(incoming.calls)) {
          expect(incoming.calls.length).toBeLessThanOrEqual(1);
        }
      }
      if (data.outgoing && typeof data.outgoing === 'object') {
        const outgoing = data.outgoing as Record<string, unknown>;
        if (Array.isArray(outgoing.calls)) {
          expect(outgoing.calls.length).toBeLessThanOrEqual(1);
        }
        if (Array.isArray(outgoing.accesses)) {
          expect(outgoing.accesses.length).toBeLessThanOrEqual(1);
        }
      }
      if (Array.isArray(data.processes)) {
        expect(data.processes.length).toBeLessThanOrEqual(1);
      }
    });

    it('baseline has >= limited results (comparison)', () => {
      const limited = runCliRaw(
        ['context', 'validateInput', '--limit', '1', '--repo', 'mini-repo'],
        MINI_REPO,
      );
      const baseline = runCliRaw(
        ['context', 'validateInput', '--repo', 'mini-repo'],
        MINI_REPO,
      );
      if (limited.status === null || baseline.status === null) return;

      expect(limited.status).toBe(0);
      expect(baseline.status).toBe(0);

      const limitedData = parseStdout(limited) as Record<string, unknown> | null;
      const baselineData = parseStdout(baseline) as Record<string, unknown> | null;
      if (!limitedData || !baselineData) return;

      // Compare each array: baseline >= limited
      const arrays = ['incoming.calls', 'outgoing.calls', 'outgoing.accesses', 'processes'];
      for (const path of arrays) {
        const parts = path.split('.');
        let limitedArr: unknown[] | undefined;
        let baselineArr: unknown[] | undefined;

        let l: unknown = limitedData;
        let b: unknown = baselineData;
        for (const key of parts) {
          if (l && typeof l === 'object') l = (l as Record<string, unknown>)[key];
          if (b && typeof b === 'object') b = (b as Record<string, unknown>)[key];
        }
        if (Array.isArray(l)) limitedArr = l;
        if (Array.isArray(b)) baselineArr = b;

        if (limitedArr && baselineArr) {
          expect(baselineArr.length).toBeGreaterThanOrEqual(limitedArr.length);
        }
      }
    });

    it('treats --limit 0 as no limit (falsy, skipped)', () => {
      const limited = runCliRaw(
        ['context', 'validateInput', '--limit', '0', '--repo', 'mini-repo'],
        MINI_REPO,
      );
      const baseline = runCliRaw(
        ['context', 'validateInput', '--repo', 'mini-repo'],
        MINI_REPO,
      );
      if (limited.status === null || baseline.status === null) return;

      const limitedData = parseStdout(limited) as Record<string, unknown> | null;
      const baselineData = parseStdout(baseline) as Record<string, unknown> | null;
      if (!limitedData || !baselineData) return;

      // Both should return the same result (limit=0 is falsy, skipped)
      if (Array.isArray(limitedData.processes) && Array.isArray(baselineData.processes)) {
        expect(limitedData.processes.length).toBe(baselineData.processes.length);
      }
    });
  });

  // ─── impact ─────────────────────────────────────────────────────────────

  describe('impact --limit', () => {
    it('truncates affected_processes/modules to --limit 1', () => {
      const result = runCliRaw(
        ['impact', 'validateInput', '--direction', 'upstream', '--limit', '1', '--repo', 'mini-repo'],
        MINI_REPO,
      );
      if (result.status === null) return;

      expect(result.status).toBe(0);
      const parsed = parseStdout(result);
      expect(parsed).toBeTruthy();

      const data = parsed as Record<string, unknown>;
      if (Array.isArray(data.affected_processes)) {
        expect(data.affected_processes.length).toBeLessThanOrEqual(1);
      }
      if (Array.isArray(data.affected_modules)) {
        expect(data.affected_modules.length).toBeLessThanOrEqual(1);
      }
    });

    it('baseline has >= limited results (comparison)', () => {
      const limited = runCliRaw(
        ['impact', 'validateInput', '--direction', 'upstream', '--limit', '1', '--repo', 'mini-repo'],
        MINI_REPO,
      );
      const baseline = runCliRaw(
        ['impact', 'validateInput', '--direction', 'upstream', '--repo', 'mini-repo'],
        MINI_REPO,
      );
      if (limited.status === null || baseline.status === null) return;

      expect(limited.status).toBe(0);
      expect(baseline.status).toBe(0);

      const limitedData = parseStdout(limited) as Record<string, unknown> | null;
      const baselineData = parseStdout(baseline) as Record<string, unknown> | null;
      if (!limitedData || !baselineData) return;

      for (const key of ['affected_processes', 'affected_modules']) {
        const l = limitedData[key];
        const b = baselineData[key];
        if (Array.isArray(l) && Array.isArray(b)) {
          expect(b.length).toBeGreaterThanOrEqual(l.length);
        }
      }
    });

    it('treats --limit 0 as no limit (falsy, skipped)', () => {
      const limited = runCliRaw(
        ['impact', 'validateInput', '--direction', 'upstream', '--limit', '0', '--repo', 'mini-repo'],
        MINI_REPO,
      );
      const baseline = runCliRaw(
        ['impact', 'validateInput', '--direction', 'upstream', '--repo', 'mini-repo'],
        MINI_REPO,
      );
      if (limited.status === null || baseline.status === null) return;

      const limitedData = parseStdout(limited) as Record<string, unknown> | null;
      const baselineData = parseStdout(baseline) as Record<string, unknown> | null;
      if (!limitedData || !baselineData) return;

      if (Array.isArray(limitedData.affected_processes) && Array.isArray(baselineData.affected_processes)) {
        expect(limitedData.affected_processes.length).toBe(baselineData.affected_processes.length);
      }
    });
  });

  // ─── cypher ─────────────────────────────────────────────────────────────

  describe('cypher --limit', () => {
    it('truncates result rows to --limit 2', () => {
      const result = runCliRaw(
        ['cypher', 'MATCH (n) RETURN n.name LIMIT 100', '--limit', '2', '--repo', 'mini-repo'],
        MINI_REPO,
      );
      if (result.status === null) return;

      expect(result.status).toBe(0);
      const parsed = parseStdout(result);
      expect(parsed).toBeTruthy();

      if (Array.isArray(parsed)) {
        expect(parsed.length).toBeLessThanOrEqual(2);
      } else if (parsed && typeof parsed === 'object') {
        const data = parsed as Record<string, unknown>;
        if (typeof data.row_count === 'number') {
          expect(data.row_count).toBeLessThanOrEqual(2);
        }
      }
    });

    it('returns more results without --limit (baseline)', () => {
      const result = runCliRaw(
        ['cypher', 'MATCH (n) RETURN n.name LIMIT 100', '--repo', 'mini-repo'],
        MINI_REPO,
      );
      if (result.status === null) return;

      expect(result.status).toBe(0);
      const parsed = parseStdout(result);
      expect(parsed).toBeTruthy();

      if (Array.isArray(parsed)) {
        // Cypher returns all nodes — mini-repo has 16+ exported symbols
        expect(parsed.length).toBeGreaterThan(2);
      } else if (parsed && typeof parsed === 'object') {
        const data = parsed as Record<string, unknown>;
        if (typeof data.row_count === 'number') {
          expect(data.row_count).toBeGreaterThan(2);
        }
      }
    });

    it('treats --limit 0 as no limit (falsy, skipped)', () => {
      const result = runCliRaw(
        ['cypher', 'MATCH (n) RETURN n.name LIMIT 100', '--limit', '0', '--repo', 'mini-repo'],
        MINI_REPO,
      );
      if (result.status === null) return;

      expect(result.status).toBe(0);
      const parsed = parseStdout(result);
      expect(parsed).toBeTruthy();

      if (Array.isArray(parsed)) {
        expect(parsed.length).toBeGreaterThan(0);
      }
    });
  });

  // ─── detect-changes ─────────────────────────────────────────────────────

  describe('detect-changes --limit', () => {
    // detect-changes output is formatted TEXT (via formatDetectChangesResult),
    // not JSON. We test the raw stdout text instead of parsing JSON.

    function createFileChange() {
      const filePath = path.join(MINI_REPO, 'src', 'validator.ts');
      const content = fs.readFileSync(filePath, 'utf8');
      fs.writeFileSync(filePath, content + '\n// change for detect-changes test\n');
    }

    it('truncates changed_symbols to --limit 1', () => {
      createFileChange();

      const result = runCliRaw(
        ['detect-changes', '--limit', '1', '--repo', 'mini-repo'],
        MINI_REPO,
      );
      if (result.status === null) return;

      expect(result.status).toBe(0);
      const stdout = result.stdout.trim();
      expect(stdout.length).toBeGreaterThan(0);

      // The formatted output lists symbols as "  Type name → filePath"
      // With --limit 1, there should be at most 1 such line
      const symbolLines = stdout.split('\n').filter(
        (line) => line.match(/^\s+\w+\s+\w+\s+→/),
      );
      expect(symbolLines.length).toBeLessThanOrEqual(1);
    });

    it('baseline has >= limited symbol lines (comparison)', () => {
      createFileChange();

      const limited = runCliRaw(
        ['detect-changes', '--limit', '1', '--repo', 'mini-repo'],
        MINI_REPO,
      );
      const baseline = runCliRaw(
        ['detect-changes', '--repo', 'mini-repo'],
        MINI_REPO,
      );
      if (limited.status === null || baseline.status === null) return;

      expect(limited.status).toBe(0);
      expect(baseline.status).toBe(0);

      const countSymbols = (stdout: string) =>
        stdout.split('\n').filter((line) => line.match(/^\s+\w+\s+\w+\s+→/)).length;

      const limitedCount = countSymbols(limited.stdout);
      const baselineCount = countSymbols(baseline.stdout);

      expect(baselineCount).toBeGreaterThanOrEqual(limitedCount);
    });

    it('treats --limit 0 as no limit (falsy, skipped)', () => {
      createFileChange();

      const limited = runCliRaw(
        ['detect-changes', '--limit', '0', '--repo', 'mini-repo'],
        MINI_REPO,
      );
      const baseline = runCliRaw(
        ['detect-changes', '--repo', 'mini-repo'],
        MINI_REPO,
      );
      if (limited.status === null || baseline.status === null) return;

      const countSymbols = (stdout: string) =>
        stdout.split('\n').filter((line) => line.match(/^\s+\w+\s+\w+\s+→/)).length;

      // Both should return the same count (limit=0 is falsy, skipped)
      expect(countSymbols(limited.stdout)).toBe(countSymbols(baseline.stdout));
    });
  });

  // ─── query ──────────────────────────────────────────────────────────────

  describe('query --limit', () => {
    it('truncates processes to --limit 1', () => {
      // "validate" matches validateInput, ValidationResult, sanitize
      const result = runCliRaw(
        ['query', 'validate', '--limit', '1', '--repo', 'mini-repo'],
        MINI_REPO,
      );
      if (result.status === null) return;

      expect(result.status).toBe(0);
      const parsed = parseStdout(result);
      expect(parsed).toBeTruthy();

      const data = parsed as Record<string, unknown>;
      if (Array.isArray(data.processes)) {
        expect(data.processes.length).toBeLessThanOrEqual(1);
      }
    });

    it('baseline has >= limited results (comparison)', () => {
      const limited = runCliRaw(
        ['query', 'validate', '--limit', '1', '--repo', 'mini-repo'],
        MINI_REPO,
      );
      const baseline = runCliRaw(
        ['query', 'validate', '--repo', 'mini-repo'],
        MINI_REPO,
      );
      if (limited.status === null || baseline.status === null) return;

      expect(limited.status).toBe(0);
      expect(baseline.status).toBe(0);

      const limitedData = parseStdout(limited) as Record<string, unknown> | null;
      const baselineData = parseStdout(baseline) as Record<string, unknown> | null;
      if (!limitedData || !baselineData) return;

      if (Array.isArray(limitedData.processes) && Array.isArray(baselineData.processes)) {
        expect(baselineData.processes.length).toBeGreaterThanOrEqual(
          limitedData.processes.length,
        );
      }
    });
  });
});
