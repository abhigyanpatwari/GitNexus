/**
 * Receiver-bound CALLS / ACCESSES emit pass — generic 8-case
 * dispatcher consuming `ScopeResolver` for the language-specific bits
 * (super recognizer, field-fallback toggle).
 *
 * **Contract Invariant I4 — case order is load-bearing.** The cases
 * are evaluated in this order; the FIRST that emits an edge wins:
 *
 *   1. **super branch** — `provider.isSuperReceiver(receiverName)` →
 *      MRO walk skipping self
 *   2. **Case 0 (compound)** — receiver has `.` or `(` → compound resolver.
 *      Also emits the interface-dispatch fan-out when the folded receiver type
 *      is an Interface (#2829) — see Case 4, which does the same.
 *   3. **Case 0.5 (implicit `this` receiver)** — GATED: fires only when
 *      the language sets `resolveThisViaEnclosingClass === true` AND the
 *      receiver is literally `this` → enclosing-class + MRO chain walk
 *      with C++ member-name-hiding semantics. Languages that leave the
 *      toggle unset skip this case entirely; their `this` sites fall
 *      through to Case 4 via the synthesized `this` typeBinding (which
 *      emits the interface-dispatch fan-out that this case does not —
 *      as do Cases 0 since #2829 and 3b since #2832; Case 0.5 remains
 *      the only fold-or-walk case without it).
 *   4. **Case 1 (namespace)** — receiver in `namespaceTargets` → exported def
 *   5. **Case 2 (class-name / static receiver)** — receiver resolves to a
 *      class-like binding (Class/Interface/Struct/Record/Enum/Trait) → MRO
 *      walk on that class. Also handles static-style invocations
 *      (`ILogger.Warn(...)`) with kind-aware reason/confidence for
 *      read/write ACCESSES.
 *   6. **Case 3 (dotted typeBinding for namespace prefix)** —
 *      `typeRef.rawName` like `models.User`
 *   7. **Case 3b (chain-typebinding)** — `typeRef.rawName` has a dot
 *      but not a namespace prefix → compound resolver. Also emits the
 *      interface-dispatch fan-out when the folded receiver type is an
 *      Interface (#2832) — same call Cases 0 and 4 make.
 *   8. **Case 4 (simple typeBinding)** — `typeRef.rawName` has no dot →
 *      MRO walk + `findOwnedMember`
 *   9. **Case 5 (value-receiver bridge)** — receiver is a `Const`/`Variable`
 *      whose `nodeId` is referenced as an `ownerId` in `model.methods`
 *      (object-literal services). Last-resort fallback for lowercase
 *      receivers with no class-like or type-binding match. Mirrors
 *      the legacy DAG bridge in `call-processor.ts`.
 *  10. **Case 6 (class-level member receiver)** — `Holder.repo.save(u)`,
 *      where the receiver's head is a CLASS and the one hop past it is a
 *      class-level (`isStatic`) field. Types the receiver from that field
 *      DEF's declared type rather than from a `typeBindings` entry, which
 *      is the thing a per-scope binding map cannot hold for a class that
 *      declares both a static and an instance member of one name. Gated on
 *      Case 0 having declined the same receiver, so it only ever adds an
 *      edge where there was none. Emits the interface-dispatch fan-out
 *      alongside Cases 0, 3b and 4.
 *
 * Reordering or merging cases changes resolution semantics.
 *
 * **Contract Invariant I5 — pre-seeding `seen` is forbidden.** The
 * orchestrator runs this pass FIRST (before `emitReferencesViaLookup`)
 * and consumes the populated `handledSites` set. Pre-seeding `seen`
 * from the shared resolver's emissions (an old optimization) actively
 * suppresses correct emissions for sites the shared resolver also
 * resolved to a wrong target.
 */

import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { SemanticModel } from '../../model/semantic-model.js';
import type { ScopeResolver } from '../contract/scope-resolver.js';
import type { GraphNodeLookup } from '../graph-bridge/node-lookup.js';
import type { WorkspaceResolutionIndex } from '../workspace-index.js';
import { collectNamespaceTargets } from '../scope/namespace-targets.js';
import {
  bindsTypeParameter,
  findClassBindingInScope,
  findEnclosingClassDef,
  isReceiverOwnedButUnbound,
  findExportedDef,
  findOwnedMember,
  findReceiverTypeBinding,
  findValueBindingInScope,
  isClassLike,
  isNamespaceNameShadowed,
  type DecorationStripper,
  resolveClassBindingForName,
} from '../scope/walkers.js';
import {
  tryEmitEdge,
  tryEmitEdgeWithExplicitTargetId,
  type CalleeIdCaptureCtx,
} from '../graph-bridge/edges.js';
import type { CalleeIdSink } from '../graph-bridge/callee-id-sink.js';
import {
  resolveCompoundReceiverClass,
  resolveCompoundReceiverTyped,
} from '../passes/compound-receiver.js';
import { erasedTypeApplication, typeApplicationArguments } from '../../utils/template-arguments.js';
import {
  heritageTypeArgumentsKey,
  stepHeritageInstantiation,
  type GroundedTypeArgument,
  type HeritageTypeArguments,
} from '../utils/generic-instantiation.js';
import { resolveDefGraphId } from '../graph-bridge/ids.js';
import {
  narrowOverloadCandidates,
  isOverloadAmbiguousAfterNormalization,
} from './overload-narrowing.js';
import type {
  ResolutionOutcomeRecorder,
  ResolutionSuppressionReason,
} from '../resolution-outcome.js';
import { classifyReceiverShape } from '../resolution-outcome.js';
import type { ReceiverOrigin } from '../resolution-outcome.js';
import { decodeReceiverChain } from '../../utils/receiver-chain-codec.js';
import type { DecodedReceiverChain } from '../../utils/receiver-chain-codec.js';

/** Subset of `ScopeResolver` consumed by this pass. Accepting the
 *  subset rather than the full provider keeps tests and partial
 *  refactors lighter — callers only need to populate what we read. */
type ReceiverBoundProviderSubset = Pick<
  ScopeResolver,
  | 'isSuperReceiver'
  | 'isSuperReceiverInContext'
  | 'fieldFallbackOnMethodLookup'
  | 'collapseMemberCallsByCallerTarget'
  | 'elementTypeOf'
  | 'hoistTypeBindingsToModule'
  | 'stripReceiverCastExpressions'
  | 'constructionSyntax'
  | 'stripTypePreservingDecoration'
  | 'resolveQualifiedReceiverMember'
  | 'namespaceReceiverPaths'
  | 'resolveReceiverMember'
  | 'resolveThisViaEnclosingClass'
  | 'conversionRankFn'
  | 'conversionOnlyArgTypePrefixes'
  | 'constraintCompatibility'
  | 'isStaticOnly'
  | 'normalizeTypeArgument'
>;

/** A bare, undecorated identifier and nothing else — see {@link isBareTypeName}. */
const BARE_TYPE_NAME_RE = /^[A-Za-z_$][\w$]*$/;

/**
 * A type name a built-in test may be asked about: a bare, undecorated
 * identifier and nothing else.
 *
 * `Promise<User>`, `[]Repo` and `Option<Repo>` all name a built-in CONTAINER
 * whose ELEMENT is very often in-program, and an await/index/unwrap step is
 * exactly how a receiver chain reaches that element. Answering "external"
 * because the outer spelling matched a built-in would relabel a real in-program
 * drop, which is the failure this whole function exists to stop. A decorated or
 * dotted spelling is likewise not a built-in name, it merely contains one.
 */
function isBareTypeName(rawName: string): boolean {
  return BARE_TYPE_NAME_RE.test(rawName);
}

/**
 * Is this dropped receiver rooted inside the analyzed program?
 *
 * Asks of the receiver's BASE — the leftmost name the chain hangs off — what
 * this index can DEMONSTRATE. Three answers, and the asymmetry between them is
 * the whole point:
 *
 * - `in-program` — the base's declared type resolves here, or the base itself is
 *   a class, a qualified name, or a value this program declares. A real edge was
 *   lost; the hedge must fire.
 * - `external` — POSITIVE evidence that the target is outside: the language
 *   itself names the base (or its bare declared type) a built-in. `console.log`,
 *   `fetch(...)`, `JSON.stringify` reach code no index contains, so there is no
 *   node an edge could have pointed at and nothing was lost.
 * - `unknown` — everything else. An absence of evidence is NOT evidence of
 *   externality: an unannotated parameter (`function f(svc) { svc.a().b(); }`)
 *   is recorded nowhere in the scope model at all, and calling that "external"
 *   published `epistemic: 'exact'` over a genuinely missing in-program caller —
 *   strictly worse than hedging, because it is a confident wrong answer rather
 *   than an admitted gap. `unknown` counts WITH `in-program` in
 *   `summarizeUnresolvedReceivers`, which is the safe direction.
 *
 * Uses the AST-derived chain base when one was minted, and falls back to the
 * head of the receiver text otherwise — never a regex over the source line.
 *
 * Exported for the unit tests that pin the three-way split; the pass is its only
 * production caller.
 */
export function classifyReceiverOrigin(
  decoded: DecodedReceiverChain | undefined,
  inScope: string,
  receiverName: string,
  scopes: ScopeResolutionIndexes,
  options: {
    /** The language's type-preserving decoration stripper. Without it a Go
     *  pointer receiver — `func (h *Host)` binds `h` to the literal `*Host` —
     *  resolves to no class and the whole method body's drops were reported as
     *  external. Same hook the three receiver-chain lookups in
     *  `compound-receiver.ts` already receive. */
    readonly stripTypePreservingDecoration?: DecorationStripper;
    /** `LanguageProvider.isBuiltInName`, threaded through the pass options the
     *  same way `emitFreeCallFallback` receives it. THE only source of positive
     *  external evidence available here; languages that declare no built-in set
     *  simply never produce an `external` verdict, which is the safe default. */
    readonly isBuiltInName?: (name: string) => boolean;
  } = {},
): ReceiverOrigin {
  // The chain's base is authoritative. Without one, take the head of the
  // receiver text up to the first member/call punctuation.
  const base = decoded?.baseReceiverName ?? /^[A-Za-z_$][\w$]*/.exec(receiverName)?.[0];
  if (base === undefined || base.length === 0) return 'unknown';
  const strip = options.stripTypePreservingDecoration;
  const isBuiltIn = options.isBuiltInName;

  // The base's declared TYPE, when it has one, is the strongest signal about
  // where the member lives: `inputs.stream()` has an in-program base bound to
  // `List<String>`, whose `stream` is in the JDK.
  const binding = findReceiverTypeBinding(inScope, base, scopes);
  if (binding !== undefined) {
    // `resolveClassBindingForName`, not a bare lookup: it also strips template
    // arguments, so an in-program generic base (`Box<String> b; b.open()`)
    // resolves instead of being mislabelled and dropped from the hedge.
    if (
      resolveClassBindingForName(binding.declaredAtScope, binding.rawName, scopes, strip) !==
      undefined
    ) {
      return 'in-program';
    }
    // The declared type is not one this index contains. That is only proof of
    // externality when the language itself names it — otherwise the type merely
    // failed to resolve (an alias, an inferred callable, a generic parameter),
    // and we fall through to ask what the index knows about the base itself.
    if (isBareTypeName(binding.rawName) && isBuiltIn?.(binding.rawName) === true) {
      return 'external';
    }
  }
  // Anything else this index knows by that name (namespace, module, free fn).
  // O(1), so it goes ahead of the scope-chain walks below: all three checks are
  // arms of the same `in-program` disjunction and none has a side effect, so
  // answering from the index first is free and changes no verdict.
  if (scopes.qualifiedNames.has(base)) return 'in-program';
  // A type the program declares, used as a static receiver.
  if (findClassBindingInScope(inScope, base, scopes, strip) !== undefined) return 'in-program';
  // A VALUE the program declares — an object-literal service, a local whose
  // initializer we could not type (`const loc = makeIt(); loc.getUser().save()`),
  // a field. The type channel had nothing usable to say about these, but the
  // program demonstrably declares the name, so the lost edge is in-program and
  // failing to type it is a resolver defect. This is the channel Case 5 already
  // dispatches on; consulting it here keeps the diagnostic honest about the
  // same population.
  if (findValueBindingInScope(inScope, base, scopes) !== undefined) return 'in-program';

  // Positive external evidence, and the only kind reachable from this pass.
  if (isBuiltIn?.(base) === true) return 'external';

  return 'unknown';
}

