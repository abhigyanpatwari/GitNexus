/**
 * Resolve a compound-receiver expression's TYPE — `user.address.save()`,
 * `svc.get_user().save()`, `c.greet().save()` — to the class def of
 * the value the receiver expression produces.
 *
 * Three shapes (parsed C-family-style):
 *   - bare identifier `name` — look up via typeBinding chain
 *   - dotted `obj.field[.field]…` — walk fields via class-scope typeBindings
 *   - call `expr.method()` — recurse into expr, find method's return-type
 *     typeBinding on its class, resolve to a class
 *
 * **Field-fallback heuristic** (Phase-9C "unified fixpoint"): when the
 * receiver class has no `methodName`, walk its fields and try the
 * lookup on each field's type. Useful for dynamically-typed languages
 * (Python). Strictly-typed languages should pass
 * `fieldFallbackOnMethodLookup: false` via `ScopeResolver`.
 *
 * Generic for any C-family language (`.` member access, `()` call
 * syntax). Languages with non-C-family syntax (Ruby blocks, COBOL)
 * either don't trigger the call branch or skip this pass entirely.
 */

import type { ScopeId, SymbolDefinition, TypeRef } from 'gitnexus-shared';
import type { ElementAccessRoute, ScopeResolver } from '../contract/scope-resolver.js';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import type { WorkspaceResolutionIndex } from '../workspace-index.js';
import { erasedTypeApplication, stripTemplateArguments } from '../../utils/template-arguments.js';
import type { DecodedReceiverChain } from '../../utils/receiver-chain-codec.js';
import { decodeReceiverChain } from '../../utils/receiver-chain-codec.js';
import type { DecorationStripper } from '../scope/walkers.js';
import {
  findClassBindingInScope,
  resolveClassBindingForName,
  findEnclosingClassDef,
  findExportedDef,
  findExportedDefByName,
  findReceiverTypeBinding,
  isClassLike,
  isNamespaceNameShadowed,
} from '../scope/walkers.js';

/** Max depth for compound-receiver chain resolution (`a().b().c().d()`).
 *  Practical code rarely exceeds 3-4 _syntactic_ hops, but languages
 *  with type-binding-mediated chains (Ruby's `x = obj.method()` binds
 *  `x → obj.method()` and recurses through the compound resolver) can
 *  triple the depth count because each intermediate step contributes
 *  two recursions (bare-ident → compound rawName → call-expr parse).
 *  8 covers 3-level chains with headroom while still capping
 *  pathological recursion. */
const COMPOUND_RECEIVER_MAX_DEPTH = 8;

const MAP_TUPLE_SENTINEL_RE = /^__MAP_TUPLE_(\d+)__:(.+)$/;

/** Cast type the resolver can look up directly: a simple identifier. */
const SIMPLE_CAST_TYPE_RE = /^[a-zA-Z_]\w*$/;

/** Classification-only shape for a cast type that is recognizable but
 *  NOT resolvable here: dotted qualifier (`com.example.Foo`), generic
 *  (`List<String>`), array (`Foo[]`), or combinations
 *  (`com.example.List<Foo>[]`) — shape `Ident(.Ident)*(<…>)?([])*`,
 *  whitespace-tolerant. No attempt is made to parse generic contents;
 *  `[^()]*` merely keeps expression-like paren content from matching.
 *  Matching this shape (when the simple-identifier shape doesn't)
 *  means the paren group IS a C-style cast whose target type we cannot
 *  look up — the only safe outcome is to resolve nothing, never to
 *  fall through to the pre-cast expression's own declared type. */
const UNPARSEABLE_CAST_TYPE_RE =
  /^[a-zA-Z_]\w*(?:\s*\.\s*[a-zA-Z_]\w*)*(?:\s*<[^()]*>)?(?:\s*\[\s*\])*$/;

function parseMapTupleSentinel(text: string): { tupleIdx: number; rhs: string } | null {
  const match = MAP_TUPLE_SENTINEL_RE.exec(text);
  if (match === null) return null;
  const [, idxStr, rhs] = match;
  if (idxStr === undefined || rhs === undefined) return null;
  return { tupleIdx: Number(idxStr), rhs };
}

interface ResolveCompoundReceiverOptions {
  /** When true (default), if method lookup fails on the receiver's
   *  class, walk its fields and try the lookup on each field's class.
   *  Phase-9C "unified fixpoint" — Python-shaped heuristic. */
  readonly fieldFallback?: boolean;
  /** Container -> element, by subscript (`repos[0]`) or accessor (`data.Values`
   *  on a `Dictionary<K,V>` yields V). Returns the element type's simple name,
   *  or `undefined`. See the `ScopeResolver` field of the same name for why the
   *  two routes share one hook, and for why `undefined` on the `index` route
   *  means "not a container" — a step that gets it DECLINES, so a language must
   *  answer that route to get index folding at all. */
  readonly elementTypeOf?: (containerType: string, via: ElementAccessRoute) => string | undefined;
  /** Walk up from the class scope to ancestor (Module) scopes when
   *  looking up a method's return-type typeBinding. Only enable for
   *  languages that hoist return-type bindings to Module scope (C#);
   *  otherwise we risk picking up unrelated module-level bindings. */
  readonly hoistTypeBindingsToModule?: boolean;
  /** `ScopeResolver.resolveThisViaEnclosingClass` — the language declares that
   *  `this` IS the enclosing class rather than a per-function-scope binding.
   *  Read only by the `this` head seed below. */
  readonly resolveThisViaEnclosingClass?: boolean;
  /** Strip C-style cast expressions from the receiver text before
   *  resolving it (`stripCastWrappers`). Default `false` — the text
   *  reaches the resolver untouched and no cast logic runs. See the
   *  `ScopeResolver` contract toggle of the same name for the
   *  classifier grammar and per-language opt-in rules. */
  readonly stripReceiverCastExpressions?: boolean;
  /** Surface syntax this language uses to construct a value, so an
   *  inline constructor receiver can be typed. Derived from the contract
   *  rather than re-declared, so a future sub-field cannot be added there
   *  and silently ignored here (#2708). */
  readonly constructionSyntax?: ScopeResolver['constructionSyntax'];
  /** Verified namespace handles visible in the current file. */
  readonly namespaceTargets?: ReadonlyMap<string, readonly string[]>;
  /** Compact receiver chain for THIS site (`ReferenceSite.receiverChain`), when
   *  the language's capture emitter produced one. Present ⇒ the structural fold
   *  is tried before the text cascade; absent ⇒ behaviour is exactly as before.
   *  Consumed only at `depth === 0`: it describes the site's own receiver, so
   *  carrying it into a recursive call would re-fold it against an inner
   *  expression it does not describe. */
  readonly receiverChain?: string;
  /** Resolve a BARE identifier the way the dotted-chain head does: when a
   *  receiver typeBinding exists for the name, that binding decides the type and
   *  nothing else does. Off by default, so the text cascade keeps its existing
   *  (more permissive) behaviour; the structural fold turns it ON.
   *
   *  Without it, the bare-identifier branch falls through to a plain class-name
   *  lookup EVEN WHEN a binding existed but named no class — which types a local
   *  that merely SHADOWS a class as that class. That fabricated a `CALLS` edge
   *  (`const Config = make(1); Config.db.query()` emitted `entry → Database.query`),
   *  the exact wrong-edge failure this work exists to avoid. */
  readonly strictBaseBinding?: boolean;
  /** Per-language type-preserving decoration stripper, from the `ScopeResolver`
   *  contract. Passed to the class lookup at the base and step sites so a
   *  decorated declared type (`*Host`) resolves to its class. Absent for
   *  languages whose declared types carry no such decoration, and never applied
   *  by the shared lookup's other callers — see the contract's own note on why
   *  this is opt-in rather than global. */
  readonly stripTypePreservingDecoration?: DecorationStripper;
}

