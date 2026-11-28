import { Minimatch } from 'minimatch';
import path from 'node:path';
import { compareCodeUnits } from '../../../../lib/utils.js';
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
import {
  nodePackageIsEsm,
  owningPackage,
  type NodeWorkspacePackages,
} from './workspace-packages.js';

type Projects = {
  tsconfigs: TsconfigIndex | null;
  nodeWorkspacePackages: NodeWorkspacePackages | null;
};
const projectsByFiles = new WeakMap<readonly ParsedFile[], Projects | undefined>();
// TypeScript 7 enables strict checking by default. Keep only files for which
// resolution can differ, using the same program membership as global names.
export type CallNullMode = 'loose' | 'strict' | 'exact';
const singleMode: Record<CallNullMode, readonly CallNullMode[]> = {
  loose: ['loose'],
  strict: ['strict'],
  exact: ['exact'],
};
const nullModesByScopeTree = new WeakMap<
  ScopeResolutionIndexes['scopeTree'],
  Map<string, readonly CallNullMode[]>
>();

/** Preserve the code-unit order of the serialized IDs, including numeric program indices. */
export function compareGlobalProjectIds(
  left: string | number | undefined,
  right: string | number | undefined,
): number {
  return compareCodeUnits(String(left), String(right));
}

function projectNullMode(project: TsconfigScope | string): CallNullMode {
  if (typeof project === 'string') return 'strict';
  if (!(project.strictNullChecks ?? project.strict ?? true)) return 'loose';
  return project.exactOptionalPropertyTypes ? 'exact' : 'strict';
}

export function callNullModes(site: ReferenceSite, indexes: ScopeResolutionIndexes) {
  const overrides = nullModesByScopeTree.get(indexes.scopeTree);
  return (
    overrides?.get(indexes.scopeTree.getScope(site.inScope)?.filePath ?? '') ?? singleMode.strict
  );
}

/** Strict-null consumers need agreement independent of exact optional property checking. */
export function callStrictNullChecks(
  site: ReferenceSite,
  indexes: ScopeResolutionIndexes,
): boolean | 'mixed' {
  const modes = callNullModes(site, indexes);
  if (!modes.includes('loose')) return true;
  return modes.length === 1 ? false : 'mixed';
}

const scriptDeclarations = new WeakSet<SymbolDefinition>();
const visibleGlobals = new WeakMap<ParsedFile, ReadonlyMap<string, readonly BindingRef[]>>();