/**
 * Upper bound on how many implementors ONE interface member may fan out to at a
 * single call site (#2829).
 *
 * Mirrors `MAX_PROPERTY_DISPATCH_FANOUT` in `property-dispatch.ts`, deliberately
 * including its reporting half: a bare cap would silently discard valid dispatch
 * targets, which is the same false-safe silence #2813 was filed about. The
 * default matches that sibling's 32 — the fan-out is a per-call-site product, so
 * an interface with hundreds of implementors (mock proliferation is the usual
 * cause) multiplies the graph without adding information a reader can act on.
 *
 * Override with `GITNEXUS_MAX_INTERFACE_DISPATCH_FANOUT` for a repo with
 * legitimately high implementor counts.
 */
export const MAX_INTERFACE_DISPATCH_FANOUT = (() => {
  const env = Number(process.env.GITNEXUS_MAX_INTERFACE_DISPATCH_FANOUT);
  return Number.isInteger(env) && env >= 1 ? env : 32;
})();

/** Bound on the sample of over-cap interface members kept for the warning. */
const MAX_REPORTED_SKIPPED_INTERFACES = 20;

/** What `emitReceiverBoundCalls` reports back to the orchestrator. */
export interface ReceiverBoundResult {
  /** CALLS/ACCESSES edges emitted by this pass. */
  readonly emitted: number;
  /** Dispatch targets DROPPED because a member exceeded the fan-out cap. */
  readonly dispatchFanoutSkipped: number;
  /** Bounded sample naming which interface members lost targets. */
  readonly dispatchFanoutSkippedNames: readonly string[];
}