/** Is this hop the language's construction selector applied to the class
 *  itself — `Factory.new` — rather than an ordinary member named `new` on a
 *  value? Both call sites ask the identical question, so it is asked in one
 *  place (#2708). `onClassConstant` is what separates `Factory.new` from
 *  `factory.new`; see the contract field for the known limitation around a
 *  class-level override of the selector. */
function isConstructionSelectorHop(
  memberName: string,
  receiverClass: SymbolDefinition,
  onClassConstant: boolean,
  options: ResolveCompoundReceiverOptions,
): boolean {
  return (
    onClassConstant &&
    options.constructionSyntax?.selector === memberName &&
    isClassLike(receiverClass.type)
  );
}

/** Escape a literal for embedding in a RegExp. The construction keyword comes
 *  from a language provider, so it is not user input, but a keyword containing
 *  a metacharacter would otherwise silently build a wrong pattern. */
function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Type of a construction expression's callee — the class it constructs.
 *
 * `Service` (bare, when the language constructs without a keyword) and
 * `new Service` (keyword form) both name the class being built, so the
 * expression's type is that class. Together with
 * `isConstructionSelectorHop` (the `Class.new` spelling), this is where the
 * rule "constructing a class yields an instance of it" lives; the
 * per-language surface syntax arrives via `constructionSyntax` (#2708).
 *
 * Returns undefined when the language declares no construction syntax,
 * when the callee names no class-like symbol reachable from `inScope`,
 * or when the keyword is required but absent — never a guess.
 */
function resolveConstructionExpressionClass(
  fnExpr: string,
  inScope: ScopeId,
  scopes: ScopeResolutionIndexes,
  index: WorkspaceResolutionIndex,
  options: ResolveCompoundReceiverOptions,
): SymbolDefinition | undefined {
  const syntax = options.constructionSyntax;
  if (syntax === undefined) return undefined;

  let calleeName: string | undefined;
  // The keyword is separated from the type by whatever trivia the source
  // used — `new Service`, `new\tService`, or a line break — so match the
  // keyword as a whole token followed by at least one whitespace character
  // rather than by exactly one space (#2708). `newService()` keeps failing
  // the match, which is the point: it is an ordinary call.
  const keywordMatch =
    syntax.keyword === undefined
      ? null
      : new RegExp(`^${escapeForRegExp(syntax.keyword)}\\s+`).exec(fnExpr);
  if (keywordMatch !== null) {
    calleeName = fnExpr.slice(keywordMatch[0].length).trim();
  } else if (syntax.bare === true) {
    calleeName = fnExpr;
  }
  // A `new`-keyword language reaching here without the keyword is an
  // ordinary free call, not a construction — resolving it to the class
  // would fabricate an edge (a factory function may share the class's
  // name).
  if (calleeName === undefined || calleeName.length === 0) return undefined;

  // Generic construction — `new Box<string>()` arrives here as `Box<string>`,
  // which names no class binding. Retry on the base name, the same
  // normalization `resolveClassBindingForName` (in `scope/walkers.ts`) already
  // applies for typed receivers (#2708).
  const baseName = stripTemplateArguments(calleeName).trim();
  const lastDot = baseName.lastIndexOf('.');
  if (lastDot !== -1) {
    const namespaceName = baseName.slice(0, lastDot);
    const exportedName = baseName.slice(lastDot + 1);
    const namespaceFiles = options.namespaceTargets?.get(namespaceName) ?? [];
    // A verified namespace is authoritative: do not fall through to the
    // workspace-wide simple-name heuristics on either a miss or ambiguity.
    if (namespaceFiles.length > 0) {
      if (isNamespaceNameShadowed(namespaceName, inScope, scopes)) return undefined;
      const namespaceMatches = namespaceFiles
        .map((targetFile) => findExportedDef(targetFile, exportedName, index))
        .filter((def): def is SymbolDefinition => def !== undefined && isClassLike(def.type));
      return namespaceMatches.length === 1 ? namespaceMatches[0] : undefined;
    }
  }

  const direct = findClassBindingInScope(inScope, calleeName, scopes);
  if (direct !== undefined && isClassLike(direct.type)) return direct;

  if (baseName.length > 0 && baseName !== calleeName) {
    const viaBaseName = findClassBindingInScope(inScope, baseName, scopes);
    if (viaBaseName !== undefined && isClassLike(viaBaseName.type)) return viaBaseName;
  }

  // Qualified callee — `new ns.Service()` / `new Outer.Inner()`. Prefer an
  // unambiguous qualified-name match, then fall back to the trailing simple
  // name the way receiver resolution does elsewhere (#2708).
  if (lastDot === -1) return undefined;

  const qualifiedIds = scopes.qualifiedNames.get(baseName);
  if (qualifiedIds.length === 1) {
    const qualified = scopes.defs.get(qualifiedIds[0]!);
    if (qualified !== undefined && isClassLike(qualified.type)) return qualified;
  }
  const simpleName = baseName.slice(lastDot + 1);
  if (simpleName.length === 0) return undefined;
  const viaSimpleName = findClassBindingInScope(inScope, simpleName, scopes);
  return viaSimpleName !== undefined && isClassLike(viaSimpleName.type) ? viaSimpleName : undefined;
}

/**
 * One position in a fold: the class the chain has reached, PLUS the declared
 * type text that produced it.
 *
 * The declared type is carried for two reasons, and the index step is its only
 * reader. First, it is the CONTAINER evidence that step demands: capture
 * normalizes `repos: User[]` down to `User`, so the resolved class alone cannot
 * tell a reduced container from a class the source merely subscripted, and
 * folding on that ambiguity typed `grid[0].run()` as `Grid.run`. Second, a
 * declared type that named NO class is still a usable position —
 * `Promise<User>` and `[]Repo` match nothing in the workspace — because a later
 * step may unwrap it; keeping only the class would strand those shapes at the
 * step that produced them.
 *
 * `undefined` when the position was reached by a route that has no declared type
 * to report (a static class receiver, say). A step needing one declines rather
 * than guessing.
 */
interface FoldState {
  /**
   * Absent when the position's declared type named no class — `Promise<User>`
   * and `[]Repo` name nothing in the workspace. ONE signal, not two: an earlier
   * version carried a separate `unresolvedDeclaredType` flag alongside a `def`
   * holding the PREVIOUS position, which no path ever read. Two sources of
   * truth for one fact, and the dead `def` read as intentional.
   *
   * Only an unwrapping step (await, index) can advance from an absent `def`;
   * every other step declines, because folding on against the previous class
   * would look the next member up on the wrong owner.
   */
  readonly def: SymbolDefinition | undefined;
  /**
   * The declared type AS WRITTEN — the spelling when capture normalized one
   * away (`TypeRef.declaredSpelling`), else `rawName` (they are the same string
   * when nothing was normalized). Only the index step reads it, and only the
   * as-written form separates `repos: User[]` from `grid: Grid`: both reduce to
   * a bare, resolvable class name.
   */
  readonly declaredType?: string;
  readonly declaredAtScope?: ScopeId;
}

/**
 * The class a receiver position's DECLARED TYPE denotes — the one lookup every
 * route in this file uses to turn a `TypeRef` into an owner to look the next
 * member up on.
 *
 * ── WHY NOT `findClassBindingInScope(scope, typeRef.rawName)` ────────────────
 *
 * `rawName` is post-normalization, and several providers reduce a type
 * APPLICATION to its base name at capture time (`Mapped[User]` → `Mapped`,
 * `Repo<User>` → `Repo`). Handing that base name to the bare lookup takes its
 * workspace-wide qualified-name fallback, which consults no scope, no import
 * and no module: it binds whatever the workspace happens to declare under that
 * name. A third-party `Mapped[User]` beside an unrelated workspace
 * `class Mapped` then produces a confident WRONG edge — strictly worse than the
 * missing one it replaced, and not recoverable downstream.
 *
 * `resolveClassBindingForName` owns the grounding rule for exactly this
 * ({@link resolveErasedBaseName}: the scope chain binds the name, or the
 * declaration is in the same file, or the index proves the name is a template
 * family, or the file has no cross-file class channel to be absent from), but it
 * is entered on the SPELLING — a name that already lost its arguments is
 * indistinguishable from an ordinary class name. {@link erasedTypeApplication}
 * restores the application from `declaredSpelling`, which is what puts a
 * capture-time-erased receiver back on the grounded route.
 *
 * ── WHY IT IS ONE HELPER AND NOT FIVE CALL SITES ─────────────────────────────
 *
 * This file types a receiver position from a `TypeRef` in five places — the
 * structural fold's member step and its module-hoist branch, the cascade's
 * bare-identifier binding, the cascade's dotted-chain HEAD, and the cascade's
 * per-segment member walk. They are five routes to ONE question, and only three
 * were wired to the grounded lookup, which is what left the hole: a Python
 * `self.m.save(u)` whose fold step correctly refused fell THROUGH to the
 * cascade — a declined fold is documented as "no answer", never a veto — and
 * the cascade's own ungrounded member walk re-minted the very edge the grounds
 * had just rejected. One shared helper is what makes "the fold refused" and
 * "the cascade refused" the same sentence, rather than two lookups that happen
 * to agree until one of them is edited.
 *
 * `stripDecoration` stays a per-caller argument because it is a DIFFERENT
 * normalization with its own risk — its own docstring records that turning a
 * former `undefined` into a hit suppresses the `?? otherResolver(...)`
 * fallbacks two dozen call sites rely on. The three fold/binding callers pass
 * the provider's stripper as they always have; the two cascade callers pass
 * nothing, as they always have. So the only behaviour this helper changes
 * anywhere is the erasure grounding, and a `TypeRef` that was never reduced
 * resolves through the identical `findClassBindingInScope` call it did before
 * (`resolveClassBindingForName` tries that first, and a name with no `<`
 * returns immediately after it).
 */
function classOfDeclaredType(
  typeRef: TypeRef,
  scopes: ScopeResolutionIndexes,
  stripDecoration?: DecorationStripper,
): SymbolDefinition | undefined {
  // `declaredAtScope`, never a scope the caller chose: all five sites passed
  // exactly this `TypeRef`'s own anchor, and taking it as a parameter is what
  // would let a sixth quietly not — which is the hole this helper exists to
  // close, one level up.
  return resolveClassBindingForName(
    typeRef.declaredAtScope,
    erasedTypeApplication(typeRef) ?? typeRef.rawName,
    scopes,
    stripDecoration,
  );
}

function typeOfMemberOnClass(
  owner: SymbolDefinition,
  memberName: string,
  scopes: ScopeResolutionIndexes,
  index: WorkspaceResolutionIndex,
  options: ResolveCompoundReceiverOptions,
): FoldState | undefined {
  const classScopeByDefId = index.classScopeByDefId;
  const ownerChain = [owner.nodeId, ...scopes.methodDispatch.mroFor(owner.nodeId)];
  for (const ownerId of ownerChain) {
    const classScope = classScopeByDefId.get(ownerId);
    const memberType = classScope?.typeBindings.get(memberName);
    if (memberType !== undefined) {
      const def = classOfDeclaredType(memberType, scopes, options.stripTypePreservingDecoration);
      // The declared type is reported even when it resolved to no class:
      // `Promise<User>` and `[]Repo` name nothing in the workspace, and an
      // await or index step unwrapping them is exactly how they become
      // resolvable. Returning `undefined` here would strand those shapes. A
      // `def` that stayed absent is reported as absent, NOT as the previous
      // owner, so nothing may fold an ordinary member off this position.
      return {
        def,
        declaredType: memberType.declaredSpelling ?? memberType.rawName,
        declaredAtScope: memberType.declaredAtScope,
      };
    }
    // Languages whose binding-scope hook hoists a method's return-type binding
    // out of the class body and onto an ancestor (Module) scope keep NOTHING in
    // the class scope to find — TypeScript is one, via `tsBindingScopeFor`, so
    // without this walk the fold cannot type a single step in the first
    // language it ships for. Gated on the same contract flag
    // `resolveCompoundReceiverClass` uses, so a language that does not hoist
    // cannot pick up an unrelated module-level binding of the same name.
    if (classScope !== undefined && options.hoistTypeBindingsToModule === true) {
      let curId: ScopeId | null = classScope.parent;
      while (curId !== null) {
        const curScope = scopes.scopeTree.getScope(curId);
        if (curScope === undefined) break;
        const hoisted = curScope.typeBindings.get(memberName);
        if (hoisted !== undefined) {
          // Same stripper the primary branch above passes. Omitting it here
          // meant a decorated declared type (`*Host`) resolved on one branch and
          // not the other, for the same member of the same class.
          const def = classOfDeclaredType(hoisted, scopes, options.stripTypePreservingDecoration);
          // Identical to the primary branch: a declared type that named no
          // class is still a usable position when the next step unwraps it.
          // Returning `undefined` here made `svc.getMap()['k'].run()` decline
          // while byte-identical `byId['k'].run()` resolved, purely because ten
          // languages route return-type bindings through this hoisted branch
          // and the other through the class scope.
          return {
            def,
            declaredType: hoisted.declaredSpelling ?? hoisted.rawName,
            declaredAtScope: hoisted.declaredAtScope,
          };
        }
        curId = curScope.parent;
      }
    }
  }
  return undefined;
}

/**
 * Type a receiver from its decoded structure instead of from its source text.
 *
 * Resolves the base, then folds the steps base-first, each step typed against
 * the class the previous step produced. Returns `undefined` the moment any step
 * fails to type, so the caller falls back to the existing text cascade rather
 * than receiving a partially-folded guess — a missing edge is recoverable, a
 * confidently wrong one is not.
 *
 * The base is resolved by handing it to `resolveCompoundReceiverClass`, which
 * already owns the bare-identifier path in full: type binding, static
 * class-name receivers, map-tuple sentinels, member aliases and call-result
 * aliases. A second implementation of that would drift from it.
 *
 * Called from `resolveCompoundReceiverClass` ahead of the text cascade, and only
 * when the site carries a `receiverChain` (see the `depth === 0` gate below).
 */
export function foldReceiverChain(
  chain: DecodedReceiverChain,
  inScope: ScopeId,
  scopes: ScopeResolutionIndexes,
  index: WorkspaceResolutionIndex,
  options: ResolveCompoundReceiverOptions = {},
): SymbolDefinition | undefined {
  // A truncated chain is missing the head that decides the final type. The
  // producer refuses to mint one, so this is defence in depth against a
  // future producer that does.
  if (chain.truncated) return undefined;
  if (chain.steps.length === 0) return undefined;

  // `receiverChain` is dropped before resolving the base: it describes the
  // whole receiver, and handing it back to the resolver would re-enter this
  // fold on the base and never terminate.
  const baseDef = resolveCompoundReceiverClass(chain.baseReceiverName, inScope, scopes, index, {
    ...options,
    fieldFallback: false,
    receiverChain: undefined,
    strictBaseBinding: true,
  });
  // The base's own declared type is carried too, so a chain whose FIRST step is
  // an unwrap (`repos[0].save()` — index applied directly to the base) has the
  // container spelling available. Without it that shape declines at step 1.
  // Looked up ONLY when something will read it: the base failed to resolve (so
  // an unwrap step is the last chance), or an index step will unwrap the
  // container. `resolveCompoundReceiverClass` already walked the scope chain for
  // this same name above, so doing it unconditionally duplicated that walk on
  // every fold — and the U10 census says 86% of chains are pure field/call and
  // never read it.
  const needsBaseDeclaredType =
    baseDef === undefined || chain.steps.some((step) => step.kind === 'index');
  const baseBinding = needsBaseDeclaredType
    ? findReceiverTypeBinding(inScope, chain.baseReceiverName, scopes)
    : undefined;

  // A base whose declared type names no class is NOT automatically a dead end:
  // `repos: User[]` binds to the literal `User[]`, which matches no class
  // because a container is not one. That position is still usable IF the next
  // step unwraps it — which is exactly what an index step does. Carrying it
  // forward with the marker lets that step recover; every other step kind
  // declines on the marker, so nothing folds against a phantom owner.
  if (baseDef === undefined && baseBinding === undefined) return undefined;
  let current: FoldState = {
    def: baseDef,
    declaredType: baseBinding?.declaredSpelling ?? baseBinding?.rawName,
    declaredAtScope: baseBinding?.declaredAtScope,
  };

  for (const step of chain.steps) {
    // A position whose declared type named no class can only be advanced by an
    // unwrapping step. Folding an ordinary member off it would look the member
    // up on the PREVIOUS class — a wrong owner, silently.
    //
    // `await` IS identity, and soundly so: every language whose capture layer
    // reduces the wrapper has ALREADY done it by the time a binding reaches the
    // fold (TypeScript strips `Promise<X>`, C# strips `Task<X>`), and awaiting a
    // value that is NOT a thenable yields that same value — so both regimes land
    // on the identical answer and there is nothing to distinguish.
    if (step.kind === 'await') continue;
    if (step.kind === 'index') {
      // An index step is NOT identity, and that asymmetry with `await` above is
      // the whole point. `await` on a non-promise is a no-op; a subscript on a
      // non-container is not — it yields the element of an indexer whose type
      // is a different class entirely.
      //
      // The NORMALIZED type name cannot tell the two regimes apart: capture
      // reduces `repos: User[]` to `User`, so a reduced container and a class
      // the source merely subscripted (`grid: Grid` where `Grid` declares an
      // index signature) both arrive as a bare, resolvable class name. Falling
      // back to identity there kept `current` on the CONTAINER and looked the
      // next member up on it — `grid[0].run()` → `Grid.run`, `t[0].Render()` →
      // `Table.Render`. A confidently wrong owner, which is strictly worse than
      // no edge and invisible to a bench that scores edge PRESENCE.
      //
      // So the step demands positive evidence instead: `declaredType`, the
      // AS-WRITTEN spelling (`TypeRef.declaredSpelling`, preserved precisely
      // because `rawName` threw it away), handed to the language's
      // `elementTypeOf`. A provider that does not recognize the spelling as a
      // container is answering "not a container", and the only sound move is to
      // decline — a language must therefore answer the `index` route to get
      // index folding at all.
      const declared = current.declaredType;
      const element =
        declared === undefined ? undefined : options.elementTypeOf?.(declared, { kind: 'index' });
      if (element === undefined) return undefined;
      const scopeForLookup = current.declaredAtScope ?? inScope;
      const elementClass = findClassBindingInScope(
        scopeForLookup,
        element,
        scopes,
        options.stripTypePreservingDecoration,
      );
      if (elementClass === undefined) return undefined;
      current = {
        def: elementClass,
        declaredType: element,
        declaredAtScope: scopeForLookup,
      };
      continue;
    }
    // Construction is NOT an ordinary member lookup. `Factory.new` on a class
    // constant denotes an instance of Factory, and the cascade already encodes
    // that (`isConstructionSelectorHop`) along with the class-constant test that
    // separates it from an instance method genuinely named `new`. The fold
    // carries no such distinction — a chain step records a name, not whether its
    // base was a class reference or a value — so folding one would resolve
    // `Factory.new.run` against whatever member named `new` the lookup reaches
    // first. That turned a correct edge into a WRONG one (Ruby
    // `Factory.new.run` → `Product.run`), which is the failure mode this whole
    // line of work exists to avoid. Decline and let the cascade answer.
    //
    // Placed AFTER the name-free continues above, deliberately. When it sat
    // first, `options.constructionSyntax?.selector === step.name` compared
    // `undefined === undefined` for every await/index step in a language with no
    // construction selector, vetoing the entire fold before it ran — which is
    // why those receivers minted a chain, fired the gate, and produced no edge.
    // Position, not a guard, is what makes that unreachable: only named steps
    // get here.
    if (options.constructionSyntax?.selector === step.name) return undefined;
    if (current.def === undefined) return undefined;
    const next = typeOfMemberOnClass(current.def, step.name, scopes, index, options);
    if (next === undefined) return undefined;
    current = next;
  }
  // A chain that ended without a class returns undefined naturally — no
  // separate guard, because `def` IS the signal.
  return current.def;
}

export function resolveCompoundReceiverClass(
  receiverText: string,
  inScope: ScopeId,
  scopes: ScopeResolutionIndexes,
  index: WorkspaceResolutionIndex,
  options: ResolveCompoundReceiverOptions = {},
  depth = 0,
): SymbolDefinition | undefined {
  const classScopeByDefId = index.classScopeByDefId;
  if (depth > COMPOUND_RECEIVER_MAX_DEPTH) return undefined;
  const text = receiverText.trim();
  if (text.length === 0) return undefined;
  const fieldFallback = options.fieldFallback ?? true;

  // ── Structural fold, ahead of the text cascade ───────────────────
  // When the capture layer produced a chain for this site, type the receiver
  // from that structure. The cascade below dispatches on enumerated textual
  // shapes, so every new spelling (`?.`, `!`, `<T>`, `->`) needs another branch;
  // the AST already knew the answer and the chain carries it.
  //
  // Only at depth 0 — the chain describes THIS site's receiver, not the inner
  // expressions the cascade recurses into.
  //
  // A failed fold falls through rather than returning: structure is an
  // additional route to an answer, never a veto on the existing one, so a site
  // the cascade could already resolve keeps resolving.
  if (depth === 0 && options.receiverChain !== undefined) {
    const decoded = decodeReceiverChain(options.receiverChain);
    if (decoded !== undefined) {
      const folded = foldReceiverChain(decoded, inScope, scopes, index, options);
      if (folded !== undefined) return folded;
    }
  }

  // ── Pre-processing: strip C-style cast expressions (opt-in) ──────
  // Cast-wrapped receivers like ((Type)((Object)this.field)).method()
  // produce parenthesized-expression receiver text. For languages that
  // opt in via `stripReceiverCastExpressions`, peel outer (Type)
  // layers so the resolver sees the actual receiver (e.g. this.field)
  // — `stripCastWrappers` documents the classification rules. When
  // the toggle is off, the text reaches the resolver untouched and no
  // cast logic runs.
  let workingText = text;
  if (options.stripReceiverCastExpressions === true && text.startsWith('(')) {
    const stripped = stripCastWrappers(text);
    // A recognized cast whose target type cannot be looked up here:
    // the only safe outcome is to resolve nothing — falling through
    // to the pre-cast expression's own declared type would emit a
    // confident wrong edge.
    if (stripped.unresolvableCast) return undefined;
    workingText = stripped.workingText;
    // A captured cast type names the exact receiver type for method
    // resolution — the cast narrows the receiver's declared type, so
    // resolve to the CAST type, not the underlying expression's type.
    if (stripped.castType !== undefined) {
      const cls = findClassBindingInScope(inScope, stripped.castType, scopes);
      if (cls !== undefined) return cls;
    }
  }

  // ── End pre-processing ─────────────────────────────────────────

  // Bare identifier — resolve via typeBinding first, then fall back to
  // a direct class-name lookup. The class-name fallback handles
  // "static receiver" shapes like `UserService.findUser()` where
  // `UserService` isn't a variable but a class imported into scope.
  if (!workingText.includes('.') && !workingText.includes('(')) {
    const mapTuple = parseMapTupleSentinel(workingText);
    if (mapTuple !== null) {
      const rhsTb = findReceiverTypeBinding(inScope, mapTuple.rhs, scopes);
      if (rhsTb === undefined) return undefined;
      const arg = extractShallowMapTypeArgByIndex(rhsTb.rawName, mapTuple.tupleIdx);
      if (arg === undefined) return undefined;
      return findClassBindingInScope(rhsTb.declaredAtScope, arg, scopes);
    }

    // A language may declare that `this` IS the enclosing class rather than a
    // per-function-scope binding (`ScopeResolver.resolveThisViaEnclosingClass`,
    // the same flag Case 0.5 in `receiver-bound-calls` uses for a BARE `this`
    // receiver). Such a language synthesizes no `this` typeBinding anywhere, so
    // a chain whose BASE is `this` — `this->repo.save(u)`, `this.repo.save(u)` —
    // had no way to seed its head and folded to nothing. Measured for the
    // NON-generic control too, so it was never a generics gap.
    // Placed before the typeBinding read: a language that DOES bind `this` per
    // function scope never sets the flag, so nothing else can reach this.
    if (workingText === 'this' && options.resolveThisViaEnclosingClass === true) {
      const enclosing = findEnclosingClassDef(inScope, scopes);
      if (enclosing !== undefined) return enclosing;
    }

    const tb = findReceiverTypeBinding(inScope, workingText, scopes);
    if (tb !== undefined) {
      // Map for-of: binding name is `user` but rawType is
      // `__MAP_TUPLE_i__:entries` (see captures.ts) — same extraction as
      // the literal-sentinel branch above.
      const boundMapTuple = parseMapTupleSentinel(tb.rawName);
      if (boundMapTuple !== null) {
        const rhsTb = findReceiverTypeBinding(inScope, boundMapTuple.rhs, scopes);
        if (rhsTb === undefined) return undefined;
        const arg = extractShallowMapTypeArgByIndex(rhsTb.rawName, boundMapTuple.tupleIdx);
        if (arg === undefined) return undefined;
        return findClassBindingInScope(rhsTb.declaredAtScope, arg, scopes);
      }

      const viaTb = classOfDeclaredType(tb, scopes, options.stripTypePreservingDecoration);
      if (viaTb !== undefined) return viaTb;

      // Member-alias / call-result shapes store the RHS path on rawName
      // (`user.address`, `addr.getCity`) — resolve as a compound chain.
      if (tb.rawName.includes('.') && !tb.rawName.includes('(')) {
        const dotted = resolveCompoundReceiverClass(
          tb.rawName,
          inScope,
          scopes,
          index,
          options,
          depth + 1,
        );
        if (dotted !== undefined) return dotted;
        const dottedCall = resolveCompoundReceiverClass(
          `${tb.rawName}()`,
          inScope,
          scopes,
          index,
          options,
          depth + 1,
        );
        if (dottedCall !== undefined) return dottedCall;
      }

      // Callable alias (`const user = getUser()` → type rawName `getUser`)
      if (!tb.rawName.includes('.') && !tb.rawName.includes('(')) {
        const callAlias = resolveCompoundReceiverClass(
          `${tb.rawName}()`,
          inScope,
          scopes,
          index,
          options,
          depth + 1,
        );
        if (callAlias !== undefined) return callAlias;
      }

      // Compound member-call alias: rawName has both `.` and `()`
      // (`user = Factory.get_user()` → rawName `Factory.get_user()`).
      // Recurse into the compound resolver with the raw compound
      // expression so the mixed-chain parser can split at top-level
      // `.` and resolve the receiver + method return type.
      if (tb.rawName.includes('.') && tb.rawName.includes('(')) {
        const compound = resolveCompoundReceiverClass(
          tb.rawName,
          inScope,
          scopes,
          index,
          options,
          depth + 1,
        );
        if (compound !== undefined) return compound;
      }
    }
    // Mirror the dotted-chain head rule below (`headType ? … : …`): a binding
    // that EXISTS but resolves to no class means "not a typed receiver", not
    // "try the class namespace instead". Only the structural fold opts in; the
    // cascade keeps its historical fallthrough so no existing edge moves.
    if (tb !== undefined && options.strictBaseBinding === true) return undefined;
    return findClassBindingInScope(inScope, workingText, scopes);
  }

  // Trailing `()` — call expression. Strip it and resolve the function
  // expression's return type. We only handle the canonical `f()` /
  // `obj.method()` shape; nested-arg expressions like `f(g())` are
  // out of scope for V1 (depth-capped recursion catches infinite loops).
  if (workingText.endsWith(')')) {
    const openIdx = matchingOpenParen(workingText);
    if (openIdx === -1) return undefined;
    const fnExpr = workingText.slice(0, openIdx).trim();
    if (fnExpr.length === 0) return undefined;

    // A keyword-marked construction is never an `obj.method()` call, even when
    // the type is qualified (`new ns.Service()`), so it must be resolved before
    // the dot-split below routes it into member resolution (#2708).
    const keyword = options.constructionSyntax?.keyword;
    if (keyword !== undefined && new RegExp(`^${escapeForRegExp(keyword)}\\s`).test(fnExpr)) {
      return resolveConstructionExpressionClass(fnExpr, inScope, scopes, index, options);
    }

    const lastDot = fnExpr.lastIndexOf('.');
    if (lastDot === -1) {
      // Free call `name()`. Look up function in scope, then its
      // return-type typeBinding (which lives in the function's
      // enclosing scope per the language's return-type hoist rule).
      const fnDef = findExportedDefByName(fnExpr, inScope, scopes, index);
      if (fnDef !== undefined) {
        const retType = findReceiverTypeBinding(inScope, fnExpr, scopes);
        const viaReturn =
          retType === undefined
            ? undefined
            : findClassBindingInScope(retType.declaredAtScope, retType.rawName, scopes);
        if (viaReturn !== undefined) return viaReturn;
      }
      // Inline construction — `Service(db).m()` / `new Service(db).m()`.
      // The constructed value IS the receiver, so there is no binding to
      // read a type off; the return-type path above cannot help either,
      // because a class has no return-type binding. Type it from the
      // class the callee names (#2708).
      return resolveConstructionExpressionClass(fnExpr, inScope, scopes, index, options);
    }

    // `obj.method()` — resolve obj's class, look up method's return
    // type on that class scope (or the MRO).
    const objExpr = fnExpr.slice(0, lastDot);
    const methodName = fnExpr.slice(lastDot + 1);
    const objClass = resolveCompoundReceiverClass(
      objExpr,
      inScope,
      scopes,
      index,
      options,
      depth + 1,
    );
    if (objClass === undefined) {
      // A verified namespace-qualified bare constructor is syntactically
      // indistinguishable from an untyped member call here. Only the namespace
      // map makes the constructor interpretation safe.
      if (options.namespaceTargets?.has(objExpr) === true) {
        return resolveConstructionExpressionClass(fnExpr, inScope, scopes, index, options);
      }
      return undefined;
    }

    // Does `objExpr` name the CLASS ITSELF (`Factory.new`) rather than a
    // value whose type is that class (`factory.new`)? Only the former is
    // a construction — see the selector fallback below. A bare identifier
    // that resolves straight to the class binding is the class constant;
    // anything reached through a typeBinding is an instance.
    const objIsClassConstant =
      !objExpr.includes('(') &&
      !objExpr.includes('.') &&
      findClassBindingInScope(inScope, objExpr, scopes)?.nodeId === objClass.nodeId;

    // Selector-form construction — `Factory.new.do_work` (#2708). Gated on the
    // receiver naming the CLASS: `factory.new` is an ordinary call to a member
    // named `new` on an instance, and reading that as construction replaced a
    // correct edge with a wrong one. For the class constant, construction wins
    // over any recorded binding for the selector, because a member named `new`
    // on a class is an instance method Ruby never reaches through the constant
    // (see the contract's KNOWN LIMITATION note for the `def self.new` case).
    if (isConstructionSelectorHop(methodName, objClass, objIsClassConstant, options)) {
      return objClass;
    }

    let retType: TypeRef | undefined;
    const ownerChain = [objClass.nodeId, ...scopes.methodDispatch.mroFor(objClass.nodeId)];
    for (const ownerId of ownerChain) {
      const cs = classScopeByDefId.get(ownerId);
      const candidate = cs?.typeBindings.get(methodName);
      if (candidate !== undefined) {
        retType = candidate;
        break;
      }
      // Fallback: walk up from the class scope looking for a return-
      // type binding on an ancestor (Module) scope. Gated on
      // `hoistTypeBindingsToModule` because only languages that hoist
      // method return-type bindings to Module scope need this path;
      // enabling it unconditionally would let other languages pick up
      // unrelated module-level bindings. See contract doc for the
      // invariant and `propagateImportedReturnTypes` for how the
      // hoisted bindings originate.
      if (cs !== undefined && options.hoistTypeBindingsToModule === true) {
        let curId: ScopeId | null = cs.parent;
        while (curId !== null) {
          const curScope = scopes.scopeTree.getScope(curId);
          if (curScope === undefined) break;
          const cand = curScope.typeBindings.get(methodName);
          if (cand !== undefined) {
            retType = cand;
            break;
          }
          curId = curScope.parent;
        }
        if (retType !== undefined) break;
      }
    }

    if (retType === undefined && fieldFallback) {
      const objCs = classScopeByDefId.get(objClass.nodeId);
      if (objCs !== undefined) {
        for (const [, fieldType] of objCs.typeBindings) {
          const fieldClass = findClassBindingInScope(
            fieldType.declaredAtScope,
            fieldType.rawName,
            scopes,
          );
          if (fieldClass === undefined) continue;
          const fcs = classScopeByDefId.get(fieldClass.nodeId);
          const candidate = fcs?.typeBindings.get(methodName);
          if (candidate !== undefined) {
            retType = candidate;
            break;
          }
        }
      }
    }

    // `Map<K,V>.values()` / `this.repos.values()` — lib `Map` often has no
    // parsed return-type binding; infer `V` from the receiver field's
    // `Map<…>` annotation when the method is `values`.
    if (retType === undefined && methodName === 'values') {
      const mapVal = resolveMapValueTypeNameFromPrefix(objExpr, inScope, scopes, index, options);
      if (mapVal !== undefined) {
        retType = {
          rawName: mapVal,
          declaredAtScope: inScope,
          source: 'return-annotation',
        };
      }
    }

    if (retType === undefined) return undefined;
    return findClassBindingInScope(retType.declaredAtScope, retType.rawName, scopes);
  }

  // Mixed dotted + call chain: `obj.field.method().field.method()…`.
  // Split at top-level `.` (those NOT inside balanced `(...)`) so a
  // middle segment like `getUser()` stays intact. Each segment is
  // either a bare identifier `field` OR `method(...)` — the former
  // resolves via the current class's typeBindings (field → type),
  // the latter resolves via the current class's typeBindings
  // (method return-type). We accept both on each hop because class
  // scopes store both method return types and field types under
  // `typeBindings` keyed by the member name.
  const parts = splitChainAtTopLevel(workingText);

  // Language-specific collection-accessor suffix (C#'s `data.Values`
  // on Dictionary<K,V>, etc.). When the provider hook recognizes
  // the final segment and unwraps the receiver's generic, return
  // the element class directly. Resolved before the field-walk
  // because Dictionary-family types aren't local class defs.
  if (options.elementTypeOf !== undefined && parts.length >= 2) {
    const last = parts[parts.length - 1];
    const headInner = parts[0];
    if (last === undefined || headInner === undefined) return undefined;
    const prefix = parts.slice(0, -1).join('.');
    let prefixType: TypeRef | undefined;
    if (parts.length === 2) {
      prefixType = findReceiverTypeBinding(inScope, prefix, scopes);
    } else {
      // Recursive resolution: walk the prefix as a dotted class chain
      // to find its typeRef. We need the TypeRef (not the class def)
      // because the hook inspects the raw generic args (e.g.
      // `Dictionary<string, User>`).
      let cur = findReceiverTypeBinding(inScope, headInner, scopes);
      for (let i = 1; i < parts.length - 1 && cur !== undefined; i++) {
        const segment = parts[i];
        if (segment === undefined) break;
        const cls = findClassBindingInScope(cur.declaredAtScope, cur.rawName, scopes);
        if (cls === undefined) {
          cur = undefined;
          break;
        }
        const cs = classScopeByDefId.get(cls.nodeId);
        cur = cs?.typeBindings.get(segment);
      }
      prefixType = cur;
    }
    if (prefixType !== undefined) {
      // `rawName`, not `declaredSpelling`, and deliberately: the accessor route
      // only fires on a multi-arg container (`Dictionary<K,V>`), which every
      // provider's capture-time normalization leaves ALONE — so the two are the
      // same string here, and reading the spelling would change nothing except
      // to widen an unmeasured surface.
      const elemName = options.elementTypeOf(prefixType.rawName, { kind: 'accessor', name: last });
      if (elemName !== undefined) {
        return findClassBindingInScope(prefixType.declaredAtScope, elemName, scopes);
      }
    }
  }

  const head = parts[0];
  if (head === undefined) return undefined;
  const headMemberName = stripCallParens(head);
  const headType = findReceiverTypeBinding(inScope, headMemberName, scopes);
  // The typed arm reads a DECLARED TYPE and so goes through the grounded lookup
  // (see {@link classOfDeclaredType}); the untyped arm resolves the head NAME as
  // the source WROTE it — a static class receiver — which was never erased and
  // keeps the bare lookup.
  //
  // NO MEASURED CASE OF ITS OWN, and that is worth saying plainly: every fixture
  // reaching here has an un-erased head (`self`, `this`, a local), for which the
  // two lookups are the same call. It is changed because leaving one of five
  // sibling reads of a `TypeRef` on the ungrounded lookup is precisely how the
  // hole below survived — three were wired, two were not, and only one of the
  // two had a fixture. See `classOfDeclaredType` for why this cannot change a
  // `TypeRef` that was never reduced.
  let currentClass: SymbolDefinition | undefined = headType
    ? classOfDeclaredType(headType, scopes)
    : findClassBindingInScope(inScope, headMemberName, scopes);
  // Whether the walk currently sits on the CLASS ITSELF rather than on a
  // value of that class. Seeded true only when the head resolved straight to
  // a class binding (`Factory.new…`); a head reached through a typeBinding
  // (`factory = Factory.new` then `factory.new…`) is already an instance.
  // Every hop past the head yields a value, so it clears below (#2708).
  let currentIsClassConstant = headType === undefined && currentClass !== undefined;
  // Head seed for a literal `this` head with no receiver typeBinding in
  // scope: languages synthesize `this` typeBindings per function scope,
  // so a chain site outside any function scope (a field initializer or
  // an instance initializer block) has none — there, the enclosing
  // class definition IS the receiver type. Restricted to initializer
  // contexts (no Function scope between the site and its class): a
  // Function scope WITHOUT a `this` typeBinding means the language
  // deliberately left `this` unbound there (object-literal methods,
  // nested plain functions, static contexts), and seeding the
  // lexically enclosing class would fabricate edges. Head resolution
  // only; the per-segment walk below is shared with every other
  // chain shape.
  //
  // A language may ALSO declare that `this` is always the enclosing class —
  // `ScopeResolver.resolveThisViaEnclosingClass`, the same flag Case 0.5 in
  // `receiver-bound-calls` already uses for a bare `this` receiver. Such a
  // language deliberately synthesizes no `this` typeBinding anywhere, so the
  // initializer-context test above can never be true inside a method body and
  // every `this->field.m()` / `this.field.m()` chain folded to nothing —
  // measured for the NON-generic control too, so it was never a generics gap.
  // Reading the provider flag keeps the rule language-free: a language that
  // does bind `this` per function scope does not set it, and is unaffected.
  if (
    currentClass === undefined &&
    headType === undefined &&
    headMemberName === 'this' &&
    (isInitializerContext(inScope, scopes) || options.resolveThisViaEnclosingClass === true)
  ) {
    currentClass = findEnclosingClassDef(inScope, scopes);
  }
  // `const user = getUser(); user.address` — the typeBinding for `user`
  // is an alias to the callee name (`getUser`), not a class. When
  // `findClassBinding` on that rawName fails, treat it as a zero-arg
  // call so return-type hoisting resolves to the class (`User`).
  if (
    currentClass === undefined &&
    headType !== undefined &&
    !headType.rawName.includes('.') &&
    !headType.rawName.includes('(')
  ) {
    currentClass = resolveCompoundReceiverClass(
      `${headType.rawName}()`,
      inScope,
      scopes,
      index,
      options,
      depth + 1,
    );
  }
  // Construction in the chain HEAD — `new Service().inner.doWork()` (#2708).
  // The head arrives as `new Service()`, which `stripCallParens` reduces to
  // `new Service`: no binding and no class of that name, so the walk was never
  // seeded and the whole chain resolved to nothing. A constructed value is an
  // instance, so `currentIsClassConstant` correctly stays false here.
  if (currentClass === undefined) {
    currentClass = resolveConstructionExpressionClass(
      headMemberName,
      inScope,
      scopes,
      index,
      options,
    );
  }

  for (let i = 1; i < parts.length && currentClass !== undefined; i++) {
    const segment = parts[i];
    if (segment === undefined) break;
    const memberName = stripCallParens(segment);
    // Selector-form construction mid-chain — `Factory.new.do_work`, including
    // the parenthesis-less spelling that never reaches the call branch above
    // (#2708). Gated on the walk sitting on the CLASS itself: after
    // `factory = Factory.new`, `factory.new` is an ordinary instance-member
    // call and must keep normal resolution.
    if (isConstructionSelectorHop(memberName, currentClass, currentIsClassConstant, options)) {
      // Constructing yields an INSTANCE of the same class: the walk stays on
      // `currentClass` but no longer sits on the class constant.
      currentIsClassConstant = false;
      continue;
    }
    const cs = classScopeByDefId.get(currentClass.nodeId);
    let memberType = cs?.typeBindings.get(memberName);
    if (
      memberType === undefined &&
      options.hoistTypeBindingsToModule === true &&
      cs !== undefined
    ) {
      let curId: ScopeId | null = cs.parent;
      while (curId !== null) {
        const curScope = scopes.scopeTree.getScope(curId);
        if (curScope === undefined) break;
        const cand = curScope.typeBindings.get(memberName);
        if (cand !== undefined) {
          memberType = cand;
          break;
        }
        curId = curScope.parent;
      }
    }
    if (memberType === undefined) {
      // Trailing segment may be a method name without `()` — e.g.
      // `this.repos.values` from a for-of iterable capture. Try the
      // call-shaped resolver before giving up.
      if (!segment.includes('(')) {
        const prefix = parts.slice(0, i).join('.');
        const asCall = resolveCompoundReceiverClass(
          `${prefix}.${memberName}()`,
          inScope,
          scopes,
          index,
          options,
          depth + 1,
        );
        if (asCall !== undefined) return asCall;
      }
      return undefined;
    }
    // THE MEASURED HOLE (#2833 follow-up). This is the cascade's copy of the
    // fold's member step, and it read the possibly-erased `rawName` directly.
    // A Python `self.m.save(u)` whose fold step refused `Mapped[User]` on
    // grounds fell through here — a declined fold is documented as "no answer",
    // never a veto — and this walk re-minted `other.py:Mapped` from the
    // workspace index. Same rule, same lookup, so the two routes now agree.
    let nextClass = classOfDeclaredType(memberType, scopes);
    if (nextClass === undefined) {
      const fromMap = unwrapMapValueToClass(memberType, scopes);
      if (fromMap !== undefined) nextClass = fromMap;
    }
    currentClass = nextClass;
    currentIsClassConstant = false;
  }
  return currentClass;
}

/**
 * Split a chain expression like `a.b().c.d()` at top-level `.`
 * separators — i.e. `.` characters NOT nested inside balanced
 * `(...)`, `[...]`, or `<...>` delimiters. Returns the segments in
 * order: `['a', 'b()', 'c', 'd()']`. Malformed input falls back to
 * a plain `split('.')`.
 */
function splitChainAtTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '<') depth++;
    else if (ch === ')' || ch === ']' || ch === '>') depth = Math.max(0, depth - 1);
    else if (ch === '.' && depth === 0) {
      out.push(text.slice(last, i));
      last = i + 1;
    }
  }
  out.push(text.slice(last));
  // Guard against pathological input (`a.` / `.a`) — drop empties.
  return out.filter((s) => s.length > 0);
}

