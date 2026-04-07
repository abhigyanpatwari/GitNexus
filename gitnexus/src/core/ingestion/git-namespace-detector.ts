/**
 * Git-namespace Detector
 * 
 * Scans a repository directory for all nested .git boundaries and builds
 * a lookup map for Deepest-Wins namespace resolution.
 * 
 * Used by the ingestion pipeline to tag every GraphNode with its
 * owning git_namespace, preventing cross-contamination in RAG queries.
 */

import { glob } from 'glob';
import path from 'path';

/**
 * Git-namespace boundary map.
 * Keys: relative paths of directories containing .git (e.g. "DOCS/ref/GitNexus")
 * Values: virtual namespace paths (e.g. "root-repo/DOCS/ref/GitNexus")
 * 
 * Root repo always has key "" mapping to repo basename.
 * Sorted by path depth descending for Deepest-Wins lookup.
 */
export interface GitNamespaceMap {
  /** Sorted boundary paths (longest first for O(B) Deepest-Wins lookup) */
  boundaries: string[];
  /** boundary path → virtual namespace */
  namespaces: Map<string, string>;
}

/**
 * Scan repoPath for all nested .git directories.
 * Returns a GitNamespaceMap with boundaries sorted by depth descending (deepest first).
 * 
 * Uses glob with dot:true to find .git specifically.
 * Root .git is included as boundary "".
 * 
 * ⚠️ Git submodules create .git FILE (not directory) containing:
 *    "gitdir: ../../../.git/modules/xxx"
 *    Must NOT use onlyDirectories:true — would miss submodules entirely.
 */
export async function buildGitNamespaceMap(repoPath: string): Promise<GitNamespaceMap> {
  const repoName = path.basename(repoPath);
  
  // Find all .git entries (directory OR file)
  const gitEntries = await glob('**/.git', {
    cwd: repoPath,
    dot: true,        // .git starts with dot
    // onlyDirectories: false (default) — catches both .git dirs AND .git files
    ignore: ['**/node_modules/**'],
  });
  
  const namespaces = new Map<string, string>();
  
  // Root always exists as boundary ""
  namespaces.set('', repoName);
  
  // Each .git parent directory is a boundary
  for (const gitPath of gitEntries) {
    // gitPath = "DOCS/RESEARCH/poc/reference/GitNexus/.git"
    const parentDir = path.dirname(gitPath).replace(/\\/g, '/');
    if (parentDir === '.') continue; // root .git, already handled
    
    // Virtual namespace = repoName + "/" + relative path
    const namespace = `${repoName}/${parentDir}`;
    namespaces.set(parentDir, namespace);
  }
  
  // Sort boundaries by depth descending (longest path first = deepest wins)
  const boundaries = Array.from(namespaces.keys())
    .filter(b => b !== '') // root goes last
    .sort((a, b) => b.split('/').length - a.split('/').length || b.length - a.length);
  boundaries.push(''); // root is always the fallback
  
  return { boundaries, namespaces };
}

/**
 * Resolve which git-namespace a file belongs to (Deepest-Wins).
 * 
 * @param filePath - Relative file path (e.g. "DOCS/RESEARCH/poc/reference/GitNexus/src/core/pipeline.ts")
 * @param namespaceMap - Pre-built GitNamespaceMap from buildGitNamespaceMap()
 * @returns Virtual namespace string (e.g. "root-repo/DOCS/RESEARCH/poc/reference/GitNexus")
 */
export function resolveGitNamespace(filePath: string, namespaceMap: GitNamespaceMap): string {
  const normalizedPath = filePath.replace(/\\/g, '/');
  
  // Deepest-Wins: iterate boundaries from longest to shortest
  for (const boundary of namespaceMap.boundaries) {
    if (boundary === '') {
      // Root fallback (always matches)
      return namespaceMap.namespaces.get('')!;
    }
    if (normalizedPath.startsWith(boundary + '/') || normalizedPath === boundary) {
      return namespaceMap.namespaces.get(boundary)!;
    }
  }
  
  // Should never reach here (root '' is always last), but safety fallback
  return namespaceMap.namespaces.get('')!;
}

/**
 * Build namespace_hint metadata to attach to query response.
 * Called ONLY when git_namespace param is not specified (undefined).
 * 
 * @param results - Query results with git_namespace property
 * @param namespaceMap - Pre-built GitNamespaceMap (cached from ingestion)
 * @returns namespace_hint object or null if only 1 namespace in results
 */
export function buildNamespaceHint(
  results: Array<{ git_namespace: string }>,
  namespaceMap: GitNamespaceMap
): NamespaceHint | null {
  // Count results per namespace
  const resultsByNamespace = new Map<string, number>();
  for (const r of results) {
    resultsByNamespace.set(r.git_namespace, (resultsByNamespace.get(r.git_namespace) || 0) + 1);
  }
  
  // If all results from same namespace → no hint needed
  if (resultsByNamespace.size <= 1) return null;
  
  return {
    warning: `Results span ${resultsByNamespace.size} git-namespaces. ` +
             `Narrow with git_namespace parameter for precise results.`,
    available_namespaces: Array.from(namespaceMap.namespaces.entries()).map(
      ([boundary, namespace]) => ({
        name: namespace,
        type: boundary === '' ? 'root' as const : 'nested' as const,
      })
    ),
    results_by_namespace: Object.fromEntries(resultsByNamespace),
  };
}

export interface NamespaceHint {
  warning: string;
  available_namespaces: Array<{
    name: string;
    type: 'root' | 'nested';
  }>;
  results_by_namespace: Record<string, number>;
}