export function emitReceiverBoundCalls(
  graph: KnowledgeGraph,
  scopes: ScopeResolutionIndexes,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
  handledSites: Set<string>,
  provider: ReceiverBoundProviderSubset,
  index: WorkspaceResolutionIndex,
  model: SemanticModel,
  options: {
    readonly recordResolutionOutcome?: ResolutionOutcomeRecorder;
    /** Resolved-callee-id capture sink (#2227 U2). Threaded in under `--pdg`
     *  OR for callable-flow's direct-target index (#2437, position-filtered);
     *  `undefined` ⇒ zero overhead, byte-identity (R4). Per-file capture
     *  contexts are built from this + `parsed.filePath` in the loop. */
    readonly calleeIdSink?: CalleeIdSink;
    /** `LanguageProvider.isBuiltInName`. Passed through the options bag rather
     *  than widened into `ReceiverBoundProviderSubset`, mirroring how
     *  `emitFreeCallFallback` receives the same hook — the subset exists to keep
     *  test providers small, and this pass reads nothing else off the language
     *  provider. Consumed ONLY by `classifyReceiverOrigin`, so leaving it unset
     *  degrades a drop's label to `unknown` (the safe direction) and changes no
     *  edge. */
    readonly isBuiltInName?: (name: string) => boolean;
    /** The generic arguments each heritage clause instantiated its base with,
     *  from the passes that emitted those heritage edges — the inheritance
     *  pre-pass, and the language resolvers that emit their own (Rust `impl T
     *  for S`, Dart `implements` / `with`) (#2912). Read
     *  ONLY by the interface-dispatch fan-out, to refuse an implementor of an
     *  incompatible instantiation. Absent ⇒ every heritage instantiation reads
     *  as unknown ⇒ the pre-#2912 fan-out, unchanged. */
    readonly heritageTypeArguments?: HeritageTypeArguments;
  } = {},
): ReceiverBoundResult {
  let emitted = 0;
  let dispatchFanoutSkipped = 0;
  const dispatchFanoutSkippedNames: string[] = [];
  // Per-pass dedup so the multiple cases don't double-emit if two of
  // them resolve the same site to the same target. NEVER pre-seed
  // from the reference index — see Contract Invariant I5.
  const seen = new Set<string>();
  const fieldFallback = provider.fieldFallbackOnMethodLookup ?? true;
  const collapse = provider.collapseMemberCallsByCallerTarget === true;
  const hoistTypeBindingsToModule = provider.hoistTypeBindingsToModule === true;
  const compoundOpts = {
    fieldFallback,
    elementTypeOf: provider.elementTypeOf,
    hoistTypeBindingsToModule,
    stripReceiverCastExpressions: provider.stripReceiverCastExpressions === true,
    constructionSyntax: provider.constructionSyntax,
    stripTypePreservingDecoration: provider.stripTypePreservingDecoration,
    resolveThisViaEnclosingClass: provider.resolveThisViaEnclosingClass,
  };
  // Loop-invariant: both hooks come off the pass arguments, so the options bag
  // for `classifyReceiverOrigin` is built once here rather than per dropped site.
  const receiverOriginOpts = {
    stripTypePreservingDecoration: provider.stripTypePreservingDecoration,
    isBuiltInName: options.isBuiltInName,
  };

  // Maps class-like graph ids back to ALL scope definitions that resolved to
  // them. Same-file partial declarations share one graph id but keep distinct
  // DefIds, and `pickOverload` keys member lookup by those DefIds. Preserving
  // every part makes dispatch independent of declaration order.
  const graphIdToClassDefs = new Map<string, SymbolDefinition[]>();
  // The same correspondence read the other way, so the dispatch walk can name a
  // heritage EDGE (which is keyed by graph ids) from the two DEFS it holds.
  const classGraphIdByDefId = new Map<string, string>();
  /**
   * Does THIS language record generic type parameters (#2912)?
   *
   * `SymbolDefinition.typeParameters` is absent both for a non-generic
   * declaration and for every declaration in a language whose captures do not
   * emit `@declaration.type-parameters`, and instantiation filtering needs the
   * two told apart: in the second case a heritage argument `T` is a type
   * VARIABLE that would otherwise read as a concrete type named "T", and
   * `class Box<T> : IValidator<T>` would be pruned out of every instantiation.
   *
   * Evidence rather than a declared capability, because the evidence is exactly
   * as good and costs nothing: one run resolves one language (`phase.ts` loops
   * per language), so a single generic declaration anywhere in it proves the
   * captures record parameters. A run where none exists cannot be harmed by the
   * answer — with no generic declaration there is no type variable to mistake.
   */
  let languageCapturesTypeParameters = false;
  for (const parsed of parsedFiles) {
    for (const def of parsed.localDefs) {
      if (!isClassLike(def.type)) continue;
      const graphId = resolveDefGraphId(parsed.filePath, def, nodeLookup);
      if (graphId === undefined) continue;
      let defs = graphIdToClassDefs.get(graphId);
      if (defs === undefined) {
        defs = [];
        graphIdToClassDefs.set(graphId, defs);
      }
      defs.push(def);
      classGraphIdByDefId.set(def.nodeId, graphId);
      if (def.typeParameters !== undefined && def.typeParameters.length > 0) {
        languageCapturesTypeParameters = true;
      }
    }
  }
  // Direct subtypes of a type, keyed by the SUPERtype's def id.
  //
  // Built from IMPLEMENTS **and** EXTENDS (#2829). IMPLEMENTS alone is not the
  // set of implementations: `preEmitInheritanceEdges` classifies heritage by the
  // TARGET's kind, so `interface B extends A` is stored as `B IMPLEMENTS A` and
  // an INTERFACE lands in A's list; and a concrete class reaches its interface
  // through `class C extends AbstractBase` (EXTENDS) + `AbstractBase implements
  // I` (IMPLEMENTS), so it is two hops away and invisible to a depth-1 walk.
  // Both shapes previously ended the fan-out on a bodiless declaration while the
  // only executable target got no edge at all.
  const subtypesBySupertypeDefId = new Map<string, SymbolDefinition[]>();
  const addSubtype = (superId: string, sub: SymbolDefinition): void => {
    let list = subtypesBySupertypeDefId.get(superId);
    if (list === undefined) {
      list = [];
      subtypesBySupertypeDefId.set(superId, list);
    }
    list.push(sub);
  };
  for (const relType of ['IMPLEMENTS', 'EXTENDS'] as const) {
    for (const rel of graph.iterRelationshipsByType(relType)) {
      const superDefs = graphIdToClassDefs.get(rel.targetId);
      const subDefs = graphIdToClassDefs.get(rel.sourceId);
      if (superDefs === undefined || subDefs === undefined) continue;
      for (const superDef of superDefs) {
        for (const subDef of subDefs) addSubtype(superDef.nodeId, subDef);
      }
    }
  }

  /**
   * Is this member a bodiless DECLARATION rather than an implementation?
   *
   * An interface method, and an `abstract` method on an abstract base, are
   * both declarations: dispatching to them names something with no body while
   * the executable target sits further down the hierarchy. `isAbstract` lives
   * on the graph NODE (the structure phase sets it), not on `SymbolDefinition`,
   * so this resolves the def to its node. A def that cannot be resolved is
   * treated as NOT abstract — the fail-open direction, matching how the rest of
   * this pass treats an unresolvable lookup.
   */
  const isDeclarationOnly = (def: SymbolDefinition): boolean => {
    const graphId = resolveDefGraphId(def.filePath, def, nodeLookup);
    if (graphId === undefined) return false;
    return graph.getNode(graphId)?.properties.isAbstract === true;
  };

  /**
   * Can an INSTANCE-typed receiver reach this member? A static member cannot be,
   * ever — `class C implements I { static save() {} }` does not satisfy `I`
   * (TypeScript rejects it outright as TS2420, "Property 'save' is missing"), so
   * an edge to it from an `I`-typed receiver names a target no dispatch can
   * produce. Every comparable tool draws the same line: tsserver partitions
   * static from instance results, clangd gates on `isVirtual()` (C++ forbids
   * virtual statics), jdtls filters abstract-or-static, and class-hierarchy
   * analysis expands only VIRTUAL call sites — a static call already has exactly
   * one target and needs no fan-out.
   *
   * Two sources answer this, and the order matters:
   *
   *   1. `provider.isStaticOnly` when the language declares it. It is the
   *      precise answer, because a language that needs the distinction defines
   *      it exactly — Kotlin marks only COMPANION-promoted defs, so a Kotlin
   *      `object Impl : Iface { override fun handle() }` is correctly kept: an
   *      `object` is a singleton INSTANCE and its members really are reachable
   *      through an `Iface`-typed receiver.
   *   2. Otherwise the graph node's `isStatic`. For every language that does not
   *      declare the hook, that flag comes from the member's own modifier (or,
   *      for Ruby, from `singleton_class` — `def self.foo`, which is likewise
   *      unreachable through an instance), so it means what we need here.
   *
   * Getting that order wrong is a live regression, not a hypothetical: the
   * method extractor derives `isStatic` from the OWNER type as well as the
   * member (`method-extractors/generic.ts`, `staticOwnerTypes`), and the JVM
   * config lists `object_declaration`. Reading the flag first would delete
   * Kotlin object implementations from the fan-out. A language that needs
   * precision declares the hook; that is the upgrade path.
   *
   * Unresolvable defs fail open (treated as reachable), matching
   * `isDeclarationOnly` and the rest of this pass.
   */
  const isUnreachableByInstanceDispatch = (def: SymbolDefinition): boolean => {
    const staticOnly = provider.isStaticOnly;
    if (staticOnly !== undefined) return staticOnly(def) === true;
    const graphId = resolveDefGraphId(def.filePath, def, nodeLookup);
    if (graphId === undefined) return false;
    return graph.getNode(graphId)?.properties.isStatic === true;
  };

  /**
   * What does this written type argument NAME, as seen from `scopeId` (#2912)?
   *
   * The scope is load-bearing: a heritage argument is resolved from the
   * declaring class's own scope and a receiver argument from the call site's,
   * because a name means what it means where it was WRITTEN. Resolving both
   * makes `Models.User` and an imported `User` one type, which a string
   * comparison could only get wrong.
   *
   * Neither answer is an error: a name that binds nothing and is not built in
   * comes back ungrounded, which the matcher reads as "unknown" and keeps.
   *
   * A TYPE PARAMETER is reported as such rather than left to the ungrounded
   * path, because `resolveClassBindingForName` answers a bounded one with its
   * BOUND's declaration — grounded, and the wrong thing to compare.
   */
  const groundTypeArgument = (name: string, scopeId: string | undefined): GroundedTypeArgument => {
    const def =
      scopeId === undefined ? undefined : resolveClassBindingForName(scopeId, name, scopes);
    return {
      ...(def !== undefined ? { definitionId: def.nodeId } : {}),
      builtIn: options.isBuiltInName?.(name) === true,
      ...(scopeId !== undefined && bindsTypeParameter(scopeId, name, scopes)
        ? { typeVariable: true }
        : {}),
    };
  };

  /**
   * Emit secondary CALLS edges with reason='interface-dispatch' when the primary
   * receiver-typed edge targeted an Interface's method.
   *
   * Walks the SUBTYPE CLOSURE of the interface rather than its direct
   * implementors (#2829). Two shapes made the depth-1 walk both wrong and
   * incomplete, each reproduced in plain Java:
   *
   *   interface ReadCloser extends Reader { int read(String p); }   // re-declares
   *   abstract class AbstractHandler implements Handler { public abstract void handle(String s); }
   *
   * In both, the depth-1 list contains a type whose `read`/`handle` is a bodiless
   * declaration, so the fan-out emitted an edge to *that* — while the only class
   * with a body (`FileRC`, `RealHandler`) is one hop further down and received
   * nothing at all. Descending and skipping declarations fixes both directions
   * at once: the wrong edge disappears and the real implementation gains one.
   *
   * Descent continues THROUGH a type that supplied a concrete member, because an
   * override further down is an equally real runtime target — dispatch is an
   * over-approximation by design, and stopping early would silently prefer the
   * base.
   *
   * The closure is walked carrying the receiver's generic INSTANTIATION (#2912).
   * `IValidator<string>` and `IValidator<int>` are one declaration and therefore
   * one subtype list, so without the substitution a `IValidator<string>` call
   * reaches `IntValidator.Check(int)` — a target no dispatch can produce. Each
   * hop unifies the arguments the subtype wrote against the ones the supertype
   * is known to hold; an incompatible hop is skipped BEFORE the visit is
   * recorded, so a type reachable by a second, compatible path still gets its
   * edge, and skipped WITHOUT descending, because its own subtypes inherit the
   * mismatch.
   * Every uncertainty keeps the target — see `generic-instantiation.ts`.
   */
  const emitInterfaceDispatchFor = (
    ownerDef: SymbolDefinition,
    memberName: string,
    primaryMemberDef: SymbolDefinition,
    site: ParsedFile['referenceSites'][number],
    confidence: number,
    calleeCapture: CalleeIdCaptureCtx | undefined,
    /** The receiver's declared type AS WRITTEN (`IValidator<string>`), or
     *  `undefined` where the case could not recover it — which restores the
     *  unfiltered fan-out for that site rather than guessing.
     *
     *  The SPELLING rather than the parsed arguments, so the parse happens after
     *  the two gates below rather than at every resolved receiver site: all five
     *  cases call this unconditionally, and the overwhelming majority of
     *  receivers are concrete classes that return at the first line. */
    receiverTypeSpelling: string | undefined,
  ): number => {
    if (ownerDef.type !== 'Interface') return 0;
    if (subtypesBySupertypeDefId.get(ownerDef.nodeId) === undefined) return 0;
    const receiverTypeArguments =
      receiverTypeSpelling === undefined
        ? undefined
        : typeApplicationArguments(receiverTypeSpelling);
    // Captures only `site`, so it is built once per SITE rather than once per
    // subtype visited. Its partner below cannot be: it is keyed by the subtype.
    const resolveSupertypeArgument = (name: string): GroundedTypeArgument =>
      groundTypeArgument(name, site.inScope);

    // Collect concrete targets across the closure first, so the cap below counts
    // real dispatch targets rather than types visited. Source-written owners
    // rank ahead of synthesized owners so a large anonymous implementation
    // family cannot consume the whole budget. Within each group, the priority
    // counts concrete implementations already encountered on the path: the
    // first implementation under an abstract branch ranks ahead of deeper
    // overrides. Carrying that count through this existing walk avoids a reverse
    // traversal per target at every call site.
    type DispatchTarget = {
      readonly member: SymbolDefinition;
      readonly syntheticOwnerPriority: number;
      readonly ancestorImplementationCount: number;
      readonly discoveryOrder: number;
    };
    type DispatchTraversal = {
      readonly typeId: string;
      readonly ancestorImplementationCount: number;
      /** The instantiation this type is known to hold ON THIS PATH (#2912), or
       *  `undefined` where it is not known — which restores the unfiltered
       *  fan-out for the subtree below it rather than guessing. */
      readonly typeArguments: readonly string[] | undefined;
    };
    const targetByMemberId = new Map<string, DispatchTarget>();
    const bestIncomingCount = new Map<string, number>([[ownerDef.nodeId, 0]]);
    const queue: DispatchTraversal[] = [
      {
        typeId: ownerDef.nodeId,
        ancestorImplementationCount: 0,
        typeArguments: receiverTypeArguments,
      },
    ];
    let head = 0;
    let discoveryOrder = 0;
    while (head < queue.length) {
      const current = queue[head++]!;
      // The whole instantiation apparatus hangs off ONE question: is the
      // supertype's own instantiation known? It is not for a non-generic
      // receiver, nor for any language that captures no heritage arguments, so
      // those walks skip every lookup below and emit exactly what they did
      // before #2912.
      const superGraphId =
        current.typeArguments === undefined ? undefined : classGraphIdByDefId.get(current.typeId);
      for (const subDef of subtypesBySupertypeDefId.get(current.typeId) ?? []) {
        const previousIncomingCount = bestIncomingCount.get(subDef.nodeId);
        if (
          previousIncomingCount !== undefined &&
          previousIncomingCount <= current.ancestorImplementationCount
        ) {
          continue;
        }

        // What THIS heritage clause instantiated its base with. `superGraphId`
        // already answers "is the supertype's instantiation known?", so it gates
        // the whole lookup once instead of being re-asked at each step below.
        let subtypeArguments: readonly string[] | undefined;
        if (superGraphId !== undefined) {
          const subGraphId = classGraphIdByDefId.get(subDef.nodeId);
          const heritageArguments =
            subGraphId === undefined
              ? undefined
              : options.heritageTypeArguments?.get(
                  heritageTypeArgumentsKey(subGraphId, superGraphId),
                );
          if (heritageArguments !== undefined) {
            const subtypeScopeId = index.classScopeByDefId.get(subDef.nodeId)?.id;
            const step = stepHeritageInstantiation({
              supertypeArguments: current.typeArguments,
              heritageArguments,
              subtypeParameters: subDef.typeParameters,
              // The "this subtype declares parameters" disjunct an earlier
              // revision carried here could never decide: `subDef` comes out of
              // the same loop that sets this flag, from exactly these defs, so a
              // subtype with parameters has already set it.
              subtypeParametersComplete: languageCapturesTypeParameters,
              resolveSupertypeArgument,
              resolveHeritageArgument: (name) => groundTypeArgument(name, subtypeScopeId),
              normalize: provider.normalizeTypeArgument,
            });
            // Skipped BEFORE the visit is recorded, so a type reachable by a
            // second, compatible path still gets its edge; and without
            // descending, because its own subtypes inherit the mismatch.
            if (!step.compatible) continue;
            subtypeArguments = step.subtypeArguments;
          }
        }

        bestIncomingCount.set(subDef.nodeId, current.ancestorImplementationCount);

        const implMember = pickOverload(subDef.nodeId, memberName, site, model, provider);
        let descendantImplementationCount = current.ancestorImplementationCount;
        if (
          implMember !== undefined &&
          implMember !== OVERLOAD_AMBIGUOUS &&
          implMember.isDeleted !== true &&
          implMember.nodeId !== primaryMemberDef.nodeId &&
          !isDeclarationOnly(implMember) &&
          !isUnreachableByInstanceDispatch(implMember)
        ) {
          const existing = targetByMemberId.get(implMember.nodeId);
          const syntheticOwnerPriority = subDef.isSynthetic === true ? 1 : 0;
          if (
            existing === undefined ||
            syntheticOwnerPriority < existing.syntheticOwnerPriority ||
            (syntheticOwnerPriority === existing.syntheticOwnerPriority &&
              current.ancestorImplementationCount < existing.ancestorImplementationCount)
          ) {
            targetByMemberId.set(implMember.nodeId, {
              member: implMember,
              syntheticOwnerPriority,
              ancestorImplementationCount: current.ancestorImplementationCount,
              discoveryOrder: existing?.discoveryOrder ?? discoveryOrder++,
            });
          }
          descendantImplementationCount++;
        }
        queue.push({
          typeId: subDef.nodeId,
          ancestorImplementationCount: descendantImplementationCount,
          typeArguments: subtypeArguments,
        });
      }
    }

    const targets = [...targetByMemberId.values()]
      .sort(
        (left, right) =>
          left.syntheticOwnerPriority - right.syntheticOwnerPriority ||
          left.ancestorImplementationCount - right.ancestorImplementationCount ||
          left.discoveryOrder - right.discoveryOrder,
      )
      .map((target) => target.member);

    // Bounded, and NEVER silently (#2829). An interface with a very large
    // implementor set multiplies edges by every call site — Go, TypeScript and
    // Kotlin do not set `collapseMemberCallsByCallerTarget`, so the product is
    // per SITE. Truncating without saying so would recreate the false-safe
    // silence this whole issue is about, which is why the sibling
    // `MAX_PROPERTY_DISPATCH_FANOUT` reports its dropped keys too.
    if (targets.length > MAX_INTERFACE_DISPATCH_FANOUT) {
      dispatchFanoutSkipped += targets.length - MAX_INTERFACE_DISPATCH_FANOUT;
      if (dispatchFanoutSkippedNames.length < MAX_REPORTED_SKIPPED_INTERFACES) {
        const dropped = targets
          .slice(MAX_INTERFACE_DISPATCH_FANOUT, MAX_INTERFACE_DISPATCH_FANOUT + 5)
          .map((target) => target.qualifiedName ?? target.nodeId);
        const omitted = targets.length - MAX_INTERFACE_DISPATCH_FANOUT - dropped.length;
        dispatchFanoutSkippedNames.push(
          `${ownerDef.qualifiedName ?? ownerDef.nodeId}.${memberName} (${targets.length} targets; ` +
            `dropped: ${dropped.join(', ')}${omitted > 0 ? `, +${omitted} more` : ''})`,
        );
      }
      targets.length = MAX_INTERFACE_DISPATCH_FANOUT;
    }

    let n = 0;
    for (const implMember of targets) {
      const ok = tryEmitEdge(
        graph,
        scopes,
        nodeLookup,
        site,
        implMember,
        'interface-dispatch',
        seen,
        confidence,
        collapse,
        calleeCapture,
      );
      if (ok) n++;
    }
    return n;
  };

  /**
   * Declared type of the CLASS-LEVEL field named `fieldName` on `ownerId`, or
   * `undefined` when the owner declares no such field, declares only an
   * instance one, or declares one whose type was never captured.
   *
   * Both facts live on the graph NODE rather than on `SymbolDefinition` —
   * `isStatic` is set by the structure phase and `declaredType` by the field
   * extractor — which is the same place {@link isUnreachableByInstanceDispatch}
   * reads `isStatic` from, so this introduces no new dependency.
   *
   * `isStatic === true` is required, not merely preferred. The receiver that
   * asks this question resolved its head to the CLASS, so an instance field of
   * that name is not reachable through it and answering with the instance
   * field's type would type the receiver as something the source cannot
   * denote. A def that resolves to no node, or a node with no captured type,
   * answers `undefined` — the declining direction, matching how the rest of
   * this pass treats an unresolvable lookup.
   */
  const declaredTypeOfClassLevelField = (
    ownerId: string,
    fieldName: string,
  ): string | undefined => {
    for (const candidate of model.fields.lookupAllByOwner(ownerId, fieldName)) {
      const graphId = resolveDefGraphId(candidate.filePath, candidate, nodeLookup);
      if (graphId === undefined) continue;
      const properties = graph.getNode(graphId)?.properties;
      if (properties?.isStatic !== true) continue;
      const declaredType = properties.declaredType;
      if (typeof declaredType !== 'string') continue;
      const trimmed = declaredType.trim();
      if (trimmed.length === 0) continue;
      return trimmed;
    }
    return undefined;
  };

  for (const parsed of parsedFiles) {
    const namespaceTargets = collectNamespaceTargets(parsed, scopes, {
      receiverPaths: provider.namespaceReceiverPaths,
      moduleFileExists: (filePath) => index.moduleScopeByFile.has(filePath),
    });
    const fileCompoundOpts = { ...compoundOpts, namespaceTargets };
    // Per-file resolved-callee-id capture context (#2227 U2). Built once per
    // file; `undefined` when the sink is absent (pdg off) so the `tryEmitEdge`
    // capture is a no-op and emission stays byte-identical (R4).
    const calleeCapture: CalleeIdCaptureCtx | undefined =
      options.calleeIdSink !== undefined
        ? { sink: options.calleeIdSink, filePath: parsed.filePath }
        : undefined;

    for (const site of parsed.referenceSites) {
      if (site.kind !== 'call' && site.kind !== 'read' && site.kind !== 'write') continue;
      if (site.explicitReceiver === undefined) continue;

      const receiverName = site.explicitReceiver.name;
      const memberName = site.name;
      const siteKey = `${parsed.filePath}:${site.atRange.startLine}:${site.atRange.startCol}`;

      // ── owned-but-unbound receiver ───────────────────────────────
      // The language declared this scope REBINDS the receiver and gave
      // it no type — a JS/TS ordinary `function`, whose `this` comes
      // from the call site (#2701). No enclosing type can be its type,
      // so this is a definitive negative, not a miss: suppress the site
      // instead of letting the receiver-blind lexical fallback in
      // `lookupCore` match the enclosing class's member by name.
      // No-op for every language that leaves `Scope.ownsReceivers` unset.
      if (isReceiverOwnedButUnbound(site.inScope, receiverName, scopes)) {
        options.recordResolutionOutcome?.({
          kind: 'suppressed',
          phase: 'receiver-bound-calls',
          filePath: parsed.filePath,
          name: site.name,
          range: site.atRange,
          reason: 'receiver-owned-but-unbound',
          candidateIds: [],
        });
        handledSites.add(siteKey);
        continue;
      }

      // ── super branch ─────────────────────────────────────────────
      // Languages with caller-context-dependent super classification
      // (C++) define `isSuperReceiverInContext`; we prefer it. Simple
      // text-only languages (Python, Java, PHP) use the plain hook.
      const isSuper =
        provider.isSuperReceiverInContext !== undefined
          ? provider.isSuperReceiverInContext(receiverName, site.inScope, scopes)
          : provider.isSuperReceiver(receiverName);
      if (isSuper) {
        const enclosingClass = findEnclosingClassDef(site.inScope, scopes);
        if (enclosingClass !== undefined) {
          // For super-receiver dispatch (`parent::`, `base.`, `super()`),
          // walk the inheritance-only ancestor chain when the language
          // exposes it. PHP's `parent::` semantically bypasses composed
          // traits; other languages without mixin augmentation have no
          // `extendsOnlyMroFor` and fall back to `mroFor`.
          const extendsOnly = scopes.methodDispatch.extendsOnlyMroFor;
          const ancestors =
            extendsOnly !== undefined
              ? extendsOnly(enclosingClass.nodeId)
              : scopes.methodDispatch.mroFor(enclosingClass.nodeId);
          let memberDef: SymbolDefinition | undefined;
          let ambiguousOwnerId: string | undefined;
          for (const ownerId of ancestors) {
            const picked =
              site.kind === 'call'
                ? pickOverload(ownerId, memberName, site, model, provider)
                : findOwnedMember(ownerId, memberName, model);
            if (picked === OVERLOAD_AMBIGUOUS) {
              ambiguousOwnerId = ownerId;
              break;
            }
            if (picked !== undefined) {
              memberDef = picked;
              break;
            }
          }
          if (ambiguousOwnerId !== undefined) {
            recordReceiverOverloadSuppression(
              options.recordResolutionOutcome,
              parsed.filePath,
              site,
              ambiguousOwnerId,
              memberName,
              model,
              provider,
            );
            handledSites.add(siteKey);
            continue;
          }
          if (memberDef !== undefined) {
            if (
              suppressDeletedCallTarget(
                options.recordResolutionOutcome,
                parsed.filePath,
                site,
                memberDef,
              )
            ) {
              handledSites.add(siteKey);
              continue;
            }
            // Super/base calls resolve through the MRO chain, not
            // through imports — the ancestor method is found by
            // walking `methodDispatch.mroFor(enclosingClass)`, which
            // is independent of whether a `using` / `import` directive
            // brought the ancestor into scope. We emit the canonical
            // `'global'` tier (ARCHITECTURE.md § Scope-Resolution
            // Pipeline — edge vocabulary).
            //
            // Known legacy-path asymmetry: the C# legacy DAG also
            // classifies `base.Save()` as `'global'` (same-graph); the
            // Python legacy DAG classifies `super().save()` as
            // `'import-resolved'` because Python's ancestor lookup
            // flows through `typeEnv.lookup(...)` which resolves the
            // superclass via its `import`/`from … import …` binding.
            // Closing that gap requires realigning the legacy tier
            // classifier and is tracked separately.
            const ok = tryEmitEdge(
              graph,
              scopes,
              nodeLookup,
              site,
              memberDef,
              'global',
              seen,
              0.85,
              collapse,
              calleeCapture,
            );
            if (ok) emitted++;
            // Always mark handled when the site was resolved, even
            // if the edge was deduplicated (collapse mode), so
            // `emitReferencesViaLookup` doesn't re-emit from the
            // reference index.
            handledSites.add(siteKey);
            continue;
          }
        }
      }

      // ── Case 0: compound receiver ────────────────────────────────
      // #2744: remember a compound receiver we could not type. Reported at
      // the end of the site loop, not here — a later case may still resolve
      // the site, and only a site that survives every case is a real drop.
      let compoundReceiverUnresolved = false;
      // The punctuation test is a C-family heuristic and it is the reason
      // `repos[0].save()` is INVISIBLE in all 14 languages: a subscript receiver
      // contains neither `.` nor `(`, so this case never fired, the fold was
      // never consulted, and no drop was recorded either — the call vanished
      // with the instrument blind to it. PHP `->` and `::` receivers are lost
      // the same way.
      //
      // A minted receiver chain is the STRUCTURAL answer to the same question:
      // the capture layer walked the real AST and found the receiver is an
      // expression, whatever punctuation it happens to be spelled with. Trusting
      // that instead of the text is the substitution this whole line of work
      // exists to make.
      if (
        receiverName.includes('.') ||
        receiverName.includes('(') ||
        site.receiverChain !== undefined
      ) {
        const resolved = resolveCompoundReceiverTyped(
          receiverName,
          site.inScope,
          scopes,
          index,
          // Group A: the receiver IS this site's expression, so the site's
          // captured chain describes it and the structural fold applies.
          { ...fileCompoundOpts, receiverChain: site.receiverChain },
        );
        const currentClass = resolved?.def;
        compoundReceiverUnresolved = currentClass === undefined;
        if (resolved !== undefined && currentClass !== undefined) {
          const chain = [currentClass.nodeId, ...scopes.methodDispatch.mroFor(currentClass.nodeId)];
          let memberDef: SymbolDefinition | undefined;
          let ambiguousOwnerId: string | undefined;
          // Static-only filter (#1756 / U3): same shape as Case 4's
          // overload-aware chain walk (skip-and-walk-on). When
          // an owner's resolved candidate is static-only (Kotlin
          // companion-promoted), continue to the next ancestor in
          // the MRO chain so a legitimate instance member can bind.
          // If the entire chain is static-only, no edge is emitted —
          // unlike Case 4, Case 0 does NOT mark the site handled in
          // that situation because compound receivers (`a.b.c()`)
          // are not pre-emitted by `emitReferencesViaLookup` (the
          // reference index has no compound-receiver entry for
          // shapes like `Logger.create("a")`), so there's no wrong
          // target to suppress.
          for (const ownerId of chain) {
            const picked =
              site.kind === 'call'
                ? pickFirstNonStaticOnly(ownerId, memberName, site, model, provider)
                : findOwnedMember(ownerId, memberName, model);
            if (picked === OVERLOAD_AMBIGUOUS) {
              ambiguousOwnerId = ownerId;
              break;
            }
            if (picked === STATIC_ONLY_FILTERED || picked === undefined) {
              continue;
            }
            memberDef = picked;
            break;
          }
          if (ambiguousOwnerId !== undefined) {
            recordReceiverOverloadSuppression(
              options.recordResolutionOutcome,
              parsed.filePath,
              site,
              ambiguousOwnerId,
              memberName,
              model,
              provider,
            );
            handledSites.add(siteKey);
            continue;
          }
          if (memberDef !== undefined) {
            if (
              suppressDeletedCallTarget(
                options.recordResolutionOutcome,
                parsed.filePath,
                site,
                memberDef,
              )
            ) {
              handledSites.add(siteKey);
              continue;
            }
            const ok = tryEmitEdge(
              graph,
              scopes,
              nodeLookup,
              site,
              memberDef,
              memberDef.filePath !== parsed.filePath ? 'import-resolved' : 'global',
              seen,
              0.85,
              collapse,
              calleeCapture,
            );
            if (ok) emitted++;
            // Interface dispatch, exactly as Case 4 does it (#2813). When the
            // folded receiver type is an Interface, the primary edge above
            // lands on the interface's own method DECLARATION; these secondary
            // edges are what reach the implementations.
            //
            // Case 4 had this and Case 0 did not, which made the gap a property
            // of receiver SYNTAX rather than of types: a struct-field receiver
            // (`s.orderRepo`) contains a dot, so it always takes Case 0, while
            // the same interface reached through a local or parameter is a bare
            // name and reaches Case 4. Field-held interfaces — dependency
            // injection, in other words — were the half that silently lost every
            // implementation edge.
            //
            // `currentClass` is the receiver's own folded type, matching what
            // Case 4 passes. `emitInterfaceDispatchFor` self-gates on
            // `ownerDef.type !== 'Interface'`, so this is inert for every
            // concrete receiver and needs no language check of its own — a
            // member whose owner resolved to a Struct emits nothing extra.
            //
            // Confidence mirrors THIS case's own primary emit above — the 0.85
            // literal — so a site's dispatch edges never claim more certainty
            // than the edge they hang off.
            //
            // Case 4 passes a site.kind-dependent value instead (1.0 for
            // read/write, `:1399-1405`) because ITS primary varies the same way.
            // Case 0 does branch on `site.kind` when picking the member
            // (`:713-716`), it simply does not vary reason/confidence with it,
            // so there is no 1.0 arm here to mirror. That leaves a read/write
            // ACCESSES through a compound receiver at 0.85 while the same access
            // through a bare name is 1.0 — a PRE-EXISTING difference between the
            // two cases' primaries, not something this fan-out introduces.
            // Deliberately not "fixed" here: changing Case 0's primary
            // confidence is a separate behavioural change affecting every
            // language, and is out of scope for #2813.
            //
            // The instantiation the FOLD typed this receiver from — the
            // declared spelling of `this.repo` / `svc.get().repo`, which the
            // folded class alone no longer carries (#2912).
            emitted += emitInterfaceDispatchFor(
              currentClass,
              memberName,
              memberDef,
              site,
              0.85,
              calleeCapture,
              resolved.declaredSpelling,
            );
            // Always mark handled when the site was resolved, even
            // if the edge was deduplicated (collapse mode), so
            // `emitReferencesViaLookup` doesn't re-emit from the
            // reference index.
            handledSites.add(siteKey);
            continue;
          }
        }
      }

      // ── Case 0.5: implicit `this` receiver ───────────────────────
      // C++ `this->member()` (and same-shape receivers in other OO
      // languages) should resolve against the enclosing class + MRO
      // even when there is no explicit `this` typeBinding in scope.
      //
      // **Static-only filter dependency (#1756 / U3):** this case does
      // NOT currently consult `provider.isStaticOnly`. Today it fires
      // only for C++ (the sole `resolveThisViaEnclosingClass === true`
      // language), which has no static-only semantics. Kotlin — the
      // current `isStaticOnly` consumer — leaves `resolveThisVia
      // EnclosingClass` unset, so Case 0.5 is dead code for Kotlin
      // crossover suppression and U3 leaves it untouched. If any
      // future language enables BOTH `resolveThisViaEnclosingClass`
      // AND `isStaticOnly`, the chain-walk below MUST adopt the
      // skip-and-walk-on filter pattern used by Cases 0, 3b, and 4.
      if (provider.resolveThisViaEnclosingClass === true && receiverName === 'this') {
        const enclosingClass = findEnclosingClassDef(site.inScope, scopes);
        if (enclosingClass !== undefined) {
          const languageResolution = provider.resolveReceiverMember?.(
            enclosingClass,
            memberName,
            site,
            scopes,
            model,
          );
          if (languageResolution?.kind === 'ambiguous') {
            options.recordResolutionOutcome?.({
              kind: 'suppressed',
              phase: 'receiver-bound-calls',
              filePath: parsed.filePath,
              name: site.name,
              range: site.atRange,
              reason: 'member-lookup-ambiguous',
              candidateIds: languageResolution.candidateIds,
            });
            handledSites.add(siteKey);
            continue;
          }
          if (languageResolution?.kind === 'resolved') {
            const memberDef = languageResolution.definition;
            if (
              suppressDeletedCallTarget(
                options.recordResolutionOutcome,
                parsed.filePath,
                site,
                memberDef,
              )
            ) {
              handledSites.add(siteKey);
              continue;
            }
            const reason =
              site.kind === 'write' || site.kind === 'read'
                ? site.kind
                : memberDef.filePath !== parsed.filePath
                  ? 'import-resolved'
                  : 'global';
            const confidence = site.kind === 'write' || site.kind === 'read' ? 1.0 : 0.85;
            const ok = tryEmitEdge(
              graph,
              scopes,
              nodeLookup,
              site,
              memberDef,
              reason,
              seen,
              confidence,
              collapse,
              calleeCapture,
            );
            if (ok) emitted++;
            handledSites.add(siteKey);
            continue;
          }

          const chain = [
            enclosingClass.nodeId,
            ...scopes.methodDispatch.mroFor(enclosingClass.nodeId),
          ];
          let memberDef: SymbolDefinition | undefined;
          let ambiguous = false;
          let hiddenByName = false;
          for (const ownerId of chain) {
            const methodOverloads = model.methods.lookupAllByOwner(ownerId, memberName);
            if (methodOverloads.length > 0) {
              const narrowed = narrowOverloadCandidates(
                methodOverloads,
                site.arity,
                site.argumentTypes,
                {
                  argumentTypeClasses: site.argumentTypeClasses,
                  conversionRankFn: provider.conversionRankFn,
                  conversionOnlyArgTypePrefixes: provider.conversionOnlyArgTypePrefixes,
                  constraintCompatibility: provider.constraintCompatibility,
                },
              );
              if (isOverloadAmbiguousAfterNormalization(narrowed, site.arity)) {
                ambiguous = true;
                break;
              }
              if (narrowed.length === 0) {
                // C++ name hiding: if the derived class declares `f`, base-class
                // overloads named `f` are hidden for member lookup
                // ([basic.lookup.classref]). A non-viable derived overload set
                // therefore terminates lookup instead of falling through to base.
                hiddenByName = true;
                break;
              }
              // Multiple tied survivors with distinct param types (e.g.
              // h(int,double) vs h(double,int) both scoring 2) → ambiguous.
              if (narrowed.length > 1) {
                ambiguous = true;
                break;
              }
              memberDef = narrowed[0] ?? methodOverloads[0];
              break;
            }

            // Field/property lookup intentionally runs only after the method
            // lookup above: in C++ member-name lookup, functions with this
            // name hide same-named base members; we therefore prefer method
            // candidates first and only target a field when no methods with
            // this name exist on the current owner.
            memberDef = model.fields.lookupFieldByOwner(ownerId, memberName);
            if (memberDef !== undefined) {
              break;
            }
          }
          if (ambiguous) {
            handledSites.add(siteKey);
            continue;
          }
          if (hiddenByName) {
            handledSites.add(siteKey);
            continue;
          }
          if (memberDef !== undefined) {
            if (
              suppressDeletedCallTarget(
                options.recordResolutionOutcome,
                parsed.filePath,
                site,
                memberDef,
              )
            ) {
              handledSites.add(siteKey);
              continue;
            }
            const reason =
              site.kind === 'write' || site.kind === 'read'
                ? site.kind
                : memberDef.filePath !== parsed.filePath
                  ? 'import-resolved'
                  : 'global';
            const confidence = site.kind === 'write' || site.kind === 'read' ? 1.0 : 0.85;
            const ok = tryEmitEdge(
              graph,
              scopes,
              nodeLookup,
              site,
              memberDef,
              reason,
              seen,
              confidence,
              collapse,
              calleeCapture,
            );
            if (ok) emitted++;
            handledSites.add(siteKey);
            continue;
          }
        }
      }

      // ── Case 1: namespace receiver ───────────────────────────────
      // `namespaceTargets` is collected per FILE, so a local declaration that
      // shadows the import must suppress it — `def f(pkg): pkg.db.query()`
      // calls a method on the PARAMETER, and resolving it through the import
      // emits a wrong edge, not a missing one. The compound-receiver
      // construction path has applied this guard since #2770; Case 1 never did,
      // for dotted and single-segment receivers alike.
      // Map lookup FIRST: it is an O(1) miss for almost every site, and the
      // guard is a scope-chain walk (a Set allocation plus a linear `ownedDefs`
      // scan per level). Guarding before looking up would charge that walk to
      // every explicit-receiver site in every language, for a candidate set
      // that is usually empty. Mirrors the order the compound-receiver
      // construction path already uses.
      const namespaceCandidates = namespaceTargets.get(receiverName);
      const targetFiles =
        namespaceCandidates !== undefined &&
        !isNamespaceNameShadowed(receiverName, site.inScope, scopes)
          ? namespaceCandidates
          : undefined;
      if (targetFiles !== undefined && provider.resolveQualifiedReceiverMember === undefined) {
        let found = false;
        for (const targetFile of targetFiles) {
          const memberDef = findExportedDef(targetFile, memberName, index);
          if (memberDef !== undefined) {
            if (
              suppressDeletedCallTarget(
                options.recordResolutionOutcome,
                parsed.filePath,
                site,
                memberDef,
              )
            ) {
              handledSites.add(siteKey);
              found = true;
              break;
            }
            const ok = tryEmitEdge(
              graph,
              scopes,
              nodeLookup,
              site,
              memberDef,
              memberDef.filePath !== parsed.filePath ? 'import-resolved' : 'global',
              seen,
              0.85,
              collapse,
              calleeCapture,
            );
            if (ok) emitted++;
            handledSites.add(siteKey);
            found = true;
            break;
          }
        }
        if (found) continue;
      }

      // ── Case 1.5: qualified namespace-receiver (language-specific) ───
      // Languages whose qualified-name semantics need workspace-wide
      // namespace-scope walking (C++ `outer::foo()`, including inline-
      // namespace transitive traversal) implement `resolveQualifiedReceiverMember`.
      // Runs before Case 2 so namespace receivers don't accidentally match a
      // class with the same simple name.
      if (provider.resolveQualifiedReceiverMember !== undefined) {
        const memberDef = provider.resolveQualifiedReceiverMember(
          receiverName,
          memberName,
          site.inScope,
          scopes,
          parsedFiles,
          site,
        );
        if (memberDef === 'ambiguous') {
          // Same-name ambiguity across inline-namespace children (#1564):
          // suppress edge emission, mark site handled.
          options.recordResolutionOutcome?.({
            kind: 'suppressed',
            phase: 'receiver-bound-calls',
            filePath: parsed.filePath,
            name: site.name,
            range: site.atRange,
            reason: 'inline-ns-ambiguous',
            candidateIds: [],
          });
          handledSites.add(siteKey);
          continue;
        }
        if (memberDef !== undefined) {
          if (
            suppressDeletedCallTarget(
              options.recordResolutionOutcome,
              parsed.filePath,
              site,
              memberDef,
            )
          ) {
            handledSites.add(siteKey);
            continue;
          }
          const ok = tryEmitEdge(
            graph,
            scopes,
            nodeLookup,
            site,
            memberDef,
            memberDef.filePath !== parsed.filePath ? 'import-resolved' : 'global',
            seen,
            0.85,
            collapse,
            calleeCapture,
          );
          if (ok) emitted++;
          handledSites.add(siteKey);
          continue;
        }
      }

      // ── Case 2: class-name receiver ──────────────────────────────
      const classDef = findClassBindingInScope(site.inScope, receiverName, scopes);
      if (classDef !== undefined) {
        const chain = [classDef.nodeId, ...scopes.methodDispatch.mroFor(classDef.nodeId)];
        let memberDef: SymbolDefinition | undefined;
        let ambiguousOwnerId: string | undefined;
        for (const ownerId of chain) {
          const picked =
            site.kind === 'call'
              ? pickOverload(ownerId, memberName, site, model, provider)
              : findOwnedMember(ownerId, memberName, model);
          if (picked === OVERLOAD_AMBIGUOUS) {
            ambiguousOwnerId = ownerId;
            break;
          }
          if (picked !== undefined) {
            memberDef = picked;
            // The MRO chain is most-derived-first ([classDef, ...ancestors]).
            // If the most-derived definition is arity-incompatible with the
            // call site, PHP throws ArgumentCountError at runtime — it does
            // NOT silently dispatch to an ancestor. Terminate the chain walk
            // so no edge is emitted, rather than falling through to an
            // arity-compatible ancestor (which would be a false positive).
            if (
              narrowOverloadCandidates([memberDef], site.arity, site.argumentTypes).length === 0
            ) {
              memberDef = undefined;
              break;
            }
            break;
          }
        }
        if (ambiguousOwnerId !== undefined) {
          recordReceiverOverloadSuppression(
            options.recordResolutionOutcome,
            parsed.filePath,
            site,
            ambiguousOwnerId,
            memberName,
            model,
            provider,
          );
          handledSites.add(siteKey);
          continue;
        }
        if (memberDef !== undefined) {
          if (
            suppressDeletedCallTarget(
              options.recordResolutionOutcome,
              parsed.filePath,
              site,
              memberDef,
            )
          ) {
            handledSites.add(siteKey);
            continue;
          }
          const reason =
            site.kind === 'write' || site.kind === 'read'
              ? site.kind
              : memberDef.filePath !== parsed.filePath
                ? 'import-resolved'
                : 'global';
          const confidence = site.kind === 'write' || site.kind === 'read' ? 1.0 : 0.85;
          const ok = tryEmitEdge(
            graph,
            scopes,
            nodeLookup,
            site,
            memberDef,
            reason,
            seen,
            confidence,
            collapse,
            calleeCapture,
          );
          if (ok) emitted++;
          handledSites.add(siteKey);
          continue;
        }
      }

      // ── Case 3: dotted typeBinding (`u: models.User`) ────────────
      const typeRef = findReceiverTypeBinding(site.inScope, receiverName, scopes);
      if (typeRef !== undefined && typeRef.rawName.includes('.')) {
        const [nsName, ...classNameParts] = typeRef.rawName.split('.');
        const className = classNameParts.join('.');
        const targetFiles3 = namespaceTargets.get(nsName);
        if (targetFiles3 !== undefined && className.length > 0) {
          let found3 = false;
          for (const targetFile3 of targetFiles3) {
            const classDef3 = findExportedDef(targetFile3, className, index);
            if (classDef3 !== undefined) {
              const picked =
                site.kind === 'call'
                  ? pickOverload(classDef3.nodeId, memberName, site, model, provider)
                  : findOwnedMember(classDef3.nodeId, memberName, model);
              if (picked === OVERLOAD_AMBIGUOUS) {
                recordReceiverOverloadSuppression(
                  options.recordResolutionOutcome,
                  parsed.filePath,
                  site,
                  classDef3.nodeId,
                  memberName,
                  model,
                  provider,
                );
                handledSites.add(siteKey);
                found3 = true;
                break;
              }
              if (picked !== undefined) {
                const memberDef = picked;
                if (
                  suppressDeletedCallTarget(
                    options.recordResolutionOutcome,
                    parsed.filePath,
                    site,
                    memberDef,
                  )
                ) {
                  handledSites.add(siteKey);
                  found3 = true;
                  break;
                }
                const ok = tryEmitEdge(
                  graph,
                  scopes,
                  nodeLookup,
                  site,
                  memberDef,
                  memberDef.filePath !== parsed.filePath ? 'import-resolved' : 'global',
                  seen,
                  // Explicit defaults so the trailing capture ctx (#2227 U2) can
                  // be threaded without changing dedup/confidence behavior.
                  0.85,
                  false,
                  calleeCapture,
                );
                if (ok) {
                  emitted++;
                  handledSites.add(siteKey);
                }
                found3 = true;
                break;
              }
            }
          }
          if (found3) continue;
        }
      }

      // ── Case 3b: chain-typebinding (`city → user.get_city`) ──────
      // Also handles compound member-call rawNames (`city → addr.get_city()`)
      // where the rawName includes both `.` and `()` — Ruby's
      // member-call-return captures produce this shape.
      const chainHead =
        typeRef !== undefined && typeRef.rawName.includes('.')
          ? (typeRef.rawName.split('.', 1)[0] ?? '')
          : undefined;
      if (typeRef !== undefined && chainHead !== undefined && !namespaceTargets.has(chainHead)) {
        // Try the plain dotted-field walk first — covers property /
        // collection-accessor shapes (`.Values`, Kotlin `.size`) and
        // field chains. Fall back to call-form (`x()`) which treats
        // the last segment as a method invocation. For rawNames that
        // already contain `()` (Ruby member-call-return captures),
        // pass through directly — the compound resolver handles the
        // full expression including the call syntax.
        // Each attempt carries its OWN spelling: the retry below used to reuse a
        // recorder reset once, before the first call, so a spelling reported by
        // the attempt that FAILED could be read as the retry's.
        let resolved = resolveCompoundReceiverTyped(
          typeRef.rawName,
          typeRef.declaredAtScope,
          scopes,
          index,
          fileCompoundOpts,
        );
        if (resolved === undefined && !typeRef.rawName.includes('(')) {
          resolved = resolveCompoundReceiverTyped(
            typeRef.rawName + '()',
            typeRef.declaredAtScope,
            scopes,
            index,
            fileCompoundOpts,
          );
        }
        const ownerDef = resolved?.def;
        if (resolved !== undefined && ownerDef !== undefined) {
          const chain = [ownerDef.nodeId, ...scopes.methodDispatch.mroFor(ownerDef.nodeId)];
          let memberDef: SymbolDefinition | undefined;
          let ambiguousOwnerId: string | undefined;
          // Static-only filter (#1756 / U3): mirrors Case 0's
          // overload-aware chain walk. When
          // a static-only candidate is found at an ancestor, walk on
          // so a legitimate instance member can bind. If the entire
          // chain is static-only, no edge is emitted (Case 3b is fed
          // by chain-typebinding receivers, not pre-emitted by
          // `emitReferencesViaLookup` for compound shapes, so no
          // handled-site marker is needed for chain-only-static).
          for (const ownerId of chain) {
            const picked =
              site.kind === 'call'
                ? pickFirstNonStaticOnly(ownerId, memberName, site, model, provider)
                : findOwnedMember(ownerId, memberName, model);
            if (picked === OVERLOAD_AMBIGUOUS) {
              ambiguousOwnerId = ownerId;
              break;
            }
            if (picked === STATIC_ONLY_FILTERED || picked === undefined) {
              continue;
            }
            memberDef = picked;
            break;
          }
          if (ambiguousOwnerId !== undefined) {
            recordReceiverOverloadSuppression(
              options.recordResolutionOutcome,
              parsed.filePath,
              site,
              ambiguousOwnerId,
              memberName,
              model,
              provider,
            );
            handledSites.add(siteKey);
            continue;
          }
          if (memberDef !== undefined) {
            if (
              suppressDeletedCallTarget(
                options.recordResolutionOutcome,
                parsed.filePath,
                site,
                memberDef,
              )
            ) {
              handledSites.add(siteKey);
              continue;
            }
            const ok = tryEmitEdge(
              graph,
              scopes,
              nodeLookup,
              site,
              memberDef,
              memberDef.filePath !== parsed.filePath ? 'import-resolved' : 'global',
              seen,
              0.85,
              collapse,
              calleeCapture,
            );
            if (ok) emitted++;
            // Interface dispatch, exactly as Cases 0 and 4 do it (#2832). Case
            // 3b folds a chain to a receiver type through the SAME
            // `resolveCompoundReceiverClass` call and the same MRO walk Case 0
            // uses, so when that fold lands on an Interface the primary edge
            // above names the interface's own bodiless DECLARATION and nothing
            // reaches the implementations.
            //
            // Leaving 3b out made the fan-out a property of how the receiver
            // was SPELLED rather than of what it resolved to: `d.repo.save()`
            // took Case 0 and fanned out, while binding the identical field to
            // a local first (`const r = d.repo; r.save()`) took Case 3b and
            // did not. #2829 closed that gap for Case 0 and left this half of
            // it open (#2832).
            //
            // `ownerDef` is the receiver's own folded type — matching Case 0's
            // `currentClass` and Case 4's `ownerDef` — NOT the owner of the
            // member the MRO walk settled on. That distinction matters: a
            // receiver that folds to a concrete class merely INHERITING an
            // interface method must not fan out, because its runtime type is
            // that class. `emitInterfaceDispatchFor` self-gates on
            // `ownerDef.type !== 'Interface'`, so this is inert for every
            // concrete receiver and needs no language check of its own.
            //
            // That gate is deliberately narrower than "the primary landed on
            // something bodiless": a chain folding to an ABSTRACT class also
            // dead-ends on a declaration-only member and does NOT fan out
            // here. Widening it to `|| isDeclarationOnly(memberDef)` would
            // cover that, but it changes Cases 0 and 4 identically and for
            // every language, so it is not #2832's to make.
            //
            // Confidence mirrors THIS case's own primary emit above — the 0.85
            // literal — so a site's dispatch edges never claim more certainty
            // than the edge they hang off. Case 4 passes a site.kind-dependent
            // value instead because ITS primary varies that way; Case 3b's
            // primary, like Case 0's, does not, so there is no 1.0 arm here to
            // mirror.
            // Same fold, same recovered spelling as Case 0.
            emitted += emitInterfaceDispatchFor(
              ownerDef,
              memberName,
              memberDef,
              site,
              0.85,
              calleeCapture,
              resolved.declaredSpelling,
            );
            // Always mark handled when the site was resolved, even
            // if the edge was deduplicated (collapse mode), so
            // `emitReferencesViaLookup` doesn't re-emit from the
            // reference index.
            handledSites.add(siteKey);
            continue;
          }
        }
      }

      // ── Case 4: simple typeBinding (`u: U`) ──────────────────────
      if (typeRef !== undefined && !typeRef.rawName.includes('.')) {
        // A `rawName` the capture layer reduced from a type application is
        // resolved through the application it was written as, so the erasure
        // takes the GROUNDED route rather than binding whatever the workspace
        // declares under that base name — see {@link erasedTypeApplication}.
        const typeApplication = erasedTypeApplication(typeRef);
        let ownerDef = resolveClassBindingForName(
          site.inScope,
          typeApplication ?? typeRef.rawName,
          scopes,
        );
        // `findClassBindingInScope(..., typeRef.rawName)` only works when
        // rawName is itself a class symbol reachable through scope bindings.
        // For languages with namespace-style imports (Go), imported types
        // don't create bindings. Fall back to QualifiedNameIndex — single-
        // match wins; ambiguous/missing falls through.
        //
        // NOT for an erased base name. This fallback consults no scope, no
        // import and no module: it binds any name with exactly one workspace
        // definition. That is a defensible last resort for a name the source
        // WROTE — the file named it, so the only question is which declaration
        // it meant — and is not defensible for a name the capture layer
        // MANUFACTURED by erasing type arguments, where the file may never
        // have named it at all. The lookup above already answered that case on
        // grounds; re-asking it here without any would undo them.
        if (ownerDef === undefined && typeApplication === undefined) {
          const qnameIds = scopes.qualifiedNames.get(typeRef.rawName);
          if (qnameIds.length === 1) {
            const qdef = scopes.defs.get(qnameIds[0]!);
            if (qdef !== undefined && isClassLike(qdef.type)) ownerDef = qdef;
          }
        }
        // Map for-of tuple bindings (`__MAP_TUPLE_i__:mapId`), callable
        // aliases (`getUser` → User), and other compound-friendly shapes
        // need the compound resolver keyed by the receiver identifier.
        //
        // Not asked for a receiver whose declared type IS an erased type
        // application the grounded lookup just refused. Those shapes are
        // alternatives to a declared type, not readings of one: this receiver
        // HAS a declared type, the question "which class does its base name
        // denote here" was already put and answered "cannot tell", and the
        // compound resolver reaches the same base name through its own
        // scope-free routes (its bare-identifier step re-runs the lookup on
        // `rawName`; its callable-alias step retries the same name as a
        // construction). Asking again by a route that cannot see the grounds
        // would make the refusal decorative.
        if (ownerDef === undefined && typeApplication === undefined) {
          ownerDef = resolveCompoundReceiverClass(
            receiverName,
            site.inScope,
            scopes,
            index,
            // Group A, same reasoning as Case 0 above.
            { ...fileCompoundOpts, receiverChain: site.receiverChain },
          );
        }
        // The receiver has a declared type, that type is a type APPLICATION,
        // and its base name could not be connected to any declaration this
        // file can see. The site is DROPPED, and dropped deliberately, so it
        // must be marked handled: `emitReferencesViaLookup` would otherwise
        // re-emit the very target the grounds refused, because the pre-resolved
        // reference index answers a name with the single workspace definition
        // that carries it and knows nothing about erasure. That is exactly why
        // the static-only filter above marks handled too — a refusal this pass
        // makes is not a refusal until the fallback emitter is told.
        //
        // Recorded as `receiver-unresolved` rather than silently: the receiver's
        // TYPE could not be established, which is the reason's own definition,
        // and a consumer counting resolver gaps must see this drop rather than
        // read the absence as a resolved site. No `receiverOrigin` — the base
        // name resolving in the index is precisely the evidence just rejected,
        // so claiming `in-program` from it would relaunder the fabrication as a
        // diagnostic, and the absent field hedges (the safe direction).
        if (ownerDef === undefined && typeApplication !== undefined) {
          options.recordResolutionOutcome?.({
            kind: 'suppressed',
            reason: 'receiver-unresolved',
            candidateIds: [],
            phase: 'receiver-bound-calls',
            filePath: parsed.filePath,
            name: site.name,
            range: site.atRange,
            siteKind: site.kind,
          });
          handledSites.add(siteKey);
          continue;
        }
        if (ownerDef !== undefined) {
          const languageResolution = provider.resolveReceiverMember?.(
            ownerDef,
            memberName,
            site,
            scopes,
            model,
          );
          if (languageResolution?.kind === 'ambiguous') {
            options.recordResolutionOutcome?.({
              kind: 'suppressed',
              phase: 'receiver-bound-calls',
              filePath: parsed.filePath,
              name: site.name,
              range: site.atRange,
              reason: 'member-lookup-ambiguous',
              candidateIds: languageResolution.candidateIds,
            });
            handledSites.add(siteKey);
            continue;
          }
          if (languageResolution?.kind === 'resolved') {
            const memberDef = languageResolution.definition;
            if (
              suppressDeletedCallTarget(
                options.recordResolutionOutcome,
                parsed.filePath,
                site,
                memberDef,
              )
            ) {
              handledSites.add(siteKey);
              continue;
            }
            const reason =
              site.kind === 'write' || site.kind === 'read'
                ? site.kind
                : memberDef.filePath !== parsed.filePath
                  ? 'import-resolved'
                  : 'global';
            const confidence = site.kind === 'write' || site.kind === 'read' ? 1.0 : 0.85;
            const ok = tryEmitEdge(
              graph,
              scopes,
              nodeLookup,
              site,
              memberDef,
              reason,
              seen,
              confidence,
              collapse,
              calleeCapture,
            );
            if (ok) emitted++;
            handledSites.add(siteKey);
            continue;
          }

          const chain = [ownerDef.nodeId, ...scopes.methodDispatch.mroFor(ownerDef.nodeId)];
          let memberDef: SymbolDefinition | undefined;
          let ambiguous = false;
          let ambiguousOwnerId: string | undefined;
          // Track whether the chain walk filtered out any static-only
          // candidates. When it did and the chain ended with no
          // legitimate instance member, we mark the site as handled so
          // `emitReferencesViaLookup` doesn't re-emit a wrong target
          // from the pre-resolved reference index (which has no
          // static-only awareness).
          let allFilteredStaticOnly = false;
          // Static-only filter (#1756 / U2): the filter must run INSIDE
          // the chain walk and BEFORE arity narrowing.
          //
          // INSIDE: when a derived owner's only candidates are static-
          // only (Kotlin companion-promoted), `pickFirstNonStaticOnly`
          // returns `undefined` and the loop `continue`s to the next
          // ancestor in the MRO chain — giving a legitimate ancestor
          // instance method a chance to bind. The earlier after-chain
          // filter aborted the entire site instead, producing a false
          // negative whenever the most-derived owner shadowed an
          // ancestor's instance method with a static-only companion
          // member.
          //
          // BEFORE narrowing: filtering survivors of `lookupAllByOwner`
          // (rather than survivors of `narrowOverloadCandidates`) means
          // a same-arity static + instance pair on one owner doesn't
          // collapse to `OVERLOAD_AMBIGUOUS`. Kotlin compile-resolves
          // such a pair unambiguously to the instance method because
          // companion members are not legal instance-dispatch
          // candidates.
          for (const ownerId of chain) {
            const picked = pickFirstNonStaticOnly(ownerId, memberName, site, model, provider);
            if (picked === OVERLOAD_AMBIGUOUS) {
              ambiguous = true;
              ambiguousOwnerId = ownerId;
              break;
            }
            if (picked === STATIC_ONLY_FILTERED) {
              // At least one static-only candidate was filtered out at
              // this owner; remember so we can mark handled if the
              // chain ends with no legitimate match.
              allFilteredStaticOnly = true;
              continue;
            }
            if (picked !== undefined) {
              memberDef = picked;
              break;
            }
            // `picked === undefined` means this owner had no member of
            // this name at all. Walk on to the next ancestor in the
            // MRO chain.
          }
          if (ambiguous) {
            // Suppress and mark handled so `emitReferencesViaLookup`
            // doesn't re-emit the pre-resolved reference. See
            // OVERLOAD_AMBIGUOUS docstring for the upstream cause.
            recordReceiverOverloadSuppression(
              options.recordResolutionOutcome,
              parsed.filePath,
              site,
              ambiguousOwnerId ?? ownerDef.nodeId,
              memberName,
              model,
              provider,
            );
            handledSites.add(siteKey);
            continue;
          }
          if (memberDef === undefined && allFilteredStaticOnly) {
            // The chain ended with no candidates because every viable
            // owner had only static-only members. Mark handled so
            // `emitReferencesViaLookup` doesn't re-emit a wrong target
            // from the pre-resolved reference index. Parallels the old
            // after-chain `isStaticOnly` suppression block.
            handledSites.add(siteKey);
            continue;
          }
          if (memberDef !== undefined) {
            if (
              suppressDeletedCallTarget(
                options.recordResolutionOutcome,
                parsed.filePath,
                site,
                memberDef,
              )
            ) {
              handledSites.add(siteKey);
              continue;
            }
            // For read/write ACCESSES, mirror the legacy DAG's reason
            // convention so consumers asserting `reason === 'write'`
            // keep working.
            const reason =
              site.kind === 'write' || site.kind === 'read'
                ? site.kind
                : memberDef.filePath !== parsed.filePath
                  ? 'import-resolved'
                  : 'global';
            const confidence = site.kind === 'write' || site.kind === 'read' ? 1.0 : 0.85;
            const ok = tryEmitEdge(
              graph,
              scopes,
              nodeLookup,
              site,
              memberDef,
              reason,
              seen,
              confidence,
              collapse,
              calleeCapture,
            );
            if (ok) emitted++;
            // Interface dispatch: when the primary owner is an
            // Interface, emit secondary CALLS edges to every
            // implementing class's same-named method.
            //
            // This case is the one that KNOWS the instantiation: the receiver
            // has a declared type, and `typeApplication` is that type restored
            // to its written `Base<Args>` spelling (`rawName` is the erasure).
            // A language whose `rawName` was never erased carries the arguments
            // itself, so both spellings are read (#2912).
            emitted += emitInterfaceDispatchFor(
              ownerDef,
              memberName,
              memberDef,
              site,
              confidence,
              calleeCapture,
              typeApplication ?? typeRef.rawName,
            );
            // Always mark handled when the site was resolved, even
            // if the edge was deduplicated (collapse mode), so
            // `emitReferencesViaLookup` doesn't re-emit from the
            // reference index.
            handledSites.add(siteKey);
            continue;
          }
        }
      }

      // ── Case 5: value-receiver bridge (object-literal services) ──
      // When prior cases couldn't resolve the receiver as a class or
      // type binding, fall back to value-binding resolution. Covers:
      //
      //   export const fooService = { getUser(id) {...} };
      //   import { fooService } from './service';
      //   fooService.getUser(id);   // ← resolve here
      //
      // `fooService` is a `Const`/`Variable` (not class-like, no typeBinding
      // for unannotated literals), so Cases 2-4 skip it. Scope-resolution
      // defs for non-class values carry a synthetic id, so we translate to
      // the canonical graph node ID via `resolveDefGraphId` before owner-
      // indexed lookup — the parser writes the graph node ID as `ownerId`
      // on the method symbol-table entry to match.
      //
      // Object-literal methods do not carry a `qualifiedName` (no class
      // owner to seed it), so the picked def cannot round-trip through
      // `tryEmitEdge` → `resolveDefGraphId`. We use
      // `tryEmitEdgeWithExplicitTargetId` instead, passing `picked.nodeId`
      // directly — same dedup-key shape, collapse-flag honoring, and
      // caller resolution as `tryEmitEdge`.
      const valueDef = findValueBindingInScope(site.inScope, receiverName, scopes);
      if (valueDef !== undefined) {
        const ownerGraphId =
          resolveDefGraphId(valueDef.filePath, valueDef, nodeLookup) ?? valueDef.nodeId;
        const picked = pickOverload(ownerGraphId, memberName, site, model, provider);
        if (picked === OVERLOAD_AMBIGUOUS) {
          recordReceiverOverloadSuppression(
            options.recordResolutionOutcome,
            parsed.filePath,
            site,
            ownerGraphId,
            memberName,
            model,
            provider,
          );
          handledSites.add(siteKey);
          continue;
        }
        if (picked !== undefined) {
          if (
            suppressDeletedCallTarget(
              options.recordResolutionOutcome,
              parsed.filePath,
              site,
              picked,
            )
          ) {
            handledSites.add(siteKey);
            continue;
          }
          // Static-only filter (#1756 / U3): unlike Case 4 there's no
          // MRO chain to walk here — Case 5 dispatches on a single
          // owner via `pickOverload`. When the picked candidate is
          // static-only (Kotlin companion-promoted), suppress the
          // edge entirely and mark the site handled so
          // `emitReferencesViaLookup` doesn't re-emit a wrong target
          // from the pre-resolved reference index. Matches the after-
          // chain handled-marker semantic used by Case 4's
          // all-filtered fall-through.
          if (provider.isStaticOnly?.(picked) === true) {
            handledSites.add(siteKey);
            continue;
          }
          const reason =
            site.kind === 'write' || site.kind === 'read'
              ? site.kind
              : picked.filePath !== parsed.filePath
                ? 'import-resolved'
                : 'global';
          const confidence = site.kind === 'write' || site.kind === 'read' ? 1.0 : 0.85;
          const ok = tryEmitEdgeWithExplicitTargetId(
            graph,
            scopes,
            nodeLookup,
            site,
            picked.nodeId,
            reason,
            seen,
            confidence,
            collapse,
            calleeCapture,
          );
          if (ok) emitted++;
          handledSites.add(siteKey);
          continue;
        }
      }

      // ── Case 6: class-level (static) member receiver ─────────────
      // `Holder.repo.save(u)` — the receiver `Holder.repo` reaches a value
      // through a CLASS-LEVEL member. Both routes that type a compound
      // receiver (the structural fold and the text cascade) read the same
      // place for the `repo` hop: the owning class scope's `typeBindings`.
      // A scope has ONE `typeBindings` map with no static/instance split, so
      // a language that declares both `p` and `static p` cannot record both
      // — and at least two resolve that collision by not recording the
      // static one at all, leaving `Holder.repo` with nothing to type
      // against. A language that nests its class-level members in a scope of
      // their own (a companion/singleton body) lands in the same place from
      // the other direction: the binding exists, but not in the scope keyed
      // by the class the receiver names. Both were MEASURED as emitting no
      // edge at all, generic field and non-generic control alike.
      //
      // The definition side does not have that ambiguity: a class-level
      // member and an instance member of one name are two distinct defs, and
      // the graph node carries both `isStatic` and the member's declared
      // type. So this case types the receiver off the DEF rather than off a
      // typeBinding, and needs no scope-tree change to do it.
      //
      // ── WHY THIS CANNOT MINT A STATIC-TARGETED EDGE ────────────────────
      //
      // `Holder.repo` is a static FIELD whose TYPE is `Repo`; the value it
      // holds is an INSTANCE. So "reached through a class-level member" says
      // nothing about the target: `save` is looked up with the ordinary
      // `pickFirstNonStaticOnly` instance walk that Cases 0/3b/4 use, and a
      // static-only `save` is skipped exactly as it is there. A genuine
      // static CALL (`Repo.create()`) never arrives here — its receiver is a
      // bare class name with no dot, which Case 2 owns and this case's
      // two-part receiver requirement excludes.
      //
      // The `isStatic === true` requirement on the FIELD is the load-bearing
      // guard in the other direction: the head resolved to the class itself,
      // so only a class-level member is reachable through it, and an
      // instance field of the same name must not be substituted. That is a
      // POSITIVE selection among the defs that exist, never a filter that
      // deletes otherwise-valid targets — the distinction that matters for a
      // language whose singleton/companion members all carry `isStatic` from
      // their OWNER type, where the flag being set is precisely what makes
      // reaching them through the type name correct.
      //
      // Runs LAST, and only for a receiver Case 0 already declined
      // (`compoundReceiverUnresolved`): a site any earlier case resolved
      // keeps that answer, so this can only turn a missing edge into an edge
      // and never retarget an existing one. Contract Invariant I4 holds —
      // nothing above moved.
      if (compoundReceiverUnresolved) {
        const staticMemberReceiver = splitClassLevelMemberReceiver(
          receiverName,
          site.receiverChain,
        );
        const headClass =
          staticMemberReceiver === undefined
            ? undefined
            : findClassBindingInScope(site.inScope, staticMemberReceiver.headName, scopes);
        // The head must be the CLASS ITSELF, not a value that happens to
        // share its name — the same `currentIsClassConstant` test the text
        // cascade makes before it treats a head as a class constant. A head
        // with a type binding is an instance and its members are typed by
        // the routes above.
        if (
          staticMemberReceiver !== undefined &&
          headClass !== undefined &&
          findReceiverTypeBinding(site.inScope, staticMemberReceiver.headName, scopes) === undefined
        ) {
          // MRO walk, so a class-level member declared on an ancestor is
          // reachable through a subclass name where the language allows it.
          // First owner that declares one wins, matching every other walk in
          // this pass.
          let fieldOwnerId: string | undefined;
          let fieldDeclaredType: string | undefined;
          for (const ownerId of [
            headClass.nodeId,
            ...scopes.methodDispatch.mroFor(headClass.nodeId),
          ]) {
            const declared = declaredTypeOfClassLevelField(
              ownerId,
              staticMemberReceiver.memberName,
            );
            if (declared === undefined) continue;
            fieldOwnerId = ownerId;
            fieldDeclaredType = declared;
            break;
          }
          // Resolve the declared type from where it was WRITTEN — the
          // declaring class's own scope — not from the call site. A caller
          // in another file need not have the field's type in scope at all,
          // and resolving `Repo` against the caller's bindings would either
          // miss or, worse, find an unrelated same-named class.
          const declaringScope =
            fieldOwnerId === undefined ? undefined : index.classScopeByDefId.get(fieldOwnerId)?.id;
          const receiverClass =
            declaringScope === undefined || fieldDeclaredType === undefined
              ? undefined
              : resolveClassBindingForName(
                  declaringScope,
                  fieldDeclaredType,
                  scopes,
                  provider.stripTypePreservingDecoration,
                );
          if (receiverClass !== undefined) {
            const chain = [
              receiverClass.nodeId,
              ...scopes.methodDispatch.mroFor(receiverClass.nodeId),
            ];
            let memberDef: SymbolDefinition | undefined;
            let ambiguousOwnerId: string | undefined;
            for (const ownerId of chain) {
              const picked = pickFirstNonStaticOnly(ownerId, memberName, site, model, provider);
              if (picked === OVERLOAD_AMBIGUOUS) {
                ambiguousOwnerId = ownerId;
                break;
              }
              // Same skip-and-walk-on as Case 4: a static-only candidate at
              // this owner must not block an ancestor's instance member.
              if (picked === STATIC_ONLY_FILTERED || picked === undefined) continue;
              memberDef = picked;
              break;
            }
            if (ambiguousOwnerId !== undefined) {
              recordReceiverOverloadSuppression(
                options.recordResolutionOutcome,
                parsed.filePath,
                site,
                ambiguousOwnerId,
                memberName,
                model,
                provider,
              );
              handledSites.add(siteKey);
              continue;
            }
            if (memberDef !== undefined) {
              if (
                suppressDeletedCallTarget(
                  options.recordResolutionOutcome,
                  parsed.filePath,
                  site,
                  memberDef,
                )
              ) {
                handledSites.add(siteKey);
                continue;
              }
              const reason =
                site.kind === 'write' || site.kind === 'read'
                  ? site.kind
                  : memberDef.filePath !== parsed.filePath
                    ? 'import-resolved'
                    : 'global';
              const confidence = site.kind === 'write' || site.kind === 'read' ? 1.0 : 0.85;
              const ok = tryEmitEdge(
                graph,
                scopes,
                nodeLookup,
                site,
                memberDef,
                reason,
                seen,
                confidence,
                collapse,
                calleeCapture,
              );
              if (ok) emitted++;
              // The receiver's declared type can be an Interface exactly as
              // in Cases 0/3b/4 — an interface-typed static field is the
              // canonical service-locator shape — so it fans out the same
              // way. Omitting it would make the static spelling emit fewer
              // targets than the identical instance field, which is the very
              // spelling-dependence #2829/#2842 closed elsewhere.
              // The field's DECLARED type is the spelling the source wrote, so
              // its arguments are available here exactly as in Case 4 (#2912).
              emitted += emitInterfaceDispatchFor(
                receiverClass,
                memberName,
                memberDef,
                site,
                confidence,
                calleeCapture,
                fieldDeclaredType,
              );
              handledSites.add(siteKey);
              continue;
            }
          }
        }
      }

      // #2744: the site survived every case with a compound receiver we could
      // not type, so the call is dropped with no candidate. Record it here —
      // after the cases, so a site a later case resolved is never reported —
      // keyed by the MEMBER name, which is the only thing still known about a
      // dropped site (its callee is unknown by definition, so the drop cannot
      // be attributed to any target symbol).
      if (compoundReceiverUnresolved && !handledSites.has(siteKey)) {
        // Decoded once: both the shape census and the origin classifier read the
        // same chain, and this is inside the drop guard so a resolved site pays
        // nothing.
        const decodedChain = decodeReceiverChain(site.receiverChain);
        options.recordResolutionOutcome?.({
          kind: 'suppressed',
          reason: 'receiver-unresolved',
          candidateIds: [],
          phase: 'receiver-bound-calls',
          filePath: parsed.filePath,
          name: site.name,
          range: site.atRange,
          // The gate above tests the receiver's punctuation, not the site's
          // kind, so property reads and writes with a compound receiver are
          // recorded here too. Carry the kind so a consumer can separate a
          // dropped CALL from a dropped property access.
          siteKind: site.kind,
          // Structural, from the AST-derived chain the emitter minted — never
          // re-derived from the source line.
          // `decodeReceiverChain` opens with a non-string guard, so the
          // undefined case needs no ternary here.
          receiverShape: classifyReceiverShape(decodedChain),
          // Whether anything was actually lost. An external target has no node
          // to point at, so its absence is completeness, not uncertainty — but
          // ONLY a positive built-in match may say so. Everything the index
          // cannot demonstrate stays `unknown` and keeps hedging.
          receiverOrigin: classifyReceiverOrigin(
            decodedChain,
            site.inScope,
            receiverName,
            scopes,
            receiverOriginOpts,
          ),
        });
      }
    }
  }

  return { emitted, dispatchFanoutSkipped, dispatchFanoutSkippedNames };
}

