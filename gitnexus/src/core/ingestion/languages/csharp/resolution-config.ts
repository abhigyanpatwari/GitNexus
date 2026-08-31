/**
 * Per-workspace config for C# scope-resolution import targeting.
 *
 * Loaded once per analyze pass via `csharpScopeResolver.loadResolutionConfig`
 * and threaded into `resolveCsharpImportTarget`. The pure gate predicates live
 * in `../../csharp-namespace-gate.ts` (shared with the legacy DAG resolver).
 */

import {
  scanCSharpProject,
  csharpScanToEvidence,
  type CSharpProjectConfig,
  type CSharpNamespaceEvidence,
} from '../../language-config.js';
import {
  loadRazorViewComponentConfig,
  type RazorViewComponentConfig,
} from './razor-view-components.js';

export interface CsharpResolutionConfig {
  readonly csharpConfigs: readonly CSharpProjectConfig[];
  /** In-repo declared-namespace evidence gating suffix-fallback resolution (#1881). */
  readonly namespaces?: CSharpNamespaceEvidence;
  /** Razor views scanned for ASP.NET ViewComponent invocation conventions. */
  readonly razorViewComponents?: RazorViewComponentConfig;
}

export async function loadCsharpResolutionConfig(
  repoRoot: string,
): Promise<CsharpResolutionConfig> {
  const [scan, razorViewComponents] = await Promise.all([
    scanCSharpProject(repoRoot),
    loadRazorViewComponentConfig(repoRoot),
  ]);
  return {
    csharpConfigs: scan.configs,
    namespaces: csharpScanToEvidence(scan),
    razorViewComponents,
  };
}
