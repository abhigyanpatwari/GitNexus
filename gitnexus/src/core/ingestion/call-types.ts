// gitnexus/src/core/ingestion/call-types.ts

/**
 * Types for the language-agnostic call extraction pipeline.
 *
 * Mirrors method-types.ts / field-types.ts: defines the domain interfaces
 * consumed by createCallExtractor() and the per-language configs.
 */

import type { SupportedLanguages } from 'gitnexus-shared';
import type { SyntaxNode } from './utils/ast-helpers.js';
import type { MixedChainStep } from './utils/call-analysis.js';

// ---------------------------------------------------------------------------
// Extracted result
// ---------------------------------------------------------------------------

/**
 * Per-node call extraction result.  The parse worker enriches this with
 * file-level context (filePath, sourceId, TypeEnv lookups, arg types) to
 * produce the final `ExtractedCall` that enters the resolution pipeline.
 */
export interface ExtractedCallSite {
  calledName: string;
  callForm?: 'free' | 'member' | 'constructor';
  receiverName?: string;
  argCount?: number;
  /** Unified mixed chain for complex receivers (field + call chains). */
  receiverMixedChain?: MixedChainStep[];
  /** When true, the type-as-receiver heuristic applies: if receiverName
   *  starts with an uppercase letter and has no TypeEnv binding, treat it
   *  as a type name (e.g. Java `User::getName`). */
  typeAsReceiverHeuristic?: boolean;
}

// ---------------------------------------------------------------------------
// Extractor interface (produced by createCallExtractor)
// ---------------------------------------------------------------------------

export interface CallExtractor {
  readonly language: SupportedLanguages;
  /**
   * Extract a call site from captured AST nodes.
   *
   * @param callNode     The @call capture (call_expression, method_invocation, …)
   * @param callNameNode The @call.name capture (identifier inside the call).
   *                     May be undefined when the call shape has no name capture
   *                     (e.g. Java method_reference via `::`).
   * @returns Extracted call site, or null when no call can be derived.
   */
  extract(callNode: SyntaxNode, callNameNode: SyntaxNode | undefined): ExtractedCallSite | null;
}

// ---------------------------------------------------------------------------
// Config interface (one per language / language group)
// ---------------------------------------------------------------------------

export interface CallExtractionConfig {
  language: SupportedLanguages;

  /**
   * Language-specific call site extraction.  Called **before** the generic
   * path.  If it returns non-null, the generic `inferCallForm` /
   * `extractReceiverName` path is skipped entirely.
   *
   * Use this for call shapes that don't follow the standard `@call` /
   * `@call.name` pattern (e.g. Java `method_reference` via `::`).
   */
  extractLanguageCallSite?: (callNode: SyntaxNode) => ExtractedCallSite | null;

  /**
   * Whether the type-as-receiver heuristic applies for this language.
   * When true and the receiver name starts with an uppercase letter,
   * the receiver is treated as a type name when no TypeEnv binding exists.
   *
   * Applies to JVM and C# languages where `Type.method()` and `Type::method`
   * are common patterns.
   */
  typeAsReceiverHeuristic?: boolean;
}

// ---------------------------------------------------------------------------
// Call-resolution DAG types
// ---------------------------------------------------------------------------
//
// The call-resolution pipeline is a typed DAG:
//
//   extract-call  ──▶  classify-form  ──▶  infer-receiver  ──▶  select-dispatch  ──▶  resolve-target  ──▶  emit-edge
//
// Provider hooks plug in at infer-receiver and select-dispatch; shared stages
// stay language-agnostic. Stages 1-2 run in the parse worker; stages 3-6 run
// on the main thread. DAG-internal types below are main-thread-only and never
// serialize to the graph.

