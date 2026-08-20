/**
 * NestJS decorator routes for the indexer.
 *
 * A NestJS endpoint is declared across two decorators: `@Controller('venues')`
 * on the class supplies the prefix, and `@Get('search')` on a method supplies
 * the verb and the remainder. Neither half is a route on its own, which is why
 * a pattern that only looks at one of them finds nothing.
 *
 * Until this existed, TypeScript's `extractDecoratorRoutes` hook was dispatch
 * guards plus static data route tables only, so a NestJS repo produced
 * essentially no `Route` nodes. That is not a quiet gap: `route_map`,
 * `api_impact` and `shape_check` all read `Route` nodes and answer "no routes
 * matching …" when there are none — so `api_impact`, whose documented job is to
 * be run BEFORE modifying a route handler, reported every live endpoint as
 * non-existent, and a not-found reads as a safe change (#3009).
 *
 * The extraction mirrors `spring.ts`, which solves the identical shape for
 * `@RequestMapping` + `@GetMapping`: collect class-level prefixes keyed by class
 * node id, then walk method decorators and attach the prefix of their enclosing
 * class. As there, the prefix travels on `ExtractedDecoratorRoute.prefix` and
 * the routes phase performs the join via `normalizeExtractedRoutePath`, so
 * NestJS routes are keyed identically to every other framework's.
 */

import type Parser from 'tree-sitter';
import type { ExtractedDecoratorRoute } from '../workers/parse-worker.js';

/** NestJS method decorators → HTTP verb. */
const NEST_METHOD_DECORATORS: Record<string, string> = {
  Get: 'GET',
  Post: 'POST',
  Put: 'PUT',
  Patch: 'PATCH',
  Delete: 'DELETE',
  Head: 'HEAD',
  Options: 'OPTIONS',
  All: '*',
};

/**
 * Cheap parse-free gate. Every JS/TS file in every repo reaches this hook, so
 * skip the walk unless the file could plausibly declare a controller. A file
 * without the substring cannot produce a route here, because a `@Controller`
 * decorator is REQUIRED before any method decorator is believed (see below).
 */
const CONTROLLER_HINT = '@Controller';

/** The decorator's call expression, whether or not it has an argument list. */
function decoratorCall(decorator: Parser.SyntaxNode): Parser.SyntaxNode | null {
  const inner = decorator.namedChild(0);
  if (!inner) return null;
  if (inner.type === 'call_expression') return inner;
  return null;
}

/** The decorator's name — `Controller` for `@Controller('x')`, `Get` for `@Get()`. */
function decoratorName(decorator: Parser.SyntaxNode): string | null {
  const inner = decorator.namedChild(0);
  if (!inner) return null;
  // `@Get()` is a call_expression; a bare `@Injectable` is a plain identifier.
  if (inner.type === 'identifier') return inner.text;
  if (inner.type === 'call_expression') {
    const fn = inner.childForFieldName('function');
    return fn?.type === 'identifier' ? fn.text : null;
  }
  return null;
}

/**
 * The literal string first argument of a decorator call, or `''` when the
 * decorator takes no argument (`@Controller()` / `@Get()` — both legal and both
 * meaning "no path segment of my own").
 *
 * Returns `null` when an argument IS present but is not a plain literal. That
 * is deliberately distinct from `''`: a computed prefix
 * (`@Controller(ROUTES.VENUES)`) whose value we cannot read must drop the route
 * rather than silently mount it at the wrong URL. `route_map` presents its
 * output as fact, and a wrong path is worse than a missing one.
 */
function decoratorLiteralArg(decorator: Parser.SyntaxNode): string | null | undefined {
  const call = decoratorCall(decorator);
  if (!call) return ''; // bare `@Get` with no call — no path of its own
  const args = call.childForFieldName('arguments');
  const first = args?.namedChild(0);
  if (!first) return ''; // `@Get()` — no path of its own

  if (first.type === 'string' || first.type === 'template_string') {
    if (first.namedChildren.some((c) => c.type === 'template_substitution')) return null;
    const fragments = first.namedChildren.filter((c) => c.type === 'string_fragment');
    // An empty literal (`@Controller('')`) has no fragments and is a real ''.
    return fragments.map((f) => f.text).join('');
  }

  // An array form (`@Get(['a', 'b'])`), an identifier, a member expression, a
  // call — all unreadable here. Skip rather than guess.
  return null;
}

/**
 * Decorators that immediately precede `node` among its parent's named children.
 * In tree-sitter-typescript a decorator is a SIBLING placed before the thing it
 * decorates — both at `export_statement`/`program` level for a class and inside
 * `class_body` for a method — and decorators stack.
 */
