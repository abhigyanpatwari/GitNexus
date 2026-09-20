import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildProcessDetectionPhaseConfig,
  formatInvalidProcessDetectionOverride,
  formatProcessDetectionBudgetBanner,
  formatWholeFlowsMissingRemedies,
  parsePositiveIntegerOverride,
  parseProcessDetectionBudgetStrings,
  processDetectionBudgetMismatch,
  processDetectionEffectiveLimits,
  resolveProcessDetectionBudget,
  toProcessDetectionStamp,
  uncertifyProcessDetectionStamp,
} from '../../src/core/ingestion/process-detection-budget.js';

describe('parsePositiveIntegerOverride', () => {
  it('accepts positive integers and rejects 0 / non-integers', () => {
    const invalid: string[] = [];
    expect(parsePositiveIntegerOverride('25')).toBe(25);
    expect(parsePositiveIntegerOverride(40)).toBe(40);
    expect(parsePositiveIntegerOverride('0', (raw) => invalid.push(raw))).toBeUndefined();
    expect(parsePositiveIntegerOverride('abc', (raw) => invalid.push(raw))).toBeUndefined();
    expect(parsePositiveIntegerOverride('-3', (raw) => invalid.push(raw))).toBeUndefined();
    expect(parsePositiveIntegerOverride('', (raw) => invalid.push(raw))).toBeUndefined();
    expect(invalid).toEqual(['0', 'abc', '-3', '']);
  });
});

describe('resolveProcessDetectionBudget (#3313)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps shipped defaults when nothing is set', () => {
    const resolved = resolveProcessDetectionBudget({}, {});
    expect(resolved.maxProcesses).toBeUndefined();
    expect(resolved.maxProcessBranching).toBe(4);
    expect(resolved.maxProcessTraceDepth).toBe(10);
    expect(resolved.maxEntryPointCandidates).toBe(200);
    expect(resolved.overridden).toEqual({
      maxProcesses: false,
      maxProcessBranching: false,
      maxProcessTraceDepth: false,
      maxEntryPointCandidates: false,
    });
  });

  it('lets an invalid option fall through to env instead of claiming a hard default', () => {
    const invalid: Array<[string, string]> = [];
    const resolved = resolveProcessDetectionBudget(
      { maxProcesses: 0 },
      { GITNEXUS_MAX_PROCESSES: '80' },
      (knob, raw) => invalid.push([knob, raw]),
    );
    expect(resolved.maxProcesses).toBe(80);
    expect(invalid).toEqual([['--max-processes', '0']]);
    expect(formatInvalidProcessDetectionOverride('--max-processes', '0')).toContain(
      'next source (env, then the built-in default)',
    );
    expect(formatInvalidProcessDetectionOverride('GITNEXUS_MAX_PROCESSES', '0')).toContain(
      'the built-in default',
    );
    expect(formatInvalidProcessDetectionOverride('GITNEXUS_MAX_PROCESSES', '0')).not.toContain(
      'next source (env, then the built-in default)',
    );
  });

  it('lets explicit options beat env (AE3 remainder)', () => {
    const resolved = resolveProcessDetectionBudget(
      { maxProcesses: 25 },
      { GITNEXUS_MAX_PROCESSES: '80' },
    );
    expect(resolved.maxProcesses).toBe(25);
    expect(resolved.overridden.maxProcesses).toBe(true);
  });

  it('reads env when option fields are unset', () => {
    const resolved = resolveProcessDetectionBudget(
      {},
      {
        GITNEXUS_MAX_PROCESSES: '40',
        GITNEXUS_MAX_PROCESS_BRANCHING: '2',
        GITNEXUS_MAX_PROCESS_TRACE_DEPTH: '8',
        GITNEXUS_MAX_ENTRY_POINT_CANDIDATES: '400',
      },
    );
    expect(resolved.maxProcesses).toBe(40);
    expect(resolved.maxProcessBranching).toBe(2);
    expect(resolved.maxProcessTraceDepth).toBe(8);
    expect(resolved.maxEntryPointCandidates).toBe(400);
  });

  it('warns and falls back on invalid env (AE5)', () => {
    const invalid: Array<[string, string]> = [];
    const zero = resolveProcessDetectionBudget({}, { GITNEXUS_MAX_PROCESSES: '0' }, (knob, raw) =>
      invalid.push([knob, raw]),
    );
    const garbage = resolveProcessDetectionBudget(
      {},
      { GITNEXUS_MAX_PROCESSES: 'abc' },
      (knob, raw) => invalid.push([knob, raw]),
    );
    expect(zero.maxProcesses).toBeUndefined();
    expect(garbage.maxProcesses).toBeUndefined();
    expect(invalid).toEqual([
      ['GITNEXUS_MAX_PROCESSES', '0'],
      ['GITNEXUS_MAX_PROCESSES', 'abc'],
    ]);
  });

  it('replaces the dynamic formula only when maxProcesses is explicit', () => {
    const unset = buildProcessDetectionPhaseConfig(
      resolveProcessDetectionBudget({}, {}),
      1000,
      (n) => Math.max(20, Math.round(n / 10)),
    );
    const explicit = buildProcessDetectionPhaseConfig(
      resolveProcessDetectionBudget({ maxProcesses: 5 }, {}),
      1000,
      (n) => Math.max(20, Math.round(n / 10)),
    );
    expect(unset.maxProcesses).toBe(100);
    expect(explicit.maxProcesses).toBe(5);
    expect(explicit.minSteps).toBe(3);
  });
});

