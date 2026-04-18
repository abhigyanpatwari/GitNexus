/**
 * Scope-resolution type definitions — RFC §2 data model (authoritative source).
 *
 * See: https://www.notion.so/346dc50b6ed281cfaacbe480bf231d50
 *
 * Anti-drift rule: every type, interface, and enum defined here is the single
 * source of truth. Later code that references these names must import them
 * from `gitnexus-shared`; it must not re-define them locally.
 *
 * Lifecycle contract (RFC §2.8): scopes are **constructed during extraction,
 * linked during finalize, immutable after finalize**. All fields are
 * `readonly` at the type level; `Object.freeze` is applied at runtime in dev
 * builds. `ReferenceIndex` is the sole structure populated after freeze — by
 * resolution, before emission.
 */

import type { NodeLabel } from '../graph/types.js';
import type { SymbolDefinition } from './symbol-definition.js';

// ─── §2.1 Type aliases ──────────────────────────────────────────────────────

/** Stable per-(file, range, kind) scope identifier; interned for identity-fast equality. */
export type ScopeId = string;

/** Stable symbol-definition identifier (graph nodeId). */
export type DefId = string;

/** Kinds of lexical scope a `Scope` node can represent. */
export type ScopeKind =
  | 'Module' // file root
  | 'Namespace' // C++ namespace, C# namespace, Kotlin package-object, Rust mod
  | 'Class' // class/struct/trait/interface body
  | 'Function' // function/method/closure/lambda body
  | 'Block' // { ... }, if-body, for-body, with-body, match arms
  | 'Expression'; // comprehensions, for-init, pattern bindings, lambda param lists

// ─── Range + Capture (parser-agnostic) ──────────────────────────────────────

/** Source-text range. 1-based `startLine`/`endLine`; 0-based `startCol`/`endCol`. */
export interface Range {
  readonly startLine: number;
  readonly startCol: number;
  readonly endLine: number;
  readonly endCol: number;
}

/**
 * Tagged capture emitted by a LanguageProvider's `emitScopeCaptures` hook.
 *
 * Parser-agnostic: tree-sitter queries and COBOL's regex tagger both produce
 * `Capture[]`. The central `ScopeExtractor` consumes captures without
 * knowing which parser produced them.
 */
export interface Capture {
  /** Capture name, including leading `@` (e.g., `'@scope.module'`, `'@declaration.class'`). */
  readonly name: string;
  readonly range: Range;
  /** The captured source text. */
  readonly text: string;
}

/**
 * A grouping of `Capture`s that came from a single query match (e.g., one
 * `@import.statement` match carries `@import.source`, `@import.name`,
 * `@import.alias?` as child captures). Keyed by capture name for O(1)
 * child access.
 */
export type CaptureMatch = Readonly<Record<string, Capture>>;

// ─── Hook input/output types (RFC §5.2) ─────────────────────────────────────

/**
 * Provider-interpreted raw import, consumed by finalize (Phase 2) to produce
 * linked `ImportEdge[]`. The provider's `interpretImport` hook turns a
 * `CaptureMatch` for an `@import.statement` into one of these; the central
 * finalize algorithm resolves `targetRaw` to a concrete file via
 * `resolveImportTarget` and materializes the final `ImportEdge`.
 *
 * Discriminated union — each variant carries only the fields that make sense
 * for its kind. Invalid shapes (e.g., a `namespace` import with an alias-like
 * `importedName` mismatch) are compile errors, not latent bugs. `'wildcard-
 * expanded'` is deliberately NOT a variant: that kind is finalize output only,
 * produced when `expandsWildcardTo` materializes a wildcard against target
 * exports — a provider must never emit it at parse time.
 */
