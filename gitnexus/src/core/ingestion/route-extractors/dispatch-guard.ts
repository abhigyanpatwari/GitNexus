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
 * The verbs BOTH operands of a conjunction guarantee — their INTERSECTION.
 *
 * `A && B` is reached only when each side holds, so the methods it serves are
 * the methods they agree on. Taking the first non-empty side instead — which is
 * what {@link verbsFromTernary} did — reports one operand's set unintersected:
 * `(GET || POST) ? (POST || PUT) : false` emitted GET and POST where only POST
 * can reach the body, so the GET route was invented outright.
 *
 * An EMPTY side is "this operand names no method", not "this operand admits
 * none", so it yields to the other rather than annihilating it — that is the
 * `isAdmin && req.method === 'POST'` shape, and it is the whole reason the
 * fallthrough existed. An empty INTERSECTION of two non-empty sides is the
 * opposite: two conflicting method assertions, a guard nothing can satisfy. No
 * verb is honest there, and the route survives verb-less, which is this
 * module's stated direction for "cannot prove it".
 */
function intersectVerbs(a: readonly string[], b: readonly string[]): readonly string[] {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  return a.filter((verb) => b.includes(verb));
}

/**
 * The verb a ternary guarantees — which is one only when an arm is a boolean
 * literal, because that is what collapses the selection into a conjunction:
 *
 *   c ? A : false   ≡  c && A     both hold, so INTERSECT both
 *   c ? false : B   ≡  !c && B    c must NOT hold, so search it at flipped parity
 *   c ? true  : B   ≡  c || B     a disjunction guarantees neither operand
 *   c ? A : true    ≡  !c || A    likewise
 *
 * With two non-literal arms the verb is chosen by a condition whose value is
 * unknown, so the ternary guarantees nothing.
 *
 * The two conjunctions intersect rather than take the first side that names a
 * verb — see {@link intersectVerbs} for the route that mistake invented. The
 * `||` rule below is the mirror image and already had it right: a disjunction
 * UNIONS its operands, all-or-nothing.
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

  if (alternative.type === 'false') {
    return intersectVerbs(
      findVerbsInSubtree(condition, false),
      findVerbsInSubtree(consequence, false),
    );
  }
  if (consequence.type === 'false') {
    return intersectVerbs(
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
  const fn = enclosingFunction(node);
  if (fn === null) return undefined;
  const own = fn.childForFieldName('name');
  if (own !== null) return own.text;
  const parent = fn.parent;
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

/**
 * The function this node sits in, or `null` at module scope.
 *
 * ONE traversal, three readers: the handler name above, the scope half of a
 * match-binding key, and the chain an assignment can rebind. They have to agree
 * on where a function begins or "the same name in the same function" stops
 * meaning one thing, so they share the walk rather than each re-deriving it.
 */
function enclosingFunction(node: SyntaxNode): SyntaxNode | null {
  let current: SyntaxNode | null = node.parent;
  while (current !== null) {
    if (FUNCTION_NODE_TYPES.has(current.type)) return current;
    current = current.parent;
  }
  return null;
}

/** Names bound outside every function share this scope. */
const MODULE_SCOPE_ID = -1;

/** The scope half of a binding key: the id of the function this node lives in. */
function enclosingScopeId(node: SyntaxNode): number {
  return enclosingFunction(node)?.id ?? MODULE_SCOPE_ID;
}

/**
 * Every scope an assignment written here could be rebinding — its own function,
 * then outward. `m = x` inside a callback rebinds the `m` of whichever enclosing
 * function declared it, and this module does not resolve which, so an assignment
 * is taken to reach all of them.
 */
function enclosingScopeIds(node: SyntaxNode): number[] {
  const ids: number[] = [];
  for (let fn = enclosingFunction(node); fn !== null; fn = enclosingFunction(fn)) ids.push(fn.id);
  ids.push(MODULE_SCOPE_ID);
  return ids;
}

/**
 * A binding key: the function a name is bound in, plus the name.
 *
 * The scope id is a number and NUL cannot appear in an identifier, so the two
 * halves cannot run together into a collision. Written as the `\u0000` ESCAPE,
 * never a raw NUL byte: a literal NUL makes the source a binary file to git,
 * grep and every other line-oriented tool.
 */
function bindingKey(scopeId: number, name: string): string {
  return `${scopeId}\u0000${name}`;
}

