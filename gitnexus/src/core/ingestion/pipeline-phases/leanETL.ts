/**
 * Phase: leanETL
 *
 * Enriches the graph with precomputed Lean elaboration data
 * (LeanGraph ndjson + statements + leandex informalization):
 * Function/Class nodes with line anchors + CALLS edges + rich
 * descriptions. The regex provider owns file structure; this phase
 * owns everything regex cannot see (tactic-proof dependencies).
 *
 * Opt-in via environment (zero impact on the default phase list,
 * hence on the pipeline-phase-registry parity test):
 *   LEAN_ETL_NDJSON=/path/mathlib428.ndjson
 *   LEAN_ETL_STATEMENTS=/path/mathlib428_statements.jsonl
 *   LEAN_ETL_INFORMAL_DB=/path/lean_explore.db   (optional)
 *   LEAN_ETL_MODULES=Mod.A,Mod.B                 (optional filter)
 *
 * @deps    structure (repo file scan completed; needs repoPath only)
 * @reads   precomputed files above (NOT the repo scan output)
 * @writes  graph (Lean Function/Class nodes, CALLS edges)
 */

import type { PipelinePhase, PipelineContext, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';
import type { StructureOutput } from './structure.js';
import { processLeanEtl } from '../lean-processor.js';
import { logger } from '../../logger.js';

export interface LeanEtlOutput {
  nodes: number;
  classNodes: number;
  edges: number;
  dangling: number;
  lined: number;
  modules: number;
}

export const leanETLPhase: PipelinePhase<LeanEtlOutput> = {
  name: 'leanETL',
  deps: ['structure'],

  async execute(
    ctx: PipelineContext,
    deps: ReadonlyMap<string, PhaseResult<unknown>>,
  ): Promise<LeanEtlOutput> {
    getPhaseOutput<StructureOutput>(deps, 'structure');
    const ndjson = process.env.LEAN_ETL_NDJSON;
    const statements = process.env.LEAN_ETL_STATEMENTS;
    if (!ndjson || !statements) {
      return { nodes: 0, classNodes: 0, edges: 0, dangling: 0, lined: 0, modules: 0 };
    }
    const modulesRaw = process.env.LEAN_ETL_MODULES ?? '';
    const modules = new Set(modulesRaw.split(',').map((s) => s.trim()).filter(Boolean));
    logger.info(`  leanETL: ${ndjson} modules=${modules.size > 0 ? [...modules].join(',') : 'ALL'}`);
    const res = await processLeanEtl(ctx.graph, {
      repoPath: ctx.repoPath,
      ndjsonPath: ndjson,
      statementsPath: statements,
      informalDbPath: process.env.LEAN_ETL_INFORMAL_DB || undefined,
      modules: modules.size > 0 ? modules : undefined,
    });
    logger.info(
      `  leanETL: ${res.nodes} nodes (${res.classNodes} class), ${res.edges} CALLS, ` +
        `${res.dangling} dangling, lines ${res.lined}/${res.nodes}, ${res.modules} modules`,
    );
    return res;
  },
};