/** A receiver of the exact shape `<name>.<name>` — a head and ONE member
 *  hop — as split by {@link splitClassLevelMemberReceiver}. */
interface ClassLevelMemberReceiver {
  readonly headName: string;
  readonly memberName: string;
}

/**
 * Split a receiver into `Head` + one member hop, or decline.
 *
 * The STRUCTURE decides when the capture layer minted a chain: exactly one
 * step, and that step a FIELD. A `call` step is a different shape entirely
 * (`Holder.make().save()` — the value comes from a return type, which the
 * routes above already own), and an `await`/`index` step transforms the value
 * in a way a field's declared type does not describe.
 *
 * Without a chain the receiver TEXT answers, and only in the one spelling that
 * cannot be read two ways: two bare identifiers around a single dot. Anything
 * carrying a call, a subscript, a second dot or a decoration declines rather
 * than being parsed here — re-deriving structure from text is what the chain
 * exists to replace, and a second, looser text parser beside the cascade's own
 * would drift from it.
 */
function splitClassLevelMemberReceiver(
  receiverText: string,
  receiverChain: string | undefined,
): ClassLevelMemberReceiver | undefined {
  const decoded = decodeReceiverChain(receiverChain);
  if (decoded !== undefined) {
    if (decoded.truncated || decoded.steps.length !== 1) return undefined;
    const step = decoded.steps[0];
    if (step === undefined || step.kind !== 'field') return undefined;
    return { headName: decoded.baseReceiverName, memberName: step.name };
  }
  const match = TWO_PART_RECEIVER_RE.exec(receiverText);
  if (match === null) return undefined;
  const [, headName, memberName] = match;
  if (headName === undefined || memberName === undefined) return undefined;
  return { headName, memberName };
}

