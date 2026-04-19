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
 *      `provider.shouldCreateScope` (default true) and
 *      `provider.resolveScopeKind` (default: suffix of the capture name).
 *      Derive parent by lexical-range containment. Hand the resulting
 *      `Scope[]` to `buildScopeTree` for validation.
 *   2. **Attach declarations + local bindings.** Walk `@declaration.*`
 *      matches. For each, build a `SymbolDefinition` and attach it to
 *      `provider.bindingScopeFor` (default: innermost containing scope)
 *      as `ownedDefs` + a local `BindingRef { origin: 'local' }`.
 *   3. **Collect raw imports.** Walk `@import.*` matches. Call
 *      `provider.interpretImport` per match; attach the returned
 *      `ParsedImport` to the ParsedFile (not to any `Scope` — finalize
 *      reconstructs the owning scope via `provider.importOwningScope`
 *      during Phase 2).
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
  CaptureMatch,
  ImportEdge,
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
import { buildPositionIndex, buildScopeTree, makeScopeId } from 'gitnexus-shared';
import type { LanguageProvider } from './language-provider.js';

// ─── Narrow hook surface the extractor actually uses ───────────────────────

/**
 * The subset of `LanguageProvider` hooks that `extract()` reads. Declared
 * as its own type so:
 *
 *   - Tests can implement just these six hooks without faking the whole
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
  | 'shouldCreateScope'
  | 'resolveScopeKind'
  | 'bindingScopeFor'
  | 'interpretImport'
  | 'interpretTypeBinding'
  | 'classifyCallForm'
>;

// ─── Public entry point ─────────────────────────────────────────────────────

/**
 * Drive the five extraction passes and return a `ParsedFile`.
 *
 * Throws `ScopeTreeInvariantError` (from #912) when the provider emits
 * captures that violate structural scope invariants. The error surfaces
 * upward rather than being silently corrected — a malformed capture set
 * is a bug in the provider's `emitScopeCaptures`, not a data condition
 * to tolerate.
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

  const moduleScope = scopeDrafts.find((s) => s.kind === 'Module');
  if (moduleScope === undefined) {
    throw new Error(
      `ScopeExtractor: no Module scope found for '${filePath}'. ` +
        `Provider must emit at least one @scope.module capture per file.`,
    );
  }

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
  pass3CollectImports(partitioned.import_, parsedImports, provider);

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

  // Freeze Scope drafts into final shape and return.
  const frozenScopes = scopeDrafts.map(draftToScope);
  return Object.freeze({
    filePath,
    moduleScope: moduleScope.id,
    scopes: Object.freeze(frozenScopes),
    parsedImports: Object.freeze(parsedImports.slice()),
    localDefs: Object.freeze(localDefs.slice()),
    referenceSites: Object.freeze(referenceSites.slice()),
  });
}

// ─── Internal: partitioning by topic ───────────────────────────────────────

interface Partitioned {
  readonly scope: readonly CaptureMatch[];
  readonly declaration: readonly CaptureMatch[];
  readonly import_: readonly CaptureMatch[];
  readonly typeBinding: readonly CaptureMatch[];
  readonly reference: readonly CaptureMatch[];
}

/**
 * Bucket each match by the topic of its anchor capture. The anchor is the
 * capture whose name is prefixed with the match's topic (`@scope.*`,
 * `@declaration.*`, `@import.*`, `@type-binding.*`, `@reference.*`).
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

  for (const match of matches) {
    const topic = topicOf(match);
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
      case 'unknown':
        // Unrecognized anchor — silently skip. Providers may emit extra
        // captures (e.g., `@comment`) that the extractor has no topic for.
        break;
    }
  }

  return { scope, declaration, import_, typeBinding, reference };
}

type Topic = 'scope' | 'declaration' | 'import' | 'type-binding' | 'reference' | 'unknown';

function topicOf(match: CaptureMatch): Topic {
  // The anchor is the capture whose name uses one of the known topic
  // prefixes. For multi-capture matches, ALL captures share the topic;
  // we pick the first matching key for efficiency.
  for (const name of Object.keys(match)) {
    if (name.startsWith('@scope.')) return 'scope';
    if (name.startsWith('@declaration.')) return 'declaration';
    if (name.startsWith('@import.')) return 'import';
    if (name.startsWith('@type-binding.')) return 'type-binding';
    if (name.startsWith('@reference.')) return 'reference';
  }
  return 'unknown';
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
  };
}

// ─── Pass 1: build scope tree ──────────────────────────────────────────────

/**
 * Convert `@scope.*` matches into `ScopeDraft[]`. Parent relationships
 * are derived from range containment (outermost scope containing `range`
 * becomes the parent). Scopes with `shouldCreateScope === false` are
 * silently omitted — their children reparent to the next enclosing
 * real scope.
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
    readonly create: boolean;
    readonly id: ScopeId;
  }

  const candidates: Candidate[] = [];
  for (const match of matches) {
    const anchor = anchorCaptureFor(match, '@scope.');
    if (anchor === undefined) continue;
    const kind = resolveKindForScopeMatch(match, anchor, provider);
    if (kind === null) continue;
    const create = provider.shouldCreateScope?.(match) ?? true;
    const id = makeScopeId({ filePath, range: anchor.range, kind });
    candidates.push({ match, range: anchor.range, kind, create, id });
  }

  // Sort by (startLine, startCol) ASC, (endLine, endCol) DESC so outer
  // scopes appear before their children for parent-resolution.
  candidates.sort((a, b) => {
    if (a.range.startLine !== b.range.startLine) return a.range.startLine - b.range.startLine;
    if (a.range.startCol !== b.range.startCol) return a.range.startCol - b.range.startCol;
    if (a.range.endLine !== b.range.endLine) return b.range.endLine - a.range.endLine;
    return b.range.endCol - a.range.endCol;
  });

  const drafts: ScopeDraft[] = [];
  const stack: Candidate[] = []; // enclosing real scopes, outermost at [0]

  for (const cand of candidates) {
    // Pop the stack until the top strictly contains this candidate.
    while (stack.length > 0 && !rangeStrictlyContains(stack[stack.length - 1]!.range, cand.range)) {
      stack.pop();
    }

    if (cand.create) {
      const parent = stack.length > 0 ? stack[stack.length - 1]!.id : null;
      drafts.push(makeDraft(cand.id, parent, cand.kind, cand.range, filePath));
      stack.push(cand);
    }
    // If `cand.create === false`, we don't push it onto the stack — child
    // scopes will reparent to whatever's below it.
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
  };
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

  for (const match of matches) {
    const anchor = anchorCaptureFor(match, '@declaration.');
    if (anchor === undefined) continue;

    const def = buildDefFromDeclarationMatch(match, anchor, filePath);
    if (def === undefined) continue;

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
    const bindingScopeId =
      provider.bindingScopeFor?.(match, draftToScope(innermost), scopeTree) ?? innermost.id;
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

  return {
    nodeId: makeDefId(filePath, anchor.range, type, nameCap.text),
    filePath,
    type,
    ...(qualifiedName !== undefined ? { qualifiedName } : { qualifiedName: nameCap.text }),
  };
}

function deriveDeclarationName(match: CaptureMatch, def: SymbolDefinition): string | undefined {
  const nameCap =
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
    case 'const':
      return 'Variable';
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
    default:
      return undefined;
  }
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

function pass3CollectImports(
  matches: readonly CaptureMatch[],
  parsedImports: ParsedImport[],
  provider: ScopeExtractorHooks,
): void {
  if (provider.interpretImport === undefined) return;
  for (const match of matches) {
    const anchor = anchorCaptureFor(match, '@import.');
    if (anchor === undefined) continue;
    const parsed = provider.interpretImport(match);
    if (parsed === null) continue;
    parsedImports.push(parsed);
  }
}

// ─── Pass 4: collect type bindings ─────────────────────────────────────────

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

    // `bindingScopeFor` may hoist the type binding to an outer scope.
    const hostId =
      provider.bindingScopeFor?.(match, draftToScope(innermost), scopeTree) ?? innermost.id;
    const host = draftById.get(hostId) ?? innermost;

    const typeRef: TypeRef = {
      rawName: parsed.rawTypeName,
      declaredAtScope: host.id,
      source: parsed.source,
    };
    host.typeBindings.set(parsed.boundName, typeRef);
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

    const site: ReferenceSite = {
      name: nameCap.text,
      atRange: anchor.range,
      inScope: inScopeId,
      kind,
      ...(callForm !== undefined ? { callForm } : {}),
      ...(explicitReceiver !== undefined ? { explicitReceiver } : {}),
      ...(arity !== undefined ? { arity } : {}),
    };
    referenceSites.push(site);
  }
}

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

function extractArity(match: CaptureMatch): number | undefined {
  const cap = match['@reference.arity'];
  if (cap === undefined) return undefined;
  const n = Number.parseInt(cap.text, 10);
  return Number.isFinite(n) ? n : undefined;
}

// ─── Internal: range + capture utilities ───────────────────────────────────

function rangeStrictlyContains(outer: Range, inner: Range): boolean {
  if (
    outer.startLine === inner.startLine &&
    outer.startCol === inner.startCol &&
    outer.endLine === inner.endLine &&
    outer.endCol === inner.endCol
  ) {
    return false;
  }
  const startsBefore =
    outer.startLine < inner.startLine ||
    (outer.startLine === inner.startLine && outer.startCol <= inner.startCol);
  const endsAfter =
    outer.endLine > inner.endLine ||
    (outer.endLine === inner.endLine && outer.endCol >= inner.endCol);
  return startsBefore && endsAfter;
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
  '@declaration.name',
  '@declaration.qualified_name',
  '@import.name',
  '@import.source',
  '@import.alias',
  '@type-binding.name',
  '@type-binding.type',
  '@reference.name',
  '@reference.receiver',
  '@reference.arity',
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
