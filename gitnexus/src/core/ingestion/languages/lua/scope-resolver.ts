/**
 * Lua `ScopeResolver` registered in `SCOPE_RESOLVERS` and consumed by the
 * generic `runScopeResolution` orchestrator.
 *
 * Minimal Phase B1 wiring: Lua's scope model (Module + Function/Method, no
 * static types) plugs into `runScopeResolution` with the least configuration
 * that unlocks CALLS + IMPORTS edges. middleclass EXTENDS + HAS_METHOD are
 * emitted by `emitLuaHeritageEdges` (heritage.ts), fed by the capture side
 * channel; middleclass MRO + `__base` super calls are Phase B2; the
 * receiver/arity polish for indirect value receivers is Phase B3.
 *
 * Reference: `languages/cobol/scope-resolver.ts` (minimal) + `languages/go/`.
 */
import type { ParsedFile } from 'gitnexus-shared';
import { SupportedLanguages } from 'gitnexus-shared';
import { populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';
import { buildSuffixIndex, suffixResolve, type SuffixIndex } from '../../import-resolvers/utils.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { luaProvider } from '../lua.js';
import { emitLuaHeritageEdges } from './heritage.js';
import { clearLuaHeritageFacts } from './capture-side-channel.js';

// Cache the suffix index across calls within one analyze run — `allFilePaths`
// is the same ReadonlySet for every Lua import in the run, so keying on its
// reference avoids rebuilding a 500-entry index per require(). Must use the
// index path: the linear-scan fallback in suffixResolve prepends `/` to the
// suffix, which fails to match root-level files like `middleclass.lua`.
let _cachedSet: ReadonlySet<string> | null = null;
let _cachedIndex: SuffixIndex | null = null;

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

  // require("a.b.c") → module path a/b/c (+ EXTENSIONS: .lua / /init.lua).
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
    const list = [...allFilePaths];
    return suffixResolve(parts, list, list, _cachedIndex ?? undefined);
  },

  // Lua: default local-first-then-imports merge (no language-specific precedence).
  mergeBindings: (existing) => [...existing],

  // Lua varargs (...) + optional params make static arity checks unreliable —
  // 'unknown' (no signal) is the safe minimal choice.
  arityCompatibility: () => 'unknown',

  // middleclass single inheritance — MRO populated in Phase B2 (buildMro +
  // defaultLinearize). Empty for now (no Class scopes yet).
  buildMro: () => new Map(),

  populateOwners: (parsed: ParsedFile) => populateClassOwnedMembers(parsed),

  // Lua has no super-call construct (middleclass __base access is Phase B2).
  isSuperReceiver: () => false,

  // middleclass `class("Name", Parent)` — emits EXTENDS. middleclass has no
  // syntactic class body, so lexical heritage cannot produce these; the hook
  // re-parses for the class() call's parent arg.
  emitHeritageEdges: emitLuaHeritageEdges,

  // Lua has globals (`function foo()` is global) — let unresolved free calls
  // fall back to the global symbol table.
  allowGlobalFreeCallFallback: true,
};

export { luaScopeResolver };
