/**
 * Lua `ScopeResolver` registered in `SCOPE_RESOLVERS` and consumed by the
 * generic `runScopeResolution` orchestrator.
 *
 * Minimal Phase B1 wiring: Lua's scope model (Module + Function/Method, no
 * static types) plugs into `runScopeResolution` with the least configuration
 * that unlocks CALLS + IMPORTS edges. middleclass EXTENDS + HAS_METHOD and
 * generic MRO dispatch are emitted through the heritage hook; `__base` calls
 * use the qualified-receiver hook to dispatch to the immediate parent.
 *
 * Reference: `languages/cobol/scope-resolver.ts` (minimal) + `languages/go/`.
 */
import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import {
  populateClassOwnedMembers,
  resolveInheritanceBaseInScope,
} from '../../scope-resolution/scope/walkers.js';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { GraphNodeLookup } from '../../scope-resolution/graph-bridge/node-lookup.js';
import { tryEmitEdge } from '../../scope-resolution/graph-bridge/edges.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { SemanticModel } from '../../model/semantic-model.js';
import {
  buildSuffixIndex,
  LUA_EXTENSIONS,
  suffixResolve,
  type SuffixIndex,
} from '../../import-resolvers/utils.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import { luaProvider } from '../lua.js';
import { emitLuaHeritageEdges } from './heritage.js';
import {
  clearLuaHeritageFacts,
  type LuaCaptureSideChannel,
  type LuaCallableAlias,
} from './capture-side-channel.js';

// Cache the suffix index across calls within one analyze run — `allFilePaths`
// is the same ReadonlySet for every Lua import in the run, so keying on its
// reference avoids rebuilding a 500-entry index per require(). Must use the
// index path: the linear-scan fallback in suffixResolve prepends `/` to the
// suffix, which fails to match root-level files like `middleclass.lua`.
let _cachedSet: ReadonlySet<string> | null = null;
let _cachedIndex: SuffixIndex | null = null;

function populateLuaOwners(parsed: ParsedFile): void {
  const channel = parsed.captureSideChannel as LuaCaptureSideChannel | undefined;
  if (channel?.kind === 'lua') {
    const classes = new Map(
      parsed.localDefs
        .filter((def) => def.type === 'Class')
        .map((def) => [def.qualifiedName ?? '', def]),
    );
    for (const pair of channel.methodOwners) {
      const method = parsed.localDefs.find(
        (def) =>
          def.type === 'Method' &&
          def.qualifiedName === pair.method &&
          // Match the declaration position, not an arbitrary `#<row>:` token.
          // Callable ids may carry an arity/signature suffix; a loose
          // substring check can associate a method with the wrong declaration.
          new RegExp(`#${pair.defRow + 1}:\\d+:Method:`).test(def.nodeId),
      );
      const owner = classes.get(pair.owner);
      if (method !== undefined && owner !== undefined) method.ownerId = owner.nodeId;
    }
  }
  populateClassOwnedMembers(parsed);
}

function resolveLuaBaseMember(
  receiverText: string,
  memberName: string,
  callerScope: string,
  scopes: Parameters<NonNullable<ScopeResolver['resolveQualifiedReceiverMember']>>[3],
): SymbolDefinition | 'ambiguous' | undefined {
  const parts = receiverText.split('.');
  if (parts.length < 2 || parts[parts.length - 1] !== '__base') return undefined;
  const className = parts.slice(0, -1).join('.');
  if (className.length === 0) return undefined;

  const classDef = resolveInheritanceBaseInScope(callerScope, className, scopes, className);
  if (classDef === undefined) return undefined;
  const parentId = scopes.methodDispatch.mroFor(classDef.nodeId)[0];
  if (parentId === undefined) return undefined;

  const candidates = [...scopes.defs.byId.values()].filter(
    (def) =>
      def.ownerId === parentId &&
      (def.type === 'Method' || def.type === 'Function') &&
      (def.qualifiedName === memberName || def.qualifiedName?.endsWith(`.${memberName}`)),
  );
  if (candidates.length === 1) return candidates[0];
  return candidates.length > 1 ? 'ambiguous' : undefined;
}

