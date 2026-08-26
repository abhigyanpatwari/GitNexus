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
 *
 * Known limitation: the URLs produced here are CONTROLLER-RELATIVE. A global
 * prefix (`app.setGlobalPrefix('api')`) and URI versioning are applied by the
 * bootstrap file, not by any decorator this file can see, so neither is
 * reflected — a route served at `/api/v1/venues/search` is stored as
 * `/venues/search`. The module's "drop rather than guess" floor is unavailable
 * for it: the evidence lives in a different file, so honouring it would mean
 * dropping every Nest route in every repo. `spring.ts` has the same hole for
 * `server.servlet.context-path`; `ExtractedDecoratorRoute.prefix` is the
 * channel a cross-file follow-up would use, the way FastAPI resolves its mount.
 */

import type Parser from 'tree-sitter';
import type { ExtractedDecoratorRoute } from '../workers/parse-worker.js';
import { plainString, propertyName } from './data-route-table.js';

/**
 * NestJS method decorators → HTTP verb. A Map rather than an object literal
 * because the lookup key is an arbitrary decorator name read out of source: a
 * plain object answers `@toString()` with `Object.prototype.toString`, which is
 * truthy and would be emitted verbatim as the route's httpMethod.
 */
const NEST_METHOD_DECORATORS: ReadonlyMap<string, string> = new Map([
  ['Get', 'GET'],
  ['Post', 'POST'],
  ['Put', 'PUT'],
  ['Patch', 'PATCH'],
  ['Delete', 'DELETE'],
  ['Head', 'HEAD'],
  ['Options', 'OPTIONS'],
  ['All', '*'],
  // `@Sse` mounts a real GET endpoint that streams; it is as much a route as
  // `@Get`. `@Search` is deliberately absent — `normalizeRouteMethod` rejects
  // SEARCH as non-standard and would key the route by URL alone, colliding
  // with every other verb on that path.
  ['Sse', 'GET'],
]);

/**
 * Class node types that can carry a `@Controller`. `export abstract class C`
 * parses as `abstract_class_declaration`, a DIFFERENT node type — and a
 * decorated abstract base sharing CRUD routes with its subclasses is ordinary
 * Nest, so matching `class_declaration` alone silently drops the whole
 * controller rather than one route.
 */
const CLASS_DECLARATION_TYPES: ReadonlySet<string> = new Set([
  'class_declaration',
  'abstract_class_declaration',
]);

/**
 * Cheap parse-free gate. Every JS/TS file in every repo reaches this hook, so
 * skip the walk unless the file could plausibly declare a controller. A file
 * without the substring cannot produce a route here, because a `@Controller`
 * decorator is REQUIRED before any method decorator is believed (see below).
 */
const CONTROLLER_HINT = '@Controller';

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
 *
 * Reading the literal is delegated to `plainString`, the same judge the
 * data-route-table extractor uses, so both agree on what is readable. Filtering
 * `string_fragment` children and joining them looks equivalent and is not:
 * tree-sitter SPLITS a literal around each `escape_sequence`, and the join then
 * DELETES the escape rather than decoding it. `@Get(':id(\\d+)')` — the ordinary
 * spelling of a Nest regex param, whose value is `:id(\d+)` — came out as
 * `:id(d+)`, and `@Get('/v\u0069ews')` came out as `/vews`. Both are paths the
 * app never serves, i.e. the wrong-URL outcome the paragraph above forbids.
 */
function decoratorLiteralArg(decorator: Parser.SyntaxNode): string | null {
  const call = decorator.namedChild(0);
  // A bare `@Injectable` with no call, or `@Get()` with no argument — legal,
  // and both mean "no path segment of my own".
  if (call?.type !== 'call_expression') return '';
  const first = call.childForFieldName('arguments')?.namedChild(0);
  if (!first) return '';

  // `@Controller({ path: 'cats', version: '1' })` is the documented form for
  // URI/header versioning, and its path is a plain literal sitting right there.
  // Worth reading rather than dropping, because the asymmetry is severe: an
  // unreadable METHOD path costs one route, an unreadable PREFIX costs every
  // route on the class.
  if (first.type === 'object') {
    // `propertyName` reads both spellings that carry a name — `{ path: … }` and
    // `{ 'path': … }` — so the class is not dropped over a pair of quotes. A
    // computed key (`{ [KEY]: … }`) has none, and keeps the drop, as does a
    // computed value.
    const path = first.namedChildren.find((child) => {
      const key = child.type === 'pair' ? child.childForFieldName('key') : null;
      return key !== null && propertyName(key) === 'path';
    });
    const value = path?.childForFieldName('value');
    return value ? plainString(value) : null;
  }

  // An array form (`@Get(['a', 'b'])`), an identifier, a member expression, a
  // call — none of them is a readable literal, and `plainString` answers `null`
  // for every one of them. Skip rather than guess.
  return plainString(first);
}