/**
 * Strip a trailing `(...)` from a chain segment so typeBinding lookup
 * uses the member name: `'getUser()'` → `'getUser'`. Leaves bare
 * identifiers (`'address'`) unchanged. Arguments inside the parens
 * are discarded — the compound resolver is return-type only.
 */
function stripCallParens(segment: string): string {
  if (!segment.endsWith(')')) return segment;
  const open = segment.indexOf('(');
  if (open === -1) return segment;
  return segment.slice(0, open);
}

/** True when `startScope` sits under a Class scope with no Function
 *  scope in between — a field-initializer or instance-initializer
 *  context, the only place a literal `this` chain head may be seeded
 *  from the lexically enclosing class. Function bodies are excluded
 *  on purpose: a Function scope carrying no `this` typeBinding means
 *  the language deliberately left `this` unbound there. */
function isInitializerContext(startScope: ScopeId, scopes: ScopeResolutionIndexes): boolean {
  let currentId: ScopeId | null = startScope;
  const visited = new Set<ScopeId>();
  while (currentId !== null) {
    if (visited.has(currentId)) return false;
    visited.add(currentId);
    const scope = scopes.scopeTree.getScope(currentId);
    if (scope === undefined) return false;
    if (scope.kind === 'Class') return true;
    if (scope.kind === 'Function') return false;
    currentId = scope.parent;
  }
  return false;
}

