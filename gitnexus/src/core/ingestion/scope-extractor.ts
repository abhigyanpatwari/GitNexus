/**
 * `ScopeExtractor` — the central, source-agnostic driver that turns a
 * language provider's `CaptureMatch[]` into a `ParsedFile`
 * (RFC §5.3 + §3.2 Phase 1; Ring 2 PKG #919).
 *
 * Exactly one entry point: `extract(matches, filePath, provider) → ParsedFile`.
 * Runs a five-pass pipeline over the matches. Each pass is internal; the
 * public contract is the output `ParsedFile`.
 *
 * ## Design principles
 *
 *   - **Source-agnostic.** Consumes `CaptureMatch[]` from providers;
 *     doesn't know whether they came from tree-sitter queries or COBOL's
 *     regex tagger. No `Tree` / `SyntaxNode` types leak into this file.
 *   - **One AST walk per language.** Providers do the AST walk inside
 *     their `emitScopeCaptures` hook; this driver does zero further
 *     traversal — it consumes captures only.
 *   - **Pure-ish.** The extractor itself is pure (same matches →
 *     same ParsedFile) when providers are pure. No side effects, no I/O.
 *   - **Centralized invariant enforcement.** Structural invariants on the
 *     scope tree (non-module has parent; parent contains child; siblings
 *     don't overlap) are enforced by `buildScopeTree` from Ring 2 SHARED
 *     (#912). Malformed inputs throw `ScopeTreeInvariantError`.
 *
 * ## The five passes
 *
 *   1. **Build scope tree.** Walk `@scope.*` matches. For each, consult
 *      `provider.resolveScopeKind` (default: suffix of the capture name).
 *      Derive parent by lexical-range containment. Hand the resulting
 *      `Scope[]` to `buildScopeTree` for validation.
 *   2. **Attach declarations + local bindings.** Walk `@declaration.*`
 *      matches. For each, build a `SymbolDefinition` and attach it to
 *      `provider.bindingScopeFor` (default: innermost containing scope)
 *      as `ownedDefs` + a local `BindingRef { origin: 'local' }`.
 *   3. **Collect raw imports.** Walk `@import.*` matches. Call
 *      `provider.interpretImport` per match; attach the returned
 *      `ParsedImport` to the ParsedFile — not to any `Scope`.
 *      `provider.importOwningScope` is declared on `LanguageProvider` and
 *      implemented by a dozen providers, but has no call site anywhere; this
 *      step's output is a flat per-file list.
 *
 *      One scope fact is read before that list flattens it away:
 *      `runsOnlyWhenCalled`, set when the statement sits anywhere inside a
 *      `Function`. It is decided here because here is the last stage that can
 *      — finalize receives the flat list, and its consumer receives a map
 *      keyed by the file's Module scope only (see
 *      `ParsedImport.runsOnlyWhenCalled`). This is a position fact, not a
 *      syntax one, so it is decided centrally for every language rather than
 *      per provider — with one capability a provider may declare to opt out
 *      of it entirely, `importsExecuteWhereWritten: false`, because position
 *      cannot defer an import that never executes (C/C++ `#include`, Rust
 *      `use`, COBOL `COPY`). Providers still decide their own *syntactic* nesting
 *      facts in their capture emitters, where the node is in hand (see
 *      `languages/python/import-decomposer.ts`).
 *   4. **Collect type bindings.** Walk `@type-binding.*` matches. Call
 *      `provider.interpretTypeBinding` per match. Attach the resulting
 *      `TypeRef` to the innermost containing scope's `typeBindings`
 *      (or override via `provider.bindingScopeFor` if set).
 *   5. **Collect reference sites.** Walk `@reference.*` matches. Emit
 *      one `ReferenceSite` per match. Classify call form via
 *      `provider.classifyCallForm` (default: the capture's sub-tag if
 *      present; else `'free'`).
 *
 * ## What gets attached where
 *
 *   - `Scope.bindings`     — **local bindings only** at this stage (Pass 2).
 *                            Finalize (#915) merges imports/wildcards on top.
 *   - `Scope.ownedDefs`    — declarations structurally owned by this scope.
 *   - `Scope.typeBindings` — local type facts (parameter annotations, `self`).
 *   - `Scope.imports`      — empty here. Populated by the finalize algorithm
 *                            when it resolves `ParsedImport.targetRaw`.
 *   - `ParsedFile.parsedImports` — every raw import in this file.
 *   - `ParsedFile.localDefs`     — flattened union of `Scope.ownedDefs`.
 *   - `ParsedFile.referenceSites` — pre-resolution usage facts.
 */

import type {
  BindingRef,
  CallableFlowExpectedSignature,
  CallableFlowOperand,
  CallableFlowPassingMode,
  CallableFlowSite,
  Capture,
  CaptureMatch,
  ImportEdge,
  ParameterTypeClass,
  ParsedFile,
  ParsedImport,
  ReferenceSite,
  ReferenceKind,
  Range,
  Scope,
  ScopeId,
  ScopeKind,
  SymbolDefinition,
  TypeRef,
} from 'gitnexus-shared';
import { buildPositionIndex, buildScopeTree, canParentScope, makeScopeId } from 'gitnexus-shared';
import type { LanguageProvider } from './language-provider.js';
import { isValidReceiverChain } from './utils/receiver-chain-codec.js';
import {
  extractTemplateArguments,
  stripTrailingCallSuffix,
  typeApplicationArguments,
} from './utils/template-arguments.js';
import { parseTypeParameterList } from './utils/type-parameters.js';

// ─── Narrow hook surface the extractor actually uses ───────────────────────

/**
 * The subset of `LanguageProvider` members that `extract()` reads — the hooks
 * it calls plus the capability flags it consults. Declared as its own type so:
 *
 *   - Tests can implement just these members without faking the whole
 *     `LanguageProvider` interface (which is ~40 fields including the
 *     legacy-DAG surface).
 *   - The extractor's dependency contract stays explicit — adding a new
 *     hook read requires updating this type.
 *
 * Real callers pass a full `LanguageProvider` — structural typing makes it
 * a `ScopeExtractorHooks` for free.
 */
export type ScopeExtractorHooks = Pick<
  LanguageProvider,
  | 'resolveScopeKind'
  | 'scopeOwnsReceivers'
  | 'bindingScopeFor'
  | 'interpretImport'
  | 'importsExecuteWhereWritten'
  | 'interpretTypeBinding'
  | 'classifyCallForm'
>;

// ─── Public entry point ─────────────────────────────────────────────────────

/**
 * Drive the five extraction passes and return a `ParsedFile`.
 *
 * Throws `ScopeTreeInvariantError` (from #912) when the provider emits
 * captures that violate structural scope invariants (e.g., overlapping
 * sibling scopes). When no `@scope.module` capture is present, a
 * synthetic Module scope is created spanning all captures, and orphan
 * non-Module scopes are re-parented under it. This enables indexing of
 * files where tree-sitter produces an ERROR root (e.g., complex .phtml
 * templates with mixed PHP/HTML/JS).
 */