/** `Holder.repo` and nothing looser — see {@link splitClassLevelMemberReceiver}. */
const TWO_PART_RECEIVER_RE = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/;

/** Resolve a member by name on a class def, narrowing by argument
 *  types when multiple overloads share the name. Falls back to the
 *  first-seen def (legacy `findOwnedMember` semantics) when there's
 *  no narrowing signal or when `argumentTypes` is unavailable. */
function pickOverload(
  ownerId: string,
  memberName: string,
  site: ParsedFile['referenceSites'][number],
  model: SemanticModel,
  provider: ReceiverBoundProviderSubset,
): SymbolDefinition | typeof OVERLOAD_AMBIGUOUS | undefined {
  const overloads = model.methods.lookupAllByOwner(ownerId, memberName);
  if (overloads.length === 0) {
    // Non-callable member (field / property / variable) — ACCESSES
    // write/read sites target these too. Fall back to the field
    // registry so owner-scoped attribute access resolves.
    return model.fields.lookupFieldByOwner(ownerId, memberName);
  }
  if (overloads.length === 1) return overloads[0];

  const candidates = narrowOverloadCandidates(overloads, site.arity, site.argumentTypes, {
    argumentTypeClasses: site.argumentTypeClasses,
    conversionRankFn: provider.conversionRankFn,
    conversionOnlyArgTypePrefixes: provider.conversionOnlyArgTypePrefixes,
    constraintCompatibility: provider.constraintCompatibility,
  });
  // When narrowing leaves >1 candidate that share identical normalized
  // parameter-types (e.g., C++ `f(int)` vs `f(long)` both collapsed to
  // `['int']` by `normalizeCppParamType`), suppress the edge entirely.
  // The graph schema has no ambiguous-target edge model, so emitting one
  // would arbitrarily pick a candidate and lie about the call's target.
  // PR #1520 review follow-up plan U2 / Claude review Finding 5.
  if (isOverloadAmbiguousAfterNormalization(candidates, site.arity)) return OVERLOAD_AMBIGUOUS;
  // When conversion-rank scoring leaves >1 tied candidate with distinct
  // parameter types (e.g. h(int,double) vs h(double,int) both scoring 2),
  // suppress rather than picking arbitrarily — C++ would call this
  // ambiguous. Mirrors ADL merged-candidate suppression behavior.
  if (candidates.length > 1) return OVERLOAD_AMBIGUOUS;
  return candidates[0] ?? overloads[0];
}

