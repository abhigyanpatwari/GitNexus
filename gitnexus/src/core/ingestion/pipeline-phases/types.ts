/**
 * Pipeline Phase — Type definitions.
 *
 * Each phase is a named node in the dependency graph with typed inputs and outputs.
 * The runner resolves dependencies via topological sort and passes
 * typed results from upstream phases as inputs to downstream phases.
 *
 * Design goals:
 *  - Explicit data flow between phases via typed outputs
 *  - The knowledge graph is a shared mutable accumulator — phases add nodes/edges
 *    and may read prior phases' contributions. This is intentional: the graph is
 *    the pipeline's primary output, not an inter-phase communication channel.
 *  - Compile-time exhaustiveness (adding a phase = type error until wired)
 *  - Each phase is independently testable with mocked inputs
 */

import type { KnowledgeGraph } from '../../graph/types.js';
import type { PipelineProgress } from 'gitnexus-shared';
import type { PipelineOptions } from '../pipeline.js';

// ── Shared context ─────────────────────────────────────────────────────────

/** Immutable context available to every phase. */
export interface PipelineContext {
  /** Absolute path to the repository root. */
  readonly repoPath: string;
  /** Mutable knowledge graph — the single shared accumulator. */
  readonly graph: KnowledgeGraph;
  /** Progress callback for UI updates. */
  readonly onProgress: (progress: PipelineProgress) => void;
  /** Pipeline options (skipGraphPhases, skipWorkers, etc.). */
  readonly options?: PipelineOptions;
  /** Pipeline start timestamp (for elapsed-time logging). */
  readonly pipelineStart: number;
}

// ── Phase result wrapper ───────────────────────────────────────────────────

/** Wraps a phase's output with timing metadata. */
export interface PhaseResult<T> {
  /** Phase name (matches the phase's `name` field). */
  readonly phaseName: string;
  /** The typed output of the phase. */
  readonly output: T;
  /** Wall-clock duration in milliseconds. */
  readonly durationMs: number;
}

// ── Phase definition ───────────────────────────────────────────────────────

/**
 * A single phase in the ingestion pipeline.
 *
 * @typeParam TDeps - Tuple of dependency phase output types
 * @typeParam TOutput - This phase's output type
 */
export interface PipelinePhase<TOutput = unknown> {
  /** Unique name for logging and result lookup. */
  readonly name: string;

  /**
   * Names of phases this phase depends on.
   * The runner guarantees these have completed before execute() is called.
   */
  readonly deps: readonly string[];

  /**
   * Execute the phase.
   *
   * @param ctx    Shared pipeline context (graph, repoPath, progress, options)
   * @param deps   Map of dependency name → PhaseResult (typed outputs from upstream phases)
   * @returns      The phase's typed output
   */
  execute(ctx: PipelineContext, deps: ReadonlyMap<string, PhaseResult<unknown>>): Promise<TOutput>;
}

/**
 * Helper to extract the typed output of a dependency phase.
 *
 * Type safety note: This uses an `as T` cast because the runner stores
 * heterogeneous phase outputs in a single `Map<string, PhaseResult<unknown>>`.
 * The cast is safe as long as callers use the correct output type for the
 * named phase. Mismatches will surface as runtime type errors, not compile-time
 * errors — this is an intentional trade-off for a static phase graph without
 * a dynamic type registry.
 *
 * @param deps       The resolved dependency map from the runner
 * @param phaseName  The name of the upstream phase whose output you need
 * @returns          The typed output of the phase
 * @throws           If the phase is not found in the dependency map
 */
export function getPhaseOutput<T>(
  deps: ReadonlyMap<string, PhaseResult<unknown>>,
  phaseName: string,
): T {
  const result = deps.get(phaseName);
  if (!result) {
    throw new Error(`Phase '${phaseName}' not found in resolved dependencies`);
  }
  return result.output as T;
}
