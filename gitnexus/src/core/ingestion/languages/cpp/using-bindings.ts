import type {
  BindingRef,
  Capture,
  CaptureMatch,
  NameClaim,
  ParsedFile,
  ParsedImport,
  Range,
  Scope,
  ScopeId,
} from 'gitnexus-shared';
import type { ScopeResolutionIndexes } from '../../model/scope-resolution-indexes.js';
import { isCppInlineNamespaceScope } from './inline-namespaces.js';

/** Namespace lookup facts, deliberately distinct from preprocessor file imports. */
export interface CppUsingDeclaration {
  readonly namespace: string;
  readonly name?: string;
  readonly range: Range;
}

const declarationsByFile = new Map<string, CppUsingDeclaration[]>();

export function clearCppUsingDeclarations(): void {
  declarationsByFile.clear();
}

export function resetCppUsingDeclarations(filePath: string): void {
  declarationsByFile.delete(filePath);
}

export function recordCppUsingDeclaration(filePath: string, capture: CaptureMatch): void {
  const namespace = capture['@import.source']?.text;
  const range = capture['@import.statement']?.range;
  if (namespace === undefined || range === undefined) return;
  const name = capture['@import.name']?.text;
  const declarations = declarationsByFile.get(filePath) ?? [];
  declarations.push({ namespace, range, ...(name === undefined ? {} : { name }) });
  declarationsByFile.set(filePath, declarations);
}

export function collectCppUsingDeclarations(filePath: string): readonly CppUsingDeclaration[] {
  return declarationsByFile.get(filePath) ?? [];
}

const compare = (
  a: Pick<Range, 'startLine' | 'startCol'>,
  b: Pick<Range, 'startLine' | 'startCol'>,
) => a.startLine - b.startLine || a.startCol - b.startCol;
const end = (range: Range) => ({ startLine: range.endLine, startCol: range.endCol });
const contains = (outer: Range, inner: Range): boolean =>
  compare(outer, inner) <= 0 && compare(end(inner), end(outer)) <= 0;

/** Claims attach to the same innermost capture range as the shared extractor. */
export function attachCppUsingClaims(captures: CaptureMatch[], filePath: string): void {
  const scopes = captures.flatMap((match) =>
    Object.values(match)
      .filter((capture) =>
        [
          '@scope.module',
          '@scope.namespace',
          '@scope.class',
          '@scope.function',
          '@scope.block',
        ].includes(capture.name),
      )
      .map((capture) => ({ match, capture })),
  );
  const byOwner = new Map<CaptureMatch, NameClaim[]>();
  const add = (claim: NameClaim, functionOnly = false, callable = false): void => {
    let owner: (typeof scopes)[number] | undefined;
    for (const candidate of scopes) {
      if (functionOnly && candidate.capture.name !== '@scope.function') continue;
      if (
        callable &&
        candidate.capture.name === '@scope.function' &&
        compare(candidate.capture.range, claim.range) === 0 &&
        compare(end(candidate.capture.range), end(claim.range)) === 0
      )
        continue;
      if (!contains(candidate.capture.range, claim.range)) continue;
      if (owner === undefined || contains(owner.capture.range, candidate.capture.range))
        owner = candidate;
    }
    if (owner === undefined) return;
    const claims = byOwner.get(owner.match) ?? [];
    // A namespace using-declaration extends the existing overload set, while a
    // block using-declaration still hides functions declared in outer scopes.
    if (callable && !claims.some((existing) => existing.name === claim.name && existing.merge))
      return;
    claims.push(claim);
    byOwner.set(owner.match, claims);
  };
  for (const declaration of collectCppUsingDeclarations(filePath)) {
    if (declaration.name === undefined) continue;
    add({
      name: declaration.name,
      range: declaration.range,
      kind: 'binding',
      merge: true,
      availableFrom: end(declaration.range),
      inactive: 'outer',
    });
  }
  for (const match of captures) {
    const variable = match['@declaration.variable'];
    const parameter = match['@type-binding.lexical-parameter'];
    const callable = match['@declaration.function'];
    const anchor = variable ?? parameter ?? callable;
    const name = parameter !== undefined ? match['@type-binding.name'] : match['@declaration.name'];
    if (anchor === undefined || name === undefined) continue;
    add(
      {
        name: name.text,
        range: anchor.range,
        kind: 'binding',
        availableFrom: end(name.range),
        inactive: 'outer',
        ...(callable === undefined ? {} : { merge: true }),
      },
      parameter !== undefined,
      callable !== undefined,
    );
  }
  for (const [match, claims] of byOwner) {
    const anchor = Object.values(match).find((capture) => capture.name.startsWith('@scope.'))!;
    (match as Record<string, Capture>)['@scope.name-claims'] = {
      name: '@scope.name-claims',
      range: anchor.range,
      text: JSON.stringify(claims),
    };
  }
}

