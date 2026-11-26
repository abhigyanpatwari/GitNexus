import type {
  BindingRef,
  ParsedFile,
  ReferenceSite,
  ScopeId,
  SymbolDefinition,
} from 'gitnexus-shared';
import {
  findClassBindingInScope,
  findReceiverTypeBinding,
} from '../../scope-resolution/scope/walkers.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { declarationScope } from './module-kind.js';
import { tsconfigFor, type TsconfigIndex, type TsconfigScope } from './tsconfig.js';
import { owningPackage, type NodeWorkspacePackages } from './workspace-packages.js';

type Projects = {
  tsconfigs: TsconfigIndex | null;
  nodeWorkspacePackages: NodeWorkspacePackages | null;
};
const projectsByFiles = new WeakMap<readonly ParsedFile[], Projects | undefined>();
const scriptClasses = new WeakSet<SymbolDefinition>();

/** A unique spelling in the graph cannot make an out-of-scope script class visible. */
export function receiverTypeIsOutOfScope(
  owner: SymbolDefinition,
  site: ReferenceSite,
  indexes: ScopeResolutionIndexes,
): boolean {
  if (!scriptClasses.has(owner) || !site.explicitReceiver?.name) return false;
  const binding = findReceiverTypeBinding(site.inScope, site.explicitReceiver.name, indexes, {
    purpose: 'value',
    position: site.atRange,
  });
  if (
    !binding ||
    (binding.source !== 'annotation' && binding.source !== 'parameter-annotation') ||
    binding.rawName !== owner.qualifiedName
  )
    return false;
  return !findClassBindingInScope(binding.declaredAtScope, binding.rawName, indexes, undefined, {
    purpose: 'type',
    position: binding.lookupPosition,
    uniqueQualifiedNameFallback: false,
  });
}

export function rememberDeclarationProjects(
  files: readonly ParsedFile[],
  config: Projects | undefined,
) {
  if (
    files.some((file) => {
      const scope = declarationScope(file.captureSideChannel);
      return scope && (scope.globalNames.length || scope.scriptNames?.length);
    })
  ) {
    projectsByFiles.set(files, config);
  } else {
    projectsByFiles.delete(files);
  }
}

function isProjectModule(
  file: string,
  jsx: boolean,
  config: TsconfigScope | null,
  packages?: NodeWorkspacePackages | null,
) {
  const nodeModule = /^node(?:16|18|20|next)$/.test(config?.module ?? '');
  const detection = config?.moduleDetection ?? (nodeModule ? 'force' : 'auto');
  if (detection === 'force') return true;
  if (detection === 'legacy') return false;
  if (jsx && (config?.jsx === 'react-jsx' || config?.jsx === 'react-jsxdev')) return true;
  const nodeResolution = config?.moduleResolution
    ? ['node16', 'nodenext'].includes(config.moduleResolution)
    : nodeModule;
  if (!nodeResolution || !packages?.packageModules) return false;
  let dir = file;
  for (;;) {
    const slash = dir.lastIndexOf('/');
    dir = slash === -1 ? '' : dir.slice(0, slash);
    const format = packages.packageModules.get(dir);
    if (format !== undefined || !dir) return format === true;
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
    if (!scope) continue;
    if (scope.scriptNames?.length) {
      const candidates = new Set(scope.scriptNames);
      for (const def of file.localDefs) {
        if (
          def.type === 'Class' &&
          def.nameRange &&
          candidates.has(`${def.nameRange.startLine}:${def.nameRange.startCol}`)
        )
          scriptClasses.add(def);
      }
    }
    const names =
      scope.scriptNames &&
      !isProjectModule(
        file.filePath,
        scope.containsJsx === true,
        tsconfigFor(config?.tsconfigs ?? null, file.filePath),
        config?.nodeWorkspacePackages,
      )
        ? scope.scriptNames
        : scope.globalNames;
    if (!names.length) continue;
    const positions = new Set(names);
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