export function extract(
  matches: readonly CaptureMatch[],
  filePath: string,
  provider: ScopeExtractorHooks,
): ParsedFile {
  // Partition matches by topic up front — one linear pass over the input.
  const partitioned = partitionByTopic(matches);

  // ── Pass 1: build the scope tree ─────────────────────────────────────
  const scopeDrafts = pass1BuildScopes(partitioned.scope, filePath, provider);
  const moduleScope = ensureModuleScope(scopeDrafts, filePath, matches);
  // Re-parent orphan drafts (parent === null, non-Module) under the
  // Module scope. Replaces drafts with new ones carrying the correct
  // parent — runs before content passes so bindings/ownedDefs are empty.
  for (let i = 0; i < scopeDrafts.length; i++) {
    const d = scopeDrafts[i];
    if (d.parent === null && d.kind !== 'Module') {
      // `ownsReceivers` must be carried across: it is decided from the scope's
      // own capture in pass 1 and re-parenting does not change what the scope
      // binds. Dropping it here would silently un-mark every function scope in
      // a file whose root parsed as ERROR (the only way a scope is orphaned).
      scopeDrafts[i] = makeDraft(
        d.id,
        moduleScope.id,
        d.kind,
        d.range,
        d.filePath,
        d.ownsReceivers,
        d.lexicalNames,
      );
    }
  }
  const scopes = scopeDrafts.map(draftToScope);
  // buildScopeTree validates invariants (throws on violation) and exposes
  // the lookup contract consumed by Passes 2-5.
  //
  // **Snapshot semantics.** Both `scopeTree` and `positionIndex` are built
  // from the post-Pass-1 `scopes` — parent/range/kind are accurate, but
  // `bindings`, `ownedDefs`, and `typeBindings` are all empty here. Later
  // passes write into the *drafts*, not into these snapshots; any hook
  // that reads `scope.bindings` etc. via the `scopeTree` argument sees a
  // structural view only. This is by design — hooks use scopeTree for
  // "what's the parent chain?" queries, not for content queries.
  const scopeTree = buildScopeTree(scopes);
  const positionIndex = buildPositionIndex(scopes);

  // ── Pass 2: attach declarations + local bindings ────────────────────
  const localDefs: SymbolDefinition[] = [];
  pass2AttachDeclarations(
    partitioned.declaration,
    scopeDrafts,
    positionIndex,
    localDefs,
    filePath,
    provider,
    scopeTree,
  );

  // ── Pass 3: collect raw imports ─────────────────────────────────────
  const parsedImports: ParsedImport[] = [];
  pass3CollectImports(
    partitioned.import_,
    positionIndex,
    filePath,
    parsedImports,
    provider,
    scopeTree,
  );

  // ── Pass 4: collect type bindings ───────────────────────────────────
  pass4CollectTypeBindings(
    partitioned.typeBinding,
    scopeDrafts,
    positionIndex,
    filePath,
    provider,
    scopeTree,
  );

  // ── Pass 5: collect reference sites ─────────────────────────────────
  const referenceSites: ReferenceSite[] = [];
  pass5CollectReferences(
    partitioned.reference,
    positionIndex,
    filePath,
    referenceSites,
    provider,
    scopeTree,
  );

  // ── Pass 6: collect normalized callable-value-flow facts ───────────
  // Kept after (and independent from) Pass 5 so existing reference-site
  // extraction remains byte-identical.
  const callableFlowSites: CallableFlowSite[] = [];
  pass6CollectCallableFlows(partitioned.callableFlow, positionIndex, filePath, callableFlowSites);

  // Freeze Scope drafts into final shape and return.
  const frozenScopes = scopeDrafts.map(draftToScope);
  return Object.freeze({
    filePath,
    moduleScope: moduleScope.id,
    scopes: Object.freeze(frozenScopes),
    parsedImports: Object.freeze(parsedImports.slice()),
    localDefs: Object.freeze(localDefs.slice()),
    referenceSites: Object.freeze(referenceSites.slice()),
    ...(callableFlowSites.length > 0
      ? { callableFlowSites: Object.freeze(callableFlowSites.slice()) }
      : {}),
  });
}

// ─── Internal: partitioning by topic ───────────────────────────────────────

interface Partitioned {
  readonly scope: readonly CaptureMatch[];
  readonly declaration: readonly CaptureMatch[];
  readonly import_: readonly CaptureMatch[];
  readonly typeBinding: readonly CaptureMatch[];
  readonly reference: readonly CaptureMatch[];
  readonly callableFlow: readonly CaptureMatch[];
}

/**
 * Bucket each match by every topic represented by its anchor captures. An
 * emitter may deliberately group a lexical scope and its declaration in one
 * match so both passes observe the exact same source range.
 *
 * A match may contain additional captures (e.g., `@import.source`,
 * `@declaration.class.name`) that are used by the provider hooks to
 * decode details. Those live inside the `CaptureMatch` and are surfaced
 * to hooks verbatim — the extractor itself only routes by anchor.
 */
function partitionByTopic(matches: readonly CaptureMatch[]): Partitioned {
  const scope: CaptureMatch[] = [];
  const declaration: CaptureMatch[] = [];
  const import_: CaptureMatch[] = [];
  const typeBinding: CaptureMatch[] = [];
  const reference: CaptureMatch[] = [];
  const callableFlow: CaptureMatch[] = [];

  for (const match of matches) {
    for (const topic of topicsOf(match)) {
      switch (topic) {
        case 'scope':
          scope.push(match);
          break;
        case 'declaration':
          declaration.push(match);
          break;
        case 'import':
          import_.push(match);
          break;
        case 'type-binding':
          typeBinding.push(match);
          break;
        case 'reference':
          reference.push(match);
          break;
        case 'callable-flow':
          callableFlow.push(match);
          break;
      }
    }
  }

  return { scope, declaration, import_, typeBinding, reference, callableFlow };
}

type Topic = 'scope' | 'declaration' | 'import' | 'type-binding' | 'reference' | 'callable-flow';

function topicsOf(match: CaptureMatch): ReadonlySet<Topic> {
  const topics = new Set<Topic>();
  for (const name of Object.keys(match)) {
    if (name.startsWith('@scope.')) topics.add('scope');
    else if (name.startsWith('@declaration.')) topics.add('declaration');
    else if (name.startsWith('@import.')) topics.add('import');
    else if (name.startsWith('@type-binding.')) topics.add('type-binding');
    else if (name.startsWith('@reference.')) topics.add('reference');
    else if (name.startsWith('@callable-flow.')) topics.add('callable-flow');
  }
  return topics;
}

// ─── Internal: Scope draft model ───────────────────────────────────────────

/**
 * Mutable Scope record used during extraction. The final `Scope` (readonly,
 * returned in `ParsedFile.scopes`) is produced by `draftToScope` at the end
 * of each pass's writes.
 */
interface ScopeDraft {
  readonly id: ScopeId;
  readonly parent: ScopeId | null;
  readonly kind: ScopeKind;
  readonly range: Range;
  readonly filePath: string;
  readonly bindings: Map<string, BindingRef[]>;
  readonly ownedDefs: SymbolDefinition[];
  readonly imports: ImportEdge[];
  readonly typeBindings: Map<string, TypeRef>;
  readonly lexicalNames?: ReadonlySet<string>;
  /** See `Scope.ownsReceivers` — set once at pass 1, never mutated. */
  readonly ownsReceivers?: ReadonlySet<string>;
}

function ensureModuleScope(
  scopeDrafts: ScopeDraft[],
  filePath: string,
  allMatches: readonly CaptureMatch[],
): ScopeDraft {
  const moduleScope = scopeDrafts.find((s) => s.kind === 'Module');
  if (moduleScope !== undefined) return moduleScope;

  // Synthesize a Module scope spanning all captures in the file.
  // Computed from ALL captures (scope, declaration, reference, etc.)
  // so the range covers top-level references that appear after the
  // last inner scope — not just inner Function/Class scopes.
  let endLine = 0;
  let endCol = 0;
  for (const match of allMatches) {
    for (const capture of Object.values(match)) {
      if (
        capture.range.endLine > endLine ||
        (capture.range.endLine === endLine && capture.range.endCol > endCol)
      ) {
        endLine = capture.range.endLine;
        endCol = capture.range.endCol;
      }
    }
  }
  const range: Range = { startLine: 0, startCol: 0, endLine, endCol };
  const synthetic = makeDraft(
    makeScopeId({ filePath, range, kind: 'Module' }),
    null,
    'Module',
    range,
    filePath,
  );

  scopeDrafts.push(synthetic);
  return synthetic;
}

function draftToScope(draft: ScopeDraft): Scope {
  const frozenBindings = new Map<string, readonly BindingRef[]>();
  for (const [name, refs] of draft.bindings) {
    frozenBindings.set(name, Object.freeze(refs.slice()));
  }
  return {
    id: draft.id,
    parent: draft.parent,
    kind: draft.kind,
    range: draft.range,
    filePath: draft.filePath,
    bindings: frozenBindings,
    ownedDefs: Object.freeze(draft.ownedDefs.slice()),
    imports: Object.freeze(draft.imports.slice()),
    typeBindings: new Map(draft.typeBindings),
    lexicalNames: draft.lexicalNames,
    ownsReceivers: draft.ownsReceivers,
  };
}

// ─── Pass 1: build scope tree ──────────────────────────────────────────────

/**
 * Convert `@scope.*` matches into `ScopeDraft[]`. Parent relationships
 * are derived from range containment (outermost scope containing `range`
 * becomes the parent).
 */
function pass1BuildScopes(
  matches: readonly CaptureMatch[],
  filePath: string,
  provider: ScopeExtractorHooks,
): ScopeDraft[] {
  interface Candidate {
    readonly match: CaptureMatch;
    readonly range: Range;
    readonly kind: ScopeKind;
    readonly id: ScopeId;
  }

  const candidates: Candidate[] = [];
  for (const match of matches) {
    const anchor = anchorCaptureFor(match, '@scope.');
    if (anchor === undefined) continue;
    const kind = resolveKindForScopeMatch(match, anchor, provider);
    if (kind === null) continue;
    const id = makeScopeId({ filePath, range: anchor.range, kind });
    candidates.push({ match, range: anchor.range, kind, id });
  }

  // Sort by (startLine, startCol) ASC, (endLine, endCol) DESC so outer
  // scopes appear before their children for parent-resolution. When two
  // candidates have exactly equal ranges (e.g. a `compilation_unit` and
  // the only top-level scope in the file — see `canParentScope`), Module
  // sorts first so it lands on the stack ahead of the candidate that will
  // claim it as parent.
  candidates.sort((a, b) => {
    if (a.range.startLine !== b.range.startLine) return a.range.startLine - b.range.startLine;
    if (a.range.startCol !== b.range.startCol) return a.range.startCol - b.range.startCol;
    if (a.range.endLine !== b.range.endLine) return b.range.endLine - a.range.endLine;
    if (a.range.endCol !== b.range.endCol) return b.range.endCol - a.range.endCol;
    if (a.kind === b.kind) return 0;
    if (a.kind === 'Module') return -1;
    if (b.kind === 'Module') return 1;
    return 0;
  });

  const drafts: ScopeDraft[] = [];
  const stack: Candidate[] = []; // enclosing real scopes, outermost at [0]

  for (const cand of candidates) {
    // Pop the stack until the top can parent this candidate (strict
    // containment, plus the equal-range Module carve-out).
    while (
      stack.length > 0 &&
      !canParentScope(
        stack[stack.length - 1]!.range,
        cand.range,
        stack[stack.length - 1]!.kind,
        cand.kind,
      )
    ) {
      stack.pop();
    }

    const parent = stack.length > 0 ? stack[stack.length - 1]!.id : null;
    drafts.push(
      makeDraft(
        cand.id,
        parent,
        cand.kind,
        cand.range,
        filePath,
        provider.scopeOwnsReceivers?.(cand.match),
        parseScopeLexicalNames(cand.match),
      ),
    );
    stack.push(cand);
  }

  return drafts;
}