/** Find the index of the `(` that matches the trailing `)` of a
 *  call-expression text. Returns -1 if unbalanced. */
function matchingOpenParen(text: string): number {
  if (!text.endsWith(')')) return -1;
  let depth = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === ')') depth++;
    else if (ch === '(') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Max peel iterations for `stripCastWrappers`. Real cast nesting —
 *  including decompiler output like `((Target)((Object)expr))` —
 *  is a handful of levels, and each cast level costs at most two
 *  peels (a redundant-paren unwrap plus the cast group itself), so
 *  16 covers 8-level nesting with headroom. Each peel rescans the
 *  working text for its matching close paren, so pathological input
 *  like `((((…))))` would otherwise cost O(N²); the cap bounds it at
 *  O(N · MAX_CAST_PEEL). Exceeding the cap bails with the not-a-cast
 *  outcome and the ORIGINAL text — all-or-nothing, never a
 *  partially-peeled result. */
const MAX_CAST_PEEL = 16;

/**
 * Peel C-style cast layers off a receiver-position expression:
 * `((Target)((Other)expr))` → `workingText` `expr`, `castType`
 * `Target`. Pure text scan — no scope or index access — consumed by
 * `resolveCompoundReceiverClass` when a language opts in via
 * `stripReceiverCastExpressions`. Track the outermost meaningful cast
 * type: the cast narrows the receiver's declared type, so the caller
 * resolves the CAST type, not the underlying expression's type.
 *
 * Each peeled paren group with a non-empty trailing expression (a
 * cast candidate) is classified three ways:
 *   (a) simple identifier (`SIMPLE_CAST_TYPE_RE`) → cast type
 *       captured (outermost capture wins; later simple groups are
 *       noise casts, as in decompiler output like
 *       `((Target)((Object)expr))`);
 *   (b) type-shaped but unparseable here — dotted / generic / array
 *       (`UNPARSEABLE_CAST_TYPE_RE`) → this IS a cast, but its type
 *       cannot be looked up: report `unresolvableCast: true` so the
 *       caller resolves nothing rather than falling through to the
 *       pre-cast expression's own declared type (the pre-#2353 safe
 *       no-op for these shapes);
 *   (c) anything else → not a cast: stop scanning and return the
 *       text peeled so far for the normal resolver.
 * A paren group with an EMPTY remainder is never a cast candidate —
 * `((…))` / `(foo)` is a redundant-paren unwrap: unwrap and re-scan
 * without capturing anything.
 *
 * Known limitation: the paren scan is not string-literal-aware — a
 * `)` inside a quoted call argument (e.g. `((T)f(")")).g`) mis-scans
 * the group boundary. Such shapes classify as not-a-cast and fall
 * through safely to the normal resolver.
 */
