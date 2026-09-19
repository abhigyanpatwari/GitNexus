/**
 * Analyze-time process-detection budget (#3313).
 *
 * Four knobs control how many execution flows `processProcesses` keeps:
 * process count, per-node branching, trace depth, and the ranked entry-point
 * pool. Precedence is CLI / explicit `AnalyzeOptions` > `.gitnexusrc` (already
 * merged into those fields) > `GITNEXUS_*` env > built-in defaults. Unset
 * `maxProcesses` keeps the dynamic `symbols / 10` formula. `0` is invalid, not
 * unlimited.
 */

import type { ProcessDetectionConfig, ProcessTruncationStats } from './process-processor.js';
import { parsePositiveIntEnv } from './utils/env.js';

export const PROCESS_DETECTION_BUDGET_DEFAULTS = {
  maxProcessBranching: 4,
  maxProcessTraceDepth: 10,
  maxEntryPointCandidates: 200,
  minSteps: 3,
} as const;

export const PROCESS_DETECTION_ENV = {
  maxProcesses: 'GITNEXUS_MAX_PROCESSES',
  maxProcessBranching: 'GITNEXUS_MAX_PROCESS_BRANCHING',
  maxProcessTraceDepth: 'GITNEXUS_MAX_PROCESS_TRACE_DEPTH',
  maxEntryPointCandidates: 'GITNEXUS_MAX_ENTRY_POINT_CANDIDATES',
} as const;

export const PROCESS_DETECTION_CLI_FLAGS = {
  maxProcesses: '--max-processes',
  maxProcessBranching: '--max-process-branching',
  maxProcessTraceDepth: '--max-process-trace-depth',
  maxEntryPointCandidates: '--max-entry-point-candidates',
} as const;

const BUDGET_KEYS = [
  'maxProcesses',
  'maxProcessBranching',
  'maxProcessTraceDepth',
  'maxEntryPointCandidates',
] as const;

export type ProcessDetectionBudgetKey = (typeof BUDGET_KEYS)[number];

export type ProcessDetectionBudgetFields = {
  maxProcesses?: number;
  maxProcessBranching?: number;
  maxProcessTraceDepth?: number;
  maxEntryPointCandidates?: number;
};

export type ProcessDetectionBudgetStrings = {
  maxProcesses?: string;
  maxProcessBranching?: string;
  maxProcessTraceDepth?: string;
  maxEntryPointCandidates?: string;
};

export type ProcessDetectionStamp = {
  /** Explicit override, or `null` when this run used the dynamic formula. */
  maxProcesses: number | null;
  maxProcessBranching: number;
  maxProcessTraceDepth: number;
  maxEntryPointCandidates: number;
  /**
   * In-place FTS park after a derived-layer rewrite (#3322). Missing stamp +
   * defaults is a match, so recovery must persist a complete stamp that still
   * mismatches until a successful analyze certifies the live Community/Process
   * rows. Success writes omit this flag.
   */
  uncertified?: true;
};

export type ResolvedProcessDetectionBudget = {
  /** Set only when an explicit override won. */
  maxProcesses?: number;
  maxProcessBranching: number;
  maxProcessTraceDepth: number;
  maxEntryPointCandidates: number;
  overridden: {
    maxProcesses: boolean;
    maxProcessBranching: boolean;
    maxProcessTraceDepth: boolean;
    maxEntryPointCandidates: boolean;
  };
};

export type ProcessDetectionEffectiveLimits = {
  maxProcesses: number;
  maxProcessBranching: number;
  maxProcessTraceDepth: number;
  maxEntryPointCandidates: number;
  /**
   * Pre-entry gate: `processProcesses` does not start the next entry once
   * collected traces already reach `maxProcesses * 2`. One started entry can
   * still append every trace `traceFromEntryPoint` returns.
   */
  maxProcessTraces: number;
};

export type InvalidBudgetHandler = (knob: string, raw: string) => void;

/** Operator copy when a CLI/rc/env token is rejected. Next precedence still applies. */
export const formatInvalidProcessDetectionOverride = (knob: string, raw: string): string => {
  const next = knob.startsWith('GITNEXUS_')
    ? 'the built-in default'
    : 'the next source (env, then the built-in default)';
  return `${knob} must be a positive integer (got ${JSON.stringify(raw)}); ignoring it so ${next} applies.`;
};

export const parsePositiveIntegerOverride = (
  raw: string | number | undefined | null,
  onInvalid?: (raw: string) => void,
): number | undefined => {
  if (raw === undefined || raw === null) return undefined;
  const text = typeof raw === 'number' ? String(raw) : raw;
  const parsed = parsePositiveIntEnv(text);
  if (parsed === undefined) onInvalid?.(typeof raw === 'number' ? text : text.trim());
  return parsed;
};