function resolveKindForScopeMatch(
  match: CaptureMatch,
  anchor: { readonly name: string },
  provider: ScopeExtractorHooks,
): ScopeKind | null {
  // Provider override takes precedence.
  const override = provider.resolveScopeKind?.(match);
  if (override !== undefined && override !== null) return override;

  // Default: derive from capture name suffix (`@scope.function` → 'Function').
  const suffix = anchor.name.slice('@scope.'.length);
  switch (suffix.toLowerCase()) {
    case 'module':
      return 'Module';
    case 'namespace':
      return 'Namespace';
    case 'class':
      return 'Class';
    case 'function':
      return 'Function';
    case 'block':
      return 'Block';
    case 'expression':
      return 'Expression';
    case 'object':
      return 'Object';
    default:
      return null;
  }
}

function makeDraft(
  id: ScopeId,
  parent: ScopeId | null,
  kind: ScopeKind,
  range: Range,
  filePath: string,
  ownsReceivers?: ReadonlySet<string>,
  lexicalNames?: ReadonlySet<string>,
): ScopeDraft {
  return {
    id,
    parent,
    kind,
    range,
    filePath,
    bindings: new Map(),
    ownedDefs: [],
    imports: [],
    typeBindings: new Map(),
    lexicalNames,
    ownsReceivers,
  };
}

function parseScopeLexicalNames(match: CaptureMatch): ReadonlySet<string> | undefined {
  const raw = match['@scope.lexical-names']?.text;
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const names = parsed.filter(
      (name): name is string => typeof name === 'string' && name.length > 0,
    );
    return names.length > 0 ? new Set(names) : undefined;
  } catch {
    return undefined;
  }
}

// ─── Pass 2: attach declarations + local bindings ──────────────────────────

function pass2AttachDeclarations(
  matches: readonly CaptureMatch[],
  drafts: readonly ScopeDraft[],
  positionIndex: ReturnType<typeof buildPositionIndex>,
  localDefs: SymbolDefinition[],
  filePath: string,
  provider: ScopeExtractorHooks,
  scopeTree: ReturnType<typeof buildScopeTree>,
): void {
  const draftById = new Map<ScopeId, ScopeDraft>();
  for (const d of drafts) draftById.set(d.id, d);

  // First def seen per `nodeId`, for the duplicate backfill below. Two query
  // patterns can legitimately match ONE declaration — a C++ templated struct
  // matches both the standalone `struct_specifier` rule and the
  // `template_declaration` rule that wraps it — and both mint the same def id.
  const firstDefByNodeId = new Map<string, SymbolDefinition>();

  for (const match of matches) {
    const anchor = anchorCaptureFor(match, '@declaration.');
    if (anchor === undefined) continue;

    const def = buildDefFromDeclarationMatch(match, anchor, filePath);
    if (def === undefined) continue;

    // ── Duplicate-declaration backfill ───────────────────────────────────────
    // `buildDefIndex` is FIRST-WRITE-WINS, so when one declaration produces two
    // defs under one id, whichever match tree-sitter reported first is the one
    // resolution sees. That was harmless while the twins were byte-identical.
    // It stops being harmless the moment one twin can carry a field the other
    // structurally cannot: a C++ `template <class T> struct Vec` has its
    // parameter list on the ENCLOSING `template_declaration`, so the standalone
    // `struct_specifier` twin can never see it, and match order would silently
    // decide whether `Vec` remembers `T`. Source order deciding a resolution
    // fact is the failure mode this subsystem rejects everywhere else.
    //
    // Copying the field onto BOTH twins makes the outcome identical whichever
    // one wins. Deliberately narrow — only `typeParameters`, the one field with
    // an asymmetric twin today. Widening this to "merge all metadata" would
    // change what every existing duplicate resolves to, which is a different
    // change with a different blast radius and no evidence behind it yet.
    const first = firstDefByNodeId.get(def.nodeId);
    if (first === undefined) {
      firstDefByNodeId.set(def.nodeId, def);
    } else if (first.typeParameters === undefined && def.typeParameters !== undefined) {
      first.typeParameters = def.typeParameters;
    } else if (def.typeParameters === undefined && first.typeParameters !== undefined) {
      def.typeParameters = first.typeParameters;
    }

    // Find the innermost scope that contains the declaration's anchor range.
    const innermostId = positionIndex.atPosition(
      filePath,
      anchor.range.startLine,
      anchor.range.startCol,
    );
    if (innermostId === undefined) continue;
    const innermost = draftById.get(innermostId);
    if (innermost === undefined) continue;

    // Ownership: attach the def to the innermost scope's `ownedDefs` — that
    // is the structural owner. `def.ownerId` is NOT populated here — the
    // extractor has no clean path to the parent's own DefId mid-extraction
    // (the parent declaration may not yet have been processed, or may live
    // in a different scope entirely). Providers that need `ownerId` should
    // set it directly from the declaration hook (e.g., derive from the
    // `@declaration.owner` capture or the parent scope id); otherwise
    // `finalize` populates method/field `ownerId` via `MethodDispatchIndex`
    // (#914) in a follow-up pass that sees every def already in place.
    innermost.ownedDefs.push(def);
    localDefs.push(def);

    // Binding visibility: default to innermost; allow hoisting via
    // `provider.bindingScopeFor`. `draftToScope(innermost)` here is a
    // **structural** snapshot — parent/range/kind only. Hooks MUST NOT
    // rely on `scope.bindings`, `ownedDefs`, or `typeBindings` being
    // populated during Pass 2: those fields are written across passes,
    // so reading them mid-extraction yields a partial view. The
    // `scopeTree` argument is similarly snapshot-before-mutation.
    //
    // Auto-hoist for scope-creating declarations: when the declaration's
    // anchor range is the same node that produced `innermost` (e.g. a
    // `function_definition` is both `@scope.function` and the
    // `@declaration.function` anchor), the name is visible OUTSIDE the
    // body, not inside. Hoisting to the parent scope is what every
    // mainstream language wants for function/class declarations. Hooks
    // can override by returning a non-null scope id.
    const autoHostedId =
      innermost.parent !== null && rangesEqual(anchor.range, innermost.range)
        ? innermost.parent
        : innermost.id;
    const bindingScopeId =
      provider.bindingScopeFor?.(match, draftToScope(innermost), scopeTree) ?? autoHostedId;
    const bindingHost = draftById.get(bindingScopeId) ?? innermost;

    const nameKey = deriveDeclarationName(match, def);
    if (nameKey === undefined) continue;

    const existing = bindingHost.bindings.get(nameKey) ?? [];
    existing.push({ def, origin: 'local' });
    bindingHost.bindings.set(nameKey, existing);
  }
}

