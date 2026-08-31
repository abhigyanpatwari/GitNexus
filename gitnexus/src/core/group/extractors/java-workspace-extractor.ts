import fs from 'node:fs/promises';
import path from 'node:path';
import type { CypherExecutor } from '../contract-extractor.js';
import type { GroupManifestLink, ContractRole } from '../types.js';
import { shouldIgnorePath, loadIgnoreRules } from '../../../config/ignore-service.js';

import { logger } from '../../logger.js';
interface JavaProjectMeta {
  groupId: string;
  artifactId: string;
  basePackage: string;
  groupPath: string;
  repoPath: string;
  deps: string[];
}

interface ImportedSymbol {
  artifactKey: string;
  symbolName: string;
  filePath: string;
}

interface XmlElement {
  name: string;
  text: string;
  children: XmlElement[];
}

async function parseJavaManifest(
  repoPath: string,
): Promise<{ groupId: string; artifactId: string; deps: string[] } | null> {
  const pomPath = path.join(repoPath, 'pom.xml');
  try {
    const content = await fs.readFile(pomPath, 'utf-8');
    return parsePom(content);
  } catch {
    // fall through to Gradle
  }

  for (const name of ['build.gradle.kts', 'build.gradle']) {
    const gradlePath = path.join(repoPath, name);
    try {
      const content = await fs.readFile(gradlePath, 'utf-8');
      return parseGradle(content, repoPath);
    } catch {
      continue;
    }
  }

  return null;
}

// POMs are static metadata, so preserve XML hierarchy without invoking Maven or
// pulling in a full effective-model resolver. This intentionally models only
// literal elements; properties, profiles, and remote parent resolution remain
// outside the workspace extractor's deterministic boundary.
function parseXmlRoot(content: string, rootName: string): XmlElement | null {
  const document: XmlElement = { name: '', text: '', children: [] };
  const stack = [document];
  const tokens = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<[^>]+>/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = tokens.exec(content)) !== null) {
    if (stack.length > 1) {
      stack[stack.length - 1].text += content.slice(cursor, match.index);
    }
    cursor = match.index + match[0].length;

    const token = match[0];
    if (token.startsWith('<![CDATA[')) {
      if (stack.length > 1) stack[stack.length - 1].text += token.slice(9, -3);
      continue;
    }
    if (token.startsWith('<!--') || token.startsWith('<?') || token.startsWith('<!')) {
      continue;
    }

    const closing = token.match(/^<\/\s*([^\s>]+)\s*>$/);
    if (closing) {
      const name = closing[1].split(':').pop()!;
      if (stack.length === 1 || stack[stack.length - 1].name !== name) return null;
      stack.pop();
      continue;
    }

    const opening = token.match(/^<\s*([^\s/>]+)/);
    if (!opening) return null;
    const element: XmlElement = {
      name: opening[1].split(':').pop()!,
      text: '',
      children: [],
    };
    stack[stack.length - 1].children.push(element);
    if (!/\/\s*>$/.test(token)) stack.push(element);
  }

  if (stack.length !== 1) return null;
  return document.children.find((element) => element.name === rootName) ?? null;
}

function childText(element: XmlElement | undefined, name: string): string | undefined {
  const value = element?.children.find((child) => child.name === name)?.text.trim();
  return value || undefined;
}

function descendants(element: XmlElement, name: string, matches: XmlElement[] = []): XmlElement[] {
  for (const child of element.children) {
    if (child.name === name) matches.push(child);
    descendants(child, name, matches);
  }
  return matches;
}

function parsePom(content: string): { groupId: string; artifactId: string; deps: string[] } | null {
  const project = parseXmlRoot(content, 'project');
  if (!project) return null;

  // Maven inherits groupId from <parent>, but artifactId is always the
  // project's own direct child and must never fall back to parent.artifactId.
  const groupId =
    childText(project, 'groupId') ??
    childText(
      project.children.find((child) => child.name === 'parent'),
      'groupId',
    );
  const artifactId = childText(project, 'artifactId');
  if (!groupId || !artifactId) return null;

  const deps: string[] = [];
  for (const dependency of descendants(project, 'dependency')) {
    const dependencyGroupId = childText(dependency, 'groupId');
    const dependencyArtifactId = childText(dependency, 'artifactId');
    if (dependencyGroupId && dependencyArtifactId) {
      deps.push(`${dependencyGroupId}:${dependencyArtifactId}`);
    }
  }

  return { groupId, artifactId, deps: [...new Set(deps)] };
}

function parseGradle(
  content: string,
  repoPath: string,
): { groupId: string; artifactId: string; deps: string[] } | null {
  const groupMatch = content.match(/group\s*=\s*['"]([^'"]+)['"]/);
  const dirName = path.basename(repoPath);
  const groupId = groupMatch ? groupMatch[1] : '';
  if (!groupId) return null;

  const artifactId = dirName;

  const deps: string[] = [];
  // implementation("group:artifact:version") or api("group:artifact:version")
  const depMatches = content.matchAll(
    /(?:implementation|api|compileOnly|runtimeOnly)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  );
  for (const m of depMatches) {
    const parts = m[1].split(':');
    if (parts.length >= 2) {
      deps.push(`${parts[0]}:${parts[1]}`);
    }
  }

  // implementation(project(":subproject"))
  const projDeps = content.matchAll(
    /(?:implementation|api)\s*\(\s*project\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\)/g,
  );
  for (const m of projDeps) {
    const subName = m[1].replace(/^:/, '');
    deps.push(`${groupId}:${subName}`);
  }

  return { groupId, artifactId, deps: [...new Set(deps)] };
}