/**
 * Every name a binding pattern introduces — `m`, `{ m }`, `{ a: m }`, `[m]`,
 * `...m`, `m = fallback`.
 *
 * Destructuring is here because it SHADOWS: `{ const { m } = req.body }` in a
 * block below a real `const m = pathname.match(…)` binds a different `m` in the
 * same function scope, and a shadow this module cannot see is a shadow it would
 * mint a route from. Over-collecting a name only ever refuses one, so the
 * recursion is deliberately blunt about the shapes it does not name.
 */
function patternNames(pattern: SyntaxNode, out: string[] = []): string[] {
  if (pattern.type === 'identifier' || pattern.type === 'shorthand_property_identifier_pattern') {
    out.push(pattern.text);
    return out;
  }
  if (pattern.type === 'pair_pattern' || pattern.type === 'assignment_pattern') {
    const bound = pattern.childForFieldName('value') ?? pattern.childForFieldName('left');
    if (bound !== null) patternNames(bound, out);
    return out;
  }
  for (const child of pattern.namedChildren) patternNames(child, out);
  return out;
}

/**
 * A single URL segment, capturing or not: `[^/]+`, `[^\/]*`, `([^/]+)`.
 *
 * The CAPTURING form is the one real dispatchers write, and it was the one form
 * this converter refused. `(` fell through to the metacharacter bail below, so
 * `^\/api\/research-runs\/([^/]+)$` translated to nothing — while the
 * non-capturing twin translated fine, which is why every test for this rule
 * passed. The tests were written against the implementation instead of against
 * the corpus, and the reporting repo does not contain a single non-capturing
 * path wildcard: a dispatcher captures the segment because it needs the id.
 *
 * The alternatives are balanced on purpose — `([^/]+` unclosed is not a segment,
 * and matching it would leave a stray `)` to be read as a literal.
 */
const SEGMENT_WILDCARD = /^(?:\(\[\^\\?\/\][+*]\)|\[\^\\?\/\][+*])/;

/**
 * Convert an anchored regex used as a path test into a route path, or `null` if
 * any part of it is not cleanly representable.
 *
 * `^\/api\/research-runs\/([^/]+)$` → `/api/research-runs/{param1}`
 *
 * Only single-segment wildcards are recognised — see {@link SEGMENT_WILDCARD}.
 * Anything else — an optional group, an alternation, a bare `.*` — bails,
 * because a route path is a claim about what the server serves and a
 * mistranslated pattern is a wrong one. A capture group around anything OTHER
 * than a segment wildcard still bails: `(.+)` spans slashes, so it is not one
 * segment and cannot be one `{param}`.
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
    const wildcard = SEGMENT_WILDCARD.exec(rest);
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
  const regexes = buildRegexConstantMap(tree.rootNode);
  const matches: MatchBindingState = { bindings: new Map(), declarations: new Map() };

  // Declarations and assignments are noted on the SAME walk that records the
  // bindings, and every emission happens after it, so a shadow or a rebinding
  // written below the match still refuses the name it would have poisoned.
  const visit = (node: SyntaxNode): void => {
    if (node.type === 'binary_expression') collectFromComparison(node, found, constants);
    else if (node.type === 'call_expression')
      collectFromRegexDispatch(node, found, regexes, matches);
    else if (node.type === 'switch_statement') collectFromSwitch(node, found, constants);
    else if (node.type === 'variable_declarator') noteDeclaration(node, matches);
    else if (
      node.type === 'assignment_expression' ||
      node.type === 'augmented_assignment_expression'
    )
      noteReassignment(node, matches);
    for (const child of node.namedChildren) visit(child);
  };
  visit(tree.rootNode);

  collectFromMatchBindings(tree.rootNode, matches.bindings, found);

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

/** A name bound to the result of an anchored-regex match against the path. */
interface MatchBinding {
  readonly name: string;
  readonly url: string;
  readonly line: number;
  readonly handlerName: string | undefined;
}

