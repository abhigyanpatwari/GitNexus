/**
 * Pipeline Phase Runner
 *
 * Executes pipeline phases in dependency order using Kahn's topological sort.
 * Each phase receives typed outputs from its upstream dependencies.
 *
 * The runner is intentionally simple:
 * - No dynamic phase loading
 * - No plugin system
 * - Static phase graph, compile-time type safety
 * - Sequential execution (parallel support is architecturally possible
 *   but most phases have linear dependencies)
 */

import type { PipelinePhase, PipelineContext, PhaseResult } from './types.js';
import { isDev } from './constants.js';

/**
 * Validate that the phases form a valid dependency graph (no cycles, all deps present).
 * Returns phases in topological execution order.
 */
function topologicalSort(phases: readonly PipelinePhase[]): PipelinePhase[] {
  const phaseMap = new Map<string, PipelinePhase>();
  for (const phase of phases) {
    if (phaseMap.has(phase.name)) {
      throw new Error(`Duplicate phase name: '${phase.name}'`);
    }
    phaseMap.set(phase.name, phase);
  }

  // Validate all deps exist
  for (const phase of phases) {
    for (const dep of phase.deps) {
      if (!phaseMap.has(dep)) {
        throw new Error(`Phase '${phase.name}' depends on '${dep}', which is not registered`);
      }
    }
  }

  // Kahn's algorithm
  const inDegree = new Map<string, number>();
  const reverseDeps = new Map<string, string[]>();

  for (const phase of phases) {
    inDegree.set(phase.name, phase.deps.length);
    for (const dep of phase.deps) {
      let rev = reverseDeps.get(dep);
      if (!rev) {
        rev = [];
        reverseDeps.set(dep, rev);
      }
      rev.push(phase.name);
    }
  }

  const sorted: PipelinePhase[] = [];
  const queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([name]) => name);

  while (queue.length > 0) {
    const name = queue.shift()!;
    sorted.push(phaseMap.get(name)!);

    for (const dependent of reverseDeps.get(name) ?? []) {
      const newDeg = (inDegree.get(dependent) ?? 1) - 1;
      inDegree.set(dependent, newDeg);
      if (newDeg === 0) queue.push(dependent);
    }
  }

  if (sorted.length !== phases.length) {
    const remaining = [...inDegree.entries()].filter(([, d]) => d > 0).map(([name]) => name);
    throw new Error(`Cycle detected in pipeline phases: ${remaining.join(', ')}`);
  }

  return sorted;
}

/**
 * Execute a set of pipeline phases in dependency order.
 *
 * @param phases  All phases to execute (order doesn't matter — sorted internally)
 * @param ctx     Shared pipeline context
 * @returns       Map of phase name → PhaseResult (all completed phases)
 */
export async function runPipeline(
  phases: readonly PipelinePhase[],
  ctx: PipelineContext,
): Promise<ReadonlyMap<string, PhaseResult<unknown>>> {
  const sorted = topologicalSort(phases);
  const results = new Map<string, PhaseResult<unknown>>();

  for (const phase of sorted) {
    const start = Date.now();

    if (isDev) {
      console.log(`▶ Phase: ${phase.name}`);
    }

    // Only expose declared dependencies — prevents hidden coupling to undeclared phases.
    const declaredDeps = new Map<string, PhaseResult<unknown>>();
    for (const depName of phase.deps) {
      const depResult = results.get(depName);
      if (depResult) declaredDeps.set(depName, depResult);
    }

    const output = await phase.execute(ctx, declaredDeps);
    const durationMs = Date.now() - start;

    results.set(phase.name, {
      phaseName: phase.name,
      output,
      durationMs,
    });

    if (isDev) {
      console.log(`✓ Phase: ${phase.name} (${durationMs}ms)`);
    }
  }

  return results;
}
