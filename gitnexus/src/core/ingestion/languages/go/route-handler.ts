import type { SymbolDefinition } from 'gitnexus-shared';
import { generateId } from '../../../../lib/utils.js';
import type { RouteHandlerResolutionHookContext } from '../../language-provider.js';
import type { SemanticModel } from '../../model/semantic-model.js';
import type { ExtractedDecoratorRoute } from '../../workers/parse-worker.js';
import { goPackageDir } from './package-clause.js';

/**
 * Resolve a gin/echo handler designator (`Login`, `pkg.Login`, `h.Login`) to a
 * symbol, looking across the files of a Go package — a package is a directory,
 * so a handler registered in `router.go` is usually a method declared in a
 * sibling file (#3402).
 *
 * Every step is unique-or-decline, and nothing falls back to a name-only match:
 * with the router and the handlers in different packages, a same-named method
 * in the router's own directory belongs to an unrelated type.
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
  const routeDir = goPackageDir(route.filePath);
  if (parts.length === 1) return uniqueId(functionsIn(context, routeDir, designator));
  if (parts.length !== 2) return undefined;
  const member = parts[1];

  // A receiver of unknown type (`h := deps.Users`, a package-level var) declines.
  const hint = route.handlerReceiver;
  if (hint === undefined) return undefined;

  const dir = hint.qualifier === undefined ? routeDir : packageDir(context, route, hint.qualifier);
  if (dir === undefined) return undefined;
  if (hint.kind === 'module') return uniqueId(functionsIn(context, dir, member));
  if (hint.name === undefined) return undefined;
  if (hint.kind === 'type') return methodOfType(context, dir, hint.name, member);

  const constructor = unique(functionsIn(context, dir, hint.name));
  const owner = constructor && ownerTypeName(constructor.returnType);
  return constructor && owner
    ? methodOfType(context, goPackageDir(constructor.filePath), owner, member)
    : undefined;
}

type DefinitionBuckets = Map<string, SymbolDefinition[]>;
type PackageIndex = Map<string, DefinitionBuckets>;
const bucketKey = (dir: string, name: string): string => JSON.stringify([dir, name]);

function append(bucket: DefinitionBuckets, key: string, def: SymbolDefinition): void {
  const values = bucket.get(key);
  if (values) values.push(def);
  else bucket.set(key, [def]);
}

function packageDefinitions(
  cache: PackageIndex,
  name: string,
  definitions: () => readonly SymbolDefinition[],
): DefinitionBuckets {
  let packages = cache.get(name);
  if (!packages) {
    packages = new Map();
    for (const def of definitions()) {
      if (!def.filePath.endsWith('_test.go')) append(packages, goPackageDir(def.filePath), def);
    }
    cache.set(name, packages);
  }
  return packages;
}

/** One immutable post-parse model per context; no cache survives a new pass. */
class GoRouteHandlerIndex {
  private readonly functions = new Map<string, DefinitionBuckets>();
  private readonly types = new Map<string, DefinitionBuckets>();
  private readonly methods = new Map<string, DefinitionBuckets>();

  constructor(private readonly model: SemanticModel) {}

  functionsIn(dir: string, name: string): readonly SymbolDefinition[] {
    return (
      packageDefinitions(this.functions, name, () =>
        this.model.symbols.lookupCallableByName(name).filter((def) => def.type === 'Function'),
      ).get(dir) ?? []
    );
  }

  typesIn(dir: string, name: string): readonly SymbolDefinition[] {
    return (
      packageDefinitions(this.types, name, () =>
        this.model.types.lookupClassByName(name).filter((def) => def.type === 'Struct'),
      ).get(dir) ?? []
    );
  }

  methodsOf(
    dir: string,
    ownerId: string,
    typeName: string,
    member: string,
  ): readonly SymbolDefinition[] {
    let index = this.methods.get(member);
    if (!index) {
      index = new Map();
      for (const def of this.model.methods.lookupMethodByName(member)) {
        if (def.filePath.endsWith('_test.go') || def.ownerId === undefined) continue;
        const packageDir = goPackageDir(def.filePath);
        const prefix = generateId('Struct', `${def.filePath}:`);
        if (def.ownerId.startsWith(prefix)) {
          append(index, bucketKey(packageDir, def.ownerId.slice(prefix.length)), def);
        }
      }
      this.methods.set(member, index);
    }
    return [
      ...this.model.methods
        .lookupAllByOwner(ownerId, member)
        .filter((def) => !def.filePath.endsWith('_test.go') && goPackageDir(def.filePath) === dir),
      ...(index.get(bucketKey(dir, typeName)) ?? []),
    ];
  }
}

const routeIndexes = new WeakMap<RouteHandlerResolutionHookContext, GoRouteHandlerIndex>();
function indexFor(context: RouteHandlerResolutionHookContext): GoRouteHandlerIndex {
  let index = routeIndexes.get(context);
  if (!index) {
    index = new GoRouteHandlerIndex(context.model);
    routeIndexes.set(context, index);
  }
  return index;
}

function unique(defs: readonly SymbolDefinition[]): SymbolDefinition | undefined {
  const byId = new Map(defs.map((def) => [def.nodeId, def]));
  return byId.size === 1 ? byId.values().next().value : undefined;
}

const uniqueId = (defs: readonly SymbolDefinition[]): string | undefined => unique(defs)?.nodeId;

function functionsIn(
  context: RouteHandlerResolutionHookContext,
  dir: string,
  name: string,
): readonly SymbolDefinition[] {
  return indexFor(context).functionsIn(dir, name);
}

/** The one package directory an import local name resolves to, if any. */
function packageDir(
  context: RouteHandlerResolutionHookContext,
  route: ExtractedDecoratorRoute,
  localName: string,
): string | undefined {
  const dirs = new Set(context.importTargetsFor(route.filePath, localName).map(goPackageDir));
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
  const index = indexFor(context);
  const owner = unique(index.typesIn(dir, typeName));
  if (owner === undefined) return undefined;
  return uniqueId(index.methodsOf(dir, owner.nodeId, typeName, member));
}
