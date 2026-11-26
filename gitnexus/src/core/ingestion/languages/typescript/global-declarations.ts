import { Minimatch } from 'minimatch';
import path from 'node:path';
import { makeScopeId } from 'gitnexus-shared';
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
import { namespaceExportsForBindings } from '../../scope-resolution/scope/published-namespace-member.js';
import { tsconfigFor, type TsconfigIndex, type TsconfigScope } from './tsconfig.js';
import { owningPackage, type NodeWorkspacePackages } from './workspace-packages.js';

type Projects = {
  tsconfigs: TsconfigIndex | null;
  nodeWorkspacePackages: NodeWorkspacePackages | null;
};
const projectsByFiles = new WeakMap<readonly ParsedFile[], Projects | undefined>();
const scriptDeclarations = new WeakSet<SymbolDefinition>();
const visibleGlobals = new WeakMap<ParsedFile, ReadonlyMap<string, readonly BindingRef[]>>();

/** Keep a single project table when each importer shadows a different name. */
class UnshadowedGlobals implements ReadonlyMap<string, BindingRef[]> {
  constructor(
    private readonly globals: ReadonlyMap<string, BindingRef[]>,
    private readonly shadowed: ReadonlySet<string>,
  ) {}
  get size() {
    return this.globals.size - this.shadowed.size;
  }
  has(name: string) {
    return !this.shadowed.has(name) && this.globals.has(name);
  }
  get(name: string) {
    return this.shadowed.has(name) ? undefined : this.globals.get(name);
  }
  *entries() {
    for (const entry of this.globals) if (!this.shadowed.has(entry[0])) yield entry;
  }
  *keys() {
    for (const [name] of this.entries()) yield name;
  }
  *values() {
    for (const [, refs] of this.entries()) yield refs;
  }
  [Symbol.iterator]() {
    return this.entries();
  }
  forEach(
    callback: (value: BindingRef[], key: string, map: ReadonlyMap<string, BindingRef[]>) => void,
    thisArg?: unknown,
  ) {
    for (const [name, refs] of this) callback.call(thisArg, refs, name, this);
  }
}

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
  if (/\.[cm]ts$/.test(file)) return true;
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
  const include = (scope.include ?? (scope.files ? [] : [scope.dir])).map((p) => compile(p, false));
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
  projectOf: (file: ParsedFile) => TsconfigScope | string,
) {
  const scopes = config?.tsconfigs?.programs ?? config?.tsconfigs?.scopes;
  if (
    !scopes?.length ||
    (scopes.length === 1 &&
      !scopes[0].dir &&
      !scopes[0].files &&
      !scopes[0].include &&
      !scopes[0].exclude)
  )
    return;
  const byPath = new Map(files.map((file) => [file.filePath, file]));
  const roots = new Map<TsconfigScope | string, Set<ParsedFile>>();
  function addRoot(project: TsconfigScope | string, file: ParsedFile) {
    let members = roots.get(project);
    if (!members) {
      members = new Set();
      roots.set(project, members);
    }
    members.add(file);
  }
  const selections = new Map<string, Map<TsconfigScope, ReturnType<typeof fileSelection>>>();
  for (const project of scopes) {
    for (const name of project.files ?? []) {
      const file = byPath.get(name);
      if (file) addRoot(project, file);
    }
    const selected = fileSelection(project);
    for (const pattern of project.include ?? (project.files ? [] : [project.dir])) {
      const prefix = pattern.split(/[?*]/, 1)[0];
      const dir = prefix.endsWith('/')
        ? prefix.slice(0, -1)
        : prefix === pattern && !path.posix.extname(prefix)
          ? prefix
          : prefix.slice(0, Math.max(0, prefix.lastIndexOf('/')));
      let configs = selections.get(dir);
      if (!configs) {
        configs = new Map();
        selections.set(dir, configs);
      }
      configs.set(project, selected);
    }
  }
  for (const file of files) {
    const owner = projectOf(file);
    if (typeof owner === 'string') addRoot(owner, file);
    let dir = file.filePath;
    do {
      dir = dir.slice(0, Math.max(0, dir.lastIndexOf('/')));
      for (const [project, selected] of selections.get(dir) ?? []) {
        if (selected(file.filePath)) addRoot(project, file);
      }
    } while (dir);
  }
  const membership = new Map<ParsedFile, Set<TsconfigScope | string>>();
  for (const [project, members] of roots) {
    for (const file of members) {
      let projects = membership.get(file);
      if (!projects) {
        projects = new Set();
        membership.set(file, projects);
      }
      projects.add(project);
      if (members.size < files.length && (typeof project === 'string' || !project.noResolve)) {
        indexes.imports.forEachTarget(file.moduleScope, (target) => {
          const dependency = byPath.get(target);
          if (dependency) members.add(dependency);
        });
        for (const reference of declarationScope(file.captureSideChannel)?.referencePaths ?? []) {
          const target = byPath.get(
            path.posix.normalize(path.posix.join(path.posix.dirname(file.filePath), reference)),
          );
          if (target) members.add(target);
        }
      }
    }
  }
  return membership;
}

