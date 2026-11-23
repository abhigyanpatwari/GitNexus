import type { CaptureMatch, NameClaim, Range } from 'gitnexus-shared';
import { nodeToCapture, type SyntaxNode } from '../../utils/ast-helpers.js';

interface ScopeCapture {
  readonly index: number;
  readonly anchor: { readonly range: Range };
  readonly kind: string;
}

const SCOPE_TAGS = ['@scope.module', '@scope.class', '@scope.function', '@scope.block'] as const;
const compare = (
  a: { startLine: number; startCol: number },
  b: { startLine: number; startCol: number },
) => a.startLine - b.startLine || a.startCol - b.startCol;
const end = (range: Range) => ({ startLine: range.endLine, startCol: range.endCol });
const key = (kind: string, range: Range) =>
  `${kind}:${range.startLine}:${range.startCol}:${range.endLine}:${range.endCol}`;

/**
 * Java locals begin at their declarator, including their own initializer, and
 * end with their lexical block. Publish those facts through the shared name
 * claim contract so a later local cannot supply an earlier alias's type.
 *
 * Scope captures from lambdas, loops, resources and local-type visibility are
 * reused by identity; emitting a second scope with the same range would lose
 * metadata or violate the scope tree. A source-order sweep assigns each local
 * to the same innermost capture the extractor will choose.
 */
export function applyJavaLocalNameClaims(
  root: SyntaxNode,
  matches: readonly CaptureMatch[],
): CaptureMatch[] {
  const out = [...matches];
  const scopes: ScopeCapture[] = [];
  const seen = new Set<string>();
  const addScope = (match: CaptureMatch, index: number) => {
    const tag = SCOPE_TAGS.find((candidate) => match[candidate] !== undefined);
    if (tag === undefined) return;
    const anchor = match[tag]!;
    const identity = key(tag, anchor.range);
    if (seen.has(identity)) return;
    seen.add(identity);
    scopes.push({ index, anchor, kind: tag });
  };
  for (let i = 0; i < out.length; i++) addScope(out[i]!, i);
  // A switch block is one lexical block for every statement group in it
  // (JLS 6.3): a group's local ends with the switch, not the method.
  for (const node of root.descendantsOfType(['block', 'for_statement', 'switch_block'])) {
    const anchor = nodeToCapture('@scope.block', node);
    if (seen.has(key('@scope.block', anchor.range))) continue;
    const match: CaptureMatch = { '@scope.block': anchor };
    addScope(match, out.length);
    out.push(match);
  }
  scopes.sort(
    (a, b) =>
      compare(a.anchor.range, b.anchor.range) ||
      compare(end(b.anchor.range), end(a.anchor.range)) ||
      (a.kind === '@scope.module' ? -1 : b.kind === '@scope.module' ? 1 : 0),
  );

  const claims = new Map<number, NameClaim[]>();
  const boundaryDeclarations = new Set<string>();
  const stack: ScopeCapture[] = [];
  let nextScope = 0;
  for (const declaration of root.descendantsOfType('local_variable_declaration')) {
    const range = nodeToCapture('@declaration.variable', declaration).range;
    while (nextScope < scopes.length && compare(scopes[nextScope]!.anchor.range, range) <= 0) {
      const candidate = scopes[nextScope++]!;
      while (
        stack.length > 0 &&
        compare(end(stack[stack.length - 1]!.anchor.range), end(candidate.anchor.range)) < 0
      )
        stack.pop();
      stack.push(candidate);
    }
    while (stack.length > 0) {
      const remaining = compare(end(stack[stack.length - 1]!.anchor.range), range);
      if (remaining > 0) break;
      if (remaining === 0) boundaryDeclarations.add(key('local', range));
      stack.pop();
    }
    const owner = stack[stack.length - 1];
    if (owner === undefined) continue;
    const owned = claims.get(owner.index) ?? [];
    for (const declarator of declaration.namedChildren) {
      if (declarator.type !== 'variable_declarator') continue;
      const name = declarator.childForFieldName('name');
      if (name === null || name.isMissing) continue;
      owned.push({
        name: name.text,
        kind: 'binding',
        purpose: 'value',
        inactive: 'outer',
        neverCallee: true,
        availableFrom: {
          startLine: name.startPosition.row + 1,
          startCol: name.startPosition.column,
        },
        range,
      });
    }
    claims.set(owner.index, owned);
  }

  for (const [index, owned] of claims) {
    const match = out[index]!;
    const scope = SCOPE_TAGS.map((tag) => match[tag]).find((anchor) => anchor !== undefined)!;
    let existing: readonly NameClaim[] | undefined;
    try {
      const parsed: unknown = JSON.parse(match['@scope.name-claims']?.text ?? '[]');
      existing = Array.isArray(parsed) ? (parsed as NameClaim[]) : undefined;
    } catch {
      existing = undefined;
    }
    // Claims that cannot be read cannot be merged either. Keep the scope's
    // own claims exactly as written rather than replacing them with ours.
    if (existing === undefined) continue;
    out[index] = {
      ...match,
      '@scope.name-claims': {
        ...scope,
        name: '@scope.name-claims',
        text: JSON.stringify([...existing, ...owned]),
      },
    };
  }
  // A local alias is evaluated at its RHS, after the new name begins owning
  // its initializer. The query's whole-statement anchor starts before that
  // boundary and would incorrectly make `var x = x` read an outer field.
  for (let i = 0; i < out.length; i++) {
    const match = out[i]!;
    const alias = match['@type-binding.alias'];
    const type = match['@type-binding.type'];
    if (alias !== undefined && type !== undefined) {
      out[i] = { ...match, '@type-binding.alias': { ...type, name: '@type-binding.alias' } };
      continue;
    }
    if (boundaryDeclarations.size === 0) continue;
    // The shared position index includes scope endpoints. At an adjacent
    // declaration, its name places the type binding inside the owning block.
    const declaration = match['@type-binding.annotation'] ?? match['@type-binding.constructor'];
    const name = match['@type-binding.name'];
    if (declaration && name && boundaryDeclarations.has(key('local', declaration.range)))
      out[i] = { ...match, [declaration.name]: { ...name, name: declaration.name } };
  }
  return out;
}