export type ParsedImport =
  /**
   * Per-name import without rename.
   *
   * Examples:
   *   - Python `from foo import X`   → `{ kind: 'named', localName: 'X', importedName: 'X', targetRaw: 'foo' }`
   *   - TS `import { X } from './foo'` → `{ kind: 'named', localName: 'X', importedName: 'X', targetRaw: './foo' }`
   *   - Java `import foo.bar.X`       → `{ kind: 'named', localName: 'X', importedName: 'X', targetRaw: 'foo.bar' }`
   */
  | {
      readonly kind: 'named';
      readonly localName: string;
      readonly importedName: string;
      readonly targetRaw: string;
    }
  /**
   * Per-name import with rename.
   *
   * Examples:
   *   - Python `from foo import X as Y`   → `{ kind: 'alias', localName: 'Y', importedName: 'X', alias: 'Y', targetRaw: 'foo' }`
   *   - TS `import { X as Y } from './foo'` → `{ kind: 'alias', localName: 'Y', importedName: 'X', alias: 'Y', targetRaw: './foo' }`
   */
  | {
      readonly kind: 'alias';
      readonly localName: string;
      readonly importedName: string;
      readonly alias: string;
      readonly targetRaw: string;
    }
  /**
   * Qualified module handle, with or without rename. `importedName` is the
   * module being aliased; `localName` is the scope-visible handle (often the
   * same unless renamed).
   *
   * Examples:
   *   - Python `import numpy`            → `{ kind: 'namespace', localName: 'numpy', importedName: 'numpy', targetRaw: 'numpy' }`
   *   - Python `import numpy as np`      → `{ kind: 'namespace', localName: 'np',    importedName: 'numpy', targetRaw: 'numpy' }`
   *   - TS `import * as np from 'numpy'` → `{ kind: 'namespace', localName: 'np',    importedName: 'numpy', targetRaw: 'numpy' }`
   *   - Go `import foo "pkg/bar"`        → `{ kind: 'namespace', localName: 'foo',   importedName: 'bar',   targetRaw: 'pkg/bar' }`
   */
  | {
      readonly kind: 'namespace';
      /** Scope-visible handle (e.g. `np` in `import numpy as np`; `numpy` when unaliased). */
      readonly localName: string;
      /** Module being aliased (e.g. `numpy` in `import numpy as np`). */
      readonly importedName: string;
      readonly targetRaw: string;
    }
  /**
   * Syntactically-detectable parse-time re-export. Finalize may still produce
   * `ImportEdge { kind: 'reexport', transitiveVia }` when flattening chains;
   * this variant preserves the *parse-time* signal so finalize doesn't have
   * to re-derive it from scratch.
   *
   * Examples:
   *   - TS `export { X } from './y'`       → `{ kind: 'reexport', localName: 'X', importedName: 'X', targetRaw: './y' }`
   *   - TS `export { X as Y } from './y'`  → `{ kind: 'reexport', localName: 'Y', importedName: 'X', alias: 'Y', targetRaw: './y' }`
   *   - Rust `pub use foo::bar`            → `{ kind: 'reexport', localName: 'bar', importedName: 'bar', targetRaw: 'foo' }`
   */
  | {
      readonly kind: 'reexport';
      /** Name as re-exported in the current module. */
      readonly localName: string;
      /** Name in the source module. */
      readonly importedName: string;
      readonly targetRaw: string;
      /** Set when the re-export renames the symbol (e.g. `export { X as Y } from './y'`). */
      readonly alias?: string;
    }
  /**
   * Wildcard import — brings every exported name from the target module into
   * the importing scope. The finalize algorithm expands this into one
   * `BindingRef` per exported name via the provider's `expandsWildcardTo`
   * hook, producing the finalize-only `ImportEdge` kind `'wildcard-expanded'`.
   *
   * Examples:
   *   - Python `from foo import *`   → `{ kind: 'wildcard', targetRaw: 'foo' }`
   *   - JS `export * from './foo'`   → `{ kind: 'wildcard', targetRaw: './foo' }`
   *   - Rust `pub use foo::*`         → `{ kind: 'wildcard', targetRaw: 'foo' }`
   */
  | {
      readonly kind: 'wildcard';
      readonly targetRaw: string;
    }
  /**
   * Runtime-computed target — the import path is not a static literal at
   * parse time. Providers SHOULD emit the unresolvable expression's source
   * text as `targetRaw` to aid diagnostics; `null` only when no string form
   * exists.
   *
   * Examples:
   *   - JS `await import(expr)`                          → `{ kind: 'dynamic-unresolved', localName: '', targetRaw: 'expr' }`
   *   - Python `importlib.import_module(f'pkg.{name}')`  → `{ kind: 'dynamic-unresolved', localName: '', targetRaw: "f'pkg.{name}'" }`
   */
  | {
      readonly kind: 'dynamic-unresolved';
      readonly localName: string;
      /** Source text of the unresolved expression when available; `null` otherwise. */
      readonly targetRaw: string | null;
    };

/**
 * Provider-interpreted type binding. The provider's `interpretTypeBinding`
 * hook turns a `CaptureMatch` (e.g., `@type-binding.parameter`) into one of
 * these; the central extractor attaches the resulting `TypeRef` to the
 * appropriate scope's `typeBindings` map.
 */
export interface ParsedTypeBinding {
  /** The name being bound (parameter name, `self`, assignment LHS, …). */
  readonly boundName: string;
  /** The raw type name as written in source (`'User'`, `'models.User'`, …). */
  readonly rawTypeName: string;
  readonly source: TypeRef['source'];
}