function resolveLuaNamespaceMember(
  receiverText: string,
  memberName: string,
  callerScope: string,
  scopes: Parameters<NonNullable<ScopeResolver['resolveQualifiedReceiverMember']>>[3],
  parsedFiles: readonly ParsedFile[],
): SymbolDefinition | 'ambiguous' | undefined {
  let current: string | null = callerScope;
  while (current !== null) {
    const scope = scopes.scopeTree.getScope(current);
    if (scope === undefined) return undefined;
    if (scope.kind === 'Module') {
      const imports = (scopes.imports.get(current) ?? []).filter(
        (edge) => edge.localName === receiverText && edge.targetFile !== null,
      );
      if (imports.length !== 1) return imports.length > 1 ? 'ambiguous' : undefined;
      const targetFile = imports[0]?.targetFile;
      const target = parsedFiles.find((file) => file.filePath === targetFile);
      if (target === undefined) return undefined;
      const candidates = target.localDefs.filter(
        (def) =>
          (def.type === 'Function' || def.type === 'Method') &&
          (def.qualifiedName === memberName || def.qualifiedName?.endsWith(`.${memberName}`)),
      );
      if (candidates.length === 1) return candidates[0];
      return candidates.length > 1 ? 'ambiguous' : undefined;
    }
    current = scope.parent;
  }
  return undefined;
}

function luaCallableCandidates(parsed: ParsedFile, name: string): readonly SymbolDefinition[] {
  return parsed.localDefs.filter(
    (def) =>
      (def.type === 'Function' || def.type === 'Method') &&
      (def.qualifiedName === name || def.qualifiedName?.endsWith(`.${name}`)),
  );
}

function resolveLuaCallableAlias(
  parsed: ParsedFile,
  source: string,
  scopes: ScopeResolutionIndexes,
  parsedFilesByPath: ReadonlyMap<string, ParsedFile>,
): SymbolDefinition | 'ambiguous' | undefined {
  const aliasesFor = (file: ParsedFile): ReadonlyMap<string, LuaCallableAlias> | 'ambiguous' => {
    const out = new Map<string, LuaCallableAlias>();
    for (const alias of (file.captureSideChannel as LuaCaptureSideChannel | undefined)
      ?.callableAliases ?? []) {
      if (out.has(alias.destination)) return 'ambiguous';
      out.set(alias.destination, alias);
    }
    return out;
  };

  const memberCandidates = (file: ParsedFile, member: string): readonly SymbolDefinition[] =>
    luaCallableCandidates(file, member);

  const seen = new Set<string>();
  const resolve = (
    current: string,
    currentParsed: ParsedFile,
    depth: number,
  ): SymbolDefinition | 'ambiguous' | undefined => {
    if (depth > 16 || seen.has(`${currentParsed.filePath}:${current}`)) return undefined;
    seen.add(`${currentParsed.filePath}:${current}`);

    const aliases = aliasesFor(currentParsed);
    if (aliases === 'ambiguous') return 'ambiguous';
    const alias = aliases.get(current);
    if (alias !== undefined) return resolve(alias.source, currentParsed, depth + 1);

    const parts = current.split('.');
    if (parts.length === 1) {
      const candidates = luaCallableCandidates(currentParsed, current);
      return candidates.length === 1
        ? candidates[0]
        : candidates.length > 1
          ? 'ambiguous'
          : undefined;
    }
    if (parts.length !== 2 || !parts.every((part) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(part)))
      return undefined;

    const [receiver, member] = parts;
    const imports = (scopes.imports.get(currentParsed.moduleScope) ?? []).filter(
      (edge) => edge.localName === receiver && edge.targetFile !== null,
    );
    if (imports.length > 1) return 'ambiguous';
    const importedTarget = imports[0]?.targetFile;
    const targetFile =
      importedTarget === null || importedTarget === undefined
        ? currentParsed
        : parsedFilesByPath.get(importedTarget);
    if (targetFile === undefined) return undefined;
    const candidates = memberCandidates(targetFile, member);
    return candidates.length === 1
      ? candidates[0]
      : candidates.length > 1
        ? 'ambiguous'
        : undefined;
  };

  return resolve(source, parsed, 0);
}

