/** Pure lexical ownership shared by registries, inference, and import provenance. */
import type {
  BindingRef,
  ImportEdge,
  NameClaim,
  NameLookupOptions,
  Range,
  Scope,
  ScopeId,
  ScopeLookup,
  SourcePosition,
  TypeRef,
} from './types.js';

export interface ScopeClaimSelection {
  readonly status: 'absent' | 'blocked' | 'selected' | 'module';
  readonly claims: readonly NameClaim[];
}
export interface NameClaimResult {
  readonly status: 'absent' | 'blocked' | 'resolved';
  readonly scope?: Scope;
  readonly typeBinding?: TypeRef;
  readonly bindings: readonly BindingRef[];
  readonly imports: readonly ImportEdge[];
  readonly claims: readonly NameClaim[];
}
export interface NameClaimSources {
  readonly scopes: ScopeLookup;
  readonly bindingsAt?: (scope: Scope, name: string) => readonly BindingRef[];
  readonly importsAt?: (scope: Scope) => readonly ImportEdge[];
}
const ABSENT: NameClaimResult = Object.freeze({
  status: 'absent',
  bindings: [],
  imports: [],
  claims: [],
});
const compare = (a: SourcePosition, b: SourcePosition): number =>
  a.startLine - b.startLine || a.startCol - b.startCol;
export function rangesOverlap(a: Range, b: Range): boolean {
  return (
    compare(a, { startLine: b.endLine, startCol: b.endCol }) <= 0 &&
    compare(b, { startLine: a.endLine, startCol: a.endCol }) <= 0
  );
}

/** Ownership is selected before target availability or target kind is inspected. */
export function selectClaimsAtScope(
  scope: Scope,
  name: string,
  options: NameLookupOptions = {},
): ScopeClaimSelection {
  const purpose = options.purpose ?? 'value';
  const claims =
    scope.nameClaims?.filter(
      (c) =>
        c.name === name &&
        (c.purpose === undefined || c.purpose === 'both' || c.purpose === purpose),
    ) ?? [];
  if (claims.length === 0) return { status: 'absent', claims };
  const active = claims.filter(
    (c) =>
      c.availableFrom === undefined ||
      options.position === undefined ||
      compare(c.availableFrom, options.position) <= 0,
  );
  if (active.length === 0) {
    const first = claims.reduce((a, b) => (compare(a.range, b.range) <= 0 ? a : b));
    return {
      status:
        first.inactive === 'outer' ? 'absent' : first.inactive === 'module' ? 'module' : 'blocked',
      claims,
    };
  }
  // Same-position alternatives retain ambiguity. Providers can mark uncertain
  // rebinding explicitly blocked rather than claiming a control-flow winner.
  const ordered = active.filter((c) => c.hoisted !== true);
  const relevant = ordered.length > 0 ? ordered : active;
  const latest = relevant.reduce((a, b) => (compare(a.range, b.range) >= 0 ? a : b)).range;
  let selected = relevant.filter((c) => compare(c.range, latest) === 0);
  if (selected.some((c) => c.merge === true))
    selected = active.filter((c) => c.merge === true || compare(c.range, latest) === 0);
  return {
    status: selected.some((c) => c.kind === 'blocked' && c.redirect === undefined)
      ? 'blocked'
      : 'selected',
    claims: selected,
  };
}

function moduleScope(start: Scope, scopes: ScopeLookup): Scope | undefined {
  let scope: Scope | undefined = start;
  const seen = new Set<ScopeId>();
  while (scope !== undefined && !seen.has(scope.id)) {
    if (scope.kind === 'Module') return scope;
    seen.add(scope.id);
    scope = scope.parent === null ? undefined : scopes.getScope(scope.parent);
  }
  return undefined;
}
function redirectScope(
  scope: Scope,
  name: string,
  claim: NameClaim,
  scopes: ScopeLookup,
): Scope | undefined {
  if (claim.redirect === 'module') return moduleScope(scope, scopes);
  let parent = scope.parent === null ? undefined : scopes.getScope(scope.parent);
  const seen = new Set<ScopeId>();
  while (parent !== undefined && !seen.has(parent.id)) {
    seen.add(parent.id);
    if (
      parent.kind === 'Function' &&
      (parent.nameClaims?.some((c) => c.name === name && c.redirect === undefined) ||
        parent.lexicalNames?.has(name) ||
        parent.bindings.has(name) ||
        parent.typeBindings.has(name))
    )
      return parent;
    parent = parent.parent === null ? undefined : scopes.getScope(parent.parent);
  }
  return undefined;
}
function matchesClaim(range: Range | undefined, claim: NameClaim): boolean {
  return range === undefined || rangesOverlap(range, claim.range);
}

function matchesBindingClaim(range: Range | undefined, claim: NameClaim): boolean {
  return (
    range === undefined ||
    (compare(claim.range, range) <= 0 &&
      compare(
        { startLine: range.endLine, startCol: range.endCol },
        { startLine: claim.range.endLine, startCol: claim.range.endCol },
      ) <= 0)
  );
}