/**
 * Sentinel returned by `pickOverload` when narrowing leaves >1 candidate
 * sharing identical normalized parameter-types. Callers should suppress
 * the CALLS edge AND mark the site as handled so `emitReferencesViaLookup`
 * does not re-emit from the pre-resolved reference index. See
 * `pickOverload` JSDoc for the upstream cause (per-language normalizer
 * collapses distinct types in arity-metadata).
 */
export const OVERLOAD_AMBIGUOUS = Symbol('overload-ambiguous');

/**
 * Sentinel returned by `pickFirstNonStaticOnly` when the only candidates
 * at the queried owner were filtered out by `provider.isStaticOnly`. Lets
 * the Case 4 chain walk distinguish "owner had no member of this name"
 * (return `undefined`, continue silently) from "owner had only static-
 * only members" (return this sentinel, continue and remember so the
 * post-chain handled-marker logic can suppress wrong-target re-emission
 * from `emitReferencesViaLookup`). See #1756 / remediation plan U2.
 */
const STATIC_ONLY_FILTERED = Symbol('static-only-filtered');

/**
 * Receiver-bound member lookup that filters static-only candidates BEFORE
 * arity narrowing. Wraps the raw `lookupAllByOwner` → `narrowOverloadCandidates`
 * pipeline so:
 *
 *   1. Candidates flagged by `provider.isStaticOnly` (Kotlin companion-
 *      promoted methods today) never enter the narrowing stage. A same-
 *      name same-arity static + instance pair on one owner therefore does
 *      NOT collapse to `OVERLOAD_AMBIGUOUS` — the instance member wins
 *      unambiguously, matching Kotlin's compile-time resolution.
 *   2. The chain walk in `emitReceiverBoundCalls` Case 4 can fall through
 *      to ancestors when only static-only candidates exist at the
 *      most-derived owner (returns `STATIC_ONLY_FILTERED`), rather than
 *      aborting the site as the previous after-chain filter did.
 *
 * Returns:
 *   - `undefined` — no member with this name on this owner; chain walk
 *     continues silently.
 *   - `STATIC_ONLY_FILTERED` — at least one candidate existed but every
 *     one was static-only; chain walk continues and remembers so the
 *     post-chain handled-marker can fire if no ancestor binds.
 *   - `OVERLOAD_AMBIGUOUS` — narrowing on the surviving non-static
 *     candidates left >1 ambiguous match; chain walk aborts and the
 *     site is marked handled (existing sentinel handling preserved).
 *   - `SymbolDefinition` — single survivor (the chosen target).
 *
 * See remediation plan `docs/plans/2026-05-22-002-fix-lang-kotlin-1782-
 * remediation-plan.md` § U2 for the full rationale.
 */
