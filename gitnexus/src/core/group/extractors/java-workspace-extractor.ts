import fs from 'node:fs/promises';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
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

type XmlNode = Record<string, unknown>;

// POMs are static metadata. Parse hierarchy with a real XML parser, but do not
// invoke Maven or resolve the effective model. Properties, profiles, and remote
// parent resolution remain outside this extractor's deterministic boundary.
const pomParser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  trimValues: true,
  parseTagValue: false,
  processEntities: false,
  ignoreDeclaration: true,
  ignorePiTags: true,
});

async function parseJavaManifest(
  repoPath: string,
): Promise<{ groupId: string; artifactId: string; deps: string[] } | null> {
  const pomPath = path.join(repoPath, 'pom.xml');
  try {
    const content = await fs.readFile(pomPath, 'utf-8');
    return parsePom(content);
  } catch {
    // Missing pom.xml — fall through to Gradle.
  }

  const gradleSidecars = await readGradleSidecars(repoPath);
  for (const name of ['build.gradle.kts', 'build.gradle']) {
    const gradlePath = path.join(repoPath, name);
    try {
      const content = await fs.readFile(gradlePath, 'utf-8');
      return parseGradle(content, repoPath, gradleSidecars);
    } catch {
      continue;
    }
  }

  return null;
}

interface GradleSidecars {
  propertiesGroup?: string;
  rootProjectName?: string;
  catalogLibraries: Map<string, string>;
  catalogBundles: Map<string, string[]>;
}

async function readIfPresent(filePath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch {
    return undefined;
  }
}