function owningScope(parsed: ParsedFile, range: Range): Scope | undefined {
  let owner: Scope | undefined;
  for (const scope of parsed.scopes) {
    if (contains(scope.range, range) && (owner === undefined || contains(owner.range, scope.range)))
      owner = scope;
  }
  return owner;
}

interface NamespaceNode {
  readonly scope: Scope;
  readonly inlineChildren: NamespaceNode[];
}

function usingDeclarations(parsed: ParsedFile): readonly CppUsingDeclaration[] {
  return (
    (
      parsed.captureSideChannel as
        | { usingDeclarations?: readonly CppUsingDeclaration[] }
        | undefined
    )?.usingDeclarations ?? collectCppUsingDeclarations(parsed.filePath)
  );
}

function createNamespaceLookup(
  parsedFiles: readonly ParsedFile[],
  getScope: (id: ScopeId) => Scope | undefined,
) {
  const paths = new Map<ScopeId, string>();
  const nodes = new Map<ScopeId, NamespaceNode>();
  const namespaces = new Map<string, NamespaceNode[]>();
  const namespacePath = (scope: Scope): string => {
    const cached = paths.get(scope.id);
    if (cached !== undefined) return cached;
    const parts: string[] = [];
    let current: Scope | undefined = scope;
    while (current !== undefined) {
      if (current.kind === 'Namespace') {
        const name = current.ownedDefs.find((def) => def.type === 'Namespace')?.qualifiedName;
        if (name !== undefined) parts.unshift(name.split('.').pop()!);
      }
      current = current.parent === null ? undefined : getScope(current.parent);
    }
    const result = parts.join('.');
    paths.set(scope.id, result);
    return result;
  };
  for (const parsed of parsedFiles) {
    for (const scope of parsed.scopes) {
      if (scope.kind !== 'Namespace' && scope.kind !== 'Module') continue;
      const path = namespacePath(scope);
      if (path === '' && scope.kind !== 'Module') continue;
      const node: NamespaceNode = { scope, inlineChildren: [] };
      nodes.set(scope.id, node);
      const group = namespaces.get(path) ?? [];
      group.push(node);
      namespaces.set(path, group);
    }
  }
  for (const node of nodes.values()) {
    if (node.scope.parent !== null && isCppInlineNamespaceScope(node.scope.id)) {
      nodes.get(node.scope.parent)?.inlineChildren.push(node);
    }
  }
  return { namespacePath, namespaces };
}

function resolveUsingMembers(
  declaration: CppUsingDeclaration,
  owner: Scope,
  filePath: string,
  visible: ReadonlySet<string>,
  { namespacePath, namespaces }: ReturnType<typeof createNamespaceLookup>,
) {
  const raw = declaration.namespace.replaceAll('::', '.').replace(/^\./, '');
  let prefix = declaration.namespace.startsWith('::') ? '' : namespacePath(owner);
  let target: string | undefined;
  while (true) {
    const candidate = prefix === '' ? raw : `${prefix}.${raw}`;
    if (namespaces.has(candidate)) {
      target = candidate;
      break;
    }
    if (prefix === '') break;
    prefix = prefix.includes('.') ? prefix.slice(0, prefix.lastIndexOf('.')) : '';
  }
  if (target === undefined) return undefined;
  const members = new Map<string, BindingRef[]>();
  const pending = [...(namespaces.get(target) ?? [])];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (!visible.has(node.scope.filePath)) continue;
    pending.push(...node.inlineChildren);
    for (const [name, refs] of node.scope.bindings) {
      if (declaration.name !== undefined && declaration.name !== name) continue;
      const bucket = members.get(name) ?? [];
      for (const ref of refs) {
        if (ref.def.type === 'Namespace') continue;
        // A named using snapshots the declarations visible at that point.
        if (
          declaration.name !== undefined &&
          ref.def.filePath === filePath &&
          ref.declarationRange !== undefined &&
          compare(ref.declarationRange, declaration.range) > 0
        )
          continue;
        if (!bucket.some((entry) => entry.def.nodeId === ref.def.nodeId)) bucket.push(ref);
      }
      members.set(name, bucket);
    }
  }
  return { target, members };
}

function createIncludeClosure(targetsOf: (filePath: string) => readonly string[]) {
  const visibleByFile = new Map<string, Set<string>>();
  return (filePath: string): Set<string> => {
    const cached = visibleByFile.get(filePath);
    if (cached !== undefined) return cached;
    const visible = new Set<string>();
    const pending = [filePath];
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (visible.has(file)) continue;
      visible.add(file);
      pending.push(...targetsOf(file));
    }
    visibleByFile.set(filePath, visible);
    return visible;
  };
}