function precedingDecorators(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const parent = node.parent;
  if (!parent) return [];
  const siblings = parent.namedChildren;
  const index = siblings.findIndex((c) => c.id === node.id);
  if (index < 0) return [];

  const out: Parser.SyntaxNode[] = [];
  for (let i = index - 1; i >= 0; i--) {
    const sibling = siblings[i];
    // A comment between the decorators and the thing they decorate is ordinary
    // (`@Post('x')` then a JSDoc block then the method) and must not terminate
    // the stack — doing so makes the whole decorated route invisible.
    if (sibling.type === 'comment') continue;
    if (sibling.type !== 'decorator') break;
    out.push(sibling);
  }
  return out;
}

/**
 * Leading `decorator` children of a node, stopping at the first child that is
 * neither a decorator nor a comment. Comments are skipped for the same reason
 * as in {@link precedingDecorators}: a doc block sitting between `@Controller`
 * and the class must not hide the decorator.
 */
function leadingDecorators(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const out: Parser.SyntaxNode[] = [];
  for (const child of node.namedChildren) {
    if (child.type === 'comment') continue;
    if (child.type !== 'decorator') break;
    out.push(child);
  }
  return out;
}

/**
 * Every decorator attached to a class, across the two shapes the grammar
 * produces — which differ by whether the class is exported:
 *
 *   `@Controller('a') class A {}`         → decorator is a CHILD of class_declaration
 *   `@Controller('a') export class A {}`  → decorator is a child of export_statement,
 *                                            i.e. a SIBLING of the class_declaration
 *
 * Checking only one of them silently drops half of all controllers, so collect
 * from both plus the sibling position for either node.
 */
function classDecorators(classNode: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const out = [...leadingDecorators(classNode), ...precedingDecorators(classNode)];
  const wrapper = classNode.parent;
  if (wrapper?.type === 'export_statement') {
    out.push(...leadingDecorators(wrapper), ...precedingDecorators(wrapper));
  }
  return out;
}

/** The `@Controller(...)` prefix for a class, or undefined when it has none. */
function controllerPrefix(classNode: Parser.SyntaxNode): string | null | undefined {
  for (const decorator of classDecorators(classNode)) {
    if (decoratorName(decorator) !== 'Controller') continue;
    return decoratorLiteralArg(decorator);
  }
  return undefined;
}

/**
 * Extract NestJS routes from one parsed TypeScript/JavaScript file.
 *
 * A method decorator is only believed when its enclosing class carries a
 * `@Controller`. `@Get`/`@Post`/`@Delete` are common identifiers, and without
 * that requirement any unrelated library using the same decorator names would
 * mint phantom endpoints.
 */
export function extractNestRoutes(
  tree: Parser.Tree,
  filePath: string,
  lineOffset = 0,
): ExtractedDecoratorRoute[] {
  if (!tree.rootNode.text.includes(CONTROLLER_HINT)) return [];

  const out: ExtractedDecoratorRoute[] = [];

  const visit = (node: Parser.SyntaxNode): void => {
    if (node.type === 'class_declaration') {
      const prefix = controllerPrefix(node);
      // `undefined` — not a controller at all. `null` — a controller whose
      // prefix could not be read, so its routes' URLs are unknowable.
      if (prefix !== undefined) {
        if (prefix !== null) collectClassRoutes(node, prefix, filePath, lineOffset, out);
        return; // a controller's methods are handled here; don't re-walk them
      }
    }
    for (const child of node.namedChildren) visit(child);
  };

  visit(tree.rootNode);
  return out;
}

function collectClassRoutes(
  classNode: Parser.SyntaxNode,
  prefix: string,
  filePath: string,
  lineOffset: number,
  out: ExtractedDecoratorRoute[],
): void {
  const body = classNode.childForFieldName('body');
  if (!body) return;

  for (const member of body.namedChildren) {
    if (member.type !== 'method_definition') continue;

    for (const decorator of precedingDecorators(member)) {
      const name = decoratorName(decorator);
      if (name === null) continue;
      const httpMethod = NEST_METHOD_DECORATORS[name];
      if (!httpMethod) continue;

      const routePath = decoratorLiteralArg(decorator);
      if (routePath === null || routePath === undefined) continue; // unreadable → skip

      const handlerName = member.childForFieldName('name')?.text;

      out.push({
        filePath,
        // A pathless `@Get()` is the controller's index route and carries no
        // segment of its own. Emit '/' rather than '': `claim()` in
        // call-processor short-circuits on a falsy routePath, so an empty
        // string would still produce the Route node but silently lose its
        // handler symbol — the route would exist with nothing attached to it.
        // Both spellings normalize to the same URL against the prefix.
        routePath: routePath === '' ? '/' : routePath,
        httpMethod,
        decoratorName: name,
        lineNumber: member.startPosition.row + 1 + lineOffset,
        prefix: prefix === '' ? null : prefix,
        ...(handlerName === undefined ? {} : { handlerName }),
      });
    }
  }
}
