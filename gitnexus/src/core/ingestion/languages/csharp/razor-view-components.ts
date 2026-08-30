/**
 * ASP.NET Core ViewComponent convention support.
 *
 * Same bound as Spring Boot DI in Java/Kotlin: do not resolve into the SDK
 * (`Microsoft.AspNetCore.Mvc.ViewComponent`, `IViewComponentHelper`,
 * `Component.InvokeAsync` itself). Those types live outside the workspace.
 * The only hop worth taking is the framework convention that lands on an
 * **in-repo** class — `InvokeAsync("Foo")` → workspace `FooViewComponent`,
 * just as a Spring `@Autowired IFoo` fans out to an in-repo `@Service`,
 * not to `ApplicationContext`.
 *
 * Razor templates are not parsed as C# (markup + code would poison
 * tree-sitter-c-sharp). Literal name extraction is enough because the
 * target catalog is already built from parsed `.cs` classes in this repo.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'glob';
import type { ParsedFile } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import { createIgnoreFilter } from '../../../../config/ignore-service.js';
import { generateId } from '../../../../lib/utils.js';
import { getMaxFileSizeBytes } from '../../utils/max-file-size.js';
import type { GraphNodeLookup } from '../../scope-resolution/graph-bridge/node-lookup.js';
import { resolveDefGraphId } from '../../scope-resolution/graph-bridge/ids.js';

const VIEW_COMPONENT_SUFFIX = 'ViewComponent';
const RAZOR_INVOKE_RE =
  /@\s*\(?\s*(?:await\s+)?Component\s*\.\s*InvokeAsync\s*\(\s*@?"([A-Za-z_][A-Za-z0-9_.-]*)"/g;
const VIEW_COMPONENT_TAG_RE = /<\s*vc:([a-z][a-z0-9-]*)\b/gi;
/** In-repo C# helper calls; `Component.` / `ViewComponent(` keep this off SDK `Task.InvokeAsync`. */
const CSHARP_INVOKE_RE =
  /(?:^|[^\w.])(?:await\s+)?(?:Component\s*\.\s*InvokeAsync|ViewComponent)\s*\(\s*@?"([A-Za-z_][A-Za-z0-9_.-]*)"/g;
const VIEW_COMPONENT_ALIAS_RE =
  /\[\s*(?:[A-Za-z_][A-Za-z0-9_.]*\.)?ViewComponent(?:Attribute)?\s*\(\s*(?:Name\s*=\s*)?@?"([A-Za-z_][A-Za-z0-9_.-]*)"[^)]*\)\s*\]\s*(?:\[[^\]]+\]\s*)*(?:(?:public|internal|protected|private|abstract|sealed|partial|static|new)\s+)*class\s+([A-Za-z_][A-Za-z0-9_]*)/g;

export interface RazorViewComponentConfig {
  readonly views: ReadonlyMap<string, string>;
}

