/**
 * `--memory-budget` (#3137) at its two real boundaries: the commander entry,
 * which rejects a bad value before any heap work, and a real child process
 * launched with the budget's heap flags. The respawn decision itself is
 * covered through `ensureHeap` in `analyze-heap-respawn.test.ts`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ensureHeapMock = vi.fn(async () => true);
const analyzeOrWatchMock = vi.fn(async () => undefined);

vi.mock('../../src/cli/analyze.js', () => ({
  ensureHeap: ensureHeapMock,
  analyzeOrWatchCommandWithRunnerIdentity: analyzeOrWatchMock,
}));

vi.mock('../../src/cli/update-notice.js', () => ({
  runProcessCliUpdateNotice: vi.fn(),
}));

class ExitCalled extends Error {
  constructor(readonly code: number | string | null | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

describe('--memory-budget validation at the CLI entry', () => {
  const initialArgv = process.argv;
  let stderrChunks: string[];

  beforeEach(() => {
    vi.resetModules();
    ensureHeapMock.mockClear();
    analyzeOrWatchMock.mockClear();
    stderrChunks = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((code?: number | string | null) => {
      throw new ExitCalled(code);
    });
  });

  afterEach(() => {
    process.argv = initialArgv;
    vi.restoreAllMocks();
  });

  const cases = ['abc', '0', '199', '1.5', '-5'].flatMap((value) => [
    { label: `analyze ${value}`, argv: ['analyze', '--memory-budget', value] },
    { label: `analyze --watch ${value}`, argv: ['analyze', '--watch', '--memory-budget', value] },
  ]);

  it.each(cases)('$label exits 1 naming the flag and its minimum', async ({ argv }) => {
    process.argv = [process.execPath, 'gitnexus', ...argv];

    await expect(import('../../src/cli/index.js')).rejects.toMatchObject({ code: 1 });

    const stderr = stderrChunks.join('');
    expect({
      namesFlag: stderr.includes('--memory-budget'),
      namesMinimum: stderr.includes('200'),
      ensureHeapCalls: ensureHeapMock.mock.calls.length,
      actionCalls: analyzeOrWatchMock.mock.calls.length,
    }).toEqual({ namesFlag: true, namesMinimum: true, ensureHeapCalls: 0, actionCalls: 0 });
  });
});

describe('--memory-budget is CLI-only', () => {
  it('a .gitnexusrc memoryBudget key is rejected as an unknown key', async () => {
    const { GitNexusRcError, loadAnalyzeConfig } = await import('../../src/cli/analyze-config.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-budget-rc-'));
    try {
      fs.writeFileSync(path.join(dir, '.gitnexusrc'), JSON.stringify({ memoryBudget: 2000 }));
      let thrown: unknown;
      try {
        loadAnalyzeConfig(dir);
      } catch (error) {
        thrown = error;
      }
      expect({
        isRcError: thrown instanceof GitNexusRcError,
        namesKey: String(thrown).includes('memoryBudget'),
      }).toEqual({ isRcError: true, namesKey: true });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('--memory-budget real-child smoke (256MB)', () => {
  it('a child launched with the budget heap flags reports a 256MB limit and would not respawn again', async () => {
    // Imported for real: this block needs the production sizing, not the mock.
    const { budgetHeapSizing, resolveBudgetHeap } = await vi.importActual<
      typeof import('../../src/cli/analyze.js')
    >('../../src/cli/analyze.js');
    const { oldSpaceMb, semiSpaceMb } = budgetHeapSizing(256);
    const out = execFileSync(
      process.execPath,
      [
        `--max-old-space-size=${oldSpaceMb}`,
        `--max-semi-space-size=${semiSpaceMb}`,
        '-e',
        'process.stdout.write(JSON.stringify({ limit: require("v8").getHeapStatistics().heap_size_limit, execArgv: process.execArgv }))',
      ],
      { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } },
    );
    const child = JSON.parse(out) as { limit: number; execArgv: string[] };
    const decision = resolveBudgetHeap({
      budgetMb: 256,
      execArgv: child.execArgv,
      nodeOptions: '',
      autoCapMb: 13107,
      autopilotDisabled: false,
      inheritedSource: 'budget',
    });

    expect({ limitMb: child.limit / (1024 * 1024), respawn: decision.respawn }).toEqual({
      limitMb: 256,
      respawn: false,
    });
  });
});
