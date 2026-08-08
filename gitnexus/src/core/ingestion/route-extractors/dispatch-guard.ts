/**
 * Hand-rolled dispatch-guard route extractor (JavaScript / TypeScript).
 *
 * Every route extractor before this one recognises a route because a FRAMEWORK
 * declares it: a decorator, a `Route::get()` call, a filesystem convention. A
 * server written against raw `node:http` declares its routes the only way the
 * language offers — by COMPARING the request path to a literal:
 *
 *     if (req.method === 'GET' && pathname === '/api/live/portfolio') { … }
 *
 * That is a route definition in every sense that matters to this graph: it has a
 * path, a verb, and a handler. GitNexus simply had no rule that could see it, so
 * `route_map` answered "No routes found in this project" for a repo with
 * seventeen route modules and 113 such comparisons — the same confident-empty
 * failure this whole change set is about, one tool wide.
 *
 * PRECISION OVER RECALL, deliberately. A missed route is a coverage limit; an
 * invented route is a false fact, and `route_map` presents its output as fact.
 * So every rule here requires the comparison to be against something that is
 * demonstrably a request path, and anything that cannot be converted cleanly is
 * dropped rather than guessed at. Specifically NOT extracted:
 *
 *   - `pathname.startsWith('/api/')` — a namespace test ("do I own this?"),
 *     not a route. Minting `/api` would claim a route nobody serves.
 *   - a bare `pathname === '/'` with no verb — far more often a normalisation
 *     branch (`pathname === '/' ? '/index.html' : pathname`) than a route. With
 *     a verb alongside it the intent is unambiguous, so that form IS extracted.
 *   - any regex whose body is not a literal path plus single-segment wildcards.
 *
 * One consequence worth stating rather than discovering: a single-page app that
 * branches on `location.pathname === '/settings'` mints a Route too. That is
 * intentional — it is the same claim a Next.js filesystem route makes, that this
 * file serves this path — and it keeps the rule from needing to guess whether a
 * comparison is "backend enough". It does mean `route_map` on a SPA reports
 * client routes alongside API ones, distinguishable by their `source`.
 *
 * @module route-extractors/dispatch-guard
 */

import type Parser from 'tree-sitter';
import type { SyntaxNode } from 'tree-sitter';
import type { ExtractedDecoratorRoute } from '../workers/parse-worker.js';

/** Provenance stamped on the Route node, in place of `decorator-<name>`. */
export const DISPATCH_GUARD_SOURCE = 'dispatch-guard-route';

const HTTP_VERBS: ReadonlySet<string> = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);

const EQUALITY_OPERATORS: ReadonlySet<string> = new Set(['===', '==']);

/**
 * Expressions that denote the request path. Kept deliberately narrow: this is
 * the predicate standing between "a string comparison" and "a route", so a loose
 * match here is how invented routes would get in. `path` alone is excluded — in
 * Node it is overwhelmingly the `node:path` module or a filesystem path.
 */
const PATH_IDENTIFIERS: ReadonlySet<string> = new Set([
  'pathname',
  'pathName',
  'urlPath',
  'routePath',
  'reqPath',
  'requestPath',
]);

/** `req.url` / `request.url` — the raw form, before a URL parse. */
const RAW_URL_RECEIVERS: ReadonlySet<string> = new Set(['req', 'request']);

/**
 * Cheap pre-filter, so this costs nothing on the overwhelming majority of files.
 *
 * Sound by construction rather than by luck: every rule below reaches a route
 * only through {@link isPathExpression}, which returns true only for one of the
 * {@link PATH_IDENTIFIERS} or for a member access whose property is `pathname` /
 * `url`. A file whose source contains none of those substrings cannot produce a
 * route, so skipping the walk cannot change the output. Keep this alternation in
 * step with those two predicates — widening one without the other would silently
 * re-introduce the empty answer this module exists to remove.
 */
const PATH_TOKEN_HINT = /pathname|pathName|urlPath|routePath|reqPath|requestPath|\.\s*url\b/;