export function lookupLexicalName(
  startScope: ScopeId,
  name: string,
  sources: NameClaimSources,
  options: NameLookupOptions = {},
): NameClaimResult {
  let id: ScopeId | null = startScope;
  let position = options.position;
  let forcedClaims: readonly NameClaim[] | undefined;
  const visited = new Set<ScopeId>();
  while (id !== null && !visited.has(id)) {
    visited.add(id);
    const scope = sources.scopes.getScope(id);
    if (scope === undefined) return { ...ABSENT, status: 'blocked' };
    if (
      scope.kind === 'Object' ||
      (id !== startScope &&
        ((scope.lookupPolicy?.skipFromChildren &&
          !scope.lookupPolicy.visibleNamesFromChildren?.includes(name)) ||
          (options.skipEnclosingClasses && scope.kind === 'Class')))
    ) {
      id = scope.lookupPolicy?.parentScope ?? scope.parent;
      continue;
    }
    const selected: ScopeClaimSelection =
      forcedClaims === undefined
        ? selectClaimsAtScope(scope, name, { ...options, position })
        : { status: 'selected', claims: forcedClaims };
    forcedClaims = undefined;
    const redirected = selected.claims.find((c) => c.redirect !== undefined);
    if (redirected !== undefined) {
      const target = redirectScope(scope, name, redirected, sources.scopes);
      if (target === undefined || target.id === id)
        return { ...ABSENT, status: 'blocked', scope, claims: selected.claims };
      if (selected.status === 'selected' && redirected.kind !== 'blocked') {
        forcedClaims = selected.claims.map((c) => ({ ...c, redirect: undefined }));
      }
      id = target.id;
      position = undefined;
      continue;
    }
    if (selected.status === 'module') {
      const target = moduleScope(scope, sources.scopes);
      if (target === undefined || target.id === id)
        return { ...ABSENT, status: 'blocked', scope, claims: selected.claims };
      let skipped: Scope | undefined = scope;
      const skippedIds = new Set<ScopeId>();
      while (skipped !== undefined && skipped.id !== target.id && !skippedIds.has(skipped.id)) {
        skippedIds.add(skipped.id);
        if (skipped.lookupPolicy?.deferParentActivation) position = undefined;
        skipped = skipped.parent === null ? undefined : sources.scopes.getScope(skipped.parent);
      }
      id = target.id;
      continue;
    }
    if (selected.status === 'blocked')
      return { ...ABSENT, status: 'blocked', scope, claims: selected.claims };
    const hasClaimsForName = scope.nameClaims?.some((claim) => claim.name === name) === true;
    const allBindings = sources.bindingsAt?.(scope, name) ?? scope.bindings.get(name) ?? [];
    const allImports = (sources.importsAt?.(scope) ?? scope.imports ?? []).filter(
      (e) => e.localName === name && e.kind !== 'side-effect' && e.kind !== 'dynamic-resolved',
    );
    let bindings = allBindings.filter(
      (b) =>
        b.availableFrom === undefined ||
        position === undefined ||
        compare(b.availableFrom, position) <= 0,
    );
    let imports = allImports;
    if (selected.status === 'selected') {
      bindings = bindings.filter((b) =>
        selected.claims.some((c) =>
          c.kind === 'import'
            ? b.via !== undefined && matchesClaim(b.via.atRange, c)
            : c.kind === 'binding' &&
              (b.origin === 'local' || b.declarationRange !== undefined) &&
              matchesBindingClaim(b.declarationRange, c),
        ),
      );
      imports = allImports.filter((e) =>
        selected.claims.some((c) => c.kind === 'import' && matchesClaim(e.atRange, c)),
      );
    } else if (hasClaimsForName) {
      // A declaration in another namespace, or a not-yet-visible declaration,
      // must not sneak back through the unfiltered legacy binding channels.
      bindings = bindings.filter(
        (b) =>
          b.availableFrom !== undefined &&
          b.declarationRange !== undefined &&
          !scope.nameClaims!.some(
            (c) => c.name === name && rangesOverlap(c.range, b.declarationRange!),
          ),
      );
      imports = [];
    }
    const ownType = scope.typeBindings.get(name);
    const typeFactOwnsName =
      ownType !== undefined &&
      !(scope.lookupPolicy?.nameClaimsComplete && ownType.source === 'assignment-inferred');
    const owns =
      selected.status === 'selected' ||
      bindings.length > 0 ||
      imports.length > 0 ||
      scope.ownsReceivers?.has(name) === true ||
      (!hasClaimsForName && (scope.lexicalNames?.has(name) === true || typeFactOwnsName));
    if (owns) {
      const typeBinding =
        selected.status === 'selected' &&
        ownType?.bindingRange !== undefined &&
        !selected.claims.some(
          (c) =>
            c.kind === 'import' ||
            (c.kind === 'binding' && rangesOverlap(c.range, ownType.bindingRange!)),
        )
          ? undefined
          : ownType;
      const usable = bindings.filter(
        (b) => (options.purpose ?? 'value') !== 'value' || b.via?.typeOnly !== true,
      );
      return {
        status:
          usable.length > 0 ||
          imports.some(
            (e) => e.kind === 'namespace' && e.targetFile !== null && e.linkStatus !== 'unresolved',
          )
            ? 'resolved'
            : 'blocked',
        scope,
        typeBinding,
        bindings: usable,
        imports,
        claims: selected.claims,
      };
    }
    if (scope.lookupPolicy?.deferParentActivation) position = undefined;
    id = scope.lookupPolicy?.parentScope ?? scope.parent;
  }
  return id === null ? ABSENT : { ...ABSENT, status: 'blocked' };
}
