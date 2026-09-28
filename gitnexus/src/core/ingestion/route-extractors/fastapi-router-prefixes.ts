import { normalizeExtractedRoutePath } from './route-path.js';
import type {
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

/** Carry mounted prefixes through exact, import-resolved router includes. */
export function resolveFastAPIRouterPrefixes(
  files: Iterable<string>,
  includes: readonly ExtractedRouterInclude[],
  imports: readonly ExtractedRouterImport[],
  moduleAliases: readonly ExtractedRouterModuleAlias[],
): ResolvedFastAPIRouterPrefixes {
  const fileSet = new Set([...files].map((file) => file.replace(/\\/g, '/')));
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
  for (const { file, prefix } of roots) {
    const stack = [{ file, prefix, visited: new Set([file]) }];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const edge of childIncludes.get(current.file) ?? []) {
        if (current.visited.has(edge.target)) continue;
        const joined = normalizeExtractedRoutePath(edge.prefix, current.prefix);
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