/**
 * Decorators that immediately precede `node` among its parent's named children.
 * In tree-sitter-typescript a decorator is a SIBLING placed before the thing it
 * decorates — at `export_statement`/`program` level for a class — and
 * decorators stack.
 *
 * Walks the sibling chain rather than indexing into `parent.namedChildren`,
 * which is the same uncached-getter trap {@link collectClassRoutes} documents:
 * a class's parent is usually `program`, so reading the list marshals every
 * top-level statement in the file, once per class. That is quadratic in
 * top-level statements — measured 200ms for a file of 800 classes, against
 * 0.9ms for this form.
 */
function precedingDecorators(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const out: Parser.SyntaxNode[] = [];
  for (let sibling = node.previousNamedSibling; sibling; sibling = sibling.previousNamedSibling) {
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
 * from both, plus the sibling position for the class itself. There is no fourth
 * source: both grammars fold a class's decorators INTO the `export_statement`
 * production, so an `export_statement` never has one as a preceding sibling.
 */
function classDecorators(classNode: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const out = [...leadingDecorators(classNode), ...precedingDecorators(classNode)];
  const wrapper = classNode.parent;
  if (wrapper?.type === 'export_statement') out.push(...leadingDecorators(wrapper));
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
    if (CLASS_DECLARATION_TYPES.has(node.type)) {
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

  // ONE forward pass over the body, accumulating the decorator run and flushing
  // it at each method. Calling `precedingDecorators` per method instead is
  // quadratic in methods-per-controller for a reason that is invisible in the
  // source: `namedChildren` is an UNCACHED getter in node-tree-sitter, so every
  // call re-marshals the entire class body into fresh JS objects before the
  // `findIndex`. Measured here, 800 methods cost 362ms (450us/method, up from
  // 42us/method at 50); a single pass is flat. `spring.ts` never had this
  // because a Java annotation is a child of the declaration it annotates.
  const pending: Parser.SyntaxNode[] = [];

  for (const member of body.namedChildren) {
    if (member.type === 'decorator') {
      pending.push(member);
      continue;
    }
    // Same reason as in `precedingDecorators`: a JSDoc block between a
    // decorator stack and its method must not hide the route (a real
    // controller shape, pinned by the suite). Known limitation of that skip: a
    // decorator ORPHANED by a commented-out handler is then absorbed onto the
    // NEXT method, minting a phantom route with the wrong handler. There is no
    // AST fix — an orphan followed by a comment is indistinguishable from a
    // stack whose method happens to be documented — and losing every
    // documented route is the worse trade, so it is made deliberately.
    if (member.type === 'comment') continue;

    // tree-sitter-javascript makes a method decorator a CHILD of the
    // `method_definition`, not a preceding sibling as in tree-sitter-typescript
    // — and this extractor is registered on the JavaScript provider too, which
    // already advertises `framework: 'nestjs'`. Reading only siblings meant
    // every `.js` Nest controller emitted nothing. On TypeScript the first
    // named child is the method name, so `leadingDecorators` contributes
    // nothing there and no route is collected twice.
    const decorators =
      member.type === 'method_definition' ? [...pending, ...leadingDecorators(member)] : [];
    for (const decorator of decorators) {
      const name = decoratorName(decorator);
      if (name === null) continue;
      const httpMethod = NEST_METHOD_DECORATORS.get(name);
      if (httpMethod === undefined) continue;

      const routePath = decoratorLiteralArg(decorator);
      if (routePath === null) continue; // unreadable → skip

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

    // Anything that is not a decorator or a comment ends the run — including
    // the method that just consumed it, so a decorated FIELD's stack is never
    // absorbed onto the method after it.
    pending.length = 0;
  }
}