export function stripCastWrappers(text: string): {
  workingText: string;
  castType: string | undefined;
  unresolvableCast: boolean;
} {
  let castType: string | undefined;
  let workingText = text;
  let peels = 0;
  while (true) {
    if (!workingText.startsWith('(')) break;
    peels++;
    if (peels > MAX_CAST_PEEL) {
      return { workingText: text, castType: undefined, unresolvableCast: false };
    }
    let d = 1;
    let closeIdx = -1;
    for (let i = 1; i < workingText.length; i++) {
      if (workingText[i] === '(') d++;
      else if (workingText[i] === ')') {
        d--;
        if (d === 0) {
          closeIdx = i;
          break;
        }
      }
    }
    if (closeIdx === -1) break;
    const insideParens = workingText.slice(1, closeIdx).trim();
    const remainder = workingText.slice(closeIdx + 1).trim();
    // Empty remainder: redundant outer parens — `((…))`, or a plain
    // parenthesized expression like `(foo)`. Unwrap and re-scan.
    // Never a cast candidate: a cast needs a trailing expression, so
    // nothing is captured from this group.
    if (remainder.length === 0) {
      workingText = insideParens;
      continue;
    }
    // A cast operand starts with `(`, an identifier, or `this`. Any
    // other remainder shape (e.g. `.member` access on the paren
    // group) means this group is not a cast — leave the text for the
    // normal resolver.
    if (!remainder.startsWith('(') && !/^[a-zA-Z_]/.test(remainder)) break;
    if (SIMPLE_CAST_TYPE_RE.test(insideParens)) {
      // (a) Resolvable cast type — capture the FIRST (outermost) one.
      if (castType === undefined) castType = insideParens;
    } else if (UNPARSEABLE_CAST_TYPE_RE.test(insideParens)) {
      // (b) Type-shaped but unparseable cast. Once a simple cast type
      // has been captured, later unparseable groups are noise casts
      // and the captured type wins; otherwise report the whole
      // expression as an unresolvable cast so the caller bails out.
      if (castType === undefined) {
        return { workingText, castType: undefined, unresolvableCast: true };
      }
    } else {
      // (c) Not a cast.
      break;
    }
    workingText = remainder;
  }
  return { workingText, castType, unresolvableCast: false };
}

