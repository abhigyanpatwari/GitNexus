import type { ParsedFile, ParsedImport, Scope, SymbolDefinition } from 'gitnexus-shared';
import type { ImportResolutionContext } from '../../scope-resolution/contract/scope-resolver.js';
import {
  rustCargoImportedModules,
  rustIsExclusiveCargoRoot,
  rustUsesRelativeImportPaths,
} from './cargo-targets.js';

interface ImportWorkspace {
  readonly files: ReadonlyMap<string, ParsedFile>;
  readonly scopes: ReadonlyMap<string, Scope>;
  readonly definitionsByFile: ReadonlyMap<string, ReadonlyMap<string, readonly SymbolDefinition[]>>;
  readonly moduleDefinitions: ReadonlySet<string>;
  readonly importsByScope: ReadonlyMap<string, ReadonlyMap<string, readonly ParsedImport[]>>;
  readonly reexportsByFile: ReadonlyMap<string, ReadonlyMap<string, readonly ScopedReexport[]>>;
}

interface ScopedReexport {
  readonly module: string;
  readonly imported: Extract<ParsedImport, { kind: 'reexport' }>;
}

const importWorkspace = new WeakMap<readonly ParsedFile[], ImportWorkspace>();

function workspaceFor(context: ImportResolutionContext): ImportWorkspace {
  let workspace = importWorkspace.get(context.parsedFiles);
  if (workspace !== undefined) return workspace;
  const definitionsByFile = new Map<string, Map<string, SymbolDefinition[]>>();
  const moduleDefinitions = new Set<string>();
  const importsByScope = new Map<string, Map<string, ParsedImport[]>>();
  const reexportsByFile = new Map<string, Map<string, ScopedReexport[]>>();
  const scopes = new Map(
    context.parsedFiles.flatMap((file) => file.scopes.map((scope) => [scope.id, scope] as const)),
  );
  const moduleByScope = new Map<string, string>();
  const moduleAt = (scopeId: string): string => {
    const cached = moduleByScope.get(scopeId);
    if (cached !== undefined) return cached;
    const scope = scopes.get(scopeId);
    if (scope === undefined) return '';
    const parent = scope.parent === null ? '' : moduleAt(scope.parent);
    const own =
      scope.kind === 'Namespace'
        ? scope.ownedDefs
            .find((def) => def.type === 'Namespace')
            ?.qualifiedName?.split('.')
            .pop()
        : undefined;
    const module = [parent, own].filter(Boolean).join('::');
    moduleByScope.set(scopeId, module);
    return module;
  };
  for (const file of context.parsedFiles) {
    const byName = new Map<string, SymbolDefinition[]>();
    const reexports = new Map<string, ScopedReexport[]>();
    definitionsByFile.set(file.filePath, byName);
    reexportsByFile.set(file.filePath, reexports);
    for (const def of file.localDefs) {
      const name = def.qualifiedName?.split('.').pop();
      if (!name) continue;
      const entries = byName.get(name) ?? [];
      entries.push(def);
      byName.set(name, entries);
    }
    for (const scope of file.scopes) {
      if (scope.kind !== 'Module' && scope.kind !== 'Namespace') continue;
      for (const bindings of scope.bindings.values()) {
        for (const binding of bindings) {
          if (binding.origin === 'local') moduleDefinitions.add(binding.def.nodeId);
        }
      }
    }
    for (const imp of file.parsedImports) {
      if (!('localName' in imp)) continue;
      const scope = imp.declaredAtScope ?? file.moduleScope;
      let names = importsByScope.get(scope);
      if (names === undefined) importsByScope.set(scope, (names = new Map()));
      const entries = names.get(imp.localName) ?? [];
      entries.push(imp);
      names.set(imp.localName, entries);
      const owner = scopes.get(scope);
      if (imp.kind === 'reexport' && (owner?.kind === 'Module' || owner?.kind === 'Namespace')) {
        const modules = reexports.get(imp.localName) ?? [];
        modules.push({ module: moduleAt(scope), imported: imp });
        reexports.set(imp.localName, modules);
      }
    }
  }
  workspace = {
    files: new Map(context.parsedFiles.map((file) => [file.filePath, file])),
    scopes,
    definitionsByFile,
    moduleDefinitions,
    importsByScope,
    reexportsByFile,
  };
  importWorkspace.set(context.parsedFiles, workspace);
  return workspace;
}