function withoutRazorComments(source: string): string {
  return source
    .replace(/@\*[\s\S]*?\*@/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

function withoutCsharpComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function tagNameToComponentName(tagName: string): string {
  return tagName
    .split('-')
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join('');
}

/** Extract statically resolvable ViewComponent names from one Razor template. */
export function extractRazorViewComponentInvocations(source: string): string[] {
  const visible = withoutRazorComments(source);
  const names = new Set<string>();

  for (const match of visible.matchAll(RAZOR_INVOKE_RE)) {
    names.add(match[1]!);
  }
  for (const match of visible.matchAll(VIEW_COMPONENT_TAG_RE)) {
    names.add(tagNameToComponentName(match[1]!));
  }

  return [...names];
}

/** In-repo C# `Component.InvokeAsync("X")` / `ViewComponent("X")` literals. */
export function extractCsharpViewComponentInvocations(source: string): string[] {
  const names = new Set<string>();
  for (const match of withoutCsharpComments(source).matchAll(CSHARP_INVOKE_RE)) {
    names.add(match[1]!);
  }
  return [...names];
}

/** Extract explicit `[ViewComponent(Name = "...")]` aliases by class name. */
export function extractViewComponentAliases(source: string): ReadonlyMap<string, readonly string[]> {
  const aliases = new Map<string, string[]>();
  for (const match of withoutCsharpComments(source).matchAll(VIEW_COMPONENT_ALIAS_RE)) {
    const alias = match[1]!;
    const className = match[2]!;
    const existing = aliases.get(className);
    if (existing) {
      if (!existing.includes(alias)) existing.push(alias);
    } else {
      aliases.set(className, [alias]);
    }
  }
  return aliases;
}

/**
 * Read Razor views once per C# resolution pass. The same ignore rules and file
 * size ceiling as repository scanning are applied, and edge emission later
 * additionally requires a live File node. This prevents ignored, oversized,
 * or concurrently removed templates from entering the graph.
 */
export async function loadRazorViewComponentConfig(
  repoRoot: string,
): Promise<RazorViewComponentConfig> {
  const ignore = await createIgnoreFilter(repoRoot);
  const paths = await glob('**/*.cshtml', {
    cwd: repoRoot,
    nodir: true,
    dot: false,
    ignore,
  });
  paths.sort();

  const maxBytes = getMaxFileSizeBytes();
  const views = new Map<string, string>();
  for (const rawPath of paths) {
    const filePath = rawPath.replace(/\\/g, '/');
    try {
      const fullPath = path.join(repoRoot, filePath);
      const stat = await fs.stat(fullPath);
      if (!stat.isFile() || stat.size > maxBytes) continue;
      views.set(filePath, await fs.readFile(fullPath, 'utf8'));
    } catch {
      // A view may disappear between glob/stat/read during watch mode.
    }
  }
  return { views };
}

function addCandidate(
  candidates: Map<string, Set<string>>,
  invocationName: string,
  targetId: string,
): void {
  const key = invocationName.toLocaleLowerCase('en-US');
  const existing = candidates.get(key);
  if (existing) {
    existing.add(targetId);
  } else {
    candidates.set(key, new Set([targetId]));
  }
}

/**
 * Emit workspace File → in-repo ViewComponent Class CALLS edges.
 *
 * Targets are only Class nodes produced from this repo's `.cs` files. There is
 * no lookup of ASP.NET SDK types; `: ViewComponent` in source is a naming
 * hint, not a resolved EXTENDS edge to `Microsoft.AspNetCore.Mvc.ViewComponent`.
 *
 * Ambiguous component names fail closed: two in-repo classes claiming the
 * same name is not evidence for picking either one.
 */
export function emitRazorViewComponentEdges(
  graph: KnowledgeGraph,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
  config: RazorViewComponentConfig | undefined,
  csharpSources: ReadonlyMap<string, string>,
): void {
  if (!config) return;

  const candidates = new Map<string, Set<string>>();
  for (const parsed of parsedFiles) {
    if (!parsed.filePath.endsWith('.cs')) continue;
    const aliases = extractViewComponentAliases(csharpSources.get(parsed.filePath) ?? '');
    for (const def of parsed.localDefs) {
      if (def.type !== 'Class') continue;
      const className = def.qualifiedName?.split('.').pop() ?? def.nodeId.split(':').pop() ?? '';
      const conventionalName = className.endsWith(VIEW_COMPONENT_SUFFIX)
        ? className.slice(0, -VIEW_COMPONENT_SUFFIX.length)
        : undefined;
      const explicitAliases = aliases.get(className) ?? [];
      if (!conventionalName && explicitAliases.length === 0) continue;

      const targetId = resolveDefGraphId(parsed.filePath, def, nodeLookup);
      if (!targetId || !graph.getNode(targetId)) continue;
      // An explicit [ViewComponent(Name = "...")] replaces the suffix name,
      // matching ASP.NET. Never register the SDK base type as a candidate.
      if (explicitAliases.length > 0) {
        for (const alias of explicitAliases) addCandidate(candidates, alias, targetId);
      } else if (conventionalName) {
        addCandidate(candidates, conventionalName, targetId);
      }
    }
  }

  const emitFromFile = (filePath: string, invocationNames: readonly string[]): void => {
    const sourceId = generateId('File', filePath);
    if (!graph.getNode(sourceId)) return;
    for (const invocationName of invocationNames) {
      const matches = candidates.get(invocationName.toLocaleLowerCase('en-US'));
      if (!matches || matches.size !== 1) continue;
      const targetId = matches.values().next().value as string;
      if (!graph.getNode(targetId)) continue;
      graph.addRelationship({
        id: generateId('CALLS', `${sourceId}:razor-view-component:${targetId}`),
        sourceId,
        targetId,
        type: 'CALLS',
        confidence: 0.9,
        reason: 'aspnet-razor-view-component',
      });
    }
  };

  for (const [viewPath, source] of config.views) {
    emitFromFile(viewPath, extractRazorViewComponentInvocations(source));
  }
  for (const [filePath, source] of csharpSources) {
    if (!filePath.endsWith('.cs')) continue;
    emitFromFile(filePath, extractCsharpViewComponentInvocations(source));
  }
}
