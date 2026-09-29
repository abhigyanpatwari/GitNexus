import { normalizeExtractedRoutePath } from './route-path.js';
import type {
  ExtractedRouterConstructorPrefix,
  ExtractedRouterImport,
  ExtractedRouterInclude,
  ExtractedRouterModuleAlias,
} from './fastapi-router-bindings.js';

interface RouterImport {
  modulePath: string;
}

export interface ResolvedFastAPIRouterPrefixes {
  prefixesByFile: Map<string, Set<string>>;
  resolvedIncludes: Set<ExtractedRouterInclude>;
}

/** Resolve only imports that identify one Python file in this repository. */
function resolveModuleFile(
  importer: string,
  modulePath: string,
  files: Set<string>,
  absoluteModules: Map<string, string | null>,
): string | undefined {
  const leadingDots = /^\.+/.exec(modulePath)?.[0].length ?? 0;
  const dotted = modulePath.slice(leadingDots);
  if (!dotted) return undefined;
  const moduleSegments = dotted.split('.');
  if (!moduleSegments.every((part) => /^[A-Za-z_]\w*$/.test(part))) return undefined;

  let stem: string;
  if (leadingDots > 0) {
    const directory = importer.replace(/\\/g, '/').split('/').slice(0, -1);
    const parentLevels = leadingDots - 1;
    if (parentLevels > directory.length) return undefined;
    stem = [...directory.slice(0, directory.length - parentLevels), ...moduleSegments].join('/');
  } else {
    stem = moduleSegments.join('/');
  }

  if (leadingDots === 0) return absoluteModules.get(stem) ?? undefined;
  const candidates = [`${stem}.py`, `${stem}/__init__.py`].filter((candidate) =>
    files.has(candidate),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

/**
 * Prefixes that apply to one router file: exact import-resolved mounts plus
 * the legacy long/short-key prefixes of mounts the resolver could not bind.
 * Shared by ingestion and the group extractor so both surfaces agree.
 */
export function mergeMountPrefixes(
  exact: ReadonlySet<string> | undefined,
  legacy: ReadonlySet<string> | undefined,
): ReadonlySet<string> | undefined {
  if (!exact) return legacy;
  if (!legacy) return exact;
  return new Set([...exact, ...legacy]);
}

/**
 * Carry mounted prefixes through exact, import-resolved router includes.
 *
 * Only a host literally named `router` passes its mounted prefix on to the
 * routers it includes, and resolution is per file rather than per variable:
 * `api_router = APIRouter(); api_router.include_router(x.router)` does not
 * pass through, and a prefixed `api_router.include_router(...)` is treated
 * as a root mount. Unprefixed includes from any other host are ignored.
 */
export function resolveFastAPIRouterPrefixes(
  files: Iterable<string>,
  includes: readonly ExtractedRouterInclude[],
  imports: readonly ExtractedRouterImport[],
  moduleAliases: readonly ExtractedRouterModuleAlias[],
  constructorPrefixes: readonly ExtractedRouterConstructorPrefix[] = [],
): ResolvedFastAPIRouterPrefixes {
  const fileSet = new Set([...files].map((file) => file.replace(/\\/g, '/')));
  const constructorPrefixByFile = new Map(
    constructorPrefixes.map((ctor) => [ctor.filePath.replace(/\\/g, '/'), ctor.prefix]),
  );
  const absoluteModules = new Map<string, string | null>();
  for (const file of fileSet) {
    if (!file.endsWith('.py')) continue;
    const stem = file.endsWith('/__init__.py')
      ? file.slice(0, -'/__init__.py'.length)
      : file.slice(0, -'.py'.length);
    const parts = stem.split('/');
    for (let i = 0; i < parts.length; i++) {
      const suffix = parts.slice(i).join('/');
      const previous = absoluteModules.get(suffix);
      absoluteModules.set(suffix, previous === undefined ? file : previous === file ? file : null);
    }
  }
  const importsByFile = new Map<string, Map<string, RouterImport>>();
  for (const imp of [...imports, ...moduleAliases]) {
    const modulePath = imp.modulePath;
    if (!modulePath) continue;
    const file = imp.filePath.replace(/\\/g, '/');
    const bindings = importsByFile.get(file) ?? new Map<string, RouterImport>();
    bindings.set(imp.localName, { modulePath });
    importsByFile.set(file, bindings);
  }

  const prefixesByFile = new Map<string, Set<string>>();
  const resolvedIncludes = new Set<ExtractedRouterInclude>();
  const childIncludes = new Map<
    string,
    { target: string; prefix: string; include: ExtractedRouterInclude }[]
  >();

  for (const inc of includes) {
    const source = inc.filePath.replace(/\\/g, '/');
    const localName = inc.routerExpr.endsWith('.router')
      ? inc.routerExpr.slice(0, -'.router'.length)
      : inc.routerExpr;
    const modulePath = importsByFile.get(source)?.get(localName)?.modulePath;
    if (!modulePath) continue;
    const target = resolveModuleFile(source, modulePath, fileSet, absoluteModules);
    if (!target) continue;

    if (inc.host === 'router') {
      const children = childIncludes.get(source) ?? [];
      children.push({ target, prefix: inc.prefix, include: inc });
      childIncludes.set(source, children);
    } else if (inc.prefix) {
      const prefixes = prefixesByFile.get(target) ?? new Set<string>();
      prefixes.add(inc.prefix);
      prefixesByFile.set(target, prefixes);
      resolvedIncludes.add(inc);
    }
  }

  const roots = [...prefixesByFile].flatMap(([file, prefixes]) =>
    [...prefixes].map((prefix) => ({ file, prefix })),
  );
  // `expanded` memoizes (file, prefix) frames so diamond-shaped include graphs
  // stay linear in distinct prefixes; the per-path `visited` set still stops
  // cycles whose edges keep growing the prefix.
  const expanded = new Set<string>();
  for (const { file, prefix } of roots) {
    const stack = [{ file, prefix, visited: new Set([file]) }];
    for (let current = stack.pop(); current; current = stack.pop()) {
      const frameKey = `${current.file}\0${current.prefix}`;
      if (expanded.has(frameKey)) continue;
      expanded.add(frameKey);
      // The parent's own `APIRouter(prefix=...)` sits between its mount
      // prefix and the child include prefix.
      const ctorPrefix = constructorPrefixByFile.get(current.file);
      const parentPrefix = ctorPrefix
        ? normalizeExtractedRoutePath(ctorPrefix, current.prefix)
        : current.prefix;
      for (const edge of childIncludes.get(current.file) ?? []) {
        if (current.visited.has(edge.target)) continue;
        const joined = normalizeExtractedRoutePath(edge.prefix, parentPrefix);
        const targetPrefixes = prefixesByFile.get(edge.target) ?? new Set<string>();
        targetPrefixes.add(joined);
        prefixesByFile.set(edge.target, targetPrefixes);
        resolvedIncludes.add(edge.include);
        stack.push({
          file: edge.target,
          prefix: joined,
          visited: new Set([...current.visited, edge.target]),
        });
      }
    }
  }

  return { prefixesByFile, resolvedIncludes };
}