const FUNCTION_NODE_TYPES: ReadonlySet<string> = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'generator_function',
  'arrow_function',
  'method_definition',
]);

/**
 * A string literal that could be a URL path: leading slash, no whitespace, and
 * no scheme. The character class is permissive about what a path may CONTAIN
 * (`{id}`, `:id`, `%20`, `.json` are all legitimate) because the leading slash
 * plus a path-denoting operand already carries the discrimination.
 */
function isPathLiteral(value: string): boolean {
  if (!value.startsWith('/')) return false;
  if (value.includes('://')) return false;
  return /^\/[\w\-./{}:$*%~@]*$/.test(value);
}

/**
 * Same-file string constants, for folding a composed path.
 *
 * Built once per file and passed down, because the idiom it exists for is
 * common enough that refusing it loses whole route modules: the reporting repo
 * writes `pathname === \`${autoTradeBasePath}/rules\`` throughout one of its
 * seventeen route files, so without folding that file contributes NOTHING while
 * looking exactly like a file with no routes.
 *
 * Deliberately flat — no scope tracking. The cost of that shortcut is bounded by
 * refusing ambiguity: a name declared twice with DIFFERENT literal values is
 * removed from the map entirely, so a shadowed constant produces no route rather
 * than the wrong one.
 */
type ConstantMap = ReadonlyMap<string, string>;

/** Follow `a = b = 'literal'` chains, with a cap so a cycle cannot hang. */
const MAX_CONSTANT_HOPS = 4;