/** Preserve unresolved header declarations in the ordinary pre-finalize scope facts. */
export function populateCppIncludedUsingClaims(
  parsedFiles: ParsedFile[],
  resolveInclude: (parsed: ParsedFile, imported: ParsedImport) => string | readonly string[] | null,
): void {
  const namedByFile = new Map<
    string,
    { owner: Scope; declarations: readonly CppUsingDeclaration[] }
  >();
  for (const parsed of parsedFiles) {
    const declarations = usingDeclarations(parsed).filter(
      (declaration) =>
        declaration.name !== undefined &&
        owningScope(parsed, declaration.range)?.id === parsed.moduleScope,
    );
    if (declarations.length === 0) continue;
    const owner = parsed.scopes.find((scope) => scope.id === parsed.moduleScope);
    if (owner !== undefined) namedByFile.set(parsed.filePath, { owner, declarations });
  }
  if (namedByFile.size === 0) return;

  const scopes = new Map(
    parsedFiles.flatMap((parsed) => parsed.scopes.map((scope) => [scope.id, scope] as const)),
  );
  const namespaceLookup = createNamespaceLookup(parsedFiles, (id) => scopes.get(id));
  const includes = new Map<string, { target: string; range: Range }[]>();
  for (const parsed of parsedFiles) {
    const edges: { target: string; range: Range }[] = [];
    for (const imported of parsed.parsedImports) {
      if (imported.kind !== 'wildcard' || imported.atRange === undefined) continue;
      const target = resolveInclude(parsed, imported);
      if (typeof target === 'string') edges.push({ target, range: imported.atRange });
    }
    includes.set(parsed.filePath, edges);
  }
  const visibleFiles = createIncludeClosure((filePath) =>
    (includes.get(filePath) ?? []).map((edge) => edge.target),
  );
  for (let index = 0; index < parsedFiles.length; index++) {
    const parsed = parsedFiles[index];
    const added: NameClaim[] = [];
    const seen = new Set<string>();
    for (const edge of includes.get(parsed.filePath) ?? []) {
      for (const includedFile of visibleFiles(edge.target)) {
        if (includedFile === parsed.filePath) continue;
        const named = namedByFile.get(includedFile);
        if (named === undefined) continue;
        for (const declaration of named.declarations) {
          const name = declaration.name!;
          const resolved = resolveUsingMembers(
            declaration,
            named.owner,
            includedFile,
            visibleFiles(parsed.filePath),
            namespaceLookup,
          );
          if ((resolved?.members.get(name)?.length ?? 0) > 0) continue;
          const key = `${name}:${edge.range.startLine}:${edge.range.startCol}`;
          if (seen.has(key)) continue;
          seen.add(key);
          added.push({
            name,
            kind: 'blocked',
            merge: true,
            range: edge.range,
            availableFrom: end(edge.range),
            inactive: 'outer',
          });
        }
      }
    }
    if (added.length === 0) continue;
    const module = parsed.scopes.find((scope) => scope.id === parsed.moduleScope);
    if (module === undefined) continue;
    const claims = [...(module.nameClaims ?? [])];
    // An inactive include claim must not erase earlier local declarations of
    // the same name. Give those bindings their existing declaration evidence;
    // the blocked include claim takes effect only at its later source position.
    for (const name of new Set(added.map((claim) => claim.name))) {
      for (const binding of module.bindings.get(name) ?? []) {
        const range = binding.declarationRange;
        if (
          range === undefined ||
          claims.some((claim) => claim.name === name && contains(claim.range, range))
        )
          continue;
        claims.push({
          name,
          kind: 'binding',
          merge: true,
          range,
          availableFrom: { startLine: range.startLine, startCol: range.startCol },
          inactive: 'outer',
        });
      }
    }
    // Extraction snapshots are frozen and may also live in the parse cache.
    // Replace only affected records before registries and ScopeTree are built.
    parsedFiles[index] = {
      ...parsed,
      scopes: parsed.scopes.map((scope) =>
        scope.id === parsed.moduleScope ? { ...scope, nameClaims: [...claims, ...added] } : scope,
      ),
    };
  }
}