function buildDefFromDeclarationMatch(
  match: CaptureMatch,
  anchor: { readonly name: string; readonly range: Range; readonly text: string },
  filePath: string,
): SymbolDefinition | undefined {
  // Anchor name pattern: `@declaration.<kind>` where <kind> maps to NodeLabel.
  const kindStr = anchor.name.slice('@declaration.'.length);
  const type = normalizeNodeLabel(kindStr);
  if (type === undefined) return undefined;

  const nameCap =
    match['@declaration.name'] ?? match[`@declaration.${kindStr}.name`] ?? match[anchor.name];
  if (nameCap === undefined) return undefined;

  const qualifiedCap = match['@declaration.qualified_name'];
  const qualifiedName = qualifiedCap?.text;
  const templateArguments =
    extractTemplateArguments(match['@declaration.template-arguments']?.text ?? '') ??
    extractTemplateArguments(qualifiedName ?? nameCap.text);

  // Optional arity metadata — producers (e.g. Python emit-captures)
  // synthesize these on function/method declarations. Their absence is
  // the normal case for other producers; readers treat undefined as
  // "unknown" per `SymbolDefinition` contract.
  const parameterCount = parseIntCapture(match['@declaration.parameter-count']);
  const requiredParameterCount = parseIntCapture(match['@declaration.required-parameter-count']);
  const parameterTypes = parseJsonStringArrayCapture(match['@declaration.parameter-types']);
  const parameterTypeClasses = parseJsonParameterTypeClassesCapture(
    match['@declaration.parameter-type-classes'],
  );
  const declaredType = match['@declaration.field-type']?.text;
  const returnType = match['@declaration.return-type']?.text;
  const templateConstraints = parseJsonCapture(match['@declaration.template-constraints']);
  // The DECLARED parameters, a different axis from `templateArguments` above:
  // that reads the arguments written on the name, this reads the list the
  // declaration was written in terms of. A declaration can carry both, and for a
  // C++ partial specialization the pairing is the only thing that tells it apart
  // from a full specialization with the identical arguments.
  const typeParameters = parseTypeParameterList(match['@declaration.type-parameters']?.text ?? '');
  const isExplicit = parseBooleanCapture(match['@declaration.is-explicit']);
  const isDeleted = parseBooleanCapture(match['@declaration.is-deleted']);
  const isSynthetic = parseBooleanCapture(match['@declaration.is-synthetic']);

  return {
    nodeId: makeDefId(filePath, anchor.range, type, nameCap.text),
    filePath,
    type,
    ...(qualifiedName !== undefined ? { qualifiedName } : { qualifiedName: nameCap.text }),
    ...(parameterCount !== undefined ? { parameterCount } : {}),
    ...(requiredParameterCount !== undefined ? { requiredParameterCount } : {}),
    ...(parameterTypes !== undefined ? { parameterTypes } : {}),
    ...(parameterTypeClasses !== undefined ? { parameterTypeClasses } : {}),
    ...(declaredType !== undefined ? { declaredType } : {}),
    ...(returnType !== undefined ? { returnType } : {}),
    ...(templateArguments !== undefined ? { templateArguments } : {}),
    ...(typeParameters !== undefined ? { typeParameters } : {}),
    ...(templateConstraints !== undefined ? { templateConstraints } : {}),
    ...(isExplicit === true ? { isExplicit: true } : {}),
    ...(isDeleted === true ? { isDeleted: true } : {}),
    ...(isSynthetic === true ? { isSynthetic: true } : {}),
  };
}

/** Parse an opaque JSON payload synthesized by per-language captures
 *  (e.g. C++ `@declaration.template-constraints`). Producer owns the
 *  shape; shared code threads it through as `unknown` per the
 *  `SymbolDefinition.templateConstraints` contract. */
function parseJsonCapture(cap: { readonly text: string } | undefined): unknown {
  if (cap === undefined) return undefined;
  try {
    return JSON.parse(cap.text);
  } catch {
    return undefined;
  }
}

function parseIntCapture(cap: { readonly text: string } | undefined): number | undefined {
  if (cap === undefined) return undefined;
  const n = Number.parseInt(cap.text, 10);
  return Number.isFinite(n) ? n : undefined;
}

function parseBooleanCapture(cap: { readonly text: string } | undefined): boolean | undefined {
  if (cap === undefined) return undefined;
  if (cap.text === 'true') return true;
  if (cap.text === 'false') return false;
  return undefined;
}

function parseJsonParameterTypeClassesCapture(
  cap: { readonly text: string } | undefined,
): ParameterTypeClass[] | undefined {
  if (cap === undefined) return undefined;
  try {
    const parsed = JSON.parse(cap.text);
    if (!Array.isArray(parsed)) return undefined;
    const out: ParameterTypeClass[] = [];
    for (const item of parsed) {
      if (item === null || typeof item !== 'object') return undefined;
      const o = item as Record<string, unknown>;
      if (typeof o.base !== 'string') return undefined;
      if (
        o.cv !== 'none' &&
        o.cv !== 'const' &&
        o.cv !== 'volatile' &&
        o.cv !== 'const volatile' &&
        o.cv !== 'unknown'
      ) {
        return undefined;
      }
      if (
        o.indirection !== 'value' &&
        o.indirection !== 'lvalue-ref' &&
        o.indirection !== 'rvalue-ref' &&
        o.indirection !== 'pointer' &&
        o.indirection !== 'unknown'
      ) {
        return undefined;
      }
      if (typeof o.pointerDepth !== 'number' || !Number.isFinite(o.pointerDepth)) {
        return undefined;
      }
      const shape: ParameterTypeClass = {
        base: o.base,
        cv: o.cv,
        indirection: o.indirection,
        pointerDepth: o.pointerDepth,
      };
      if (Array.isArray(o.templateArguments)) {
        if (!o.templateArguments.every((x): x is string => typeof x === 'string')) {
          return undefined;
        }
        shape.templateArguments = [...o.templateArguments];
      }
      out.push(shape);
    }
    return out;
  } catch {
    return undefined;
  }
}