/** Type arguments of a shallow `Map<K,V>` / `ReadonlyMap<K,V>` (depth-aware). */
function extractShallowMapTypeArgByIndex(mapText: string, wantIndex: number): string | undefined {
  const t = mapText.trim();
  const m = /^(?:ReadonlyMap|Map)\s*</.exec(t);
  if (m === null || m.index !== 0) return undefined;
  const openIdx = m[0].length - 1;
  if (t[openIdx] !== '<') return undefined;
  let depth = 1;
  const args: string[] = [];
  let segStart = openIdx + 1;
  for (let i = openIdx + 1; i < t.length; i++) {
    const ch = t[i];
    if (ch === '<') depth++;
    else if (ch === '>') {
      depth--;
      if (depth === 0) {
        const tail = t.slice(segStart, i).trim();
        if (tail.length > 0) args.push(tail);
        break;
      }
    } else if (ch === ',' && depth === 1) {
      args.push(t.slice(segStart, i).trim());
      segStart = i + 1;
    }
  }
  const picked = args[wantIndex]?.trim();
  return picked !== undefined && picked.length > 0 ? picked : undefined;
}

function unwrapMapValueToClass(
  memberType: TypeRef,
  scopes: ScopeResolutionIndexes,
): SymbolDefinition | undefined {
  const v = extractShallowMapTypeArgByIndex(memberType.rawName, 1);
  if (v === undefined) return undefined;
  return findClassBindingInScope(memberType.declaredAtScope, v, scopes);
}