/** Materialize namespace identities once, then augment only the using's owner. */
export function populateCppUsingBindings(
  parsedFiles: readonly ParsedFile[],
  indexes: ScopeResolutionIndexes,
): void {
  if (!parsedFiles.some((parsed) => usingDeclarations(parsed).length > 0)) return;
  const namespaceLookup = createNamespaceLookup(parsedFiles, (id) =>
    indexes.scopeTree.getScope(id),
  );
  const { namespacePath } = namespaceLookup;
  const byFile = new Map(parsedFiles.map((parsed) => [parsed.filePath, parsed]));
  const visibleFiles = createIncludeClosure((filePath) => {
    const parsed = byFile.get(filePath);
    if (parsed === undefined) return [];
    return (indexes.imports.get(parsed.moduleScope) ?? []).flatMap((edge) =>
      edge.targetFile !== null && edge.linkStatus !== 'unresolved' ? [edge.targetFile] : [],
    );
  });
  const augmentations = indexes.bindingAugmentations as Map<ScopeId, Map<string, BindingRef[]>>;
  const append = (
    scope: Scope,
    name: string,
    refs: readonly BindingRef[],
    declaration: CppUsingDeclaration,
  ): void => {
    let bindings = augmentations.get(scope.id);
    if (bindings === undefined) {
      bindings = new Map();
      augmentations.set(scope.id, bindings);
    }
    const bucket = bindings.get(name) ?? [];
    for (const ref of refs) {
      bucket.push({
        def: ref.def,
        origin: 'namespace',
        declarationRange: declaration.range,
        availableFrom: end(declaration.range),
      });
    }
    bindings.set(name, bucket);
  };
  for (const parsed of parsedFiles) {
    const facts = usingDeclarations(parsed);
    if (facts.length === 0) continue;
    const visible = visibleFiles(parsed.filePath);
    for (const declaration of facts) {
      const owner = owningScope(parsed, declaration.range);
      if (owner === undefined) continue;
      const resolved = resolveUsingMembers(
        declaration,
        owner,
        parsed.filePath,
        visible,
        namespaceLookup,
      );
      if (resolved === undefined) continue;
      const { target, members } = resolved;
      for (const [name, refs] of members) {
        if (declaration.name !== undefined) {
          append(owner, name, refs, declaration);
          continue;
        }
        // A directive contributes at the nearest common namespace. A nearer
        // ordinary declaration hides it; declarations in that namespace join
        // its overload/ambiguity set instead of being silently replaced.
        let current: Scope | undefined = owner;
        let hidden = false;
        const candidates = [...refs];
        while (current !== undefined) {
          const currentPath = namespacePath(current);
          const common =
            current.kind === 'Module' ||
            (current.kind === 'Namespace' &&
              (target === currentPath || target.startsWith(`${currentPath}.`)));
          const ordinary = (current.bindings.get(name) ?? []).filter(
            (ref) =>
              ref.declarationRange === undefined ||
              compare(ref.declarationRange, declaration.range) <= 0,
          );
          if (common) {
            candidates.push(...ordinary);
            break;
          }
          const typedLocal =
            current.typeBindings.has(name) &&
            current.nameClaims?.some(
              (claim) =>
                claim.name === name &&
                compare(claim.availableFrom ?? claim.range, declaration.range) <= 0,
            );
          if (ordinary.length > 0 || typedLocal) {
            hidden = true;
            break;
          }
          current =
            current.parent === null ? undefined : indexes.scopeTree.getScope(current.parent);
        }
        if (!hidden) append(owner, name, candidates, declaration);
      }
    }
  }

  // A module-scope using written in a header is part of the including
  // translation unit. Snapshot before propagation: include cycles and input
  // file order must not change the surface copied to another file.
  const moduleUsings = new Map<ScopeId, Map<string, BindingRef[]>>();
  for (const parsed of parsedFiles) {
    const bindings = augmentations.get(parsed.moduleScope);
    if (bindings !== undefined) {
      moduleUsings.set(
        parsed.moduleScope,
        new Map([...bindings].map(([name, refs]) => [name, [...refs]])),
      );
    }
  }
  if (moduleUsings.size === 0) return;
  for (const parsed of parsedFiles) {
    const owner = indexes.scopeTree.getScope(parsed.moduleScope);
    if (owner === undefined) continue;
    const seenIncludes = new Set<string>();
    for (const edge of indexes.imports.get(parsed.moduleScope) ?? []) {
      if (
        edge.targetFile === null ||
        edge.linkStatus === 'unresolved' ||
        edge.atRange === undefined
      )
        continue;
      const key = `${edge.targetFile}:${edge.atRange.startLine}:${edge.atRange.startCol}`;
      if (seenIncludes.has(key)) continue;
      seenIncludes.add(key);
      for (const includedFile of visibleFiles(edge.targetFile)) {
        if (includedFile === parsed.filePath) continue;
        const included = byFile.get(includedFile);
        if (included === undefined) continue;
        for (const [name, refs] of moduleUsings.get(included.moduleScope) ?? []) {
          append(owner, name, refs, { namespace: '', range: edge.atRange });
        }
      }
    }
  }
}