export const parseProcessDetectionBudgetStrings = (
  raw: ProcessDetectionBudgetStrings,
  onInvalid?: InvalidBudgetHandler,
): ProcessDetectionBudgetFields => {
  const out: ProcessDetectionBudgetFields = {};
  for (const key of BUDGET_KEYS) {
    if (raw[key] === undefined) continue;
    const parsed = parsePositiveIntegerOverride(raw[key], (invalid) =>
      onInvalid?.(PROCESS_DETECTION_CLI_FLAGS[key], invalid),
    );
    if (parsed !== undefined) out[key] = parsed;
  }
  return out;
};

const readOverride = (
  options: ProcessDetectionBudgetFields,
  env: NodeJS.ProcessEnv,
  key: ProcessDetectionBudgetKey,
  onInvalid?: InvalidBudgetHandler,
): number | undefined => {
  const fromOptions = options[key];
  if (fromOptions !== undefined) {
    const parsed = parsePositiveIntegerOverride(fromOptions, (invalid) =>
      onInvalid?.(PROCESS_DETECTION_CLI_FLAGS[key], invalid),
    );
    if (parsed !== undefined) return parsed;
  }
  const envName = PROCESS_DETECTION_ENV[key];
  const fromEnv = env[envName];
  if (fromEnv === undefined) return undefined;
  return parsePositiveIntegerOverride(fromEnv, (invalid) => onInvalid?.(envName, invalid));
};

export const resolveProcessDetectionBudget = (
  options: ProcessDetectionBudgetFields = {},
  env: NodeJS.ProcessEnv = process.env,
  onInvalid?: InvalidBudgetHandler,
): ResolvedProcessDetectionBudget => {
  const maxProcesses = readOverride(options, env, 'maxProcesses', onInvalid);
  const branching = readOverride(options, env, 'maxProcessBranching', onInvalid);
  const depth = readOverride(options, env, 'maxProcessTraceDepth', onInvalid);
  const entryPoints = readOverride(options, env, 'maxEntryPointCandidates', onInvalid);
  return {
    ...(maxProcesses === undefined ? {} : { maxProcesses }),
    maxProcessBranching: branching ?? PROCESS_DETECTION_BUDGET_DEFAULTS.maxProcessBranching,
    maxProcessTraceDepth: depth ?? PROCESS_DETECTION_BUDGET_DEFAULTS.maxProcessTraceDepth,
    maxEntryPointCandidates:
      entryPoints ?? PROCESS_DETECTION_BUDGET_DEFAULTS.maxEntryPointCandidates,
    overridden: {
      maxProcesses: maxProcesses !== undefined,
      maxProcessBranching: branching !== undefined,
      maxProcessTraceDepth: depth !== undefined,
      maxEntryPointCandidates: entryPoints !== undefined,
    },
  };
};

export const hasProcessDetectionOverride = (resolved: ResolvedProcessDetectionBudget): boolean =>
  resolved.overridden.maxProcesses ||
  resolved.overridden.maxProcessBranching ||
  resolved.overridden.maxProcessTraceDepth ||
  resolved.overridden.maxEntryPointCandidates;

export const toProcessDetectionStamp = (
  resolved: ResolvedProcessDetectionBudget,
): ProcessDetectionStamp => ({
  maxProcesses: resolved.maxProcesses ?? null,
  maxProcessBranching: resolved.maxProcessBranching,
  maxProcessTraceDepth: resolved.maxProcessTraceDepth,
  maxEntryPointCandidates: resolved.maxEntryPointCandidates,
});

/** Complete stamp that always mismatches until the next successful analyze. */
export const uncertifyProcessDetectionStamp = (
  recorded: ProcessDetectionStamp | undefined,
): ProcessDetectionStamp => ({
  maxProcesses: recorded?.maxProcesses ?? null,
  maxProcessBranching:
    recorded?.maxProcessBranching ?? PROCESS_DETECTION_BUDGET_DEFAULTS.maxProcessBranching,
  maxProcessTraceDepth:
    recorded?.maxProcessTraceDepth ?? PROCESS_DETECTION_BUDGET_DEFAULTS.maxProcessTraceDepth,
  maxEntryPointCandidates:
    recorded?.maxEntryPointCandidates ?? PROCESS_DETECTION_BUDGET_DEFAULTS.maxEntryPointCandidates,
  uncertified: true,
});

