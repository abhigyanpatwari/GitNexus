/**
 * Lua `ScopeResolver` registered in `SCOPE_RESOLVERS` and consumed by the
 * generic `runScopeResolution` orchestrator.
 *
 * Minimal Phase B1 wiring: Lua's scope model (Module + Function/Method, no
 * static types) plugs into `runScopeResolution` with the least configuration
 * that unlocks CALLS + IMPORTS edges. middleclass EXTENDS + HAS_METHOD and
 * generic MRO dispatch are emitted through the heritage hook; `__base` super
 * calls remain intentionally unsupported.
 *
 * Reference: `languages/cobol/scope-resolver.ts` (minimal) + `languages/go/`.
 */
import type { ParsedFile } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';
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
import { clearLuaHeritageFacts, type LuaCaptureSideChannel } from './capture-side-channel.js';

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

  // Lua has no super-call construct (middleclass __base access is Phase B2).
  isSuperReceiver: () => false,

  // middleclass `class("Name", Parent)` — emits EXTENDS. middleclass has no
  // syntactic class body, so lexical heritage cannot produce these; the hook
  // consumes the capture side-channel's class() facts.
  emitHeritageEdges: emitLuaHeritageEdges,

  // Lua has globals (`function foo()` is global) — let unresolved free calls
  // fall back to the global symbol table.
  allowGlobalFreeCallFallback: true,
};

export { luaScopeResolver };