/** Publish globals at the module scope so lexical declarations retain precedence. */
export function bindGlobalDeclarations(
  files: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
) {
  if (!projectsByFiles.has(files)) return;
  const config = projectsByFiles.get(files);
  const projectOf = (file: ParsedFile) =>
    tsconfigFor(config?.tsconfigs ?? null, file.filePath) ??
    owningPackage(file.filePath, config?.nodeWorkspacePackages)?.dir ??
    '';
  const membership = projectMembers(files, config, indexes, projectOf);
  const programIds = new Map(config?.tsconfigs?.scopes.map((scope, index) => [scope, index]));
  const globals = new Map<TsconfigScope | string, Map<string, BindingRef[]>>();
  const declaredNamespaces = new Map<ParsedFile, Set<SymbolDefinition>>();
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
    const projects = membership ? membership.get(file) : [projectOf(file)];
    for (const project of projects ?? []) {
      const names =
        scope.scriptNames &&
        !isProjectModule(
          file.filePath,
          scope.containsJsx === true,
          typeof project === 'string' ? null : project,
          config?.nodeWorkspacePackages,
        )
          ? scope.scriptNames
          : scope.globalNames;
      if (!names.length) continue;
      const positions = new Set(names);
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
        if (def.type === 'Namespace') {
          let declarations = declaredNamespaces.get(file);
          if (!declarations) {
            declarations = new Set();
            declaredNamespaces.set(file, declarations);
          }
          declarations.add(def);
        }
      }
    }
  }
  const namespaces = indexes.namespaceFqnBindings as Map<string, ReadonlyMap<string, BindingRef[]>>;
  const accessible = indexes.accessibleNamespacesByScope as Map<ScopeId, readonly string[]>;
  const definitionsByBucket = new WeakMap<readonly BindingRef[], Set<SymbolDefinition>>();
  const agreedByProjects = new Map<string, Map<string, BindingRef[]>>();
  function definitions(refs: readonly BindingRef[]) {
    let result = definitionsByBucket.get(refs);
    if (!result) {
      result = new Set(refs.map((ref) => ref.def));
      definitionsByBucket.set(refs, result);
    }
    return result;
  }
  for (const file of files) {
    visibleGlobals.delete(file);
    const owner = projectOf(file);
    const projects = membership?.get(file);
    if (membership && !projects) continue;
    const visibleProjects = projects && !projects.has(owner) ? [...projects] : [owner];
    const symbols = globals.get(visibleProjects[0]);
    if (!symbols?.size) continue;
    // An explicit import owns its local spelling even when its target is not a module.
    const shadowed = new Set<string>();
    for (const entry of file.parsedImports) {
      if ('localName' in entry && symbols.has(entry.localName)) shadowed.add(entry.localName);
    }
    const projectKey = JSON.stringify(
      visibleProjects
        .map((project) => (typeof project === 'string' ? project : programIds.get(project)))
        .sort(),
    );
    const namespace = JSON.stringify(['typescript-global', projectKey, [...shadowed].sort()]);
    if (!namespaces.has(namespace)) {
      let shared = agreedByProjects.get(projectKey) ?? symbols;
      if (visibleProjects.length > 1 && !agreedByProjects.has(projectKey)) {
        // A shared dependency without its own project only has a unique binding
        // when its including programs agree on the declarations.
        shared = new Map(
          [...symbols].filter(([name, refs]) =>
            visibleProjects.slice(1).every((project) => {
              const other = globals.get(project)?.get(name);
              return (
                other?.length === refs.length &&
                refs.every((ref) => definitions(other).has(ref.def))
              );
            }),
          ),
        );
        agreedByProjects.set(projectKey, shared);
      }
      for (const name of shadowed) if (!shared.has(name)) shadowed.delete(name);
      namespaces.set(namespace, shadowed.size ? new UnshadowedGlobals(shared, shadowed) : shared);
    }
    accessible.set(file.moduleScope, [...(accessible.get(file.moduleScope) ?? []), namespace]);
    const visible = namespaces.get(namespace)!;
    visibleGlobals.set(file, visible);
    for (const def of declaredNamespaces.get(file) ?? []) {
      if (!def.declarationRange || !def.qualifiedName) continue;
      const siblings = visible.get(def.qualifiedName);
      if (!siblings || siblings.length < 2 || !definitions(siblings).has(def)) continue;
      const name = JSON.stringify([namespace, def.qualifiedName]);
      if (!namespaces.has(name))
        namespaces.set(name, namespaceExportsForBindings(siblings, indexes));
      const scope = makeScopeId({
        filePath: file.filePath,
        range: def.declarationRange,
        kind: 'Namespace',
      });
      accessible.set(scope, [...(accessible.get(scope) ?? []), name]);
    }
  }
}