/**
 * Cross-file workspace index consumed by finalize-phase hooks
 * (`resolveImportTarget`, `expandsWildcardTo`). Opaque placeholder in Ring 1;
 * concretely typed in Ring 2 SHARED (#915).
 */
export type WorkspaceIndex = unknown;

// `ScopeTree` is exported from `./scope-tree.js` as of Ring 2 SHARED (#912).
// The former opaque placeholder lived here during Ring 1; removed now that
// the concrete type exists. Consumers import from `gitnexus-shared` directly.

/** Call-site description passed to `arityCompatibility`. */
export interface Callsite {
  /** Number of arguments at the call site. */
  readonly arity: number;
}

// ─── §2.4 ImportEdge ────────────────────────────────────────────────────────

/**
 * A cross-file import edge attached to a module/namespace scope.
 *
 * Raw (unlinked) edges are emitted during parse (Phase 1); `targetModuleScope`
 * and `targetDefId` are filled in during finalize (Phase 2) via SCC-aware
 * bounded-fixpoint linking (RFC §3.2).
 */
export interface ImportEdge {
  /** How this scope sees the imported name (after alias). */
  readonly localName: string;
  /** Exporting file; `null` only when `kind === 'dynamic-unresolved'`. */
  readonly targetFile: string | null;
  /** The name under which the target exports this symbol. */
  readonly targetExportedName: string;
  /** Pre-resolved at finalize: the module scope of the exporting file. */
  readonly targetModuleScope?: ScopeId;
  /** Pre-resolved at finalize: the exported symbol's `DefId`. */
  readonly targetDefId?: DefId;
  readonly kind:
    | 'named'
    | 'alias'
    | 'namespace'
    | 'wildcard-expanded'
    | 'reexport'
    | 'dynamic-unresolved';
  /** Re-export chain, for provenance (e.g., `['./y']` when re-exported via `./y`). */
  readonly transitiveVia?: readonly string[];
  /** Set to `'unresolved'` when the SCC fixpoint could not link this edge. */
  readonly linkStatus?: 'unresolved';
}

// ─── §2.3 BindingRef ────────────────────────────────────────────────────────

/**
 * A name binding visible at a scope, with provenance.
 *
 * Provenance stays at the visibility layer — a name being visible because it
 * is local vs imported vs wildcard-expanded vs re-exported is a property of
 * the binding itself. This keeps evidence emission and `import-use` reference
 * stamping first-class instead of reconstructing provenance from a side table.
 */
export interface BindingRef {
  readonly def: SymbolDefinition;
  readonly origin: 'local' | 'import' | 'namespace' | 'wildcard' | 'reexport';
  /** Non-null for non-local origins; carries the `ImportEdge` that brought the name into this scope. */
  readonly via?: ImportEdge;
}

// ─── §2.5 TypeRef ───────────────────────────────────────────────────────────

/**
 * A reference to a named type, anchored at its declaration site.
 *
 * Design choice: raw name + declaration-site scope, resolved at lookup time.
 * Pre-resolution would invert the extraction/resolution wall. Deferred thunks
 * add no capability. Structured type systems are months of work per language.
 * This shape keeps V1 tractable while preserving correctness for aliases,
 * re-exports, and nested modules. Generics deferred to V2 via `typeArgs`.
 */
export interface TypeRef {
  /** The name as written in source (e.g., `'User'`, `'models.User'`, `'List'`). */
  readonly rawName: string;
  /** Anchor for resolving `rawName` — the scope where the annotation/inference was written. */
  readonly declaredAtScope: ScopeId;
  readonly source:
    | 'annotation'
    | 'parameter-annotation'
    | 'return-annotation'
    | 'self'
    | 'assignment-inferred'
    | 'constructor-inferred'
    | 'receiver-propagated';
  /** Reserved for V2+: generic type arguments (`List<User>` → `[TypeRef('User')]`). V1 ignores. */
  readonly typeArgs?: readonly TypeRef[];
}

// ─── §2.2 Scope ─────────────────────────────────────────────────────────────

/**
 * The canonical lexical-scope node. Forms the spine of the SemanticModel.
 *
 * ScopeId shape (RFC §2.2): `scope:{filePath}#{startLine}:{startCol}-{endLine}:{endCol}:{kind}`
 * — deterministic, stable across reparses of the same source, interned.
 */
export interface Scope {
  readonly id: ScopeId;
  readonly parent: ScopeId | null;
  readonly kind: ScopeKind;
  readonly range: Range;
  readonly filePath: string;

