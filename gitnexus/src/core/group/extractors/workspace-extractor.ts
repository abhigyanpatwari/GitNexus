import type { CypherExecutor } from '../contract-extractor.js';
import type { GroupManifestLink } from '../types.js';
import { extractRustWorkspaceLinks } from './rust-workspace-extractor.js';
import { extractNodeWorkspaceLinks } from './node-workspace-extractor.js';
import { extractPythonWorkspaceLinks } from './python-workspace-extractor.js';
import { extractGoWorkspaceLinks } from './go-workspace-extractor.js';
import { extractJavaWorkspaceLinks } from './java-workspace-extractor.js';
import { extractElixirWorkspaceLinks } from './elixir-workspace-extractor.js';

export interface WorkspaceDiscoveryResult {
  links: GroupManifestLink[];
  stats: WorkspaceExtractorStats[];
}

interface WorkspaceExtractorStats {
  ecosystem: string;
  linkCount: number;
  projectCount: number;
}

export async function discoverWorkspaceLinks(
  repos: Record<string, string>,
  repoPaths: Map<string, string>,
  dbExecutors?: Map<string, CypherExecutor>,
): Promise<WorkspaceDiscoveryResult> {
  const links: GroupManifestLink[] = [];
  const stats: WorkspaceExtractorStats[] = [];

  const rustResult = await extractRustWorkspaceLinks(repos, repoPaths, dbExecutors);
  if (rustResult.links.length > 0) {
    links.push(...rustResult.links);
    stats.push({
      ecosystem: 'Rust',
      linkCount: rustResult.links.length,
      projectCount: rustResult.discoveredCrates.size,
    });
  }

  const nodeResult = await extractNodeWorkspaceLinks(repos, repoPaths, dbExecutors);
  if (nodeResult.links.length > 0) {
    links.push(...nodeResult.links);
    stats.push({
      ecosystem: 'Node',
      linkCount: nodeResult.links.length,
      projectCount: nodeResult.discoveredPackages.size,
    });
  }

  const pyResult = await extractPythonWorkspaceLinks(repos, repoPaths, dbExecutors);
  if (pyResult.links.length > 0) {
    links.push(...pyResult.links);
    stats.push({
      ecosystem: 'Python',
      linkCount: pyResult.links.length,
      projectCount: pyResult.discoveredPackages.size,
    });
  }

  const goResult = await extractGoWorkspaceLinks(repos, repoPaths, dbExecutors);
  if (goResult.links.length > 0) {
    links.push(...goResult.links);
    stats.push({
      ecosystem: 'Go',
      linkCount: goResult.links.length,
      projectCount: goResult.discoveredModules.size,
    });
  }

  const javaResult = await extractJavaWorkspaceLinks(repos, repoPaths, dbExecutors);
  if (javaResult.links.length > 0) {
    links.push(...javaResult.links);
    stats.push({
      ecosystem: 'Java',
      linkCount: javaResult.links.length,
      projectCount: javaResult.discoveredProjects.size,
    });
  }

  const elixirResult = await extractElixirWorkspaceLinks(repos, repoPaths, dbExecutors);
  if (elixirResult.links.length > 0) {
    links.push(...elixirResult.links);
    stats.push({
      ecosystem: 'Elixir',
      linkCount: elixirResult.links.length,
      projectCount: elixirResult.discoveredApps.size,
    });
  }

  return { links, stats };
}
