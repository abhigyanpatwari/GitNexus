/**
 * Phase registry seam (issue #2080, taint/PDG substrate M0).
 *
 * A small, behaviour-preserving abstraction over phase-list *assembly*. Today
 * `buildPhaseList` is a hand-maintained array with a single ad-hoc
 * `if (!skipGraphPhases)` guard; this registry generalises that guard into a
 * per-phase `enabledWhen` predicate so later milestones can register opt-in
 * phases (e.g. CFG → M1 #2081) without editing the array each time.
 *
 * M0 wires the seam with **no behaviour change**: `build(options)` must return
 * a phase list identical in membership and order to the legacy array for every
 * options combination. The registry covers only list assembly — the runner,
 * topological sort, `PipelinePhase.execute`, and any result-extraction guards
 * (e.g. the `skipGraphPhases` check in `runPipelineFromRepo`) are untouched.
 *
 * Generic over the options type so this module depends only on `PipelinePhase`
 * (no import of `PipelineOptions`, which lives in `pipeline.ts` and would
 * otherwise create an import cycle).
 */

import type { PipelinePhase } from './types.js';

/** Options accepted when registering a phase. */
export interface RegisterPhaseOptions<TOptions> {
  /**
   * Predicate deciding whether this phase is included for a given options
   * object. Absent ⇒ the phase is always enabled. This is the generalised
   * form of the legacy `if (!skipGraphPhases)` guard.
   *
   * `options` is required, not optional: callers normalize an absent options
   * object once at `build()` (e.g. `buildPhaseList` passes `options ?? {}`), so
   * individual predicates read `(o) => !o.skipGraphPhases` without a defensive
   * `?.` on every phase (#2080 review S1).
   */
  readonly enabledWhen?: (options: TOptions) => boolean;
}

interface PhaseRegistration<TOptions> {
  readonly phase: PipelinePhase;
  readonly enabledWhen?: (options: TOptions) => boolean;
}

/**
 * Ordered registry of pipeline phases. Not a global singleton — callers
 * construct a fresh registry (so registration order is deterministic and there
 * is no import-order or test-isolation hazard) and `build()` it per run.
 */
export class PhaseRegistry<TOptions = unknown> {
  private readonly registrations: PhaseRegistration<TOptions>[] = [];

  /**
   * Register a phase. This is the `registerPhase(phase, { enabledWhen })` seam
   * named in issue #2080. Returns `this` for fluent chaining. Registration
   * order is preserved by `build()`.
   */
  register(phase: PipelinePhase, options?: RegisterPhaseOptions<TOptions>): this {
    this.registrations.push({ phase, enabledWhen: options?.enabledWhen });
    return this;
  }

  /**
   * Build the ordered phase list for the given options. A phase is included
   * iff it has no `enabledWhen` predicate or its predicate returns `true`.
   * Order matches registration order. `options` is required — callers that may
   * have no options normalize once at the call site (`options ?? {}`) so the
   * predicates never see `undefined`.
   */
  build(options: TOptions): PipelinePhase[] {
    return this.registrations
      .filter((r) => r.enabledWhen === undefined || r.enabledWhen(options))
      .map((r) => r.phase);
  }
}
