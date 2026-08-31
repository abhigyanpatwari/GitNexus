/**
 * Phase: scan
 *
 * Walks the repository filesystem and collects file paths + sizes.
 * Does NOT read file contents — that happens in downstream phases.
 *
 * @deps    (none — this is the pipeline root)
 * @reads   repoPath (filesystem)
 * @writes  graph (nothing yet — just returns scanned paths)
 * @output  ScannedFile[], allPaths[], totalFiles
 */

import type { PipelinePhase, PipelineContext } from './types.js';
import { walkRepositoryPaths } from '../filesystem-walker.js';
import path from 'node:path';

export interface ScanOutput {
  scannedFiles: { path: string; size: number }[];
  allPaths: string[];
  totalFiles: number;
}

const SPRING_ACTUATOR_ENDPOINT_FILES = new Set([
  'mappings.json',
  'beans.json',
  'conditions.json',
  'configprops.json',
  'env.json',
]);

/**
 * Runtime snapshots are external analysis inputs, not repository source. When
 * a configured input lives below the repository root, exclude it before any
 * downstream phase reads file contents. This is especially important for
 * Actuator env/configprops payloads: their values must never become File-node
 * content or enter FTS merely because the snapshot directory is in the repo.
 */
function excludesRuntimeInput(repoPath: string, filePath: string, inputPath: string): boolean {
  const repo = path.resolve(repoPath);
  const candidate = path.resolve(repoPath, filePath);
  const input = path.resolve(repoPath, inputPath);

  const inputRelativeToRepo = path.relative(repo, input);
  if (inputRelativeToRepo === '') {
    const candidateRelativeToRepo = path.relative(repo, candidate);
    return (
      path.dirname(candidateRelativeToRepo) === '.' &&
      SPRING_ACTUATOR_ENDPOINT_FILES.has(path.basename(candidateRelativeToRepo).toLowerCase())
    );
  }
  if (inputRelativeToRepo.startsWith('..') || path.isAbsolute(inputRelativeToRepo)) return false;

  const relative = path.relative(input, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export const scanPhase: PipelinePhase<ScanOutput> = {
  name: 'scan',
  deps: [],

  async execute(ctx: PipelineContext): Promise<ScanOutput> {
    ctx.onProgress({
      phase: 'extracting',
      percent: 0,
      message: 'Scanning repository...',
    });

    const springActuatorPath = ctx.options?.springActuatorPath;
    let scannedFiles;
    try {
      scannedFiles = await walkRepositoryPaths(ctx.repoPath, (current, total, filePath) => {
        const scanProgress = Math.round((current / total) * 15);
        const isRuntimeInput =
          springActuatorPath !== undefined &&
          excludesRuntimeInput(ctx.repoPath, filePath, springActuatorPath);
        ctx.onProgress({
          phase: 'extracting',
          percent: scanProgress,
          message: 'Scanning repository...',
          ...(isRuntimeInput ? {} : { detail: filePath }),
          stats: {
            filesProcessed: current,
            totalFiles: total,
            nodesCreated: ctx.graph.nodeCount,
          },
        });
      });
    } catch (err) {
      // Missing roots throw so status cannot treat an empty glob as "every
      // covered file was deleted". The pipeline still reports an empty scan
      // for a path that is not a directory, matching analyze of a bad cwd.
      if (err instanceof Error && err.message.startsWith('walkRepositoryPaths:')) {
        return { scannedFiles: [], allPaths: [], totalFiles: 0 };
      }
      throw err;
    }

    if (springActuatorPath !== undefined) {
      scannedFiles = scannedFiles.filter(
        (file) => !excludesRuntimeInput(ctx.repoPath, file.path, springActuatorPath),
      );
    }

    const totalFiles = scannedFiles.length;
    const allPaths = scannedFiles.map((f) => f.path);

    ctx.onProgress({
      phase: 'extracting',
      percent: 15,
      message: 'Repository scanned successfully',
      stats: { filesProcessed: totalFiles, totalFiles, nodesCreated: ctx.graph.nodeCount },
    });

    return { scannedFiles, allPaths, totalFiles };
  },
};
