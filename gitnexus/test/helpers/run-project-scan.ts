import type {
  HttpFileDetections,
  HttpLanguagePlugin,
  HttpScanInput,
  RepoContext,
} from '../../src/core/group/extractors/http-patterns/types.js';

/**
 * One-shot form of an HTTP plugin's project scan, for tests that already hold
 * every input tree: each file through `collect`, then one `resolve`. The
 * orchestrator instead runs `collect` per file as it parses and clones the
 * facts, so a fact shape that only fails under `structuredClone` is caught by
 * the orchestrator tests, not by callers of this helper.
 */
export function runProjectScan(
  plugin: HttpLanguagePlugin,
  inputs: readonly HttpScanInput[],
  repoContext?: RepoContext,
): HttpFileDetections[] {
  const scan = plugin.projectScan;
  if (!scan || inputs.length === 0) return [];
  return scan.resolve(
    inputs.map((input) => scan.collect(input, repoContext)),
    repoContext,
  );
}