  /** Names visible from this scope. Provenance preserved via `BindingRef.origin`. */
  readonly bindings: ReadonlyMap<string, readonly BindingRef[]>;

  /** Defs structurally owned by this scope (e.g., methods owned by a class body scope). */
  readonly ownedDefs: readonly SymbolDefinition[];

  /** Import edges attached to this scope. Mostly module/namespace scopes, but some
   *  languages allow local imports (Python `def f(): from x import Y`, Rust
   *  fn-local `use`, TS dynamic `import()`). */
  readonly imports: readonly ImportEdge[];

  /** Local type facts visible from this scope (parameter annotations, `self` binding, etc.). */
  readonly typeBindings: ReadonlyMap<string, TypeRef>;
}

// ─── §2.6 Resolution + ResolutionEvidence ───────────────────────────────────

/**
 * One piece of evidence for a `Resolution`. Multiple signals corroborate a
 * single match; their weights compose additively to produce `confidence`.
 *
 * Weights come from `EvidenceWeights` (see `./evidence-weights.ts`).
 */
export interface ResolutionEvidence {
  readonly kind:
    | 'local'
    | 'scope-chain'
    | 'import'
    | 'type-binding'
    | 'owner-match'
    | 'kind-match'
    | 'arity-match'
    | 'global-name'
    | 'global-qualified'
    | 'dynamic-import-unresolved';
  /** Signal weight, sourced from `EvidenceWeights`. Additive; sum capped at 1.0. */
  readonly weight: number;
  /** Optional debug annotation (e.g., `'matched via self: User'`). */
  readonly note?: string;
}

/**
 * A ranked resolution candidate returned by `ClassRegistry.lookup` /
 * `MethodRegistry.lookup` / `FieldRegistry.lookup`. Evidence composes
 * additively; callers read `[0]` for the one-shot answer or inspect the
 * evidence trace for debugging.
 */
export interface Resolution {
  readonly def: SymbolDefinition;
  /** Σ of `evidence[].weight`, capped at 1.0. */
  readonly confidence: number;
  readonly evidence: readonly ResolutionEvidence[];
  /** Optional debug trace: scopes walked to reach `def`. */
  readonly path?: readonly ScopeId[];
}

// ─── §2.7 Reference + ReferenceIndex ────────────────────────────────────────

/**
 * A post-resolution usage fact: some code at `atRange` inside `fromScope`
 * references `toDef` with the given confidence/evidence. Materialized by the
 * resolution phase; emitted as graph edges (`CALLS`/`READS`/`WRITES`/etc.)
 * during the emit phase.
 */
export interface Reference {
  /** Innermost lexical scope containing `atRange`. */
  readonly fromScope: ScopeId;
  readonly toDef: DefId;
  /** Location of the reference in source. */
  readonly atRange: Range;
  readonly kind: 'call' | 'read' | 'write' | 'type-reference' | 'inherits' | 'import-use';
  readonly confidence: number;
  readonly evidence: readonly ResolutionEvidence[];
}

/**
 * Two-way index over `Reference` records, populated during the resolution
 * phase. Scopes stay immutable after finalize; references accumulate here.
 */
export interface ReferenceIndex {
  readonly bySourceScope: ReadonlyMap<ScopeId, readonly Reference[]>;
  readonly byTargetDef: ReadonlyMap<DefId, readonly Reference[]>;
}

// ─── §4.1 LookupParams ──────────────────────────────────────────────────────

/**
 * Opaque placeholder for the per-kind registry passed as the owner-scoped
 * contributor. Typed concretely in Ring 2 SHARED (#917); kept as `unknown`
 * here so Ring 1 can ship without pulling in the registry implementation.
 */
export type RegistryContributor = unknown;

/**
 * Parameters accepted by `Registry.lookup`. Three registries (Class/Method/
 * Field) run the same 7-step algorithm with different parameter tuples; see
 * RFC §4.4 for per-registry specializations.
 */
export interface LookupParams {
  readonly acceptedKinds: readonly NodeLabel[];
  /** Class lookups: false. Method/Field lookups: true. */
  readonly useReceiverTypeBinding: boolean;
  readonly ownerScopedContributor: RegistryContributor | null;
  /** Optional arity hint fed to `provider.arityCompatibility`. */
  readonly arityHint?: number;
  /** Explicit receiver name (e.g., `'user'` in `user.save()`). When present,
   *  the receiver's type binding at the callsite scope is used; otherwise
   *  the enclosing method's implicit `self`/`this` is consulted. See §4.1. */
  readonly explicitReceiver?: { readonly name: string };
}