/** Named imports can use Cargo's exact root and #[path] topology. */
function cargoNamedTarget(
  segments: readonly string[],
  targetRaw: string,
  fromFile: string,
  allFilePaths: ReadonlySet<string>,
  config: unknown,
  context: ImportResolutionContext,
  visited: ReadonlySet<ParsedImport>,
): { readonly target: string | readonly string[] | null } | undefined {
  const imported = context.parsedImport;
  if (
    imported === undefined ||
    !['named', 'alias', 'reexport'].includes(imported.kind) ||
    !('importedName' in imported)
  )
    return undefined;
  if (rustUsesRelativeImportPaths(config, fromFile) === undefined) return undefined;
  const workspace = workspaceFor(context);
  const parsed = workspace.files.get(fromFile);
  if (parsed === undefined) return undefined;
  if (
    !targetRaw.startsWith('::') &&
    !['crate', '$crate', 'self', 'super'].includes(segments[0] ?? '')
  ) {
    let lexical = workspace.scopes.get(imported.declaredAtScope ?? parsed.moduleScope);
    while (lexical !== undefined) {
      // A lexical alias owns this path head even when its target is unknown.
      // Cargo's extern-prelude name must not bypass that binding.
      if (
        workspace.importsByScope
          .get(lexical.id)
          ?.get(segments[0])
          ?.some((imp) => imp !== imported)
      ) {
        return { target: null };
      }
      const localTypes = (lexical.bindings.get(segments[0]) ?? []).filter(
        (binding) =>
          binding.origin === 'local' &&
          ['Namespace', 'Class', 'Struct', 'Enum', 'Trait', 'TypeAlias', 'Union'].includes(
            binding.def.type,
          ),
      );
      if (localTypes.length > 0) {
        if (localTypes.some((binding) => binding.def.type !== 'Namespace')) return { target: null };
        // Function/block-local modules are not published in Cargo's module tree.
        if (lexical.kind !== 'Module' && lexical.kind !== 'Namespace') return undefined;
        break;
      }
      if (lexical.kind === 'Namespace') break;
      lexical = lexical.parent === null ? undefined : workspace.scopes.get(lexical.parent);
    }
  }
  const owner: string[] = [];
  let scope = workspace.scopes.get(imported.declaredAtScope ?? parsed.moduleScope);
  while (scope !== undefined) {
    if (scope.kind === 'Namespace') {
      const name = scope.ownedDefs
        .find((def) => def.type === 'Namespace')
        ?.qualifiedName?.split('.')
        .pop();
      if (name) owner.unshift(name);
    }
    scope = scope.parent === null ? undefined : workspace.scopes.get(scope.parent);
  }
  const modules = rustCargoImportedModules(
    config,
    fromFile,
    segments.slice(0, -1),
    owner.join('::'),
    targetRaw.startsWith('::'),
  );
  if (modules === undefined) return undefined;
  const candidates = new Set<string>();
  for (const location of modules) {
    if (!allFilePaths.has(location.file)) continue;
    const definitions =
      workspace.definitionsByFile.get(location.file)?.get(imported.importedName) ?? [];
    // The shared finalizer matches a file-wide simple name. A precise module
    // receipt must not let it pick a different namespace or a same-file homonym.
    if (definitions.length > 1) return { target: null };
    if (
      definitions.length === 1 &&
      (!workspace.moduleDefinitions.has(definitions[0]!.nodeId) ||
        (definitions[0]!.namespacePrefix ?? '').replaceAll('.', '::') !== location.module)
    )
      continue;
    if (definitions.length === 0) {
      const reexports =
        workspace.reexportsByFile.get(location.file)?.get(imported.importedName) ?? [];
      // The closure is file-wide too. A sole explicit re-export in the named
      // module is the identity evidence it needs; other namespaces or competing
      // re-exports cannot safely be collapsed to one file-wide name.
      if (reexports.length !== 1) return { target: null };
      const reexport = reexports[0]!;
      if (reexport.module !== location.module) continue;
      if (location.module !== '') {
        // Namespace-scoped exports deliberately do not enter the shared
        // file-level closure. Follow this exact receipt instead. A file-only
        // target cannot communicate an alias's changed symbol spelling.
        if (reexport.imported.importedName !== imported.importedName) return { target: null };
        const target = resolveRustImportTarget(
          reexport.imported.targetRaw,
          location.file,
          allFilePaths,
          config,
          { parsedFiles: context.parsedFiles, parsedImport: reexport.imported },
          visited,
        );
        if (target === null) return { target: null };
        for (const file of typeof target === 'string' ? [target] : target) candidates.add(file);
        continue;
      }
    }
    candidates.add(location.file);
  }
  const files = [...candidates];
  return { target: files.length === 0 ? null : files.length === 1 ? files[0] : files };
}