function pickFirstNonStaticOnly(
  ownerId: string,
  memberName: string,
  site: ParsedFile['referenceSites'][number],
  model: SemanticModel,
  provider: ReceiverBoundProviderSubset,
): SymbolDefinition | typeof OVERLOAD_AMBIGUOUS | typeof STATIC_ONLY_FILTERED | undefined {
  const rawOverloads = model.methods.lookupAllByOwner(ownerId, memberName);
  if (rawOverloads.length === 0) {
    // Non-callable member (field / property / variable) — ACCESSES
    // write/read sites target these too. Static-only filtering doesn't
    // apply to fields, so delegate straight to `lookupFieldByOwner`.
    return model.fields.lookupFieldByOwner(ownerId, memberName);
  }
  const isStaticOnly = provider.isStaticOnly;
  let overloads: readonly SymbolDefinition[] = rawOverloads;
  let filteredAny = false;
  if (isStaticOnly !== undefined) {
    const survivors: SymbolDefinition[] = [];
    for (const candidate of rawOverloads) {
      if (isStaticOnly(candidate) === true) {
        filteredAny = true;
        continue;
      }
      survivors.push(candidate);
    }
    overloads = survivors;
  }
  if (overloads.length === 0) {
    // Every candidate was static-only; the caller (Case 4 chain walk)
    // should walk on to the next owner AND remember that filtering
    // happened so it can mark the site handled if the whole chain
    // ends with no legitimate match.
    return filteredAny ? STATIC_ONLY_FILTERED : undefined;
  }
  if (overloads.length === 1) return overloads[0];

  const candidates = narrowOverloadCandidates(overloads, site.arity, site.argumentTypes, {
    argumentTypeClasses: site.argumentTypeClasses,
    conversionRankFn: provider.conversionRankFn,
    conversionOnlyArgTypePrefixes: provider.conversionOnlyArgTypePrefixes,
    constraintCompatibility: provider.constraintCompatibility,
  });
  // Same ambiguity handling as `pickOverload`: when normalization
  // collapses the surviving overloads into a single bucket (e.g., C++
  // `f(int)`/`f(long)` normalized to `['int']`), suppress rather than
  // arbitrarily picking. When narrowing leaves >1 distinct candidate
  // with no tie-breaker, suppress for the same reason.
  if (isOverloadAmbiguousAfterNormalization(candidates, site.arity)) return OVERLOAD_AMBIGUOUS;
  if (candidates.length > 1) return OVERLOAD_AMBIGUOUS;
  return candidates[0] ?? overloads[0];
}