describe('processDetectionBudgetMismatch (KTD4)', () => {
  const defaults = resolveProcessDetectionBudget({}, {});

  it('matches a missing stamp against default/dynamic knobs', () => {
    expect(processDetectionBudgetMismatch(undefined, defaults)).toBe(false);
  });

  it('mismatches a missing stamp when any override is set', () => {
    expect(
      processDetectionBudgetMismatch(
        undefined,
        resolveProcessDetectionBudget({ maxEntryPointCandidates: 400 }, {}),
      ),
    ).toBe(true);
  });

  it('mismatches when a present stamp differs', () => {
    const recorded = toProcessDetectionStamp(defaults);
    expect(
      processDetectionBudgetMismatch({ ...recorded, maxEntryPointCandidates: 400 }, defaults),
    ).toBe(true);
  });

  it('mismatches explicit maxProcesses vs later dynamic even when the integer equals the formula', () => {
    const explicit = resolveProcessDetectionBudget({ maxProcesses: 100 }, {});
    expect(processDetectionBudgetMismatch(toProcessDetectionStamp(explicit), defaults)).toBe(true);
    expect(toProcessDetectionStamp(explicit).maxProcesses).toBe(100);
    expect(toProcessDetectionStamp(defaults).maxProcesses).toBe(null);
  });

  it('matches an identical present stamp', () => {
    const resolved = resolveProcessDetectionBudget(
      { maxProcesses: 25, maxEntryPointCandidates: 400 },
      {},
    );
    expect(processDetectionBudgetMismatch(toProcessDetectionStamp(resolved), resolved)).toBe(false);
  });

  it('mismatches an uncertified stamp even when the numeric fields match defaults', () => {
    const recorded = uncertifyProcessDetectionStamp(toProcessDetectionStamp(defaults));
    expect(recorded.uncertified).toBe(true);
    expect(recorded.maxProcesses).toBe(null);
    expect(processDetectionBudgetMismatch(recorded, defaults)).toBe(true);
    expect(processDetectionBudgetMismatch(toProcessDetectionStamp(defaults), defaults)).toBe(false);
  });
});

describe('warning copy and banner', () => {
  it('maps loud counters to the matching knobs and names the pre-entry trace gate', () => {
    const limits = processDetectionEffectiveLimits(20, resolveProcessDetectionBudget({}, {}));
    expect(limits.maxProcessTraces).toBe(40);
    expect(
      formatWholeFlowsMissingRemedies(
        { entryPointCandidatesDropped: 210, entryPointsUnexplored: 0, processesDropped: 0 },
        limits,
        410,
      ),
    ).toContain('--max-entry-point-candidates');
    expect(
      formatWholeFlowsMissingRemedies(
        { entryPointCandidatesDropped: 210, entryPointsUnexplored: 0, processesDropped: 0 },
        limits,
        410,
      ),
    ).not.toContain('--max-process-branching');
    expect(
      formatWholeFlowsMissingRemedies(
        { entryPointCandidatesDropped: 0, entryPointsUnexplored: 3, processesDropped: 1 },
        limits,
        10,
      ),
    ).toContain('--max-processes');
    expect(
      formatWholeFlowsMissingRemedies(
        { entryPointCandidatesDropped: 0, entryPointsUnexplored: 3, processesDropped: 1 },
        limits,
        10,
      ),
    ).toContain('40');
    expect(
      formatWholeFlowsMissingRemedies(
        { entryPointCandidatesDropped: 0, entryPointsUnexplored: 3, processesDropped: 1 },
        limits,
        10,
      ),
    ).toContain('next entry is skipped');
  });

  it('prints a banner only when an override is active', () => {
    expect(formatProcessDetectionBudgetBanner(resolveProcessDetectionBudget({}, {}))).toBeNull();
    expect(
      formatProcessDetectionBudgetBanner(resolveProcessDetectionBudget({ maxProcesses: 25 }, {})),
    ).toContain('maxProcesses=25');
    expect(
      formatProcessDetectionBudgetBanner(
        resolveProcessDetectionBudget({ maxProcessBranching: 6 }, {}),
      ),
    ).toContain('maxProcesses=dynamic (max(20, round(symbols/10)))');
  });

  it('parses CLI/rc numeric strings without treating 0 as unlimited', () => {
    const parsed = parseProcessDetectionBudgetStrings({
      maxProcesses: '25',
      maxProcessBranching: '0',
    });
    expect(parsed).toEqual({ maxProcesses: 25 });
  });
});