/**
 * DAG stage 3 output: call record with receiver type and source discriminant.
 *
 * `receiverTypeName` is resolved via TypeEnv → constructor-map → class-as-receiver →
 * mixed-chain, or synthesized by `inferImplicitReceiver`. `receiverSource` tags
 * which path won and drives MRO strategy selection in stage 4.
 *
 * Invariants:
 * - `receiverSource` MUST match how `receiverTypeName` was resolved; every
 *   discriminant must have a live reader and writer.
 * - `hint` is opaque to shared stages; only the same provider's `selectDispatch` reads it.
 *
 * @see language-provider.ts § inferImplicitReceiver, selectDispatch
 */
export interface ReceiverEnriched {
  readonly calledName: string;
  readonly callForm: 'free' | 'member' | 'constructor' | undefined;
  readonly receiverName: string | undefined;
  readonly receiverTypeName: string | undefined;
  readonly receiverSource:
    | 'none'
    | 'typed-binding'
    | 'constructor-map'
    | 'class-as-receiver'
    | 'mixed-chain'
    | 'implicit-self';
  /** Free-form hint from the provider hook; opaque to shared stages. */
  readonly hint?: string;
}

/**
 * Provider hook output for `LanguageProvider.inferImplicitReceiver` (DAG stage 3).
 *
 * Overlay applied to `ReceiverEnriched` when an implicit receiver is synthesized.
 * Ruby example: bare `serialize` inside `Account#call_serialize` →
 * `{ callForm: 'member', receiverName: 'self', receiverTypeName: 'Account',
 *   receiverSource: 'implicit-self', hint: 'instance' }`
 *
 * Invariants:
 * - `receiverSource` is always `'implicit-self'` — the only variant this type produces.
 * - `callForm` is always `'member'` — the rewrite converts bare-call to method invocation.
 * - `hint` is opaque to shared stages; consumed by the same language's `selectDispatch`.
 */
export interface ImplicitReceiverOverride {
  readonly callForm: 'free' | 'member' | 'constructor';
  readonly receiverName: string;
  readonly receiverTypeName: string;
  readonly receiverSource: Extract<ReceiverEnriched['receiverSource'], 'implicit-self'>;
  /** Free-form language tag (e.g. Ruby sets 'singleton' for `def self.foo`
   *  method bodies). Consumed by the same language's `selectDispatch` hook. */
  readonly hint?: string;
}

/**
 * DAG stage 4 output: dispatch strategy for resolving the target method.
 *
 * Encodes which resolver branch to try first and an optional fallback.
 * Stage 5 delegates to `resolveMemberCall`, `resolveFreeCall`, or
 * `resolveStaticCall` based on `primary`.
 *
 * - `primary`: `'owner-scoped'` = MRO walk, `'free'` = arity-tiered global lookup,
 *   `'constructor'` = type instantiation.
 * - `fallback`: Only `'free-arity-narrowed'` exists; used by Ruby implicit-self
 *   to degrade to arity-tiered free lookup when the MRO walk misses.
 * - `ancestryView`: Ruby `'ruby-mixin'` only. `'singleton'` walks extend providers
 *   only; a miss NEVER falls through to file-scoped lookup (enforced in
 *   resolveCallTarget). `'instance'` is the default.
 *
 * Common patterns:
 *   - `{primary: 'constructor'}` — constructor call
 *   - `{primary: 'owner-scoped'}` — member call with known type
 *   - `{primary: 'owner-scoped', fallback: 'free-arity-narrowed', ancestryView: 'instance'}` — Ruby implicit-self
 *   - `{primary: 'owner-scoped', ancestryView: 'singleton'}` — Ruby class-method call
 *
 * @see language-provider.ts § selectDispatch
 * @see call-processor.ts § defaultDispatchDecision, resolveCallTarget
 */
export interface DispatchDecision {
  readonly primary: 'owner-scoped' | 'free' | 'constructor';
  readonly fallback?: 'free-arity-narrowed';
  readonly ancestryView?: 'instance' | 'singleton';
  readonly hint?: string;
}
