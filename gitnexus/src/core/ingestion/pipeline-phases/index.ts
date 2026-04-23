/**
 * Pipeline Phases — barrel export.
 *
 * Exports all phases, the runner, types, and shared utilities
 * for the ingestion pipeline.
 */

// ── Phase exports (in dependency order) ────────────────────────────────────

export { scanPhase, type ScanOutput } from './scan.js';
export { structurePhase, type StructureOutput } from './structure.js';
export { markdownPhase, type MarkdownOutput } from './markdown.js';
export { cobolPhase, type CobolOutput } from './cobol.js';
export { parsePhase, type ParseOutput } from './parse.js';
export { routesPhase, type RoutesOutput, type RouteEntry } from './routes.js';
export { toolsPhase, type ToolsOutput, type ToolDef } from './tools.js';
export { ormPhase, type ORMOutput } from './orm.js';
export { crossFilePhase, type CrossFileOutput } from './cross-file.js';
export {
  scopeResolutionPhase,
  type ScopeResolutionOutput,
} from '../scope-resolution/pipeline/phase.js';
export { mroPhase, type MROOutput } from './mro.js';
export { communitiesPhase, type CommunitiesOutput } from './communities.js';
export { processesPhase, type ProcessesOutput } from './processes.js';

// ── Infrastructure ─────────────────────────────────────────────────────────

export { runPipeline } from './runner.js';
export type { PipelinePhase, PipelineContext, PhaseResult } from './types.js';
export { getPhaseOutput } from './types.js';
