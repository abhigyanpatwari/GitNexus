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
type CompiledActuatorExclusion =
  | { kind: 'repo-root-endpoints' }
  | { kind: 'dir'; resolved: string };

function compileActuatorExclusions(
  repoPath: string,
  inputPaths: readonly string[],
): CompiledActuatorExclusion[] {
  const repo = path.resolve(repoPath);
  const compiled: CompiledActuatorExclusion[] = [];
  const seen = new Set<string>();
  for (const inputPath of inputPaths) {
    const input = path.resolve(repoPath, inputPath);
    const inputRelativeToRepo = path.relative(repo, input);
    if (inputRelativeToRepo === '') {
      if (seen.has('')) continue;
      seen.add('');
      compiled.push({ kind: 'repo-root-endpoints' });
      continue;
    }
    if (
      inputRelativeToRepo === '..' ||
      inputRelativeToRepo.startsWith(`..${path.sep}`) ||
      path.isAbsolute(inputRelativeToRepo)
    ) {
      continue;
    }
    if (seen.has(input)) continue;
    seen.add(input);
    compiled.push({ kind: 'dir', resolved: input });
  }
  return compiled;
}

function matchesActuatorExclusion(
  repoPath: string,
  filePath: string,
  exclusions: readonly CompiledActuatorExclusion[],
): boolean {
  if (exclusions.length === 0) return false;
  const repo = path.resolve(repoPath);
  const candidate = path.resolve(repoPath, filePath);
  for (const exclusion of exclusions) {
    if (exclusion.kind === 'repo-root-endpoints') {
      const candidateRelativeToRepo = path.relative(repo, candidate);
      if (
        path.dirname(candidateRelativeToRepo) === '.' &&
        SPRING_ACTUATOR_ENDPOINT_FILES.has(path.basename(candidateRelativeToRepo).toLowerCase())
      ) {
        return true;
      }
      continue;
    }
    const relative = path.relative(exclusion.resolved, candidate);
    if (
      relative === '' ||
      (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    ) {
      return true;
    }
  }
  return false;
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

    const actuatorExclusions = compileActuatorExclusions(ctx.repoPath, [
      ...(ctx.options?.springActuatorPath === undefined ? [] : [ctx.options.springActuatorPath]),
      ...(ctx.options?.springActuatorScanExclusions ?? []),
    ]);
    let scannedFiles;
    try {
      scannedFiles = await walkRepositoryPaths(ctx.repoPath, (current, total, filePath) => {
        const scanProgress = Math.round((current / total) * 15);
        const isRuntimeInput = matchesActuatorExclusion(ctx.repoPath, filePath, actuatorExclusions);
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

    if (actuatorExclusions.length > 0) {
      scannedFiles = scannedFiles.filter(
        (file) => !matchesActuatorExclusion(ctx.repoPath, file.path, actuatorExclusions),
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