/** Keep a single project table when each importer shadows a different name. */
class UnshadowedGlobals implements ReadonlyMap<string, BindingRef[]> {
  constructor(
    readonly globals: ReadonlyMap<string, BindingRef[]>,
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

/** Candidate spellings may include a shadowed global. Resolution still uses the importer's view. */
export function overloadNameTable(bindings: ReadonlyMap<string, readonly BindingRef[]>) {
  return bindings instanceof UnshadowedGlobals ? bindings.globals : bindings;
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
    config?.tsconfigs?.scopes.some((scope) => projectNullMode(scope) !== 'strict') ||
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
  return nodeResolution && nodePackageIsEsm(file, packages);
}

function fileSelection(scope: TsconfigScope) {
  const compile = (pattern: string, exclude: boolean) => {
    // TypeScript treats brackets, braces and parentheses literally. Only *, ** and ? are wildcards.
    const tail = pattern.slice(pattern.lastIndexOf('/') + 1);
    let glob = pattern;
    if (!/[.*?]/.test(tail)) glob = pattern ? `${pattern}/**/*` : '**/*';
    return new Minimatch(glob.replace(/[[\]\\]/g, String.raw`\$&`), {
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

function includeDirectory(pattern: string): string {
  const prefix = pattern.split(/[?*]/, 1)[0];
  if (prefix.endsWith('/')) return prefix.slice(0, -1);
  if (prefix === pattern && !path.posix.extname(prefix)) return prefix;
  return prefix.slice(0, Math.max(0, prefix.lastIndexOf('/')));
}

type GlobalProject = TsconfigScope | string;
type ProjectRoots = Map<GlobalProject, Set<ParsedFile>>;
type ProjectSelections = Map<string, Map<TsconfigScope, ReturnType<typeof fileSelection>>>;

function addMember<K, V>(groups: Map<K, Set<V>>, key: K, member: V) {
  const group = groups.get(key);
  if (group) group.add(member);
  else groups.set(key, new Set([member]));
}

function indexProjectRoots(
  project: TsconfigScope,
  byPath: ReadonlyMap<string, ParsedFile>,
  roots: ProjectRoots,
  selections: ProjectSelections,
) {
  for (const name of project.files ?? []) {
    const file = byPath.get(name);
    if (file) addMember(roots, project, file);
  }
  const selected = fileSelection(project);
  for (const pattern of project.include ?? (project.files ? [] : [project.dir])) {
    const directory = includeDirectory(pattern);
    const existing = selections.get(directory);
    if (existing) existing.set(project, selected);
    else selections.set(directory, new Map([[project, selected]]));
  }
}

function selectFileProjects(
  file: ParsedFile,
  owner: GlobalProject,
  roots: ProjectRoots,
  selections: ProjectSelections,
) {
  if (typeof owner === 'string') addMember(roots, owner, file);
  let dir = file.filePath;
  do {
    dir = dir.slice(0, Math.max(0, dir.lastIndexOf('/')));
    for (const [project, selected] of selections.get(dir) ?? []) {
      if (selected(file.filePath)) addMember(roots, project, file);
    }
  } while (dir);
}

function includeDependencies(
  file: ParsedFile,
  members: Set<ParsedFile>,
  byPath: ReadonlyMap<string, ParsedFile>,
  indexes: ScopeResolutionIndexes,
) {
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

/** Explicit file entries and transitive imports stay in a project even when an exclude matches. */
function projectMembers(
  files: readonly ParsedFile[],
  config: Projects | undefined,
  indexes: ScopeResolutionIndexes,
  projectOf: (file: ParsedFile) => GlobalProject,
) {
  const index = config?.tsconfigs;
  const scopes = index?.standalonePrograms?.length
    ? [...(index.programs ?? []), ...index.standalonePrograms]
    : (index?.programs ?? index?.scopes);
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
  const roots: ProjectRoots = new Map();
  const selections: ProjectSelections = new Map();
  for (const project of scopes) indexProjectRoots(project, byPath, roots, selections);
  for (const file of files) selectFileProjects(file, projectOf(file), roots, selections);

  const membership = new Map<ParsedFile, Set<GlobalProject>>();
  for (const [project, members] of roots) {
    const followImports = typeof project === 'string' || !project.noResolve;
    for (const file of members) {
      addMember(membership, file, project);
      if (followImports && members.size < files.length)
        includeDependencies(file, members, byPath, indexes);
    }
  }
  return membership;
}

type GlobalTable = Map<string, BindingRef[]>;
type DeclarationScope = NonNullable<ReturnType<typeof declarationScope>>;

function declarationPositions(
  scope: DeclarationScope,
  filePath: string,
  project: GlobalProject,
  packages?: NodeWorkspacePackages | null,
) {
  if (!scope.scriptNames) return scope.globalNames;
  const config = typeof project === 'string' ? null : project;
  return isProjectModule(filePath, scope.containsJsx === true, config, packages)
    ? scope.globalNames
    : scope.scriptNames;
}

function visiblePrograms(
  owner: GlobalProject,
  projects: ReadonlySet<GlobalProject> | undefined,
  standalone: ReadonlySet<TsconfigScope>,
): GlobalProject[] {
  if (!projects) return [owner];
  const visible = [...projects];
  if (visible.length < 2) return visible;
  // An imported file belongs to its including programs, even outside every config directory.
  const configured = visible.filter((project) => typeof project !== 'string');
  if (!configured.length) return visible;
  const primary = configured.filter((project) => !standalone.has(project));
  return primary.length ? primary : configured;
}

function recordProjectNullModes(
  filePath: string,
  projects: readonly GlobalProject[],
  modes: Map<string, readonly CallNullMode[]>,
) {
  const first = projectNullMode(projects[0]);
  if (projects.some((project) => projectNullMode(project) !== first)) {
    modes.set(filePath, [...new Set(projects.map(projectNullMode))]);
  } else if (first !== 'strict') {
    modes.set(filePath, singleMode[first]);
  }
}

class GlobalBindings {
  private readonly globals = new Map<GlobalProject, GlobalTable>();
  private readonly declaredNamespaces = new Map<ParsedFile, Set<SymbolDefinition>>();
  private readonly definitionsByBucket = new WeakMap<
    readonly BindingRef[],
    Set<SymbolDefinition>
  >();
  private readonly agreedByProjects = new Map<string, GlobalTable>();
  private readonly namespaces: Map<string, ReadonlyMap<string, BindingRef[]>>;
  private readonly accessible: Map<ScopeId, readonly string[]>;

  constructor(
    private readonly indexes: ScopeResolutionIndexes,
    private readonly programIds: ReadonlyMap<TsconfigScope, number>,
    private readonly packages?: NodeWorkspacePackages | null,
  ) {
    this.namespaces = indexes.namespaceFqnBindings as typeof this.namespaces;
    this.accessible = indexes.accessibleNamespacesByScope as typeof this.accessible;
  }

  collect(
    file: ParsedFile,
    membership: ReturnType<typeof projectMembers>,
    projectOf: (file: ParsedFile) => GlobalProject,
  ) {
    const scope = declarationScope(file.captureSideChannel);
    if (!scope) return;
    if (scope.scriptNames?.length) {
      const candidates = new Set(scope.scriptNames);
      for (const def of file.localDefs) {
        if (def.nameRange && candidates.has(`${def.nameRange.startLine}:${def.nameRange.startCol}`))
          scriptDeclarations.add(def);
      }
    }
    const projects = membership ? membership.get(file) : [projectOf(file)];
    for (const project of projects ?? []) {
      const names = declarationPositions(scope, file.filePath, project, this.packages);
      if (names.length) this.addDeclarations(file, project, new Set(names));
    }
  }

  private addDeclarations(
    file: ParsedFile,
    project: GlobalProject,
    positions: ReadonlySet<string>,
  ) {
    let symbols = this.globals.get(project);
    if (!symbols) {
      symbols = new Map();
      this.globals.set(project, symbols);
    }
    for (const def of file.localDefs) {
      const { nameRange, qualifiedName } = def;
      if (
        !nameRange ||
        !qualifiedName ||
        !positions.has(`${nameRange.startLine}:${nameRange.startCol}`)
      )
        continue;
      const refs = symbols.get(qualifiedName) ?? [];
      refs.push({ def, origin: 'namespace' });
      symbols.set(qualifiedName, refs);
      if (def.type === 'Namespace') addMember(this.declaredNamespaces, file, def);
    }
  }

  private definitions(refs: readonly BindingRef[]) {
    let result = this.definitionsByBucket.get(refs);
    if (!result) {
      result = new Set(refs.map((ref) => ref.def));
      this.definitionsByBucket.set(refs, result);
    }
    return result;
  }

  private sharedGlobals(
    projectKey: string,
    projects: readonly GlobalProject[],
    symbols: GlobalTable,
  ) {
    const cached = this.agreedByProjects.get(projectKey);
    if (cached) return cached;
    if (projects.length < 2) return symbols;
    // A shared dependency without its own project only has a unique binding
    // when its including programs agree on the declarations.
    const others = projects.slice(1);
    const shared = new Map(
      [...symbols].filter(([name, refs]) =>
        others.every((project) => {
          const other = this.globals.get(project)?.get(name);
          return (
            other?.length === refs.length &&
            refs.every((ref) => this.definitions(other).has(ref.def))
          );
        }),
      ),
    );
    this.agreedByProjects.set(projectKey, shared);
    return shared;
  }

  private namespaceFor(file: ParsedFile, projects: readonly GlobalProject[], symbols: GlobalTable) {
    // An explicit import owns its local spelling even when its target is not a module.
    const shadowed = new Set<string>();
    for (const entry of file.parsedImports) {
      if ('localName' in entry && symbols.has(entry.localName)) shadowed.add(entry.localName);
    }
    const projectKey = JSON.stringify(
      projects
        .map((project) => (typeof project === 'string' ? project : this.programIds.get(project)))
        .sort(compareGlobalProjectIds),
    );
    const namespace = JSON.stringify([
      'typescript-global',
      projectKey,
      [...shadowed].sort(compareCodeUnits),
    ]);
    if (!this.namespaces.has(namespace)) {
      const shared = this.sharedGlobals(projectKey, projects, symbols);
      for (const name of shadowed) if (!shared.has(name)) shadowed.delete(name);
      this.namespaces.set(
        namespace,
        shadowed.size ? new UnshadowedGlobals(shared, shadowed) : shared,
      );
    }
    return namespace;
  }

  publish(file: ParsedFile, projects: readonly GlobalProject[]) {
    const symbols = this.globals.get(projects[0]);
    if (!symbols?.size) return;
    const namespace = this.namespaceFor(file, projects, symbols);
    this.accessible.set(file.moduleScope, [
      ...(this.accessible.get(file.moduleScope) ?? []),
      namespace,
    ]);
    const visible = this.namespaces.get(namespace)!;
    visibleGlobals.set(file, visible);
    for (const def of this.declaredNamespaces.get(file) ?? []) {
      if (!def.declarationRange || !def.qualifiedName) continue;
      const siblings = visible.get(def.qualifiedName);
      if (!siblings || siblings.length < 2 || !this.definitions(siblings).has(def)) continue;
      const name = JSON.stringify([namespace, def.qualifiedName]);
      if (!this.namespaces.has(name))
        this.namespaces.set(name, namespaceExportsForBindings(siblings, this.indexes));
      const scope = makeScopeId({
        filePath: file.filePath,
        range: def.declarationRange,
        kind: 'Namespace',
      });
      this.accessible.set(scope, [...(this.accessible.get(scope) ?? []), name]);
    }
  }
}

/** Publish globals at the module scope so lexical declarations retain precedence. */
export function bindGlobalDeclarations(
  files: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
) {
  nullModesByScopeTree.delete(indexes.scopeTree);
  if (!projectsByFiles.has(files)) return;
  const config = projectsByFiles.get(files);
  const projectOf = (file: ParsedFile) =>
    tsconfigFor(config?.tsconfigs ?? null, file.filePath) ??
    owningPackage(file.filePath, config?.nodeWorkspacePackages)?.dir ??
    '';
  const membership = projectMembers(files, config, indexes, projectOf);
  const standalone = new Set(config?.tsconfigs?.standalonePrograms);
  const programIds = new Map(config?.tsconfigs?.scopes.map((scope, index) => [scope, index]));
  const nullModes = config?.tsconfigs?.scopes.some((scope) => projectNullMode(scope) !== 'strict')
    ? new Map<string, readonly CallNullMode[]>()
    : undefined;
  if (nullModes) nullModesByScopeTree.set(indexes.scopeTree, nullModes);
  const bindings = new GlobalBindings(indexes, programIds, config?.nodeWorkspacePackages);
  for (const file of files) bindings.collect(file, membership, projectOf);
  for (const file of files) {
    visibleGlobals.delete(file);
    const owner = projectOf(file);
    const projects = membership?.get(file);
    if (membership && !projects) continue;
    const visible = visiblePrograms(owner, projects, standalone);
    if (nullModes) recordProjectNullModes(file.filePath, visible, nullModes);
    bindings.publish(file, visible.includes(owner) ? [owner] : visible);
  }
}
