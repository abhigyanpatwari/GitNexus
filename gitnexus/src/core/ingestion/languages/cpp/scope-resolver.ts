import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import {
  findClassBindingInScope,
  findEnclosingClassDef,
} from '../../scope-resolution/scope/walkers.js';
import { SupportedLanguages } from 'gitnexus-shared';
import { buildMro, defaultLinearize } from '../../scope-resolution/passes/mro.js';
import { populateClassOwnedMembers } from '../../scope-resolution/scope/walkers.js';
import type { ScopeResolver } from '../../scope-resolution/contract/scope-resolver.js';
import { cppProvider } from '../c-cpp.js';
import { cppArityCompatibility } from './arity.js';
import { cppMergeBindings } from './merge-bindings.js';
import { resolveCppImportTarget } from './import-target.js';
import { scanCppHeaderFiles } from './header-scan.js';
import {
  expandCppWildcardNames,
  isFileLocal,
  clearFileLocalNames,
  populateCppAnonymousNamespaceScopes,
  populateCppNonGloballyVisible,
  isCppDefGloballyVisible,
} from './file-local-linkage.js';
import {
  populateCppDependentBases,
  clearCppDependentBases,
  isCppDependentBaseMember,
} from './two-phase-lookup.js';
import { populateCppAssociatedNamespaces, clearCppAdlState, pickCppAdlCandidates } from './adl.js';
import {
  clearCppInlineNamespaces,
  populateCppInlineNamespaceScopes,
  resolveCppQualifiedNamespaceMember,
} from './inline-namespaces.js';
import { populateCppRangeBindings } from './range-bindings.js';

/**
 * C++ `ScopeResolver` registered in `SCOPE_RESOLVERS` and consumed by
 * the generic `runScopeResolution` orchestrator (RFC #909 Ring 3).
 *
 * C++ extends C's scope resolution with:
 *   - Namespaces (`namespace foo { ... }`)
 *   - Classes with methods and multiple inheritance
 *   - `using namespace` (wildcard import from namespace)
 *   - `using X::name` (named import from namespace)
 *   - Anonymous namespace (file-local linkage, like C `static`)
 *   - Default parameters (requiredParameterCount < parameterCount)
 *   - Overloading (arity-based disambiguation)
 *   - Templates (V1: generic-ignored, `List<User>` ≡ `List`)
 *   - Leftmost-base MRO for multiple inheritance
 */