function parseJsonStringArrayCapture(
  cap: { readonly text: string } | undefined,
): string[] | undefined {
  if (cap === undefined) return undefined;
  try {
    const parsed = JSON.parse(cap.text) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    return parsed.every((x): x is string => typeof x === 'string') ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function deriveDeclarationName(match: CaptureMatch, def: SymbolDefinition): string | undefined {
  const nameCap =
    match['@declaration.binding-name'] ??
    match['@declaration.name'] ??
    match[
      Object.keys(match).find((k) => k.startsWith('@declaration.') && k.endsWith('.name')) ?? ''
    ];
  if (nameCap !== undefined) return nameCap.text;
  // Fall back to qualifiedName tail.
  const q = def.qualifiedName;
  if (q !== undefined && q.length > 0) {
    const dot = q.lastIndexOf('.');
    return dot === -1 ? q : q.slice(dot + 1);
  }
  return undefined;
}

/**
 * Map a lower-case declaration kind (from `@declaration.<kind>`) to a
 * graph `NodeLabel`. Silently returns `undefined` for kinds we don't
 * recognize — providers can emit richer captures without breaking the
 * driver.
 */
function normalizeNodeLabel(kindStr: string): SymbolDefinition['type'] | undefined {
  switch (kindStr.toLowerCase()) {
    case 'class':
      return 'Class';
    case 'interface':
      return 'Interface';
    case 'enum':
      return 'Enum';
    case 'struct':
      return 'Struct';
    case 'union':
      return 'Union';
    case 'trait':
      return 'Trait';
    case 'method':
      return 'Method';
    case 'function':
      return 'Function';
    case 'constructor':
      return 'Constructor';
    case 'field':
    case 'property':
      return 'Property';
    case 'variable':
      return 'Variable';
    // `const` / `let` declarations align with the legacy DAG parse phase,
    // which emits `Const` graph nodes via `@definition.const` capture for
    // `lexical_declaration`. Returning `'Const'` here lets resolveDefGraphId's
    // qualified-key path succeed for value receivers without relying on the
    // simple-key fallback (PR #1718 review Finding 1 / 2026-05-21-002 U4).
    case 'const':
      return 'Const';
    case 'typealias':
    case 'type_alias':
      return 'TypeAlias';
    case 'typedef':
      return 'Typedef';
    case 'record':
      return 'Record';
    case 'delegate':
      return 'Delegate';
    case 'annotation':
      return 'Annotation';
    case 'namespace':
      return 'Namespace';
    case 'program':
      return 'Module';
    case 'macro':
      return 'Macro';
    default:
      return undefined;
  }
}

/** Function-like labels: callable defs that must keep incoming CALLS edges. */
const NODE_BEARING_FUNCTION_LABELS: ReadonlySet<SymbolDefinition['type']> = new Set([
  'Function',
  'Method',
  'Constructor',
]);

/** Value labels: non-callable bindings (a `const`/`let`/`var` holds a value). */
const NODE_BEARING_VALUE_LABELS: ReadonlySet<SymbolDefinition['type']> = new Set([
  'Const',
  'Variable',
]);

/**
 * Collapse rule for the deferred node-creation migration (#1876).
 *
 * When graph-node creation moves from the legacy DAG onto the
 * registry-primary path, a single source binding can carry more than one
 * `SymbolDefinition` for the same name in the same scope — e.g. a direct
 * arrow `const fn = () => {}` is classified BOTH as a `Function` (the
 * arrow) and a `Variable` (the binding). Emitting one graph node per def
 * would reproduce exactly the duplicate-node bug this issue tracks.
 *
 * `selectNodeBearingDef` picks the ONE def that should bear the graph node
 * for such a binding group:
 *
 *   1. a function-like def (`Function` / `Method` / `Constructor`) if any —
 *      the binding is callable and must keep incoming `CALLS` edges;
 *   2. otherwise a value def (`Const` / `Variable`) — the binding holds a
 *      value (e.g. an array-method result after the U1/U2 narrowing);
 *   3. otherwise the first def — deterministic fallback for label sets this
 *      rule does not rank.
 *
 * INPUT CONTRACT: `group` must be the defs bound to ONE name within ONE
 * scope (a binding group). It deliberately does NOT dedup by range —
 * `SymbolDefinition` carries no range and `makeDefId` encodes only the
 * start position, so containment is uncomputable here; the caller forms the
 * group (e.g. from a scope's `ownedDefs` keyed by name) before calling.
 *
 * Pure. No production call site yet — this dead export is intentional and
 * tracked by #1876 (the deferred node-creation migration); it is the
 * executable contract that follow-up will consume, pinned today by the
 * scope-extractor unit test.
 */
export function selectNodeBearingDef(
  group: readonly SymbolDefinition[],
): SymbolDefinition | undefined {
  if (group.length === 0) return undefined;
  const functionLike = group.find((def) => NODE_BEARING_FUNCTION_LABELS.has(def.type));
  if (functionLike !== undefined) return functionLike;
  const value = group.find((def) => NODE_BEARING_VALUE_LABELS.has(def.type));
  if (value !== undefined) return value;
  return group[0];
}

function makeDefId(
  filePath: string,
  range: Range,
  type: SymbolDefinition['type'],
  name: string,
): string {
  return `def:${filePath}#${range.startLine}:${range.startCol}:${type}:${name}`;
}

// ─── Pass 3: collect raw imports ───────────────────────────────────────────

/**
 * Does this import run only when something calls the function it sits in?
 *
 * Walks the scope chain to the file root rather than reading the immediate
 * kind, because the immediate kind is not enough in either direction. A `Block`
 * at the top of a module (`if (FLAG) { require('./x'); }`) runs during
 * initialization; the same `Block` inside a function does not. `Class`,
 * `Namespace`, `Expression` and `Object` bodies execute where they are defined,
 * so they are initialization-time too. Only an enclosing `Function` — anywhere
 * up the chain — defers execution.
 *
 * Language-agnostic on purpose: it is what catches Python's
 * `def f(): from x import Y`, Ruby's `def f; require 'x'; end` and a CommonJS
 * `require()` in a function body, none of which any `kind` marks as deferred —
 * only their position says it.
 *
 * The rule is about EXECUTION, so it does not hold for a language whose
 * imports are not executed statements at all — a C/C++ `#include` (spliced by
 * the preprocessor before the program runs) or a Rust `use` (a compile-time
 * path alias). Both are legal inside a function body and neither is deferred
 * by sitting there, so a cycle they form is REAL. Marking one deferred would
 * make `check --cycles` drop that cycle, and suppressing a true cycle is the
 * failure direction that matters. Such a language opts out by declaring
 * `LanguageProvider.importsExecuteWhereWritten: false`, checked by the caller
 * — the capability is named on the provider rather than the language being
 * named here, because shared ingestion code must not branch on language
 * (AGENTS.md).
 *
 * Decided HERE and nowhere later because this is the last stage that knows the
 * answer — see `ParsedImport.runsOnlyWhenCalled` for why finalize and the graph
 * bridge cannot recover it.
 */
function runsOnlyWhenCalled(
  scopeTree: ReturnType<typeof buildScopeTree>,
  scopeId: ScopeId,
): boolean {
  // Inline rather than `utils/scope-tree-walk.ts`'s `walkToScope`, which is the
  // shared primitive for exactly this climb and IS the right call everywhere it
  // is used today — five `bindingScopeFor` hooks, all per-BINDING. This runs per
  // IMPORT on every file of every analyze, and `walkToScope` takes `...kinds`
  // and builds `new Set(kinds)` per call: measured on this host, 1.0 ns inline
  // against 32.3 ns through the helper for the module-level case that is ~99% of
  // imports, plus ~232 B of allocation each. Rewriting the helper's membership
  // test as `kinds.includes` takes it to 8.8 ns — still 8x, because the rest
  // array allocates regardless. Reuse loses to a two-field loop here; it would
  // not on a colder path.
  //
  // No depth cap: the chain is acyclic by construction, since `buildScopeTree`
  // only parents a scope to one that STRICTLY contains it.
  let current: ScopeId | null = scopeId;
  while (current !== null) {
    const scope = scopeTree.getScope(current);
    if (scope === undefined) return false;
    if (scope.kind === 'Function') return true;
    current = scope.parent;
  }
  return false;
}

function pass3CollectImports(
  matches: readonly CaptureMatch[],
  positionIndex: ReturnType<typeof buildPositionIndex>,
  filePath: string,
  parsedImports: ParsedImport[],
  provider: ScopeExtractorHooks,
  scopeTree: ReturnType<typeof buildScopeTree>,
): void {
  if (provider.interpretImport === undefined) return;
  // Hoisted: the capability is a property of the language, identical for every
  // match in the file. A provider that declares its imports do not execute
  // where they are written (C/C++ `#include`, Rust `use`, COBOL `COPY`) skips
  // the position walk entirely — position cannot defer something that never
  // runs, and marking one deferred would hide a real cycle. Absent reads as
  // `true`, so an undeclared provider is unchanged. See
  // `LanguageProvider.importsExecuteWhereWritten`.
  const positionCanDefer = provider.importsExecuteWhereWritten !== false;
  for (const match of matches) {
    const anchor = anchorCaptureFor(match, '@import.');
    if (anchor === undefined) continue;
    const parsed = provider.interpretImport(match);
    if (parsed === null) continue;
    // The statement's own position, resolved to the innermost scope holding
    // it. An unlocatable anchor leaves the import unmarked, which reads as
    // "runs at initialization" — the fail-safe direction, since it can only
    // make `check --cycles` over-report.
    const inScopeId = positionCanDefer
      ? positionIndex.atPosition(filePath, anchor.range.startLine, anchor.range.startCol)
      : undefined;
    const deferred = inScopeId !== undefined && runsOnlyWhenCalled(scopeTree, inScopeId);
    parsedImports.push(deferred ? { ...parsed, runsOnlyWhenCalled: true } : parsed);
  }
}

// ─── Pass 4: collect type bindings ─────────────────────────────────────────

/** Cap on the retained as-written annotation. Real container spellings are a
 *  handful of characters; a multi-line mapped/conditional type is neither a
 *  container any `elementTypeOf` parses nor worth keeping one copy of per
 *  binding on a kernel-scale repo. Over the cap the spelling is dropped, which
 *  makes an index step decline — the safe direction. */
const MAX_DECLARED_SPELLING_LENGTH = 256;

function pass4CollectTypeBindings(
  matches: readonly CaptureMatch[],
  drafts: readonly ScopeDraft[],
  positionIndex: ReturnType<typeof buildPositionIndex>,
  filePath: string,
  provider: ScopeExtractorHooks,
  scopeTree: ReturnType<typeof buildScopeTree>,
): void {
  const draftById = new Map<ScopeId, ScopeDraft>();
  for (const d of drafts) draftById.set(d.id, d);

  for (const match of matches) {
    const anchor = anchorCaptureFor(match, '@type-binding.');
    if (anchor === undefined) continue;

    const parsed = provider.interpretTypeBinding?.(match);
    if (parsed === null || parsed === undefined) continue;

    const innermostId = positionIndex.atPosition(
      filePath,
      anchor.range.startLine,
      anchor.range.startCol,
    );
    if (innermostId === undefined) continue;
    const innermost = draftById.get(innermostId);
    if (innermost === undefined) continue;

    // Auto-hoist for scope-creating type bindings (e.g. Python's
    // `@type-binding.return` whose anchor is the function_definition
    // itself). Same condition as Pass 2 — when the anchor coincides
    // with the innermost scope's range, the binding belongs in the
    // enclosing scope (callers, not the function body, look up the
    // return type by the function's name).
    const autoHostedId =
      innermost.parent !== null && rangesEqual(anchor.range, innermost.range)
        ? innermost.parent
        : innermost.id;
    // `bindingScopeFor` may hoist the type binding to an outer scope.
    const hostId =
      provider.bindingScopeFor?.(match, draftToScope(innermost), scopeTree) ?? autoHostedId;
    const host = draftById.get(hostId) ?? innermost;

    // The annotation as the source wrote it, kept only when the provider's
    // interpretation is not already it. `interpretTypeBinding` normalizes
    // container spellings away (`User[]` → `User`, `List[User]` → `User`,
    // `[]*User` → `User`), which makes a reduced container indistinguishable
    // from a class of the same name — and an index step folding on that
    // ambiguity typed `grid[0]` as `Grid`. Read at the one place the
    // distinction matters; see `TypeRef.declaredSpelling`.
    //
    // Read from the capture rather than from `ParsedTypeBinding` deliberately:
    // `@type-binding.type` is the shared anchor EVERY provider already reads to
    // build `rawTypeName`, so nothing has to be threaded through fourteen
    // interpreters (and none can forget to).
    // A provider may override when its grammar keeps part of the written type
    // outside `@type-binding.type` (C++ hangs `*` on the declarator).
    const writtenType = (parsed.declaredSpelling ?? match['@type-binding.type']?.text)?.trim();
    const declaredSpelling =
      writtenType !== undefined &&
      writtenType.length > 0 &&
      writtenType.length <= MAX_DECLARED_SPELLING_LENGTH &&
      writtenType !== parsed.rawTypeName
        ? writtenType
        : undefined;
    const typeRef: TypeRef =
      declaredSpelling === undefined
        ? {
            rawName: parsed.rawTypeName,
            declaredAtScope: host.id,
            source: parsed.source,
          }
        : {
            rawName: parsed.rawTypeName,
            declaredSpelling,
            declaredAtScope: host.id,
            source: parsed.source,
          };
    // Prefer stronger sources when multiple matches fire for the same
    // bound name in the same scope. Example: `u: User = find()` matches
    // both the annotation and constructor-inferred patterns; the explicit
    // annotation (stronger source) must win over the call-site guess
    // regardless of query-match arrival order.
    const existing = host.typeBindings.get(parsed.boundName);
    if (
      existing === undefined ||
      typeBindingStrength(typeRef.source) >= typeBindingStrength(existing.source)
    ) {
      host.typeBindings.set(parsed.boundName, typeRef);
    }
  }

  // ── Transitive closure over identifier-chain type bindings ─────────
  // Captures like `(assignment left: (ident) right: (ident))` emit a
  // TypeRef whose `rawName` is the RHS identifier. When the RHS name is
  // itself a bound variable with a known type in the same scope (or a
  // parent scope), follow the chain so `alias` ultimately points at the
  // class type — not at another local variable name. Without this,
  // `resolveTypeRef` hits the chained name, sees it's a local Variable
  // (non-type kind), and strict-returns null.
  for (const draft of drafts) {
    for (const [name, ref] of draft.typeBindings) {
      const resolved = followChainedRef(ref, draftById);
      if (resolved !== ref) draft.typeBindings.set(name, resolved);
    }
  }
}

/** Max chain depth: practical programs rarely exceed 4-5 re-bindings;
 *  the cap just prevents runaway loops when providers emit cycles. */
const CHAIN_MAX_DEPTH = 16;

/**
 * Follow an identifier-chain TypeRef through successive typeBindings
 * lookups in the declaring scope and its ancestors. Returns the terminal
 * TypeRef (or the original if the chain dead-ends or cycles).
 */
function followChainedRef(start: TypeRef, draftById: ReadonlyMap<ScopeId, ScopeDraft>): TypeRef {
  let current = start;
  const visited = new Set<string>();
  for (let depth = 0; depth < CHAIN_MAX_DEPTH; depth++) {
    // A rawName containing a dot (`models.User`) goes through
    // `QualifiedNameIndex` at resolution time — don't follow it here.
    if (current.rawName.includes('.')) return current;

    // Look up the current rawName in the declaring scope and walk up
    // the chain until we hit a scope that has a binding for it.
    let scopeId: ScopeId | null = current.declaredAtScope;
    let next: TypeRef | undefined;
    while (scopeId !== null) {
      const scope = draftById.get(scopeId);
      if (scope === undefined) break;
      next = scope.typeBindings.get(current.rawName);
      if (next !== undefined) break;
      scopeId = scope.parent;
    }

    if (next === undefined) return current; // dead end — nothing to chain to
    if (next === current) return current; // self-ref
    if (visited.has(next.rawName)) return current; // cycle guard
    visited.add(next.rawName);
    current = next;
  }
  return current;
}

/**
 * Priority ordering when multiple `TypeRef`s compete for the same bound
 * name in the same scope. Higher number wins; ties keep the later match
 * (last-write-wins preserves historical order within a tier).
 *
 * Rationale: explicit variable and field annotations always beat bindings
 * derived from parameter annotations or inference because they reflect the
 * most specific user intent. `self`/`cls` are treated as strongly as other
 * declared types because they are language-required receiver types.
 */
function typeBindingStrength(source: TypeRef['source']): number {
  switch (source) {
    case 'annotation':
      return 3;
    case 'parameter-annotation':
    case 'return-annotation':
    case 'self':
      return 2;
    case 'assignment-inferred':
    case 'constructor-inferred':
    case 'receiver-propagated':
      return 1;
    default:
      return 0;
  }
}

// ─── Pass 5: collect reference sites ───────────────────────────────────────

function pass5CollectReferences(
  matches: readonly CaptureMatch[],
  positionIndex: ReturnType<typeof buildPositionIndex>,
  filePath: string,
  referenceSites: ReferenceSite[],
  provider: ScopeExtractorHooks,
  scopeTree: ReturnType<typeof buildScopeTree>,
): void {
  for (const match of matches) {
    const anchor = anchorCaptureFor(match, '@reference.');
    if (anchor === undefined) continue;

    const kind = referenceKindFromAnchor(anchor.name);
    if (kind === undefined) continue;

    const nameCap = match['@reference.name'] ?? anchor;
    // Optional qualified form of the reference (e.g. a C++ base `Other::Inner`),
    // threaded to resolution so a same-tail nested base resolves to the correct
    // sibling via the full-path QualifiedNameIndex before the simple-tail walk
    // (#1982). Absent for unqualified references — resolution stays unchanged.
    const qualifiedCap = match['@reference.qualified-name'];
    // Generic ARGUMENTS written on a heritage reference (`: IValidator<string>`);
    // `inherits` only, because a call/read/write anchor spans the whole call
    // expression, whose `<…>` would be an argument list, a comparison, or
    // nothing at all — widening the kind would mint confident nonsense (#2912).
    const typeArguments =
      kind === 'inherits' ? heritageTypeArguments(match, anchor, nameCap) : undefined;
    const inScopeId = positionIndex.atPosition(
      filePath,
      anchor.range.startLine,
      anchor.range.startCol,
    );
    if (inScopeId === undefined) continue;

    const callForm =
      kind === 'call'
        ? classifyCallFormForMatch(match, anchor.name, provider, scopeTree, inScopeId)
        : undefined;
    const explicitReceiver = extractExplicitReceiver(match);
    const arity = extractArity(match);
    const argumentTypes = extractArgumentTypes(match);
    const argumentTypeClasses = parseJsonParameterTypeClassesCapture(
      match['@reference.parameter-type-classes'],
    );

    // Object-literal key for value-ref sites (`{ key: fn }` / shorthand);
    // consumed by the property-dispatch pass (#2437).
    const propertyKeyCap = match['@reference.property-key'];

    // Compact receiver chain, when the emitter produced one. Validated HERE as
    // well as at the store boundary: bounds applied only on load are a
    // recurring defect in this codebase — the writer keeps minting payloads the
    // reader keeps rejecting, which is a permanent warm-cache-miss reparse loop
    // that logs nothing.
    const receiverChain = extractReceiverChain(match);

    // Callee-position marker: a member-read capture that is actually the callee
    // of an enclosing call (`obj.f` in `obj.f()`). Recorded, not acted on —
    // whether the read is a phantom or a genuine func-typed-field read depends
    // on the resolved tail's kind, which only edge emission knows. Emitted by
    // languages whose read pattern has no call-position exclusion; absent
    // everywhere else, so the site stays byte-identical for them.
    const inCalleePosition = match['@reference.callee-position'] !== undefined;
    // Pointer-embedding marker: `struct S { *T }` rather than `struct S { T }`.
    // Recorded, not acted on — Go's method-set rules make the two forms differ
    // (see `ReferenceSite.embeddedAsPointer`), and only structural interface
    // detection knows what to do with that. Absent for every language without
    // pointer embedding, so their sites stay byte-identical.
    const embeddedAsPointer = match['@reference.embedded-pointer'] !== undefined;
    // Static-gating marker: the call sits in a branch the language layer proved
    // dead at index time (Zig `if (CONST_FALSE)`). Recorded on the site and
    // copied to the CALLS edge; absent everywhere else (see
    // `ReferenceSite.staticGated`).
    const staticGated = kind === 'call' && match['@reference.static-gated'] !== undefined;

    const site: ReferenceSite = {
      name: nameCap.text,
      atRange: anchor.range,
      inScope: inScopeId,
      kind,
      ...(qualifiedCap?.text !== undefined && qualifiedCap.text.length > 0
        ? { rawQualifiedName: qualifiedCap.text }
        : {}),
      ...(typeArguments !== undefined ? { typeArguments } : {}),
      ...(propertyKeyCap?.text !== undefined && propertyKeyCap.text.length > 0
        ? { propertyKey: propertyKeyCap.text }
        : {}),
      ...(callForm !== undefined ? { callForm } : {}),
      ...(explicitReceiver !== undefined ? { explicitReceiver } : {}),
      ...(arity !== undefined ? { arity } : {}),
      ...(argumentTypes !== undefined ? { argumentTypes } : {}),
      ...(argumentTypeClasses !== undefined ? { argumentTypeClasses } : {}),
      ...(receiverChain !== undefined ? { receiverChain } : {}),
      ...(inCalleePosition ? { inCalleePosition: true } : {}),
      ...(embeddedAsPointer ? { embeddedAsPointer: true } : {}),
      ...(staticGated ? { staticGated: true } : {}),
    };
    referenceSites.push(site);
  }
}

/**
 * The generic arguments a heritage reference was written with, by whichever of
 * the two routes this emitter uses (#2912).
 *
 * `@reference.type-arguments` is the explicit route, for an emitter whose anchor
 * is the bare NAME node (Rust's `impl Trait for S` anchors on the trait
 * identifier inside a `generic_type`). It wins where present: moving such an
 * anchor to cover the arguments would change the site's range, and that range is
 * part of every inheritance EDGE ID — a spelling detail must not renumber the
 * graph. Every other emitter already anchors on the whole base, so its spelling
 * is read directly and no query changed.
 */
function heritageTypeArguments(
  match: CaptureMatch,
  anchor: Capture,
  nameCap: Capture,
): readonly string[] | undefined {
  const explicit = match['@reference.type-arguments']?.text;
  return explicit !== undefined
    ? typeApplicationArguments(explicit)
    : referenceTypeArguments(anchor.text, nameCap.text);
}

/**
 * Type arguments written on a heritage reference, read from the anchor's own
 * spelling — `IValidator<string>` → `['string']` (#2912).
 *
 * Two shapes are handled before the spelling is read as an application:
 *
 *   - A trailing CONSTRUCTOR INVOCATION is dropped. `record R : Base<int>(x)`
 *     and Kotlin `class C : Bar<Int>()` write a call in the heritage position;
 *     the call is not part of the type, and leaving it attached would make the
 *     list fail to close at the end and lose the arguments entirely.
 *   - The application's base must BE the referenced name (`Other::Inner<T>`
 *     ends with `Inner`). An anchor that spans more than the base type is not
 *     read at all rather than read wrongly.
 *
 * `undefined` for a non-generic base and for every spelling that is not exactly
 * one balanced argument list — absence is the "unknown" value that consumers
 * fail open on, so declining is always safe here.
 */
function referenceTypeArguments(
  anchorText: string,
  baseName: string,
): readonly string[] | undefined {
  const text = stripTrailingCallSuffix(anchorText.trim());
  const opener = text.search(OPENING_BRACKET);
  if (opener === -1) return undefined;
  if (!text.slice(0, opener).trimEnd().endsWith(baseName)) return undefined;
  return typeApplicationArguments(text);
}

const OPENING_BRACKET = /[<[]/;

function referenceKindFromAnchor(name: string): ReferenceKind | undefined {
  const suffix = name.slice('@reference.'.length);
  // Strip sub-tag after the kind (`@reference.call.member` → `call`).
  const firstDot = suffix.indexOf('.');
  const head = firstDot === -1 ? suffix : suffix.slice(0, firstDot);
  switch (head.toLowerCase()) {
    case 'call':
      return 'call';
    case 'read':
      return 'read';
    case 'write':
      return 'write';
    case 'type':
    case 'type_reference':
      return 'type-reference';
    case 'inherits':
      return 'inherits';
    case 'import_use':
    case 'import-use':
      return 'import-use';
    case 'macro':
      return 'macro';
    case 'value-ref':
      return 'value-ref';
    default:
      return undefined;
  }
}

function classifyCallFormForMatch(
  match: CaptureMatch,
  anchorName: string,
  provider: ScopeExtractorHooks,
  scopeTree: ReturnType<typeof buildScopeTree>,
  inScopeId: ScopeId,
): 'free' | 'member' | 'constructor' | 'index' {
  // Declarative sub-tag path first: `@reference.call.member` → 'member'.
  const suffix = anchorName.slice('@reference.call.'.length);
  switch (suffix.toLowerCase()) {
    case 'free':
      return 'free';
    case 'member':
      return 'member';
    case 'constructor':
      return 'constructor';
    case 'index':
      return 'index';
  }

  // Hook-based path: provider knows.
  const hook = provider.classifyCallForm;
  if (hook !== undefined) {
    const scope = scopeTree.getScope(inScopeId);
    if (scope !== undefined) return hook(match, scope);
  }

  return 'free';
}

function extractExplicitReceiver(match: CaptureMatch): { readonly name: string } | undefined {
  const cap = match['@reference.receiver'];
  if (cap === undefined) return undefined;
  return { name: cap.text };
}

/**
 * The compact receiver chain, when the language emitter synthesized one.
 *
 * Returns `undefined` for anything that does not decode, so a malformed or
 * over-bound payload degrades to the existing text cascade rather than
 * poisoning the durable store. Never throws — this runs per reference site.
 */
function extractReceiverChain(match: CaptureMatch): string | undefined {
  const cap = match['@reference.receiver-chain'];
  if (cap === undefined) return undefined;
  return isValidReceiverChain(cap.text) ? cap.text : undefined;
}

function extractArity(match: CaptureMatch): number | undefined {
  const cap = match['@reference.arity'];
  if (cap === undefined) return undefined;
  const n = Number.parseInt(cap.text, 10);
  return Number.isFinite(n) ? n : undefined;
}

function extractArgumentTypes(match: CaptureMatch): readonly string[] | undefined {
  const cap = match['@reference.parameter-types'];
  if (cap === undefined) return undefined;
  try {
    const parsed = JSON.parse(cap.text);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) return parsed;
  } catch {
    /* malformed — fall through */
  }
  return undefined;
}

// ─── Pass 6: collect callable-value-flow facts ─────────────────────────────

const CALLABLE_FLOW_KINDS = [
  'seed',
  'copy',
  'alias',
  'address',
  'store',
  'load',
  'formal',
  'argument',
  'invoke',
] as const;

type CallableFlowKind = (typeof CALLABLE_FLOW_KINDS)[number];

function pass6CollectCallableFlows(
  matches: readonly CaptureMatch[],
  positionIndex: ReturnType<typeof buildPositionIndex>,
  filePath: string,
  out: CallableFlowSite[],
): void {
  for (const match of matches) {
    const kind = callableFlowKind(match);
    if (kind === undefined) continue;
    const anchor = match[`@callable-flow.${kind}`];
    if (anchor === undefined) continue;

    switch (kind) {
      case 'seed': {
        const destination = callableFlowOperand(match, 'destination', positionIndex, filePath);
        const target = match['@callable-flow.target'];
        const targetName = match['@callable-flow.target-name']?.text ?? target?.text;
        if (destination === undefined || target === undefined || !nonEmpty(targetName)) continue;
        const expectedSignature = callableFlowExpectedSignature(match);
        out.push({
          kind,
          destination,
          targetName,
          targetRange: target.range,
          ...(nonEmpty(match['@callable-flow.target-qualified-name']?.text)
            ? { targetQualifiedName: match['@callable-flow.target-qualified-name']!.text }
            : {}),
          ...(expectedSignature !== undefined ? { expectedSignature } : {}),
        });
        break;
      }
      case 'copy':
      case 'alias': {
        const source = callableFlowOperand(match, 'source', positionIndex, filePath);
        const destination = callableFlowOperand(match, 'destination', positionIndex, filePath);
        if (source === undefined || destination === undefined) continue;
        out.push({ kind, source, destination });
        break;
      }
      case 'address': {
        const source = callableFlowOperand(match, 'source', positionIndex, filePath);
        const destination = callableFlowOperand(match, 'destination', positionIndex, filePath);
        if (source === undefined || destination === undefined) continue;
        out.push({ kind, source, destination });
        break;
      }
      case 'store': {
        const source = callableFlowOperand(match, 'source', positionIndex, filePath);
        const pointer = callableFlowOperand(match, 'pointer', positionIndex, filePath);
        if (source === undefined || pointer === undefined) continue;
        out.push({ kind, source, pointer });
        break;
      }
      case 'load': {
        const pointer = callableFlowOperand(match, 'pointer', positionIndex, filePath);
        const destination = callableFlowOperand(match, 'destination', positionIndex, filePath);
        if (pointer === undefined || destination === undefined) continue;
        out.push({ kind, pointer, destination });
        break;
      }
      case 'formal': {
        const owner = match['@callable-flow.owner'];
        const binding = callableFlowOperand(match, 'binding', positionIndex, filePath);
        const parameterIndex = parseNonNegativeInt(match['@callable-flow.parameter-index']?.text);
        const passingMode = parseCallablePassingMode(match['@callable-flow.passing-mode']?.text);
        if (
          owner === undefined ||
          !nonEmpty(owner.text) ||
          binding === undefined ||
          parameterIndex === undefined ||
          passingMode === undefined
        ) {
          continue;
        }
        const expectedSignature = callableFlowExpectedSignature(match);
        out.push({
          kind,
          ownerName: owner.text,
          ownerRange: owner.range,
          parameterIndex,
          binding,
          passingMode,
          ...(expectedSignature !== undefined ? { expectedSignature } : {}),
        });
        break;
      }
      case 'argument': {
        const source = callableFlowOperand(match, 'source', positionIndex, filePath);
        const parameterIndex = parseNonNegativeInt(match['@callable-flow.parameter-index']?.text);
        if (source === undefined || parameterIndex === undefined) continue;
        out.push({
          kind,
          callSite: anchor.range,
          parameterIndex,
          source,
          ...(nonEmpty(match['@callable-flow.direct-callee-name']?.text)
            ? { directCalleeName: match['@callable-flow.direct-callee-name']!.text }
            : {}),
        });
        break;
      }
      case 'invoke': {
        const callee = callableFlowOperand(match, 'callee', positionIndex, filePath);
        const inScope = positionIndex.atPosition(
          filePath,
          anchor.range.startLine,
          anchor.range.startCol,
        );
        const invocationKind = parseCallableInvocationKind(
          match['@callable-flow.invocation-kind']?.text,
        );
        if (callee === undefined || inScope === undefined || invocationKind === undefined) continue;
        const receiver = callableFlowOperand(match, 'receiver', positionIndex, filePath);
        const arity = parseNonNegativeInt(match['@callable-flow.arity']?.text);
        out.push({
          kind,
          callSite: anchor.range,
          inScope,
          callee,
          invocationKind,
          ...(receiver !== undefined ? { receiver } : {}),
          ...(arity !== undefined ? { arity } : {}),
        });
        break;
      }
    }
  }
}

function callableFlowKind(match: CaptureMatch): CallableFlowKind | undefined {
  return CALLABLE_FLOW_KINDS.find((kind) => match[`@callable-flow.${kind}`] !== undefined);
}

function callableFlowOperand(
  match: CaptureMatch,
  role: 'source' | 'destination' | 'pointer' | 'binding' | 'callee' | 'receiver',
  positionIndex: ReturnType<typeof buildPositionIndex>,
  filePath: string,
): CallableFlowOperand | undefined {
  const cap = match[`@callable-flow.${role}`];
  if (cap === undefined || !nonEmpty(cap.text)) return undefined;
  const inScope = positionIndex.atPosition(filePath, cap.range.startLine, cap.range.startCol);
  if (inScope === undefined) return undefined;
  const expressionKind = parseCallableOperandKind(match[`@callable-flow.${role}-kind`]?.text);
  const indirection = parseNonNegativeInt(match[`@callable-flow.${role}-indirection`]?.text);
  if (indirection !== undefined && indirection > 16) return undefined;
  return {
    name: cap.text,
    inScope,
    atRange: cap.range,
    indirection: indirection ?? 0,
    addressOf: match[`@callable-flow.${role}-address`]?.text === 'true',
    ...(expressionKind !== undefined ? { expressionKind } : {}),
    ...(nonEmpty(match[`@callable-flow.${role}-qualified-name`]?.text)
      ? { qualifiedName: match[`@callable-flow.${role}-qualified-name`]!.text }
      : {}),
  };
}

function callableFlowExpectedSignature(
  match: CaptureMatch,
): CallableFlowExpectedSignature | undefined {
  const parameterCount = parseNonNegativeInt(match['@callable-flow.expected-arity']?.text);
  const parameterTypes = parseJsonStringArray(match['@callable-flow.expected-types']?.text);
  const parameterTypeClasses = parseJsonParameterTypeClassesCapture(
    match['@callable-flow.expected-type-classes'],
  );
  const isConst = parseBooleanText(match['@callable-flow.expected-const']?.text);
  if (
    parameterCount === undefined &&
    parameterTypes === undefined &&
    parameterTypeClasses === undefined &&
    isConst === undefined
  ) {
    return undefined;
  }
  return {
    ...(parameterCount !== undefined ? { parameterCount } : {}),
    ...(parameterTypes !== undefined ? { parameterTypes } : {}),
    ...(parameterTypeClasses !== undefined ? { parameterTypeClasses } : {}),
    ...(isConst !== undefined ? { isConst } : {}),
  };
}

function parseCallableOperandKind(
  text: string | undefined,
): 'binding' | 'callable-designator' | 'bound-member' | 'anonymous-callable' | undefined {
  switch (text) {
    case 'binding':
    case 'callable-designator':
    case 'bound-member':
    case 'anonymous-callable':
      return text;
    default:
      return undefined;
  }
}

function parseBooleanText(text: string | undefined): boolean | undefined {
  if (text === 'true') return true;
  if (text === 'false') return false;
  return undefined;
}

function parseJsonStringArray(text: string | undefined): readonly string[] | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) && parsed.every((value) => typeof value === 'string')
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function parseNonNegativeInt(text: string | undefined): number | undefined {
  if (text === undefined || !/^\d+$/.test(text)) return undefined;
  const value = Number.parseInt(text, 10);
  return Number.isSafeInteger(value) ? value : undefined;
}

function parseCallablePassingMode(text: string | undefined): CallableFlowPassingMode | undefined {
  switch (text) {
    case 'value':
    case 'reference':
    case 'pointer':
      return text;
    default:
      return undefined;
  }
}

function parseCallableInvocationKind(
  text: string | undefined,
): 'indirect' | 'member-pointer' | 'callable-object' | undefined {
  switch (text) {
    case 'indirect':
    case 'member-pointer':
    case 'callable-object':
      return text;
    default:
      return undefined;
  }
}

function nonEmpty(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}

// ─── Internal: range + capture utilities ───────────────────────────────────

function rangesEqual(a: Range, b: Range): boolean {
  return (
    a.startLine === b.startLine &&
    a.startCol === b.startCol &&
    a.endLine === b.endLine &&
    a.endCol === b.endCol
  );
}

/**
 * Capture names that are never anchors — they are sub-tags nested inside a
 * larger anchor (e.g., the receiver expression inside a `@reference.call`
 * may span more source than the called name, but is not the call itself).
 *
 * The list is maintained here centrally rather than per-pass because the
 * set is small and stable; adding a new sub-tag convention is a one-line
 * change.
 */
const KNOWN_SUB_TAGS: ReadonlySet<string> = new Set<string>([
  '@scope.lexical-names',
  '@declaration.name',
  '@declaration.qualified_name',
  '@declaration.is-synthetic',
  '@import.name',
  '@import.source',
  '@import.alias',
  // Provider-set marker, not a statement anchor. Listed for the same reason as
  // its siblings: it is emitted on a sub-node of the import statement, and the
  // anchor must stay `@import.statement` regardless of relative span.
  '@import.publishes',
  '@type-binding.name',
  '@type-binding.type',
  '@reference.name',
  '@reference.qualified-name',
  // The generic arguments a heritage base was written with, when the emitter's
  // anchor is the bare name and cannot carry them (#2912). A sub-tag for the
  // usual reason: it spans a sibling node of the anchor, never the site itself.
  '@reference.type-arguments',
  '@reference.property-key',
  '@reference.callee-position',
  '@reference.embedded-pointer',
  '@reference.static-gated',
  '@reference.receiver',
  '@reference.operator',
  '@reference.arity',
  '@reference.parameter-types',
  '@reference.parameter-type-classes',
  '@declaration.parameter-count',
  '@declaration.required-parameter-count',
  '@declaration.parameter-types',
  '@declaration.parameter-type-classes',
  '@declaration.return-type',
  '@declaration.template-constraints',
  // MUST be listed, and the failure it prevents is silent def LOSS rather than
  // a missing field. `anchorCaptureFor` picks the broadest-span `@declaration.*`
  // capture that is not a known sub-tag; a type-parameter list is normally
  // narrower than the declaration that owns it, but a C++ `template <class A,
  // class B, …>` or a multi-line Java `<T extends A & B>` written above a short
  // declaration can out-span it. The anchor would then be `type-parameters`,
  // `normalizeNodeLabel` would return undefined for it, and the whole class def
  // would be dropped rather than merely losing its parameters.
  '@declaration.type-parameters',
  '@declaration.is-explicit',
  '@declaration.is-deleted',
]);

/**
 * Return the anchor capture for a match — the one whose name begins with
 * `prefix` AND is not in the known-sub-tag set. When multiple candidates
 * remain, the broadest-ranged one wins: tree-sitter queries often tag
 * both a whole statement and a sub-token under the same topic
 * (`@scope.function` + `@scope.function.name`); the anchor is the
 * statement-level one.
 */
function anchorCaptureFor(
  match: CaptureMatch,
  prefix: string,
): { readonly name: string; readonly range: Range; readonly text: string } | undefined {
  let best: { readonly name: string; readonly range: Range; readonly text: string } | undefined;
  let bestSpan = -1;
  for (const name of Object.keys(match)) {
    if (!name.startsWith(prefix)) continue;
    if (KNOWN_SUB_TAGS.has(name)) continue;
    const cap = match[name]!;
    const span =
      (cap.range.endLine - cap.range.startLine) * 1_000_000 +
      (cap.range.endCol - cap.range.startCol);
    if (span > bestSpan) {
      bestSpan = span;
      best = cap;
    }
  }
  return best;
}