/**
 * Match bindings, keyed by the FUNCTION a name is bound in as well as the name.
 *
 * The bare name is not enough, and settling for it invented routes. `m`, `match`
 * and `result` are the three most common local names in dispatcher code, so a
 * file with two handlers routinely binds `m` twice to unrelated things:
 *
 *     function handleReplay(req)   { const m = pathname.match(REPLAY_RE)
 *                                    if (req.method === 'GET' && m) … }
 *     function handleSettings(req) { const m = req.headers['x-mode']
 *                                    if (req.method === 'DELETE' && m) … }
 *
 * Keyed by name alone, the second function's `m` resolved to the FIRST
 * function's binding and minted `DELETE /api/live/positions/{param1}/replay` —
 * wrong in its verb, its handler and its line, for a path that handler never
 * serves. The poison rule did not catch it because poisoning only ran when a
 * second REGEX MATCH bound the name; a binding to anything else never reached
 * that code at all. And the loss compounded: the fabricated route carries a
 * verb, so {@link reconcileDispatchGuardRoutes} treats it as the authoritative
 * claim on that URL and EVICTS the honest verb-less one.
 *
 * Two names in two functions are now two keys, so neither can see the other.
 * Within ONE scope the module still refuses rather than resolves, the way
 * {@link buildConstantMap} does: a second declarator for the same key is a
 * shadow this walk cannot order, and an assignment can rebind a name from any
 * function nested inside the one that declared it.
 */
interface MatchBindingState {
  /** Binding key -> the binding, or `null` once the name is ambiguous there. */
  readonly bindings: Map<string, MatchBinding | null>;
  /** Binding key -> how many declarators bind it. A second one is a shadow. */
  readonly declarations: Map<string, number>;
}

/**
 * Count a declarator against its key, and refuse the key once a second one
 * binds it.
 *
 * Refusing rather than ordering costs the real route in
 * `const m = pathname.match(RE); { const m = other() }` — the honest GET is
 * dropped alongside the shadow that would have fabricated a DELETE. That is the
 * cheaper failure by this module's own bar, and it is the same trade
 * {@link buildConstantMap} makes for a name declared twice.
 */
function noteDeclaration(node: SyntaxNode, matches: MatchBindingState): void {
  const name = node.childForFieldName('name');
  if (name === null) return;
  const scopeId = enclosingScopeId(node);
  for (const bound of patternNames(name)) {
    const key = bindingKey(scopeId, bound);
    const count = (matches.declarations.get(key) ?? 0) + 1;
    matches.declarations.set(key, count);
    if (count > 1) matches.bindings.set(key, null);
  }
}

/**
 * Refuse a name that is ASSIGNED anywhere it could reach.
 *
 * `let m = pathname.match(RE); m = fallback()` leaves `m` holding something this
 * walk never saw, and the declaration alone is no longer evidence of what the
 * later `if (m)` tests. Poisoning pre-emptively — before the binding is even
 * recorded — is what makes the order of the two statements not matter.
 *
 * Only a REBINDING counts. `m.index = 0` and `m[1] = x` assign THROUGH the name
 * and leave it bound to the same match, so refusing on them would drop routes
 * for writes that change nothing this module reads.
 */
const REBINDABLE_TARGETS: ReadonlySet<string> = new Set([
  'identifier',
  'array_pattern',
  'object_pattern',
]);

function noteReassignment(node: SyntaxNode, matches: MatchBindingState): void {
  const left = node.childForFieldName('left');
  if (left === null || !REBINDABLE_TARGETS.has(left.type)) return;
  const names = patternNames(left);
  if (names.length === 0) return;
  for (const scopeId of enclosingScopeIds(node)) {
    for (const name of names) matches.bindings.set(bindingKey(scopeId, name), null);
  }
}

/**
 * Same-file `const NAME = /re/` bindings, so a regex named once and used by name
 * still yields its route.
 *
 * Verbatim from the reporting repo: `positionReplayRoutes.js` declares
 * `const POSITION_REPLAY_RE = /^\/api\/live\/positions\/([^/]+)\/replay$/` at
 * module scope and then uses it BOTH ways — `POSITION_REPLAY_RE.test(pathname)`
 * and `pathname.match(POSITION_REPLAY_RE)`. Keying only on inline literals
 * loses the whole file.
 *
 * Ambiguity is refused the same way {@link buildConstantMap} refuses it: a name
 * bound twice to different patterns is dropped rather than resolved to the
 * first, because a half-right regex is a wrong route.
 *
 * That refusal only ever SAW regex literals, which left the two rebindings that
 * matter walking straight past it. `let RE = /^\/api\/re\/([^/]+)$/` followed by
 * `RE = buildDynamic(req)` still minted the literal's route, and so did a
 * `const RE = new RegExp(userPrefix + '/x')` twin in another function — the map
 * is flat, so a same-named binding anywhere in the file is exactly the ambiguity
 * the doc claims to refuse. A name bound to ANYTHING that is not a regex
 * literal, or assigned at all, is now dropped.
 */