function emitLuaCallableAliasEdges(
  graph: KnowledgeGraph,
  scopes: ScopeResolutionIndexes,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
  handledSites: Set<string>,
  _model: SemanticModel,
): number {
  const parsedFilesByPath = new Map(parsedFiles.map((file) => [file.filePath, file]));
  const seen = new Set<string>();
  let emitted = 0;

  for (const parsed of parsedFiles) {
    for (const site of parsed.referenceSites) {
      if (site.kind !== 'call' || site.explicitReceiver !== undefined) continue;
      const siteKey = `${parsed.filePath}:${site.atRange.startLine}:${site.atRange.startCol}`;
      if (handledSites.has(siteKey)) continue;

      const channel = parsed.captureSideChannel as LuaCaptureSideChannel | undefined;
      if (channel?.callableAliases.some((alias) => alias.destination === site.name) !== true)
        continue;
      const target = resolveLuaCallableAlias(parsed, site.name, scopes, parsedFilesByPath);
      if (target === undefined || target === 'ambiguous') continue;

      if (tryEmitEdge(graph, scopes, nodeLookup, site, target, 'lua-callable-alias', seen, 0.85)) {
        emitted++;
      }
      handledSites.add(siteKey);
    }
  }
  return emitted;
}

const luaScopeResolver: ScopeResolver = {
  language: SupportedLanguages.Lua,
  languageProvider: luaProvider,
  importEdgeReason: 'lua-scope: require',

  // Worker capture facts are process-local and can outlive a single analysis in
  // server mode. Runs once before each Lua workspace pass, mirroring the
  // Java/Kotlin `loadResolutionConfig` clear. The per-file delete in
  // `captures.ts` is the operative fix for the empty-recapture stale path;
  // this clear-all is the belt-and-suspenders lifecycle hook.
  loadResolutionConfig: () => {
    clearLuaHeritageFacts();
    return undefined;
  },

  // require("a.b.c") → module path a/b/c (+ Lua extensions: .lua / /init.lua).
  // targetRaw arrives quote-stripped (interpretLuaImport); Lua's module
  // separator is `.`, so split on it before joining to a path.
  resolveImportTarget: (targetRaw, _fromFile, allFilePaths) => {
    const parts = targetRaw
      .replace(/^["']|["']$/g, '')
      .split('.')
      .filter(Boolean);
    if (parts.length === 0) return null;
    if (_cachedSet !== allFilePaths) {
      const list = [...allFilePaths];
      _cachedIndex = buildSuffixIndex(list, list);
      _cachedSet = allFilePaths;
    }
    // Once the suffix index exists, suffixResolve only consults the index;
    // passing a spread copy here would still traverse the entire workspace on
    // every require() despite the cache (#2909 contract).
    return suffixResolve(parts, [], [], _cachedIndex ?? undefined, LUA_EXTENSIONS);
  },

  // Lua: default local-first-then-imports merge (no language-specific precedence).
  mergeBindings: (existing, incoming) => [...existing, ...incoming],

  // Lua supplies nil for missing positional arguments and ignores extras, so
  // TypeScript-style min/max arity filtering would reject valid calls.
  arityCompatibility: () => 'unknown',

  // middleclass uses single inheritance; the generic breadth-first
  // linearization is conservative and refuses no additional edges when the
  // heritage graph is ambiguous or cyclic.
  buildMro: (graph, parsedFiles, nodeLookup) =>
    buildMro(graph, parsedFiles, nodeLookup, defaultLinearize),

  populateOwners: populateLuaOwners,

  // middleclass exposes the parent class as `Class.__base`; the qualified
  // receiver hook below resolves `Class.__base.method()` through the generic
  // MRO index without adding a Lua-specific dispatch pass.
  isSuperReceiver: () => false,
  resolveQualifiedReceiverMember: (receiver, member, callerScope, scopes, parsedFiles) =>
    resolveLuaBaseMember(receiver, member, callerScope, scopes) ??
    resolveLuaNamespaceMember(receiver, member, callerScope, scopes, parsedFiles),

  // middleclass `class("Name", Parent)` — emits EXTENDS. middleclass has no
  // syntactic class body, so lexical heritage cannot produce these; the hook
  // consumes the capture side-channel's class() facts.
  emitHeritageEdges: emitLuaHeritageEdges,

  // Lua has globals (`function foo()` is global) — let unresolved free calls
  // fall back to the global symbol table.
  allowGlobalFreeCallFallback: true,

  // Module-level aliases such as `local f = util.answer; f()` are not
  // receiver calls, so the generic receiver pass cannot see their target.
  // Resolve only static, uniquely identified aliases here; dynamic keys,
  // factory results, function-local aliases, cycles, and ambiguity fail closed.
  emitUnresolvedReceiverEdges: emitLuaCallableAliasEdges,
};

export { luaScopeResolver };