function deriveBasePackage(groupId: string, artifactId: string): string {
  const sanitized = artifactId.replace(/-/g, '.');
  if (groupId.endsWith(`.${sanitized}`) || groupId === sanitized) {
    return groupId;
  }
  return `${groupId}.${sanitized}`;
}

async function scanJavaImports(
  repoPath: string,
  knownPackages: Map<string, string>,
): Promise<ImportedSymbol[]> {
  const results: ImportedSymbol[] = [];
  const sourceFiles = await findJavaFiles(repoPath);

  for (const relFile of sourceFiles) {
    const absPath = path.join(repoPath, relFile);
    let content: string;
    try {
      content = await fs.readFile(absPath, 'utf-8');
    } catch {
      continue;
    }

    const importRegex = /^import\s+(?:static\s+)?([a-zA-Z][\w.]*\.[A-Z]\w*)/gm;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const fullImport = match[1];
      for (const [basePkg, artifactKey] of knownPackages) {
        if (fullImport.startsWith(basePkg + '.') || fullImport === basePkg) {
          const parts = fullImport.split('.');
          const className = parts[parts.length - 1];
          if (isPascalCase(className)) {
            results.push({
              artifactKey,
              symbolName: className,
              filePath: relFile,
            });
          }
          break;
        }
      }
    }
  }

  return results;
}

function isPascalCase(name: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/.test(name);
}

async function findJavaFiles(repoPath: string): Promise<string[]> {
  const results: string[] = [];
  const ig = await loadIgnoreRules(repoPath);

  async function walk(dir: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (shouldIgnorePath(childRel)) continue;
        if (ig && ig.ignores(childRel + '/')) continue;
        await walk(path.join(dir, entry.name), childRel);
      } else if (entry.name.endsWith('.java') || entry.name.endsWith('.kt')) {
        if (shouldIgnorePath(childRel)) continue;
        if (ig && ig.ignores(childRel)) continue;
        results.push(childRel);
      }
    }
  }

  await walk(repoPath, '');
  return results;
}

export interface JavaWorkspaceResult {
  links: GroupManifestLink[];
  discoveredProjects: Map<string, JavaProjectMeta>;
}

export async function extractJavaWorkspaceLinks(
  repos: Record<string, string>,
  repoPaths: Map<string, string>,
  _dbExecutors?: Map<string, CypherExecutor>,
): Promise<JavaWorkspaceResult> {
  const projectsByKey = new Map<string, JavaProjectMeta>();
  const projectsByGroupPath = new Map<string, JavaProjectMeta>();

  for (const [groupPath] of Object.entries(repos)) {
    const repoPath = repoPaths.get(groupPath);
    if (!repoPath) continue;

    const manifest = await parseJavaManifest(repoPath);
    if (!manifest) continue;

    const key = `${manifest.groupId}:${manifest.artifactId}`;
    const meta: JavaProjectMeta = {
      groupId: manifest.groupId,
      artifactId: manifest.artifactId,
      basePackage: deriveBasePackage(manifest.groupId, manifest.artifactId),
      groupPath,
      repoPath,
      deps: manifest.deps,
    };
    const existing = projectsByKey.get(key);
    if (existing) {
      logger.warn(
        `[java-workspace-extractor] duplicate artifact "${key}" in "${groupPath}" and "${existing.groupPath}" — skipping "${groupPath}"`,
      );
      continue;
    }
    projectsByKey.set(key, meta);
    projectsByGroupPath.set(groupPath, meta);
  }

  const links: GroupManifestLink[] = [];
  const seen = new Set<string>();

  for (const [, proj] of projectsByGroupPath) {
    const groupDeps = proj.deps.filter((d) => projectsByKey.has(d));
    if (groupDeps.length === 0) continue;

    const knownPackages = new Map<string, string>();
    for (const dep of groupDeps) {
      const depMeta = projectsByKey.get(dep);
      if (depMeta) knownPackages.set(depMeta.basePackage, dep);
    }

    const imports = await scanJavaImports(proj.repoPath, knownPackages);

    for (const imp of imports) {
      const providerProj = projectsByKey.get(imp.artifactKey);
      if (!providerProj) continue;

      const qualifiedContract = `${providerProj.artifactId}::${imp.symbolName}`;
      const dedupKey = `${proj.groupPath}→${providerProj.groupPath}::${qualifiedContract}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      const link: GroupManifestLink = {
        from: providerProj.groupPath,
        to: proj.groupPath,
        type: 'custom',
        contract: qualifiedContract,
        role: 'provider' as ContractRole,
      };
      links.push(link);
    }
  }

  return { links, discoveredProjects: projectsByGroupPath };
}
