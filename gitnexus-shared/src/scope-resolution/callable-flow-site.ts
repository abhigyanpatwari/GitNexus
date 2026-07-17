/**
 * Always-on callable-value-flow facts produced during scope extraction.
 *
 * These records deliberately contain no parser nodes or provider-private
 * objects: they cross the worker, disk-cache, and ParsedFile-store boundaries.
 * Language providers recognize syntax and emit `@callable-flow.*` captures;
 * the central extractor attaches lexical scope ids and materializes this
 * language-neutral representation.
 */

import type { ParameterTypeClass } from './symbol-definition.js';
import type { Range, ScopeId } from './types.js';

/** A lexical binding or abstract indirection cell used by a flow fact. */
export interface CallableFlowOperand {
  /** Provider-normalized lexical binding name. */
  readonly name: string;
  readonly inScope: ScopeId;
  readonly atRange: Range;
  /** Number of dereference operators applied at this occurrence. */
  readonly indirection: number;
  /** Whether this occurrence explicitly takes the binding's address. */
  readonly addressOf: boolean;
  /**
   * Provider-normalized expression role. `binding` is the conservative
   * default; the other variants prove the occurrence denotes a callable
   * designator rather than a value produced by an expression.
   */
  readonly expressionKind?:
    | 'binding'
    | 'callable-designator'
    | 'bound-member'
    | 'anonymous-callable';
  /** Qualified spelling retained for receiver/member-aware lookup. */
  readonly qualifiedName?: string;
}

/** Callable shape used to disambiguate overload sets when syntax supplies it. */
export interface CallableFlowExpectedSignature {
  readonly parameterCount?: number;
  readonly parameterTypes?: readonly string[];
  readonly parameterTypeClasses?: readonly ParameterTypeClass[];
  /** C++ member-function cv qualifier when the declarator supplies it. */
  readonly isConst?: boolean;
}

// 'pointer' is currently behaviorally identical to 'value' in the solver
// (only 'reference' back-propagates); it stays in the union as C/C++
// provenance. A 'callable-object' passing mode had no producer and was
// dropped (#2522 review) — the invocation-kind 'callable-object' below is a
// different, live concept.
export type CallableFlowPassingMode = 'value' | 'reference' | 'pointer';

export interface CallableFlowSeedSite {
  readonly kind: 'seed';
  readonly destination: CallableFlowOperand;
  /** Simple callable name used for lexical lookup. */
  readonly targetName: string;
  /** Optional provider-normalized qualified spelling (for example `Base.method`). */
  readonly targetQualifiedName?: string;
  readonly targetRange: Range;
  readonly expectedSignature?: CallableFlowExpectedSignature;
}

export interface CallableFlowCopySite {
  readonly kind: 'copy';
  readonly source: CallableFlowOperand;
  readonly destination: CallableFlowOperand;
}

/** True identity (for example a C++ reference), modelled bidirectionally. */
export interface CallableFlowAliasSite {
  readonly kind: 'alias';
  readonly source: CallableFlowOperand;
  readonly destination: CallableFlowOperand;
}

/** `destination` receives the abstract address of `source`. */
export interface CallableFlowAddressSite {
  readonly kind: 'address';
  readonly source: CallableFlowOperand;
  readonly destination: CallableFlowOperand;
}

/** Targets in `source` flow into every abstract cell reached by `pointer`. */
export interface CallableFlowStoreSite {
  readonly kind: 'store';
  readonly source: CallableFlowOperand;
  readonly pointer: CallableFlowOperand;
}

/** Targets in every abstract cell reached by `pointer` flow into `destination`. */
export interface CallableFlowLoadSite {
  readonly kind: 'load';
  readonly pointer: CallableFlowOperand;
  readonly destination: CallableFlowOperand;
}

/** Maps a callable definition's parameter position to its lexical binding. */
export interface CallableFlowFormalSite {
  readonly kind: 'formal';
  readonly ownerName: string;
  readonly ownerRange: Range;
  readonly parameterIndex: number;
  readonly binding: CallableFlowOperand;
  readonly passingMode: CallableFlowPassingMode;
  readonly expectedSignature?: CallableFlowExpectedSignature;
}

/** Maps one real call-site argument position to its source operand. */
export interface CallableFlowArgumentSite {
  readonly kind: 'argument';
  readonly callSite: Range;
  readonly parameterIndex: number;
  readonly source: CallableFlowOperand;
  /** Direct callee spelling used when an earlier resolver already emitted the edge. */
  readonly directCalleeName?: string;
}

export type CallableFlowInvocationKind = 'indirect' | 'member-pointer' | 'callable-object';

/** A syntactically indirect invocation owned by callable-value-flow. */
export interface CallableFlowInvokeSite {
  readonly kind: 'invoke';
  readonly callSite: Range;
  readonly inScope: ScopeId;
  readonly callee: CallableFlowOperand;
  readonly receiver?: CallableFlowOperand;
  readonly invocationKind: CallableFlowInvocationKind;
  readonly arity?: number;
}

export type CallableFlowSite =
  | CallableFlowSeedSite
  | CallableFlowCopySite
  | CallableFlowAliasSite
  | CallableFlowAddressSite
  | CallableFlowStoreSite
  | CallableFlowLoadSite
  | CallableFlowFormalSite
  | CallableFlowArgumentSite
  | CallableFlowInvokeSite;
