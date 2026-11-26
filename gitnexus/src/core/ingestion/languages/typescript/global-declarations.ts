import type { BindingRef, ParsedFile, ScopeId } from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { declarationScope } from './module-kind.js';
import { tsconfigFor, type TsconfigIndex } from './tsconfig.js';
import { owningPackage, type NodeWorkspacePackages } from './workspace-packages.js';

type Projects = {
  tsconfigs: TsconfigIndex | null;
  nodeWorkspacePackages: NodeWorkspacePackages | null;
};
const projectsByFiles = new WeakMap<readonly ParsedFile[], Projects | undefined>();

export function rememberDeclarationProjects(
  files: readonly ParsedFile[],
  config: Projects | undefined,
) {
  if (files.some((file) => declarationScope(file.captureSideChannel)?.globalNames.length)) {
    projectsByFiles.set(files, config);
  } else {
    projectsByFiles.delete(files);
  }
}

/** Publish globals at the module scope so lexical declarations retain precedence. */
export function bindGlobalDeclarations(
  files: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
) {
  if (!projectsByFiles.has(files)) return;
  const config = projectsByFiles.get(files);
  const projectOf = (file: ParsedFile) =>
    tsconfigFor(config?.tsconfigs ?? null, file.filePath)?.dir ??
    owningPackage(file.filePath, config?.nodeWorkspacePackages)?.dir ??
    '';
  const globals = new Map<string, Map<string, BindingRef[]>>();
  for (const file of files) {
    const scope = declarationScope(file.captureSideChannel);
    if (!scope?.globalNames.length) continue;
    const positions = new Set(scope.globalNames);
    const project = projectOf(file);
    let symbols = globals.get(project);
    if (!symbols) {
      symbols = new Map();
      globals.set(project, symbols);
    }
    for (const def of file.localDefs) {
      if (
        !def.nameRange ||
        !def.qualifiedName ||
        !positions.has(`${def.nameRange.startLine}:${def.nameRange.startCol}`)
      )
        continue;
      const name = def.qualifiedName;
      const refs = symbols.get(name) ?? [];
      refs.push({ def, origin: 'namespace' });
      symbols.set(name, refs);
    }
  }
  const namespaces = indexes.namespaceFqnBindings as Map<string, ReadonlyMap<string, BindingRef[]>>;
  const accessible = indexes.accessibleNamespacesByScope as Map<ScopeId, readonly string[]>;
  for (const file of files) {
    const project = projectOf(file);
    const symbols = globals.get(project);
    if (!symbols?.size) continue;
    // An explicit import owns its local spelling even when its target is not a module.
    const shadowed = new Set<string>();
    for (const entry of file.parsedImports) {
      if ('localName' in entry && symbols.has(entry.localName)) shadowed.add(entry.localName);
    }
    const namespace = JSON.stringify(['typescript-global', project, [...shadowed].sort()]);
    if (!namespaces.has(namespace)) {
      namespaces.set(
        namespace,
        shadowed.size ? new Map([...symbols].filter(([name]) => !shadowed.has(name))) : symbols,
      );
    }
    accessible.set(file.moduleScope, [...(accessible.get(file.moduleScope) ?? []), namespace]);
  }
}
