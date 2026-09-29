import type { SymbolDefinition } from 'gitnexus-shared';
import { generateId } from '../../../../lib/utils.js';
import type { RouteHandlerResolutionHookContext } from '../../language-provider.js';
import type { ExtractedDecoratorRoute } from '../../workers/parse-worker.js';

/**
 * Resolve a gin/echo handler designator (`Login`, `pkg.Login`, `h.Login`) to a
 * symbol, looking across the files of a Go package — a package is a directory,
 * so a handler registered in `router.go` is usually a method declared in a
 * sibling file (#3402).
 *
 * Every step is unique-or-decline. A receiver hint whose owner cannot be found
 * declines rather than falling back to a name-only match: with the router and
 * the handlers in different packages, a same-named method in the router's own
 * directory belongs to an unrelated type.
 *
 * Runs at the end of the parse phase, before scope resolution, so a Method's
 * `ownerId` is still the worker's `Struct:<methodFile>:<Receiver>` id — keyed on
 * the METHOD's file, which is not the struct's node id when the struct is
 * declared in another file of the package. Ownership is therefore matched on
 * either id.
 */
export function resolveGoRouteHandler(
  route: ExtractedDecoratorRoute,
  context: RouteHandlerResolutionHookContext,
): string | undefined {
  const designator = route.handlerName;
  if (!designator) return undefined;
  const parts = designator.split('.');
  const routeDir = dirOf(route.filePath);
  const { model } = context;

  if (parts.length === 1) return uniqueId(functionsIn(model, routeDir, designator));
  if (parts.length !== 2) return undefined;
  const member = parts[1];

  const hint = route.handlerReceiver;
  if (hint === undefined) {
    // Receiver of unknown type: the method is unique in the package, or unknown.
    return uniqueId(model.methods.lookupMethodByName(member).filter(inPackage(routeDir)));
  }

  const dir = hint.qualifier === undefined ? routeDir : packageDir(context, route, hint.qualifier);
  if (dir === undefined) return undefined;
  if (hint.kind === 'module') return uniqueId(functionsIn(model, dir, member));
  if (hint.name === undefined) return undefined;
  if (hint.kind === 'type') return methodOfType(context, dir, hint.name, member);

  const constructor = unique(functionsIn(model, dir, hint.name));
  const owner = constructor && ownerTypeName(constructor.returnType);
  return constructor && owner
    ? methodOfType(context, dirOf(constructor.filePath), owner, member)
    : undefined;
}

function dirOf(filePath: string): string {
  const normalized = filePath.replaceAll('\\', '/');
  const slash = normalized.lastIndexOf('/');
  return slash < 0 ? '' : normalized.slice(0, slash);
}

/** Non-test files of the package in `dir`; `_test.go` files are a separate build. */
const inPackage =
  (dir: string) =>
  (def: SymbolDefinition): boolean =>
    dirOf(def.filePath) === dir && !def.filePath.endsWith('_test.go');

function unique(defs: readonly SymbolDefinition[]): SymbolDefinition | undefined {
  const byId = new Map(defs.map((def) => [def.nodeId, def]));
  return byId.size === 1 ? byId.values().next().value : undefined;
}

const uniqueId = (defs: readonly SymbolDefinition[]): string | undefined => unique(defs)?.nodeId;

function functionsIn(
  model: RouteHandlerResolutionHookContext['model'],
  dir: string,
  name: string,
): readonly SymbolDefinition[] {
  return model.symbols
    .lookupCallableByName(name)
    .filter((def) => def.type === 'Function' && inPackage(dir)(def));
}

/** The one package directory an import local name resolves to, if any. */
function packageDir(
  context: RouteHandlerResolutionHookContext,
  route: ExtractedDecoratorRoute,
  localName: string,
): string | undefined {
  const dirs = new Set(context.importTargetsFor(route.filePath, localName).map(dirOf));
  return dirs.size === 1 ? dirs.values().next().value : undefined;
}

/**
 * `*T`, `T`, `(*T, error)` → `T`. A qualified (`pkg.T`) or composite result is
 * declined: the owner would live in another package this hint cannot name.
 */
function ownerTypeName(returnType: string | undefined): string | undefined {
  if (returnType === undefined) return undefined;
  const first = returnType.replace(/^\(/, '').split(',')[0]?.trim() ?? '';
  const name = first.replace(/^\*/, '');
  return /^[A-Za-z_]\w*$/.test(name) ? name : undefined;
}

function methodOfType(
  context: RouteHandlerResolutionHookContext,
  dir: string,
  typeName: string,
  member: string,
): string | undefined {
  const { model } = context;
  const owner = unique(
    model.types
      .lookupClassByName(typeName)
      .filter((def) => def.type === 'Struct' && inPackage(dir)(def)),
  );
  if (owner === undefined) return undefined;
  return uniqueId(
    model.methods
      .lookupMethodByName(member)
      .filter(
        (def) =>
          inPackage(dir)(def) &&
          (def.ownerId === owner.nodeId ||
            def.ownerId === generateId('Struct', `${def.filePath}:${typeName}`)),
      ),
  );
}
