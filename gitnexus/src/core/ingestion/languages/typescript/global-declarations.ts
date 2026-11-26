import { Minimatch } from 'minimatch';
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
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { declarationScope } from './module-kind.js';
import { tsconfigFor, type TsconfigIndex, type TsconfigScope } from './tsconfig.js';
import { owningPackage, type NodeWorkspacePackages } from './workspace-packages.js';

type Projects = {
  tsconfigs: TsconfigIndex | null;
  nodeWorkspacePackages: NodeWorkspacePackages | null;
};
const projectsByFiles = new WeakMap<readonly ParsedFile[], Projects | undefined>();
const scriptDeclarations = new WeakSet<SymbolDefinition>();
const visibleGlobals = new WeakMap<ParsedFile, ReadonlyMap<string, readonly BindingRef[]>>();

export const projectNameFallback: ScopeResolver['isGlobalNameFallbackPlausible'] = ({
  callerParsed,
  candidate,
  site,
}) =>
  candidate.filePath === callerParsed.filePath ||
  !scriptDeclarations.has(candidate) ||
  !!visibleGlobals
    .get(callerParsed)
    ?.get(site?.name ?? candidate.qualifiedName ?? '')
    ?.some((ref) => ref.def.nodeId === candidate.nodeId);

/** A unique spelling in the graph cannot make an out-of-scope script class visible. */
export function receiverTypeIsOutOfScope(
  owner: SymbolDefinition,
  site: ReferenceSite,
  indexes: ScopeResolutionIndexes,
): boolean {
  if (!scriptDeclarations.has(owner) || !site.explicitReceiver?.name || !owner.qualifiedName)
    return false;
  const receiver = site.explicitReceiver.name;
  if (
    receiver === owner.qualifiedName ||
    /^new\s+([\p{ID_Start}$_][\p{ID_Continue}$]*)\s*[(<]/u.exec(receiver)?.[1] ===
      owner.qualifiedName
  ) {
    return !findClassBindingInScope(site.inScope, owner.qualifiedName, indexes, undefined, {
      purpose: 'value',
      position: site.atRange,
      uniqueQualifiedNameFallback: false,
    });
  }
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

function fileSelection(scope: TsconfigScope) {
  const compile = (pattern: string, exclude: boolean) => {
    // TypeScript treats brackets, braces and parentheses literally. Only *, ** and ? are wildcards.
    const tail = pattern.slice(pattern.lastIndexOf('/') + 1);
    const glob = /[.*?]/.test(tail) ? pattern : (pattern ? pattern + '/' : '') + '**/*';
    return new Minimatch(glob.replace(/[\[\]\\]/g, '\\$&'), {
      nobrace: true,
      noext: true,
      nonegate: true,
      nocomment: true,
      platform: 'linux',
      nocase: process.platform === 'win32',
      dot: exclude,
    });
  };
  const files = new Set(scope.files);
  const include = (scope.include ?? (scope.files ? [] : ['**/*'])).map((p) => compile(p, false));
  const exclude = scope.exclude?.map((p) => compile(p, true)) ?? [];
  return (file: string) => {
    if (files.has(file)) return true;
    if (!include.some((pattern) => pattern.match(file))) return false;
    // An exclude matching a directory also excludes every descendant.
    for (
      let part = file;
      part && exclude.length;
      part = part.slice(0, Math.max(0, part.lastIndexOf('/')))
    ) {
      if (exclude.some((pattern) => pattern.match(part))) return false;
    }
    return true;
  };
}

/** Explicit file entries and transitive imports stay in a project even when an exclude matches. */
function projectMembers(
  files: readonly ParsedFile[],
  config: Projects | undefined,
  indexes: ScopeResolutionIndexes,
) {
  if (!config?.tsconfigs?.scopes.some((scope) => scope.files || scope.include || scope.exclude))
    return;
  const byPath = new Map(files.map((file) => [file.filePath, file]));
  const included = new Set<ParsedFile>();
  const selections = new Map<TsconfigScope, ReturnType<typeof fileSelection>>();
  for (const file of files) {
    const scope = tsconfigFor(config.tsconfigs, file.filePath);
    if (!scope) {
      included.add(file);
      continue;
    }
    let selected = selections.get(scope);
    if (!selected) {
      selected = fileSelection(scope);
      selections.set(scope, selected);
    }
    if (selected(file.filePath)) included.add(file);
  }
  for (const file of included) {
    indexes.imports.forEachTarget(file.moduleScope, (target) => {
      const dependency = byPath.get(target);
      if (dependency) included.add(dependency);
    });
  }
  return included;
}

/** Publish globals at the module scope so lexical declarations retain precedence. */
export function bindGlobalDeclarations(
  files: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
) {
  if (!projectsByFiles.has(files)) return;
  const config = projectsByFiles.get(files);
  const members = projectMembers(files, config, indexes);
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
        if (def.nameRange && candidates.has(`${def.nameRange.startLine}:${def.nameRange.startCol}`))
          scriptDeclarations.add(def);
      }
    }
    if (members && !members.has(file)) continue;
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
    visibleGlobals.delete(file);
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
    visibleGlobals.set(file, namespaces.get(namespace)!);
  }
}