/** A declared module is evidence; a similarly named file elsewhere is not. */
function declaredRelativeTarget(
  segments: readonly string[],
  fromFile: string,
  allFilePaths: ReadonlySet<string>,
  resolutionConfig: unknown,
  context: ImportResolutionContext,
): { readonly target: string | readonly string[] | null } | undefined {
  const workspace = workspaceFor(context);
  const parsed = workspace.files.get(fromFile);
  if (parsed === undefined) return undefined;
  let scope = workspace.scopes.get(context.parsedImport?.declaredAtScope ?? parsed.moduleScope);
  const visited = new Set<string>();
  while (scope !== undefined && !visited.has(scope.id)) {
    visited.add(scope.id);
    const ownNamespace =
      scope.kind === 'Namespace'
        ? scope.ownedDefs.find((def) => def.type === 'Namespace')?.nodeId
        : undefined;
    const declarations = new Set(
      (scope.bindings.get(segments[0]) ?? [])
        .filter(
          (binding) =>
            binding.origin === 'local' &&
            binding.def.type === 'Namespace' &&
            binding.def.nodeId !== ownNamespace,
        )
        .map((binding) => binding.def.nodeId),
    );
    if (declarations.size > 0) {
      if (declarations.size !== 1) return { target: null };
      const inline: string[] = [];
      let owner: Scope | undefined = scope;
      while (owner !== undefined) {
        if (owner.kind === 'Namespace') {
          const name = owner.ownedDefs
            .find((def) => def.type === 'Namespace')
            ?.qualifiedName?.split('.')
            .pop();
          if (name !== undefined) inline.unshift(name);
        }
        owner = owner.parent === null ? undefined : workspace.scopes.get(owner.parent);
      }
      const normalized = fromFile.replace(/\\/g, '/');
      const slash = normalized.lastIndexOf('/');
      const directory = slash === -1 ? '' : normalized.slice(0, slash);
      const filename = normalized.slice(slash + 1);
      const ownsDirectory =
        ['lib.rs', 'main.rs', 'mod.rs'].includes(filename) ||
        rustIsExclusiveCargoRoot(resolutionConfig, fromFile);
      const base = ownsDirectory ? directory : normalized.replace(/\.rs$/, '');
      const modulePath = [...inline, ...segments];
      const target = resolveModulePath(modulePath, base, allFilePaths);
      if (ownsDirectory || rustUsesRelativeImportPaths(resolutionConfig, fromFile) !== undefined) {
        return { target };
      }
      // A standalone source may be passed directly to rustc as a custom crate
      // root. Without Cargo membership, both its module layout and that root
      // layout are possible; keep ambiguity when both contain the module.
      const rootTarget = resolveModulePath(modulePath, directory, allFilePaths);
      const candidates = [
        ...new Set(
          [target, rootTarget].flatMap((candidate) =>
            candidate === null ? [] : typeof candidate === 'string' ? [candidate] : candidate,
          ),
        ),
      ];
      return {
        target:
          candidates.length === 0 ? null : candidates.length === 1 ? candidates[0] : candidates,
      };
    }
    scope = scope.parent === null ? undefined : workspace.scopes.get(scope.parent);
  }
  return undefined;
}

/**
 * Resolve a Rust `use` import path to a repo-relative file path.
 *
 * Rust module resolution rules:
 *   - `crate::foo::bar` → `src/foo/bar.rs` or `src/foo/bar/mod.rs`
 *   - `super::foo` → parent directory's `foo.rs` or `foo/mod.rs`
 *   - `self::foo` → same directory's `foo.rs` or `foo/mod.rs`
 *   - External crate imports (no `crate::`/`super::`/`self::`) → null
 */
