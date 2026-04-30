/**
 * Pipeline progress types — shared between CLI and web.
 */

export type PipelinePhase =
  | 'idle'
  | 'extracting'
  | 'structure'
  | 'parsing'
  | 'imports'
  | 'calls'
  | 'heritage'
  | 'anchors'
  | 'communities'
  | 'processes'
  | 'enriching'
  | 'complete'
  | 'error';

export interface PipelineProgress {
  phase: PipelinePhase;
  percent: number;
  message: string;
  detail?: string;
  stats?: {
    filesProcessed: number;
    totalFiles: number;
    nodesCreated: number;
    filesChanged?: number;
    symbolsUpdated?: number;
    warnings?: number;
  };
}
