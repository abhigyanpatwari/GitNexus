/**
 * Normalized compiler facts for Move.
 *
 * `move-flow` is the authoritative source for package/module/function facts.
 * This module keeps the raw MCP shapes in one place and exposes a stable,
 * parsed representation that downstream projections can consume without
 * re-querying move-flow or reparsing signatures independently.
 */

export interface MoveFlowConstant {
  name: string;
  type: string;
  value: string;
}

export type CallGraphMap = Record<string, string[]>;

// ─────────────────────────────────────────────────────────────────────────
// move-flow `facts` query — full-fidelity, compiler-sourced per-module facts.
//
// Shape mirrors the live `move_package_query { query: "facts" }` response.
// These types are the source of truth for the thin facts→graph mapper; the
// `facts` query is the ONLY ingestion path — move-flow builds without it are
// rejected by the ingest phase's hard-require gate.
// ─────────────────────────────────────────────────────────────────────────

/** A generic type parameter as reported by the facts query. */
export interface MoveFactsTypeParam {
  name: string;
  abilities: string[];
  isPhantom: boolean;
}

/** A struct field or enum-variant field. */
export interface MoveFactsField {
  /** Field name, or the positional index (`"0"`, `"1"`, …) for positional fields. */
  name: string;
  type: string;
  positional: boolean;
}

/**
 * A parsed attribute. Recursive shape: nested `args` and assignment `value`s
 * are serialized (keys absent when none/empty, per serde skip rules). Examples:
 *   `{ name: "view" }`
 *   `{ name: "lint::skip", args: [{ name: "needless_bool" }] }`
 *   `{ name: "resource_group_member", args: [{ name: "group", value: "0xa::vault::Group" }] }`
 */
export interface MoveFactsAttribute {
  name: string;
  /** Assignment value, e.g. `group = "0xa::vault::Group"` -> `"0xa::vault::Group"`. */
  value?: string;
  /** Nested attribute arguments (recursive). */
  args?: MoveFactsAttribute[];
  [key: string]: unknown;
}

/** A `friend` declaration target. */
export interface MoveFactsFriend {
  module: string;
}

/** One enum variant. */
export interface MoveFactsVariant {
  name: string;
  kind: 'unit' | 'positional' | 'named';
  fields: MoveFactsField[];
  attributes: MoveFactsAttribute[];
}

/** AST-derived resource access for a function. Every value is a
 *  fully-qualified type expression such as `"0xa::vault::Holding"`
 *  (lowercase, non-zero-padded hex addresses). */
export interface MoveFactsResourceAccess {
  reads: string[];
  writes: string[];
}

/** A function as reported by the facts query. */
export interface MoveFactsFunction {
  name: string;
  file?: string;
  span?: [number, number];
  visibility: 'public' | 'friend' | 'internal' | 'package' | string;
  isEntry: boolean;
  isInline: boolean;
  isNative: boolean;
  isView: boolean;
  attributes?: MoveFactsAttribute[];
  typeParams?: MoveFactsTypeParam[];
  params?: { name: string; type: string }[];
  /**
   * Return types, one entry per tuple element: `[]` for no return, one entry
   * for a scalar, N entries for a tuple.
   */
  returnTypes: string[];
  /** Fully-qualified resource names the function acquires (e.g. `0xa::coin::CoinStore`). */
  acquiresInferred?: string[];
  resourceAccess?: MoveFactsResourceAccess;
  /** Compiler-synthesized lambda-lifted function. */
  isLambdaLifted?: boolean;
  /** Host function's local name for lambda-lifted functions (resolved through
   *  nested closures by move-flow). */
  definedIn?: string;
}

/**
 * A struct or enum as reported by the facts query. move-flow groups both under
 * the module's `structs` array and distinguishes them by `kind`.
 */
export interface MoveFactsType {
  kind: 'struct' | 'enum';
  name: string;
  file?: string;
  span?: [number, number];
  abilities: string[];
  typeParams: MoveFactsTypeParam[];
  /** Present for structs. */
  fields?: MoveFactsField[];
  /** Present for enums. */
  variants?: MoveFactsVariant[];
  attributes: MoveFactsAttribute[];
}

/** Per-module facts. */
export interface MoveFactsModule {
  file?: string;
  span?: [number, number];
  friends?: MoveFactsFriend[];
  attributes?: MoveFactsAttribute[];
  functions?: MoveFactsFunction[];
  /** Structs *and* enums (each tagged by `kind`), per the facts `structs` key. */
  structs?: MoveFactsType[];
  constants?: MoveFlowConstant[];
}

/** The full facts query response: qualified module name → facts. */
export type MoveFactsMap = Record<string, MoveFactsModule>;