export function resolveRustImportTarget(
  targetRaw: string,
  fromFile: string,
  allFilePaths: ReadonlySet<string>,
  resolutionConfig?: unknown,
  context?: ImportResolutionContext,
  visited: ReadonlySet<ParsedImport> = new Set(),
): string | readonly string[] | null {
  if (!targetRaw) return null;

  const segments = targetRaw.split('::').filter(Boolean);
  if (segments.length === 0) return null;

  if (context !== undefined) {
    // Inline re-export chains are a provider-only supplement to the shared
    // SCC closure. Cycles and excessive depth conservatively stay unresolved.
    const imported = context.parsedImport;
    if (imported !== undefined && (visited.has(imported) || visited.size >= 64)) return null;
    const nextVisited = imported === undefined ? visited : new Set([...visited, imported]);
    const cargo = cargoNamedTarget(
      segments,
      targetRaw,
      fromFile,
      allFilePaths,
      resolutionConfig,
      context,
      nextVisited,
    );
    if (cargo !== undefined) return cargo.target;
  }

  const fromNormalized = fromFile.replace(/\\/g, '/');
  const fromDir = fromNormalized.includes('/')
    ? fromNormalized.slice(0, fromNormalized.lastIndexOf('/'))
    : '';

  if (segments[0] === 'crate') {
    const cratePath = segments.slice(1);
    return resolveModulePath(cratePath, findSrcRoot(fromNormalized), allFilePaths);
  }

  if (segments[0] === 'super') {
    const parentDir = fromDir.includes('/') ? fromDir.slice(0, fromDir.lastIndexOf('/')) : '';
    const restPath = segments.slice(1);
    return resolveModulePath(restPath, parentDir, allFilePaths);
  }

  if (segments[0] === 'self') {
    const restPath = segments.slice(1);
    return resolveModulePath(restPath, fromDir, allFilePaths);
  }

  const relativeMode = rustUsesRelativeImportPaths(resolutionConfig, fromFile);
  const relative =
    relativeMode !== false && !targetRaw.startsWith('::') && context !== undefined
      ? declaredRelativeTarget(segments, fromFile, allFilePaths, resolutionConfig, context)
      : undefined;
  // Standalone sources have no edition receipt. Prefer a declared local module,
  // matching modern Rust; context-free callers keep their legacy resolution.
  if (relative !== undefined && relativeMode !== null) return relative.target;

  // External crate — try workspace-level resolution
  const workspaceResult = resolveWorkspaceCrate(segments, allFilePaths);
  const legacyTarget =
    workspaceResult ?? resolveModulePath(segments, findSrcRoot(fromNormalized), allFilePaths);
  if (relative === undefined) return legacyTarget;
  // A file shared by 2015 and modern targets has both interpretations. Keep
  // every possible target instead of selecting an edition by visitation order.
  const candidates = [
    ...new Set(
      [relative.target, legacyTarget].flatMap((target) =>
        target === null ? [] : typeof target === 'string' ? [target] : target,
      ),
    ),
  ];
  return candidates.length === 0 ? null : candidates.length === 1 ? candidates[0] : candidates;
}

function findSrcRoot(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const srcIdx = normalized.lastIndexOf('/src/');
  if (srcIdx !== -1) return normalized.slice(0, srcIdx + 4); // includes trailing /src
  if (normalized.startsWith('src/')) return 'src';
  return '';
}

function resolveModulePath(
  pathSegments: string[],
  baseDir: string,
  allFilePaths: ReadonlySet<string>,
): string | readonly string[] | null {
  if (pathSegments.length === 0) {
    const modPath = baseDir ? `${baseDir}/mod.rs` : 'mod.rs';
    if (allFilePaths.has(modPath)) return modPath;
    return null;
  }

  const modulePath = pathSegments.join('/');

  // Try direct file
  const directFile = baseDir ? `${baseDir}/${modulePath}.rs` : `${modulePath}.rs`;
  if (allFilePaths.has(directFile)) return directFile;

  // Try mod.rs inside directory
  const modFile = baseDir ? `${baseDir}/${modulePath}/mod.rs` : `${modulePath}/mod.rs`;
  if (allFilePaths.has(modFile)) return modFile;

  // Try partial path resolution: for `use crate::models::User` where
  // User is a type inside models.rs, resolve to `src/models.rs`
  if (pathSegments.length >= 2) {
    const parentPath = pathSegments.slice(0, -1).join('/');
    const parentFile = baseDir ? `${baseDir}/${parentPath}.rs` : `${parentPath}.rs`;
    if (allFilePaths.has(parentFile)) return parentFile;

    const parentModFile = baseDir ? `${baseDir}/${parentPath}/mod.rs` : `${parentPath}/mod.rs`;
    if (allFilePaths.has(parentModFile)) return parentModFile;
  }

  // Fallback: try increasingly shorter path prefixes
  for (let i = pathSegments.length - 2; i >= 1; i--) {
    const prefix = pathSegments.slice(0, i).join('/');
    const prefixFile = baseDir ? `${baseDir}/${prefix}.rs` : `${prefix}.rs`;
    if (allFilePaths.has(prefixFile)) return prefixFile;
    const prefixModFile = baseDir ? `${baseDir}/${prefix}/mod.rs` : `${prefix}/mod.rs`;
    if (allFilePaths.has(prefixModFile)) return prefixModFile;
  }

  return null;
}

function resolveWorkspaceCrate(
  segments: string[],
  allFilePaths: ReadonlySet<string>,
): string | null {
  const crateName = segments[0];
  const restSegments = segments.slice(1);

  const candidates = [
    restSegments.length > 0
      ? `${crateName}/src/${restSegments.join('/')}.rs`
      : `${crateName}/src/lib.rs`,
    restSegments.length > 0
      ? `${crateName}/src/${restSegments.join('/')}/mod.rs`
      : `${crateName}/src/lib.rs`,
  ];

  for (const candidate of candidates) {
    if (allFilePaths.has(candidate)) return candidate;
  }

  return null;
}

export interface RustResolveContext {
  readonly fromFile: string;
  readonly allFilePaths: ReadonlySet<string>;
}