function suppressDeletedCallTarget(
  record: ResolutionOutcomeRecorder | undefined,
  filePath: string,
  site: ParsedFile['referenceSites'][number],
  target: SymbolDefinition,
): boolean {
  if (site.kind !== 'call' || target.isDeleted !== true) return false;
  record?.({
    kind: 'suppressed',
    phase: 'receiver-bound-calls',
    filePath,
    name: site.name,
    range: site.atRange,
    reason: 'selected-callable-deleted',
    candidateIds: [target.nodeId],
  });
  return true;
}

function recordReceiverOverloadSuppression(
  record: ResolutionOutcomeRecorder | undefined,
  filePath: string,
  site: ParsedFile['referenceSites'][number],
  ownerId: string,
  memberName: string,
  model: SemanticModel,
  provider: ReceiverBoundProviderSubset,
): void {
  if (record === undefined) return;
  const overloads = model.methods.lookupAllByOwner(ownerId, memberName);
  const candidates = narrowOverloadCandidates(overloads, site.arity, site.argumentTypes, {
    argumentTypeClasses: site.argumentTypeClasses,
    conversionRankFn: provider.conversionRankFn,
    conversionOnlyArgTypePrefixes: provider.conversionOnlyArgTypePrefixes,
    constraintCompatibility: provider.constraintCompatibility,
  });
  const reason: ResolutionSuppressionReason = isOverloadAmbiguousAfterNormalization(
    candidates,
    site.arity,
  )
    ? 'overload-ambiguous-normalization'
    : hasConversionRankingSignal(site, provider)
      ? 'conversion-rank-tied'
      : 'overload-ambiguous';
  record({
    kind: 'suppressed',
    phase: 'receiver-bound-calls',
    filePath,
    name: site.name,
    range: site.atRange,
    reason,
    candidateIds: candidates.map((d) => d.nodeId),
  });
}

function hasConversionRankingSignal(
  site: ParsedFile['referenceSites'][number],
  provider: ReceiverBoundProviderSubset,
): boolean {
  return (
    provider.conversionRankFn !== undefined &&
    site.argumentTypes !== undefined &&
    site.argumentTypes.length > 0
  );
}