function buildConstantMap(root: SyntaxNode): ConstantMap {
  const direct = new Map<string, string>(); // name -> literal
  const alias = new Map<string, string>(); // name -> other name
  const ambiguous = new Set<string>();

  const record = (map: Map<string, string>, name: string, value: string): void => {
    const existing = map.get(name);
    if (existing !== undefined && existing !== value) ambiguous.add(name);
    else map.set(name, value);
  };

  const visit = (node: SyntaxNode): void => {
    if (node.type === 'variable_declarator') {
      const name = node.childForFieldName('name');
      const value = unparenthesize(node.childForFieldName('value'));
      if (name !== null && name.type === 'identifier' && value !== null) {
        if (value.type === 'string' || value.type === 'template_string') {
          const raw = plainLiteralValue(value);
          if (raw !== null) record(direct, name.text, raw);
        } else if (value.type === 'identifier') {
          record(alias, name.text, value.text);
        }
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);

  const resolved = new Map<string, string>();
  for (const name of [...direct.keys(), ...alias.keys()]) {
    if (ambiguous.has(name)) continue;
    let current = name;
    for (let hop = 0; hop < MAX_CONSTANT_HOPS; hop++) {
      if (ambiguous.has(current)) break;
      const literal = direct.get(current);
      if (literal !== undefined) {
        resolved.set(name, literal);
        break;
      }
      const next = alias.get(current);
      if (next === undefined) break;
      current = next;
    }
  }
  return resolved;
}

/** Unquote a plain string / substitution-free template literal. */
function plainLiteralValue(node: SyntaxNode): string | null {
  if (node.type !== 'string' && node.type !== 'template_string') return null;
  if (
    node.type === 'template_string' &&
    node.namedChildren.some((c) => c.type !== 'string_fragment')
  ) {
    return null;
  }
  const text = node.text;
  if (text.length < 2) return null;
  return text.slice(1, -1);
}

/**
 * The string this expression denotes, folding same-file constants where it can.
 *
 * Handles a plain literal, a template string whose substitutions all resolve to
 * known constants, and `+` concatenation of those. Returns `null` the moment any
 * part is unknown — a partially-folded path would be a wrong route, and a route
 * that is missing is the cheaper of the two failures.
 */
function literalValue(node: SyntaxNode, constants: ConstantMap = new Map()): string | null {
  const plain = plainLiteralValue(node);
  if (plain !== null) return plain;

  if (node.type === 'identifier') return constants.get(node.text) ?? null;

  if (node.type === 'template_string') {
    let out = '';
    for (const child of node.namedChildren) {
      if (child.type === 'string_fragment') {
        out += child.text;
        continue;
      }
      if (child.type !== 'template_substitution') return null;
      const inner = unparenthesize(child.namedChildren[0] ?? null);
      if (inner === null) return null;
      const value = literalValue(inner, constants);
      if (value === null) return null;
      out += value;
    }
    return out;
  }

  if (node.type === 'binary_expression' && node.childForFieldName('operator')?.text === '+') {
    const left = unparenthesize(node.childForFieldName('left'));
    const right = unparenthesize(node.childForFieldName('right'));
    if (left === null || right === null) return null;
    const leftValue = literalValue(left, constants);
    const rightValue = literalValue(right, constants);
    if (leftValue === null || rightValue === null) return null;
    return leftValue + rightValue;
  }

  return null;
}

/**
 * Does this expression denote the request path? Accepts a bare identifier from
 * {@link PATH_IDENTIFIERS}, any member access ending in `.pathname`, and the raw
 * `req.url` / `request.url` forms.
 */
function isPathExpression(node: SyntaxNode): boolean {
  if (node.type === 'identifier') return PATH_IDENTIFIERS.has(node.text);
  if (node.type === 'member_expression') {
    const property = node.childForFieldName('property');
    if (property === null) return false;
    if (PATH_IDENTIFIERS.has(property.text)) return true;
    if (property.text === 'url') {
      const object = node.childForFieldName('object');
      return object !== null && RAW_URL_RECEIVERS.has(object.text);
    }
    return false;
  }
  return false;
}

/** A logical `!`. `-` and `~` are unary too and are not negation. */
function isNegation(node: SyntaxNode): boolean {
  return node.type === 'unary_expression' && node.childForFieldName('operator')?.text === '!';
}

/**
 * Is this comparison reached only when it is FALSE?
 *
 * The module already refuses to inherit a verb from an `if` whose `else` branch
 * holds the comparison, for the reason stated in `governingVerb`: the branch runs
 * precisely when the condition did NOT hold, so attributing it is backwards.
 * `!` is the same fact written as an operator, and it was not handled — a stated
 * invariant with half an implementation, which is worse than an absent one
 * because the doc comment reads as though it were covered.
 *
 * Measured before fixing. `if (!(pathname === '/api/admin'))` INVENTED
 * `/api/admin`; `if (!(req.method === 'GET') && pathname === '/api/x')` emitted
 * `GET /api/x`, the one verb the branch guarantees the request does not have.
 *
 * PARITY, not presence: `!!x` is `x`, and a rule keyed on "is there a `!` above
 * me" would refuse a positive condition.
 *
 * The walk stops at the FUNCTION boundary and nowhere else. An earlier draft
 * also broke at `statement_block`, reasoning that `if (!cond) { … }` must not
 * negate a comparison written in its body — true, but already guaranteed by the
 * tree shape: the `!` lives in the if's CONDITION, which is a sibling of the
 * block, never an ancestor of anything inside it. So that break could only ever
 * fire where a `!` genuinely IS an ancestor across a block, i.e. an IIFE — which
 * the function-boundary stop catches first. Unreachable, and unreachable in the
 * UNSAFE direction: stopping early under-counts negations, and an under-count
 * reads a negated guard as positive and invents the route. Removed rather than
 * kept for symmetry.
 */
function isNegatedContext(node: SyntaxNode): boolean {
  let negations = 0;
  let current: SyntaxNode = node;
  let parent = current.parent;
  while (parent !== null && !FUNCTION_NODE_TYPES.has(parent.type)) {
    if (isNegation(parent)) negations += 1;
    current = parent;
    parent = current.parent;
  }
  return negations % 2 === 1;
}

/** Strip redundant parentheses, which the grammar keeps as real nodes. */
function unparenthesize(node: SyntaxNode | null): SyntaxNode | null {
  let current = node;
  while (current !== null && current.type === 'parenthesized_expression') {
    current = current.namedChildren[0] ?? null;
  }
  return current;
}

/** Does this expression denote the request METHOD (`req.method`, `method`)? */
function isMethodExpression(node: SyntaxNode): boolean {
  if (node.type === 'identifier') return node.text === 'method' || node.text === 'httpMethod';
  if (node.type === 'member_expression') {
    const property = node.childForFieldName('property');
    return property !== null && (property.text === 'method' || property.text === 'httpMethod');
  }
  return false;
}

/**
 * The HTTP verb an equality comparison asserts, if it is one — `req.method ===
 * 'GET'` → `GET`. Case-normalised, so `'get'` works too.
 */
function verbFromComparison(node: SyntaxNode): string | null {
  if (node.type !== 'binary_expression') return null;
  const operator = node.childForFieldName('operator')?.text ?? '';
  if (!EQUALITY_OPERATORS.has(operator)) return null;
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  if (left === null || right === null) return null;

  for (const [expr, literal] of [
    [left, right],
    [right, left],
  ] as const) {
    if (!isMethodExpression(expr)) continue;
    const value = literalValue(literal);
    if (value === null) continue;
    const verb = value.toUpperCase();
    if (HTTP_VERBS.has(verb)) return verb;
  }
  return null;
}

/**
 * Find the verbs that govern a path comparison, by walking outward.
 *
 * Two idioms, both common and both handled:
 *   `if (req.method === 'GET' && pathname === '/x')` — a sibling in the same
 *   condition; and
 *   `if (req.method === 'GET') { if (pathname === '/x') … }` — an enclosing
 *   guard.
 *
 * The walk stops at the function boundary, and REFUSES to inherit a verb from an
 * `if` whose `else` branch we are standing in: in
 * `if (req.method === 'POST') {…} else if (pathname === '/x')` the path
 * comparison is reached precisely when the method is NOT POST, so attributing
 * POST to it would be exactly backwards.
 *
 * Returns a LIST because one guard can serve several methods:
 * `if ((req.method === 'GET' || req.method === 'POST') && pathname === '/x')` is
 * two routes, and returning the first verb reported it as GET-only — a route
 * that silently loses its other methods reads as a narrower contract than the
 * code implements. Empty means "no verb is guaranteed", which stays verb-less.
 */
function governingVerbs(comparison: SyntaxNode): readonly string[] {
  let current: SyntaxNode = comparison;
  let parent = current.parent;

  while (parent !== null && !FUNCTION_NODE_TYPES.has(parent.type)) {
    if (
      parent.type === 'binary_expression' &&
      parent.childForFieldName('operator')?.text === '&&'
    ) {
      const sibling =
        parent.childForFieldName('left')?.id === current.id
          ? parent.childForFieldName('right')
          : parent.childForFieldName('left');
      const verbs = sibling === null ? [] : findVerbsInSubtree(sibling);
      if (verbs.length > 0) return verbs;
    }
    if (parent.type === 'if_statement') {
      const alternative = parent.childForFieldName('alternative');
      const inElseBranch = alternative !== null && alternative.id === current.id;
      const condition = parent.childForFieldName('condition');
      // A comparison inside the condition itself is handled by the `&&` rule
      // above; here we only inherit from an ENCLOSING if we are governed by.
      if (!inElseBranch && condition !== null && condition.id !== current.id) {
        const verbs = findVerbsInSubtree(condition);
        if (verbs.length > 0) return verbs;
      }
    }
    current = parent;
    parent = current.parent;
  }
  return [];
}

/**
 * The verb a subtree GUARANTEES when it evaluates truthy.
 *
 * `negated` counts whether an odd number of `!` stands between the question and
 * this node. It is PARITY, the same rule `isNegatedContext` states — and the
 * rule the previous presence-based check contradicted: it returned null at the
 * first `!` it saw, so `!!(req.method === 'GET')` lost a verb the source states
 * outright. A stated invariant with half an implementation, in the same module
 * that had already been fixed for exactly that once.
 *
 * A verb reached at odd parity is the verb the branch EXCLUDES, so it yields
 * nothing — the route survives, verb-less, which is the honest answer: this
 * branch does not say which method it serves. Siblings are still searched,
 * because excluding one verb says nothing about the next.
 */
function findVerbsInSubtree(node: SyntaxNode, negated = false): readonly string[] {
  if (isNegation(node)) {
    const operand = node.childForFieldName('argument');
    return operand === null ? [] : findVerbsInSubtree(operand, !negated);
  }

  // A ternary SELECTS between its arms, so a verb inside one is not reached
  // merely because the whole is truthy — see `verbsFromTernary`.
  if (node.type === 'ternary_expression') return verbsFromTernary(node, negated);

  if (isDisjunction(node)) return verbsFromDisjunction(node, negated);

  const direct = verbFromComparison(node);
  if (direct !== null) return negated ? [] : [direct];

  // Generic descent keeps FIRST-match rather than unioning across children: an
  // arbitrary node says nothing about how its children combine, and two verbs
  // found under one are far more likely to be unrelated than alternatives. The
  // one construct that genuinely means "either of these" is `||`, handled above.
  for (const child of node.namedChildren) {
    const found = findVerbsInSubtree(child, negated);
    if (found.length > 0) return found;
  }
  return [];
}

/** A logical `||`. */
function isDisjunction(node: SyntaxNode): boolean {
  return node.type === 'binary_expression' && node.childForFieldName('operator')?.text === '||';
}

/**
 * The verbs a disjunction guarantees — ALL of them, or none.
 *
 * `req.method === 'GET' || req.method === 'POST'` is the multi-method guard, and
 * every operand names a verb, so the guard serves exactly those two.
 *
 * `req.method === 'GET' || isAdmin` is not: the branch is reached for ANY method
 * when `isAdmin` holds, so the honest answer is no verb at all. Reporting `GET`
 * — which is what taking the first match did — presents a route open to every
 * method as one restricted to a single method, and this module's whole bar is
 * that a wrong answer costs more than a missing one.
 *
 * So: every operand must yield at least one verb, or the whole disjunction
 * yields none. At odd parity `!(A || B)` is `!A && !B`, which excludes verbs
 * rather than offering them, so nothing is guaranteed either.
 */
function verbsFromDisjunction(node: SyntaxNode, negated: boolean): readonly string[] {
  if (negated) return [];
  const operands = [node.childForFieldName('left'), node.childForFieldName('right')];
  const collected: string[] = [];
  for (const operand of operands) {
    if (operand === null) return [];
    const verbs = findVerbsInSubtree(operand, false);
    if (verbs.length === 0) return [];
    for (const verb of verbs) if (!collected.includes(verb)) collected.push(verb);
  }
  return collected;
}

/**
 * The verb a ternary guarantees — which is one only when an arm is a boolean
 * literal, because that is what collapses the selection into a conjunction:
 *
 *   c ? A : false   ≡  c && A     both hold, so search both
 *   c ? false : B   ≡  !c && B    c must NOT hold, so search it at flipped parity
 *   c ? true  : B   ≡  c || B     a disjunction guarantees neither operand
 *   c ? A : true    ≡  !c || A    likewise
 *
 * With two non-literal arms the verb is chosen by a condition whose value is
 * unknown, so the ternary guarantees nothing.
 *
 * Measured before fixing: `(req.method === 'GET' ? false : true) && pathname ===
 * '/api/i'` emitted `GET /api/i` — the one method that branch guarantees the
 * request does NOT have, the same inversion `!` produced before `d4dcba8c`. The
 * three shapes that were already right stay right; refusing every ternary would
 * have been safe but would have dropped them.
 *
 * At odd parity every conjunction above becomes a disjunction (De Morgan) and
 * guarantees nothing, so a negated ternary yields no verb. `!(c ? false : true)`
 * is really `c` and could be read, but it needs BOTH arms folded as literals to
 * see that, and no such condition has been observed in a real dispatcher.
 * Declining is the safe direction: a missing verb, not an inverted one.
 */
function verbsFromTernary(node: SyntaxNode, negated: boolean): readonly string[] {
  if (negated) return [];
  const condition = unparenthesize(node.childForFieldName('condition'));
  const consequence = unparenthesize(node.childForFieldName('consequence'));
  const alternative = unparenthesize(node.childForFieldName('alternative'));
  if (condition === null || consequence === null || alternative === null) return [];

  const firstNonEmpty = (a: readonly string[], b: readonly string[]): readonly string[] =>
    a.length > 0 ? a : b;

  if (alternative.type === 'false') {
    return firstNonEmpty(
      findVerbsInSubtree(condition, false),
      findVerbsInSubtree(consequence, false),
    );
  }
  if (consequence.type === 'false') {
    return firstNonEmpty(
      findVerbsInSubtree(condition, true),
      findVerbsInSubtree(alternative, false),
    );
  }
  return [];
}

/**
 * The name of the function containing this comparison — the route's handler.
 *
 * Covers the declared forms and the two anonymous ones that carry a name from
 * their binding site: `const handle = (req) => …` and the object-literal method
 * shorthand (`{ async handle(req, res) {…} }`), which is how the reporting
 * repo's route modules are written.
 */
function enclosingHandlerName(node: SyntaxNode): string | undefined {
  let current: SyntaxNode | null = node.parent;
  while (current !== null) {
    if (FUNCTION_NODE_TYPES.has(current.type)) {
      const own = current.childForFieldName('name');
      if (own !== null) return own.text;
      const parent = current.parent;
      if (parent === null) return undefined;
      if (parent.type === 'variable_declarator' || parent.type === 'pair') {
        const bound = parent.childForFieldName('name') ?? parent.childForFieldName('key');
        return bound?.text;
      }
      if (parent.type === 'assignment_expression') {
        const left = parent.childForFieldName('left');
        if (left === null) return undefined;
        return left.type === 'member_expression'
          ? (left.childForFieldName('property')?.text ?? undefined)
          : left.text;
      }
      return undefined;
    }
    current = current.parent;
  }
  return undefined;
}

/**
 * Convert an anchored regex used as a path test into a route path, or `null` if
 * any part of it is not cleanly representable.
 *
 * `^\/api\/research-runs\/[^/]+$` → `/api/research-runs/{param}`
 *
 * Only two wildcard atoms are recognised, both single-segment (`[^/]+` and
 * `[^/]*`, with or without the slash escaped). Anything else — an optional
 * group, an alternation, a bare `.*` — bails, because a route path is a claim
 * about what the server serves and a mistranslated pattern is a wrong one.
 */
export function regexToRoutePath(source: string): string | null {
  if (!source.startsWith('^') || !source.endsWith('$')) return null;
  const body = source.slice(1, -1);
  if (body.length === 0) return null;

  let out = '';
  let i = 0;
  let paramIndex = 0;
  while (i < body.length) {
    const rest = body.slice(i);
    const wildcard = /^\[\^\\?\/\][+*]/.exec(rest);
    if (wildcard !== null) {
      paramIndex += 1;
      out += `{param${paramIndex}}`;
      i += wildcard[0].length;
      continue;
    }
    const char = body[i] ?? '';
    if (char === '\\') {
      const escaped = body[i + 1];
      if (escaped === undefined) return null;
      // Only escapes of literal path punctuation are meaningful here; an escape
      // class (`\d`, `\w`, `\s`) is a pattern, not a literal.
      if (/[A-Za-z0-9]/.test(escaped)) return null;
      out += escaped;
      i += 2;
      continue;
    }
    if ('[](){}|+*?^$.'.includes(char)) return null;
    out += char;
    i += 1;
  }
  return out.startsWith('/') ? out : null;
}

/** A route the walk found, before per-file reconciliation. */
interface GuardRoute {
  readonly url: string;
  readonly verb: string | null;
  readonly handlerName: string | undefined;
  readonly line: number;
}

/**
 * Extract routes declared by path-comparison dispatch from one JS/TS file.
 *
 * Returns the same {@link ExtractedDecoratorRoute} transport every AST-level
 * route extractor returns — a route is a route once it has a path, a verb and a
 * handler, and reusing the transport means the routes phase, the `(method, url)`
 * dedup and the handler-symbol resolution all apply unchanged. `source`
 * distinguishes the provenance, which is the part that actually differs: a
 * decorator route is DECLARED, a dispatch-guard route is INFERRED from a
 * comparison.
 */
export function extractDispatchGuardRoutes(
  tree: Parser.Tree,
  filePath: string,
  lineOffset = 0,
): ExtractedDecoratorRoute[] {
  // Every JS/TS file in every repo reaches this hook, so the walk is gated on a
  // substring test first — see PATH_TOKEN_HINT for why skipping is sound.
  if (!PATH_TOKEN_HINT.test(tree.rootNode.text)) return [];

  const found: GuardRoute[] = [];

  const constants = buildConstantMap(tree.rootNode);

  const visit = (node: SyntaxNode): void => {
    if (node.type === 'binary_expression') collectFromComparison(node, found, constants);
    else if (node.type === 'call_expression') collectFromRegexTest(node, found);
    else if (node.type === 'switch_statement') collectFromSwitch(node, found, constants);
    for (const child of node.namedChildren) visit(child);
  };
  visit(tree.rootNode);

  return dedupeWithinFile(found).map((route) => ({
    filePath,
    routePath: route.url,
    httpMethod: route.verb ?? '',
    decoratorName: DISPATCH_GUARD_SOURCE,
    source: DISPATCH_GUARD_SOURCE,
    lineNumber: route.line + lineOffset,
    ...(route.handlerName ? { handlerName: route.handlerName } : {}),
  }));
}

function collectFromComparison(node: SyntaxNode, out: GuardRoute[], constants: ConstantMap): void {
  // Reached only when the comparison is FALSE — claiming the path would be
  // exactly backwards. See `isNegatedContext`.
  if (isNegatedContext(node)) return;
  const operator = node.childForFieldName('operator')?.text ?? '';
  if (!EQUALITY_OPERATORS.has(operator)) return;
  const left = node.childForFieldName('left');
  const right = node.childForFieldName('right');
  if (left === null || right === null) return;

  for (const [expr, literal] of [
    [left, right],
    [right, left],
  ] as const) {
    if (!isPathExpression(expr)) continue;
    const value = literalValue(literal, constants);
    if (value === null || !isPathLiteral(value)) continue;
    const verbs = governingVerbs(node);
    // A bare `/` is only a route when a verb says so — see the module header.
    if (value === '/' && verbs.length === 0) continue;
    pushPerVerb(out, verbs, {
      url: value,
      handlerName: enclosingHandlerName(node),
      line: node.startPosition.row + 1,
    });
    return;
  }
}

/**
 * Emit one route per governing verb, or a single verb-less route when the guard
 * guarantees none. A multi-method guard is genuinely several routes: they share
 * a path and a handler but not a method, and `(method, url)` is the key every
 * downstream consumer dedups and looks up on.
 */
function pushPerVerb(
  out: GuardRoute[],
  verbs: readonly string[],
  route: Omit<GuardRoute, 'verb'>,
): void {
  if (verbs.length === 0) {
    out.push({ ...route, verb: null });
    return;
  }
  for (const verb of verbs) out.push({ ...route, verb });
}

/**
 * `switch (pathname) { case '/api/health': … }` — the other way to write the
 * same dispatch, and the reason this module is not a rule about `if`. The
 * discriminant carries the path signal for every arm at once, so each
 * string-literal case is a route with no further evidence needed.
 *
 * Not reported by anyone; included because it is the same shape wearing
 * different syntax, and waiting for a bug report per shape is how a graph stays
 * permanently one idiom behind the code it indexes.
 */
function collectFromSwitch(node: SyntaxNode, out: GuardRoute[], constants: ConstantMap): void {
  // The grammar wraps a switch discriminant in `parenthesized_expression`,
  // unlike a comparison operand.
  const discriminant = unparenthesize(node.childForFieldName('value'));
  if (discriminant === null || !isPathExpression(discriminant)) return;

  const body = node.childForFieldName('body');
  if (body === null) return;

  // The verbs governing the whole switch, if any (`if (req.method === 'GET')
  // switch (pathname) { … }`). Read once — every arm shares them.
  const verbs = governingVerbs(node);

  for (const arm of body.namedChildren) {
    if (arm.type !== 'switch_case') continue;
    const caseValue = arm.childForFieldName('value');
    if (caseValue === null) continue;
    const value = literalValue(caseValue, constants);
    if (value === null || !isPathLiteral(value)) continue;
    if (value === '/' && verbs.length === 0) continue;
    pushPerVerb(out, verbs, {
      url: value,
      handlerName: enclosingHandlerName(arm),
      line: arm.startPosition.row + 1,
    });
  }
}

function collectFromRegexTest(node: SyntaxNode, out: GuardRoute[]): void {
  if (isNegatedContext(node)) return;
  const callee = node.childForFieldName('function');
  if (callee === null || callee.type !== 'member_expression') return;
  if (callee.childForFieldName('property')?.text !== 'test') return;
  const receiver = callee.childForFieldName('object');
  if (receiver === null || receiver.type !== 'regex') return;

  const argument = node.childForFieldName('arguments')?.namedChildren[0];
  if (argument === undefined || !isPathExpression(argument)) return;

  const pattern = receiver.childForFieldName('pattern');
  if (pattern === null) return;
  const url = regexToRoutePath(pattern.text);
  if (url === null) return;

  pushPerVerb(out, governingVerbs(node), {
    url,
    handlerName: enclosingHandlerName(node),
    line: node.startPosition.row + 1,
  });
}

/**
 * Collapse duplicate `(url, verb)` findings within one file, keeping the first —
 * matching the routes phase's own first-writer-wins. The same comparison can
 * legitimately appear more than once (an early-return guard and the branch that
 * serves it), and each occurrence is the same route.
 *
 * The verb-less/verb-qualified reconciliation is deliberately NOT here — see
 * {@link reconcileDispatchGuardRoutes}, which needs the whole repo to do it.
 */
function dedupeWithinFile(routes: readonly GuardRoute[]): GuardRoute[] {
  const seen = new Set<string>();
  const out: GuardRoute[] = [];
  for (const route of routes) {
    const key = `${route.verb ?? ''} ${route.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(route);
  }
  return out;
}

/** The minimum a route needs for reconciliation — structural, not nominal. */
interface ReconcilableRoute {
  readonly routePath: string;
  readonly httpMethod: string;
  readonly source?: string;
}

/**
 * Drop a dispatch-guard route whose URL is claimed WITH a verb somewhere in the
 * repository.
 *
 * The idiom that makes this necessary is the split route table: one module lists
 * every path it recognises (`isKnownApiPath`, or a `match(method, pathname)`
 * that ORs them all) so the dispatcher can 404 early, and separate modules
 * handle each path by verb. Both are path comparisons and both are real, but
 * only the second is a route in the sense `route_map` reports — the first is a
 * membership test.
 *
 * Left alone this doubles the map: measured on the reporting repo, 94 routes of
 * which 34 were the table's verb-less shadow of a route already listed with its
 * verb and its true handler. Reconciling per-FILE cannot see it, because the
 * table and the handlers are different files; only the whole registry can.
 *
 * Applies to dispatch-guard routes only. A framework route with no verb is
 * method-agnostic BY DECLARATION (a Django function view, a Laravel resource),
 * which is a fact rather than a weaker observation, and must not be dropped.
 */
export function reconcileDispatchGuardRoutes<T extends ReconcilableRoute>(
  routes: readonly T[],
): T[] {
  const verbedUrls = new Set(
    routes
      .filter((r) => r.source === DISPATCH_GUARD_SOURCE && r.httpMethod !== '')
      .map((r) => r.routePath),
  );
  if (verbedUrls.size === 0) return [...routes];
  return routes.filter(
    (r) =>
      !(r.source === DISPATCH_GUARD_SOURCE && r.httpMethod === '' && verbedUrls.has(r.routePath)),
  );
}