export const cppScopeResolver: ScopeResolver = {
  language: SupportedLanguages.CPlusPlus,
  languageProvider: cppProvider,
  importEdgeReason: 'cpp-scope: include',

  loadResolutionConfig: (repoPath: string) => {
    // Clear stale per-pipeline state from any previous invocation.
    clearFileLocalNames();
    clearCppDependentBases();
    clearCppAdlState();
    clearCppInlineNamespaces();
    return scanCppHeaderFiles(repoPath);
  },

  resolveImportTarget: (targetRaw, fromFile, allFilePaths, resolutionConfig) => {
    // Augment allFilePaths with header files discovered via loadResolutionConfig.
    // C++ .h/.hpp/.hxx/.hh files may be classified differently by language
    // detection but are importable from .cpp files via #include.
    const headerPaths = resolutionConfig as ReadonlySet<string> | undefined;
    if (headerPaths !== undefined && headerPaths.size > 0) {
      const augmented = new Set(allFilePaths);
      for (const h of headerPaths) augmented.add(h);
      return resolveCppImportTarget(targetRaw, fromFile, augmented);
    }
    return resolveCppImportTarget(targetRaw, fromFile, allFilePaths);
  },

  expandsWildcardTo: (targetModuleScope, parsedFiles) =>
    expandCppWildcardNames(targetModuleScope, parsedFiles),

  mergeBindings: (existing, incoming, scopeId) => cppMergeBindings(existing, incoming, scopeId),

  // Adapter: cppArityCompatibility predates ScopeResolver and uses
  // (def, callsite). ScopeResolver contract is (callsite, def).
  arityCompatibility: (callsite, def) => cppArityCompatibility(def, callsite),

  buildMro: (graph, parsedFiles, nodeLookup) =>
    buildMro(graph, parsedFiles, nodeLookup, defaultLinearize),

  populateOwners: (parsed: ParsedFile) => {
    populateClassOwnedMembers(parsed);
    // Resolve inline- and anonymous-namespace ranges (recorded at capture
    // time) to ScopeIds BEFORE `populateCppNonGloballyVisible` runs, so
    // both exemptions see the populated Sets.
    populateCppInlineNamespaceScopes(parsed);
    populateCppAnonymousNamespaceScopes(parsed);
    // Track namespace-nested and class-nested defs so the global free-call
    // fallback and wildcard expansion can suppress them as unqualified
    // cross-file callables.
    populateCppNonGloballyVisible(parsed);
    // Build the class-def → enclosing-namespace-qualified-name map used
    // by ADL (U2 of plan 2026-05-13-001) to identify each argument type's
    // associated namespace for Koenig lookup.
    populateCppAssociatedNamespaces(parsed);
  },

  // Resolve recorded template-class → dependent-base simple names to
  // class nodeIds for two-phase template lookup (U3 of plan
  // 2026-05-13-001). Runs AFTER all files have had `populateOwners`
  // applied so that cross-file base classes (e.g. Base in base.h,
  // Derived in derived.h) are reachable in the workspace index.
  populateWorkspaceOwners: (parsedFiles: readonly ParsedFile[]) => {
    populateCppDependentBases(parsedFiles);
  },

  // Simple `isSuperReceiver` returns false for C++. Real super
  // classification is caller-context-dependent and lives in
  // `isSuperReceiverInContext` below — without scope context the
  // previous regex `/^[A-Z]\w*::/` misclassified namespace-qualified
  // calls (e.g., `Singleton::getInstance()`) as super calls and routed
  // them through the wrong resolution branch.
  isSuperReceiver: () => false,

  isSuperReceiverInContext: (text, callerScope, scopes) => {
    // The receiver text comes from the LHS of `::` in `qualified_identifier`
    // (e.g., for `Base<T>::method()`, text is `Base<T>`). Strip template
    // arguments (V1: name-only matching, generics ignored) and any leading
    // namespace qualifier so the lookup matches the bare class def's
    // simple name. `Base<T>::method()` → `Base`; `outer::v1::Base<T>` →
    // `Base`. This handles the Phase 5 cross-unit composition where
    // qualified base-method calls appear inside template bodies.
    let lhs = text;
    const sepIdx = lhs.indexOf('::');
    if (sepIdx > 0) lhs = lhs.slice(0, sepIdx).trim();
    // Strip trailing template-argument list (greedy: drop everything from
    // the first `<` onward — V1 ignores generics).
    const lt = lhs.indexOf('<');
    if (lt > 0) lhs = lhs.slice(0, lt).trim();
    // Strip nested namespace prefix from the receiver text itself (the
    // `outer::v1::Base` shape that appears in derived-list `base_class_clause`).
    const lastDoubleColon = lhs.lastIndexOf('::');
    if (lastDoubleColon >= 0) lhs = lhs.slice(lastDoubleColon + 2).trim();
    if (lhs.length === 0) return false;

    // Resolve the LHS in the caller's scope chain. Only class-like
    // resolutions can be super receivers; Namespace and unresolved
    // names are not super calls.
    const lhsDef = findClassBindingInScope(callerScope, lhs, scopes);
    if (lhsDef === undefined) return false;

    // The caller must have an enclosing class — super calls only make
    // sense inside a class body. Free functions can use `ClassName::`
    // for namespace-qualified calls but those are not super.
    const enclosing = findEnclosingClassDef(callerScope, scopes);
    if (enclosing === undefined) return false;

    // `lhsDef` must be in the caller's MRO (i.e., the caller's enclosing
    // class derives from it). The class itself counts as its own MRO
    // root — `Self::method()` is a qualified self-call, not a super
    // call, so exclude the caller's own class.
    if (lhsDef.nodeId === enclosing.nodeId) return false;
    const mro = scopes.methodDispatch.mroFor(enclosing.nodeId);
    return mro.includes(lhsDef.nodeId);
  },

  // C++ is statically typed — disable field fallback heuristic
  fieldFallbackOnMethodLookup: false,
  // C++ needs return type propagation across #include boundaries
  propagatesReturnTypesAcrossImports: true,
  // C++ #include brings in all symbols — enable global free call fallback
  allowGlobalFreeCallFallback: true,
  // Range-for element type inference: for (auto& user : users) → bind user to User
  populateRangeBindings: populateCppRangeBindings,
  // C++ method return-type bindings need to be visible from module scope
  // for cross-file propagation and compound-receiver chain resolution.
  // cppBindingScopeFor hoists @type-binding.return to Module scope.
  hoistTypeBindingsToModule: true,
  // Enable receiver-bound explicit-`this` fallback only for C++.
  resolveThisViaEnclosingClass: true,
  // The `isFileLocalDef` hook on the global free-call fallback names
  // file-local linkage historically, but semantically gates "logically
  // invisible cross-file" defs. C++ extends this to also reject class-
  // owned methods/fields and namespace-nested symbols — an unqualified
  // call from a free function MUST NOT resolve to `User::save` or
  // `ns::foo` (Cppreference, "Unqualified name lookup"). Without this
  // gate, the global fallback walks every callable in the workspace
  // registry and matches any class method or namespace function by
  // simple name.
  isFileLocalDef: (def: SymbolDefinition) => {
    const simple = def.qualifiedName?.split('.').pop() ?? def.qualifiedName ?? '';
    if (isFileLocal(def.filePath, simple)) return true;
    // Class-owned (Method/Field) — `populateClassOwnedMembers` already
    // stamps `ownerId`; cheap fast-path before consulting the scope map.
    if (def.ownerId !== undefined) return true;
    // Namespace-nested defs — require qualification cross-file. Scope-
    // walked at `populateOwners` time into a per-file nodeId set.
    if (!isCppDefGloballyVisible(def.filePath, def.nodeId)) return true;
    return false;
  },

  // C++ two-phase template lookup: inside a class template body,
  // unqualified calls MUST NOT bind to members of a dependent base
  // class. The standard requires `this->name()` or `Base<T>::name()`
  // forms to make the lookup dependent. Without this gate the global
  // free-call fallback walks the workspace registry and silently binds
  // unqualified calls to dependent-base members, producing CALLS edges
  // the compiler would reject. See plan 2026-05-13-001 U3.
  isCallableVisibleFromCaller: ({ candidate, callerScope, scopes }) => {
    if (callerScope === undefined || scopes === undefined) return true;
    // Reject when the candidate is a member of a dependent base of the
    // caller's enclosing template class. Otherwise allow.
    return !isCppDependentBaseMember(callerScope, candidate, scopes);
  },

  // C++ argument-dependent / Koenig lookup (U2 of plan 2026-05-13-001).
  // Contributes candidates from associated namespaces of class-typed
  // arguments; caller merges with ordinary unqualified lookup candidates.
  // Current boundary: class-typed value/pointer/reference args and template
  // specializations with explicit type arguments contribute associated
  // namespaces. Function-pointer args and full conversion-ranking remain
  // excluded.
  resolveAdlCandidates: (site, callerParsed, scopes, parsedFiles) => {
    // `using ns::name;` introduces `name` into ordinary unqualified lookup.
    // For template-class method bodies, lexical scope walks can miss this
    // named-using visibility; recover by resolving the imported namespace
    // member directly when the local call name matches a named using import.
    const usingNamedHits: SymbolDefinition[] = [];
    const seenUsing = new Set<string>();
    for (const imp of callerParsed.parsedImports) {
      if (imp.kind !== 'named') continue;
      if (imp.localName !== site.name) continue;
      const member = resolveCppQualifiedNamespaceMember(
        imp.targetRaw,
        imp.importedName,
        parsedFiles,
        scopes,
      );
      if (member === undefined) continue;
      if (seenUsing.has(member.nodeId)) continue;
      seenUsing.add(member.nodeId);
      usingNamedHits.push(member);
    }
    const adlHits = pickCppAdlCandidates(site, callerParsed, scopes, parsedFiles);
    if (usingNamedHits.length === 0) return adlHits;
    if (adlHits === undefined || adlHits.length === 0) return usingNamedHits;
    const merged: SymbolDefinition[] = [];
    const seen = new Set<string>();
    for (const hit of usingNamedHits) {
      seen.add(hit.nodeId);
      merged.push(hit);
    }
    for (const hit of adlHits) {
      if (seen.has(hit.nodeId)) continue;
      seen.add(hit.nodeId);
      merged.push(hit);
    }
    return merged;
  },

  // C++ qualified namespace-member resolution (U5 of plan 2026-05-13-001).
  // Handles `outer::foo()` where `outer` is a namespace (not a class).
  // Walks each parsed file's namespace scopes by simple name, then
  // descends transitively through inline-namespace children when
  // searching for the called member. Returns undefined for non-namespace
  // receivers so receiver-bound-calls Case 2 still gets a chance.
  resolveQualifiedReceiverMember: (receiverName, memberName, _callerScope, scopes, parsedFiles) =>
    resolveCppQualifiedNamespaceMember(receiverName, memberName, parsedFiles, scopes),
};