/**
 * Walk `objExpr` as a field chain (`this.repos`) and return the `V`
 * type name from a terminal `Map<K,V>` field binding — used when
 * resolving `.values()` without a parsed stdlib return type.
 */
function resolveMapValueTypeNameFromPrefix(
  objExpr: string,
  inScope: ScopeId,
  scopes: ScopeResolutionIndexes,
  index: WorkspaceResolutionIndex,
  options: ResolveCompoundReceiverOptions,
): string | undefined {
  const classScopeByDefId = index.classScopeByDefId;
  const parts = splitChainAtTopLevel(objExpr);
  const head = parts[0];
  if (head === undefined) return undefined;
  const headMemberName = stripCallParens(head);
  const headType = findReceiverTypeBinding(inScope, headMemberName, scopes);
  let currentClass: SymbolDefinition | undefined = headType
    ? findClassBindingInScope(headType.declaredAtScope, headType.rawName, scopes)
    : findClassBindingInScope(inScope, headMemberName, scopes);
  if (
    currentClass === undefined &&
    headType !== undefined &&
    !headType.rawName.includes('.') &&
    !headType.rawName.includes('(')
  ) {
    currentClass = resolveCompoundReceiverClass(
      `${headType.rawName}()`,
      inScope,
      scopes,
      index,
      options,
      1,
    );
  }
  let lastMemberType: TypeRef | undefined;
  for (let i = 1; i < parts.length && currentClass !== undefined; i++) {
    const segment = parts[i];
    if (segment === undefined) break;
    const memberName = stripCallParens(segment);
    const cs = classScopeByDefId.get(currentClass.nodeId);
    if (cs === undefined) return undefined;
    let memberType = cs.typeBindings.get(memberName);
    if (memberType === undefined && options.hoistTypeBindingsToModule === true) {
      let curId: ScopeId | null = cs.parent;
      while (curId !== null) {
        const curScope = scopes.scopeTree.getScope(curId);
        if (curScope === undefined) break;
        const cand = curScope.typeBindings.get(memberName);
        if (cand !== undefined) {
          memberType = cand;
          break;
        }
        curId = curScope.parent;
      }
    }
    if (memberType === undefined) return undefined;
    lastMemberType = memberType;
    let nextClass = findClassBindingInScope(memberType.declaredAtScope, memberType.rawName, scopes);
    if (nextClass === undefined) {
      const fromMap = unwrapMapValueToClass(memberType, scopes);
      if (fromMap !== undefined) nextClass = fromMap;
    }
    currentClass = nextClass;
  }
  if (lastMemberType === undefined) return undefined;
  return extractShallowMapTypeArgByIndex(lastMemberType.rawName, 1);
}