const isCompleteStamp = (
  recorded: ProcessDetectionStamp | undefined,
): recorded is ProcessDetectionStamp =>
  recorded !== undefined &&
  (recorded.maxProcesses === null ||
    (typeof recorded.maxProcesses === 'number' && Number.isInteger(recorded.maxProcesses))) &&
  Number.isInteger(recorded.maxProcessBranching) &&
  Number.isInteger(recorded.maxProcessTraceDepth) &&
  Number.isInteger(recorded.maxEntryPointCandidates);

export const processDetectionBudgetMismatch = (
  recorded: ProcessDetectionStamp | undefined,
  resolved: ResolvedProcessDetectionBudget,
): boolean => {
  if (recorded?.uncertified === true) return true;
  if (!isCompleteStamp(recorded)) {
    // Legacy meta: same defaults as today's shipped behavior stay a match so
    // an upgrade backfills the stamp instead of re-detecting. Any explicit
    // override is a mismatch — otherwise a budget-only raise on a pre-#3313
    // index would preserve the sampled Community/Process layer.
    return hasProcessDetectionOverride(resolved);
  }
  const stamp = toProcessDetectionStamp(resolved);
  return (
    recorded.maxProcesses !== stamp.maxProcesses ||
    recorded.maxProcessBranching !== stamp.maxProcessBranching ||
    recorded.maxProcessTraceDepth !== stamp.maxProcessTraceDepth ||
    recorded.maxEntryPointCandidates !== stamp.maxEntryPointCandidates
  );
};

export const buildProcessDetectionPhaseConfig = (
  resolved: ResolvedProcessDetectionBudget,
  symbolCount: number,
  computeDynamicMaxProcesses: (n: number) => number,
): Pick<
  ProcessDetectionConfig,
  'maxProcesses' | 'maxBranching' | 'maxTraceDepth' | 'maxEntryPointCandidates' | 'minSteps'
> => ({
  maxProcesses: resolved.maxProcesses ?? computeDynamicMaxProcesses(symbolCount),
  maxBranching: resolved.maxProcessBranching,
  maxTraceDepth: resolved.maxProcessTraceDepth,
  maxEntryPointCandidates: resolved.maxEntryPointCandidates,
  minSteps: PROCESS_DETECTION_BUDGET_DEFAULTS.minSteps,
});

export const processDetectionEffectiveLimits = (
  maxProcesses: number,
  resolved: ResolvedProcessDetectionBudget,
): ProcessDetectionEffectiveLimits => ({
  maxProcesses,
  maxProcessBranching: resolved.maxProcessBranching,
  maxProcessTraceDepth: resolved.maxProcessTraceDepth,
  maxEntryPointCandidates: resolved.maxEntryPointCandidates,
  maxProcessTraces: maxProcesses * 2,
});

export const formatWholeFlowsMissingRemedies = (
  truncation: Pick<
    ProcessTruncationStats,
    'entryPointCandidatesDropped' | 'entryPointsUnexplored' | 'processesDropped'
  >,
  limits: ProcessDetectionEffectiveLimits,
  observedEntryPointCandidates: number,
): string => {
  const parts: string[] = [];
  if (truncation.entryPointCandidatesDropped > 0) {
    parts.push(
      `${PROCESS_DETECTION_CLI_FLAGS.maxEntryPointCandidates} ` +
        `(this run ranked ${observedEntryPointCandidates} candidate(s))`,
    );
  }
  if (truncation.entryPointsUnexplored > 0 || truncation.processesDropped > 0) {
    parts.push(
      `${PROCESS_DETECTION_CLI_FLAGS.maxProcesses} ` +
        `(this run used ${limits.maxProcesses}; next entry is skipped once ` +
        `collected traces reach ${limits.maxProcessTraces})`,
    );
  }
  return parts.length === 0 ? '' : ` Raise ${parts.join('; ')}.`;
};

export const formatProcessDetectionBudgetBanner = (
  resolved: ResolvedProcessDetectionBudget,
): string | null => {
  if (!hasProcessDetectionOverride(resolved)) return null;
  const maxProcesses = resolved.overridden.maxProcesses
    ? String(resolved.maxProcesses)
    : 'dynamic (max(20, round(symbols/10)))';
  return (
    `  Process-detection budget: maxProcesses=${maxProcesses}, ` +
    `maxProcessBranching=${resolved.maxProcessBranching}, ` +
    `maxProcessTraceDepth=${resolved.maxProcessTraceDepth}, ` +
    `maxEntryPointCandidates=${resolved.maxEntryPointCandidates}`
  );
};