function buildRegexConstantMap(root: SyntaxNode): ReadonlyMap<string, string> {
  const patterns = new Map<string, string>();
  const ambiguous = new Set<string>();

  const visit = (node: SyntaxNode): void => {
    if (node.type === 'variable_declarator') {
      const name = node.childForFieldName('name');
      const value = unparenthesize(node.childForFieldName('value'));
      if (name !== null && name.type === 'identifier') {
        const pattern =
          value !== null && value.type === 'regex'
            ? (value.childForFieldName('pattern')?.text ?? null)
            : null;
        if (pattern === null) ambiguous.add(name.text);
        else {
          const existing = patterns.get(name.text);
          if (existing !== undefined && existing !== pattern) ambiguous.add(name.text);
          else patterns.set(name.text, pattern);
        }
      }
    }
    if (node.type === 'assignment_expression' || node.type === 'augmented_assignment_expression') {
      const left = node.childForFieldName('left');
      if (left !== null && left.type === 'identifier') ambiguous.add(left.text);
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);

  for (const name of ambiguous) patterns.delete(name);
  return patterns;
}

/** The regex pattern this expression denotes — inline literal or named const. */
function regexPatternOf(
  node: SyntaxNode | null,
  regexes: ReadonlyMap<string, string>,
): string | null {
  const expr = unparenthesize(node);
  if (expr === null) return null;
  if (expr.type === 'regex') return expr.childForFieldName('pattern')?.text ?? null;
  if (expr.type === 'identifier') return regexes.get(expr.text) ?? null;
  return null;
}

/**
 * A route declared by matching the path against an anchored regex.
 *
 * Two spellings of the same test, with the operands swapped:
 *
 *     if (RE.test(pathname))              — receiver is the regex
 *     const m = pathname.match(RE)        — receiver is the path
 *
 * Only `.test` was read, which is why 28 of the reporting repo's 75 routes still
 * named the shared route table as their handler rather than the module that
 * actually serves them: their modules dispatch with `.match`.
 *
 * `.match` differs in one way that matters. Its result is USED — it carries the
 * captured segments — so it is almost always BOUND, and the verb then lives in a
 * later `if` rather than around the call:
 *
 *     const runMatch = pathname.match(/^\/api\/research-runs\/([^/]+)$/)
 *     if (req.method === 'GET' && runMatch) { … }
 *
 * Reading the verb off the CALL would report every one of those verb-less. So a
 * bound match is recorded rather than emitted, and {@link collectFromMatchBindings}
 * emits it where the binding is actually tested. An unbound match is a plain
 * predicate and is emitted here, exactly like `.test`.
 */
function collectFromRegexDispatch(
  node: SyntaxNode,
  out: GuardRoute[],
  regexes: ReadonlyMap<string, string>,
  matches: MatchBindingState,
): void {
  const callee = node.childForFieldName('function');
  if (callee === null || callee.type !== 'member_expression') return;
  const method = callee.childForFieldName('property')?.text;
  if (method !== 'test' && method !== 'match') return;

  const receiver = callee.childForFieldName('object');
  const argument = node.childForFieldName('arguments')?.namedChildren[0] ?? null;
  if (receiver === null || argument === null) return;

  // `RE.test(pathname)` vs `pathname.match(RE)` — the regex and the path swap
  // sides with the method, so each spelling is checked in its own orientation
  // rather than accepting any pairing.
  const pattern =
    method === 'test'
      ? isPathExpression(argument)
        ? regexPatternOf(receiver, regexes)
        : null
      : isPathExpression(receiver)
        ? regexPatternOf(argument, regexes)
        : null;
  if (pattern === null) return;

  const url = regexToRoutePath(pattern);
  if (url === null) return;

  const boundName = boundDeclaratorName(node);
  if (boundName !== null) {
    // Keyed by the function this name is bound in — see MatchBindingState for
    // the routes the bare name invented. Already-refused keys stay refused, and
    // a key bound twice to DIFFERENT routes is poisoned rather than resolved to
    // the first.
    const key = bindingKey(enclosingScopeId(node), boundName);
    const existing = matches.bindings.get(key);
    if (existing !== undefined && (existing === null || existing.url !== url)) {
      matches.bindings.set(key, null);
      return;
    }
    matches.bindings.set(key, {
      name: boundName,
      url,
      line: node.startPosition.row + 1,
      handlerName: enclosingHandlerName(node),
    });
    return;
  }

  // Unbound: the call IS the predicate, so its own context carries the verb.
  if (isNegatedContext(node)) return;
  pushPerVerb(out, governingVerbs(node), {
    url,
    handlerName: enclosingHandlerName(node),
    line: node.startPosition.row + 1,
  });
}

/** The name this call's result is bound to by `const NAME = <call>`, if any. */
function boundDeclaratorName(call: SyntaxNode): string | null {
  const parent = call.parent;
  if (parent === null || parent.type !== 'variable_declarator') return null;
  if (parent.childForFieldName('value')?.id !== call.id) return null;
  const name = parent.childForFieldName('name');
  return name !== null && name.type === 'identifier' ? name.text : null;
}

/**
 * Emit a route wherever a recorded match binding is TESTED.
 *
 * The binding's declaration proves a path; the test site proves the method, and
 * one binding can be tested more than once. A reference counts only in a
 * truthiness position — see {@link isTruthinessPosition} — which is what
 * separates `if (m && …)` from `m[1]`, a read of the captured segment that says
 * nothing about dispatch and would otherwise mint a duplicate route per capture
 * group used.
 *
 * A binding that is never tested still emits ONE verb-less route: the code did
 * compute an anchored match against the request path, which is the same evidence
 * an unbound `.test` carries, and dropping it would trade a known path for
 * nothing.
 *
 * The DECLARATION's own name identifier needs no special case: its parent is a
 * `variable_declarator`, which is not a truthiness position, so the same
 * predicate that rejects `m[1]` rejects it. An explicit skip was written here
 * first and removed once it proved unreachable — it read as though the
 * declaration were a hazard, which sends the next reader looking for one.
 *
 * A use counts only against a binding in ITS OWN function. `tested` is keyed the
 * same way, and that half matters as much as the emission: keyed by bare name, a
 * same-named local in another handler marked the name tested and SUPPRESSED the
 * real binding's own verb-less route from the tail loop below — so the honest
 * route was not merely joined by a fabricated one, it was replaced by it, down
 * to reporting the wrong handler and the wrong line.
 */
function collectFromMatchBindings(
  root: SyntaxNode,
  matchBindings: ReadonlyMap<string, MatchBinding | null>,
  out: GuardRoute[],
): void {
  // Resolving a scope costs a walk to the function boundary, and this visits
  // every identifier in the file. Names that no live binding uses are rejected
  // on a set lookup first, so files without a bound match pay nothing.
  const liveNames = new Set<string>();
  for (const binding of matchBindings.values()) if (binding !== null) liveNames.add(binding.name);
  if (liveNames.size === 0) return;
  const tested = new Set<string>();

  const visit = (node: SyntaxNode): void => {
    if (node.type === 'identifier' && liveNames.has(node.text)) {
      const key = bindingKey(enclosingScopeId(node), node.text);
      const binding = matchBindings.get(key);
      if (
        binding !== undefined &&
        binding !== null &&
        isTruthinessPosition(node) &&
        !isNegatedContext(node)
      ) {
        tested.add(key);
        pushPerVerb(out, governingVerbs(node), {
          url: binding.url,
          handlerName: enclosingHandlerName(node) ?? binding.handlerName,
          line: node.startPosition.row + 1,
        });
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(root);

  for (const [key, binding] of matchBindings) {
    if (binding === null || tested.has(key)) continue;
    out.push({
      url: binding.url,
      verb: null,
      handlerName: binding.handlerName,
      line: binding.line,
    });
  }
}

/**
 * Is this reference read for its TRUTH — an operand of `&&`/`||`, or the whole
 * condition of an `if`?
 *
 * Deliberately narrow. `runMatch[1]` (a `subscript_expression` parent) reads a
 * captured segment, and `validate(runMatch)` passes it along; neither asserts
 * that the request took this route, and counting them would emit one duplicate
 * route per use of the captured id. Parentheses are transparent, so
 * `if ((runMatch))` and `if (verb && (runMatch))` both count.
 */
function isTruthinessPosition(node: SyntaxNode): boolean {
  let current: SyntaxNode = node;
  let parent = current.parent;
  while (parent !== null && parent.type === 'parenthesized_expression') {
    current = parent;
    parent = current.parent;
  }
  if (parent === null) return false;
  if (parent.type === 'binary_expression') {
    const operator = parent.childForFieldName('operator')?.text;
    return operator === '&&' || operator === '||';
  }
  if (parent.type === 'if_statement') {
    return parent.childForFieldName('condition')?.id === current.id;
  }
  return false;
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