async function readGradleSidecars(repoPath: string): Promise<GradleSidecars> {
  const [properties, settingsKts, settingsGroovy, catalog] = await Promise.all([
    readIfPresent(path.join(repoPath, 'gradle.properties')),
    readIfPresent(path.join(repoPath, 'settings.gradle.kts')),
    readIfPresent(path.join(repoPath, 'settings.gradle')),
    readIfPresent(path.join(repoPath, 'gradle', 'libs.versions.toml')),
  ]);

  const sidecars: GradleSidecars = {
    catalogLibraries: new Map(),
    catalogBundles: new Map(),
  };

  const groupMatch = properties?.match(/(?:^|\n)\s*group\s*=\s*([^\s#]+)/);
  if (groupMatch) sidecars.propertiesGroup = groupMatch[1];

  const settings = settingsKts ?? settingsGroovy;
  const nameMatch = settings?.match(/rootProject\.name\s*=\s*['"]([^'"]+)['"]/);
  if (nameMatch) sidecars.rootProjectName = nameMatch[1];

  if (catalog) {
    const parsed = parseGradleVersionCatalog(catalog);
    sidecars.catalogLibraries = parsed.libraries;
    sidecars.catalogBundles = parsed.bundles;
  }

  return sidecars;
}

function catalogAccessors(alias: string): string[] {
  const dotted = alias.replace(/[-_]/g, '.');
  const camel = alias.replace(/[-_]+([A-Za-z0-9])/g, (_, char: string) => char.toUpperCase());
  return [...new Set([alias, dotted, camel])];
}

function projectAccessorToArtifactId(accessor: string): string {
  const last = accessor.split('.').pop()!;
  return last.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`).replace(/^-/, '');
}

function moduleToGa(module: string): string | undefined {
  const parts = module.split(':');
  return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : undefined;
}

function parseInlineTomlTable(rhs: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const match of rhs.matchAll(/([A-Za-z0-9_-]+)\s*=\s*['"]([^'"]+)['"]/g)) {
    fields[match[1]] = match[2];
  }
  return fields;
}

/** Default Gradle catalog (`gradle/libs.versions.toml`) — aliases only, no version resolution. */
function parseGradleVersionCatalog(toml: string): {
  libraries: Map<string, string>;
  bundles: Map<string, string[]>;
} {
  const libraries = new Map<string, string>();
  const bundles = new Map<string, string[]>();
  let section: 'libraries' | 'bundles' | 'other' = 'other';

  const addLibrary = (alias: string, ga: string) => {
    for (const accessor of catalogAccessors(alias)) libraries.set(accessor, ga);
  };

  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) {
      const name = header[1];
      section =
        name === 'libraries' || name.endsWith('.libraries')
          ? 'libraries'
          : name === 'bundles' || name.endsWith('.bundles')
            ? 'bundles'
            : 'other';
      continue;
    }

    if (section === 'libraries') {
      const dottedModule = line.match(/^([A-Za-z0-9._-]+)\.module\s*=\s*['"]([^'"]+)['"]$/);
      if (dottedModule) {
        const ga = moduleToGa(dottedModule[2]);
        if (ga) addLibrary(dottedModule[1], ga);
        continue;
      }
      const assignment = line.match(/^([A-Za-z0-9._-]+)\s*=\s*(.+)$/);
      if (!assignment) continue;
      const alias = assignment[1];
      const rhs = assignment[2].trim();
      const quoted = rhs.match(/^['"]([^'"]+)['"]$/);
      if (quoted) {
        const ga = moduleToGa(quoted[1]);
        if (ga) addLibrary(alias, ga);
        continue;
      }
      const table = parseInlineTomlTable(rhs);
      const ga = table.module
        ? moduleToGa(table.module)
        : table.group && table.name
          ? `${table.group}:${table.name}`
          : undefined;
      if (ga) addLibrary(alias, ga);
      continue;
    }

    if (section === 'bundles') {
      const assignment = line.match(/^([A-Za-z0-9._-]+)\s*=\s*\[([^\]]*)\]$/);
      if (!assignment) continue;
      const members = [...assignment[2].matchAll(/['"]([^'"]+)['"]/g)].map((match) => match[1]);
      for (const accessor of catalogAccessors(assignment[1])) bundles.set(accessor, members);
    }
  }

  return { libraries, bundles };
}

const GRADLE_GROUP_PATTERNS = [
  /(?:^|[\n{;])\s*(?:rootProject\.)?group\s*=\s*['"]([^'"]+)['"]/,
  /(?:^|[\n{;])\s*group\s+['"]([^'"]+)['"]/,
];

const GRADLE_COORD_CONFIGS =
  'implementation|api|compileOnly|runtimeOnly|testImplementation|testApi|testCompileOnly|compile|kapt|ksp|commonMainImplementation|commonMainApi';

const CATALOG_ALIAS = '([A-Za-z0-9_]+(?:\\.[A-Za-z0-9_]+)*)(?:\\.get\\(\\)|\\.asProvider\\(\\))?';

function gradleDepRe(suffix: string): RegExp {
  return new RegExp(`(?:${GRADLE_COORD_CONFIGS})\\s*${suffix}`, 'g');
}

function parseGradleGroup(content: string): string | undefined {
  for (const pattern of GRADLE_GROUP_PATTERNS) {
    const match = content.match(pattern);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function asXmlNode(value: unknown): XmlNode | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as XmlNode)
    : undefined;
}

function xmlText(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).trim();
    return text || undefined;
  }
  const nested = asXmlNode(value)?.['#text'];
  if (nested === undefined) return undefined;
  return xmlText(nested);
}

function xmlChildText(node: XmlNode | undefined, name: string): string | undefined {
  return node ? xmlText(node[name]) : undefined;
}

function asList(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** Direct project dependencies only — not BOM, profiles, or plugin classpath. */
function collectProjectDependencies(project: XmlNode, deps: string[]): void {
  const dependencies = asXmlNode(project.dependencies);
  if (!dependencies) return;
  for (const dep of asList(dependencies.dependency)) {
    const depNode = asXmlNode(dep);
    const groupId = xmlChildText(depNode, 'groupId');
    const artifactId = xmlChildText(depNode, 'artifactId');
    if (groupId && artifactId) deps.push(`${groupId}:${artifactId}`);
  }
}

function parsePom(content: string): { groupId: string; artifactId: string; deps: string[] } | null {
  let parsed: unknown;
  try {
    parsed = parseSourceSafe(pomParser, content);
  } catch {
    return null;
  }

  const project = asXmlNode(asXmlNode(parsed)?.project);
  if (!project) return null;

  // Maven inherits groupId from <parent>, but artifactId is always the
  // project's own direct child and must never fall back to parent.artifactId.
  const groupId =
    xmlChildText(project, 'groupId') ?? xmlChildText(asXmlNode(project.parent), 'groupId');
  const artifactId = xmlChildText(project, 'artifactId');
  if (!groupId || !artifactId) return null;

  const deps: string[] = [];
  collectProjectDependencies(project, deps);
  return { groupId, artifactId, deps: [...new Set(deps)] };
}

function parseGradle(
  content: string,
  repoPath: string,
  sidecars: GradleSidecars = { catalogLibraries: new Map(), catalogBundles: new Map() },
): { groupId: string; artifactId: string; deps: string[] } | null {
  // Static text + default catalog file. Do not execute Gradle.
  const groupId = parseGradleGroup(content) ?? sidecars.propertiesGroup ?? '';
  if (!groupId) return null;

  const artifactId = sidecars.rootProjectName ?? path.basename(repoPath);
  const { catalogLibraries, catalogBundles } = sidecars;

  const deps: string[] = [];
  const pushCatalogAlias = (alias: string) => {
    const ga = catalogLibraries.get(alias);
    if (ga) deps.push(ga);
  };

  const namedPattern = gradleDepRe(
    `(?:\\(\\s*)?(?:group\\s*=\\s*['"](?<group1>[^'"]+)['"]\\s*,\\s*name\\s*=\\s*['"](?<name1>[^'"]+)['"]|name\\s*=\\s*['"](?<name2>[^'"]+)['"]\\s*,\\s*group\\s*=\\s*['"](?<group2>[^'"]+)['"]|group:\\s*['"](?<group3>[^'"]+)['"]\\s*,\\s*name:\\s*['"](?<name3>[^'"]+)['"]|name:\\s*['"](?<name4>[^'"]+)['"]\\s*,\\s*group:\\s*['"](?<group4>[^'"]+)['"])`,
  );
  for (const match of content.matchAll(namedPattern)) {
    const group =
      match.groups?.group1 ?? match.groups?.group2 ?? match.groups?.group3 ?? match.groups?.group4;
    const name =
      match.groups?.name1 ?? match.groups?.name2 ?? match.groups?.name3 ?? match.groups?.name4;
    if (group && name) deps.push(`${group}:${name}`);
  }

  for (const match of content.matchAll(
    gradleDepRe(`(?:\\(\\s*)?libs(?:\\.libraries)?\\.(?!bundles\\.|plugins\\.)${CATALOG_ALIAS}`),
  )) {
    pushCatalogAlias(match[1]);
  }

  for (const match of content.matchAll(
    gradleDepRe(`(?:\\(\\s*)?libs\\.bundles\\.${CATALOG_ALIAS}`),
  )) {
    for (const member of catalogBundles.get(match[1]) ?? []) {
      for (const accessor of catalogAccessors(member)) pushCatalogAlias(accessor);
    }
  }

  for (const match of content.matchAll(gradleDepRe(`\\(\\s*projects\\.([A-Za-z][A-Za-z0-9.]*)`))) {
    deps.push(`${groupId}:${projectAccessorToArtifactId(match[1])}`);
  }

  for (const match of content.matchAll(
    gradleDepRe(`(?:\\(\\s*['"]([^'"]+)['"]\\s*\\)|['"]([^'"]+)['"])`),
  )) {
    const coord = match[1] ?? match[2];
    if (!coord) continue;
    const parts = coord.split(':');
    if (parts.length >= 2) deps.push(`${parts[0]}:${parts[1]}`);
  }

  for (const match of content.matchAll(
    gradleDepRe(`(?:\\(\\s*)?project\\s*\\(\\s*['"]([^'"]+)['"]\\s*\\)`),
  )) {
    deps.push(`${groupId}:${match[1].replace(/^:/, '')}`);
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
