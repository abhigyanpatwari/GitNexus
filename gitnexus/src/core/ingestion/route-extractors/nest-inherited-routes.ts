/**
 * NestJS routes a controller inherits from a base class in ANOTHER file.
 *
 * `nest.ts` reads one file at a time. It emits a controller's own routes and
 * those of the base classes declared beside it, and stops where the `extends`
 * chain leaves the file. The shared `CrudController` that a dozen controllers
 * extend lives in a file of its own, so that stop is the common case, and each
 * of those controllers reaches the graph with only the routes it adds.
 *
 * What a file can say on its own is recorded as {@link NestInheritanceFacts}:
 * its classes, and each controller left open at an imported base. This module
 * joins them once every file has been read, following the chain the way Nest
 * does at runtime (`MetadataScanner.getAllMethodNames`): from the controller
 * up, keeping the first declaration of each handler name.
 *
 * An import is followed only when it resolves to ONE file and that file
 * exports ONE class under the imported name, directly or through `export …
 * from` barrels. Anything else — a package outside the repository, a namespace
 * import, two candidates — ends the chain: the routes above it stay missing,
 * which is recoverable, where routes taken from the wrong class are not.
 *
 * An inherited route belongs to the CONTROLLER's file, not to the file that
 * declares the handler. An incremental write replaces the rows of the files
 * that changed and of the files that import them; the controller imports its
 * base class, so its rows are rewritten when either file changes. Rows hung on
 * the base file would outlive a controller that stops extending it. The handler
 * is still the base method: `handlerFilePath` tells the name lookup which file
 * declares it.
 */

import type { ExtractedDecoratorRoute } from '../workers/parse-worker.js';
import { normalizeExtractedRoutePath } from './route-path.js';

/** The class a declaration extends: one of the same file, or an imported one. */
export type NestBaseRef =
  | { readonly local: string }
  | { readonly source: string; readonly name: string };

/** A route a class declares on an instance method, before any controller prefix. */
export interface NestInheritableRoute {
  readonly handlerName: string;
  readonly httpMethod: string;
  readonly decoratorName: string;
  readonly routePath: string;
}

/** A top-level class that declares routes or extends another class. */
export interface NestClassFacts {
  readonly name: string;
  /** Names the module exports it under; `default` for a default export. */
  readonly exportedAs: readonly string[];
  readonly base?: NestBaseRef;
  /**
   * Method and accessor names on its prototype, which hide a base handler of
   * the same name. `null` when a computed key makes the list unknowable.
   */
  readonly names: readonly string[] | null;
  readonly routes: readonly NestInheritableRoute[];
}

/** A controller whose chain of same-file base classes ends at an import. */
export interface NestOpenController {
  readonly prefix: string;
  /** Line of the class name, 1-based. */
  readonly lineNumber: number;
  /** Names declared by the controller and the same-file classes already walked. */
  readonly redeclared: readonly string[];
  /** `METHOD /url` of the routes its own file already emits for it. */
  readonly claimed: readonly string[];
  readonly base: { readonly source: string; readonly name: string };
}

/** What one file contributes. Plain data: it crosses the worker and cache boundary. */
export interface NestInheritanceFacts {
  readonly classes: readonly NestClassFacts[];
  readonly controllers: readonly NestOpenController[];
  /** `export { imported as name } from 'source'`. */
  readonly reexports: readonly {
    readonly name: string;
    readonly source: string;
    readonly imported: string;
  }[];
  /** Sources of `export * from 'source'`. */
  readonly starExports: readonly string[];
}

interface ResolvedClass {
  readonly filePath: string;
  readonly facts: NestClassFacts;
}

export function resolveNestInheritedRoutes(
  files: readonly { readonly filePath: string; readonly facts: NestInheritanceFacts }[],
  resolveImportTargets: (fromFile: string, moduleSpecifier: string) => readonly string[],
): ExtractedDecoratorRoute[] {
  const byFile = new Map(files.map((file) => [file.filePath, file.facts]));

  const targetOf = (fromFile: string, source: string): string | undefined => {
    const targets = resolveImportTargets(fromFile, source);
    return targets.length === 1 ? targets[0] : undefined;
  };

  /**
   * The class `filePath` exports under `name`. `undefined` when it exports
   * none; `null` when two different classes could be the one, which makes the
   * name unusable rather than a coin toss.
   */
  const exportedClass = (
    filePath: string,
    name: string,
    seen: Set<string>,
  ): ResolvedClass | null | undefined => {
    const key = `${filePath}\0${name}`;
    // Barrels can re-export each other; each is asked for a name once.
    if (seen.has(key)) return undefined;
    seen.add(key);
    const facts = byFile.get(filePath);
    if (!facts) return undefined;

    const declared = facts.classes.filter((cls) => cls.exportedAs.includes(name));
    if (declared.length > 1) return null;
    if (declared.length === 1) return { filePath, facts: declared[0] };

    const named = facts.reexports.filter((reexport) => reexport.name === name);
    if (named.length > 1) return null;
    if (named.length === 1) {
      const target = targetOf(filePath, named[0].source);
      return target === undefined ? undefined : exportedClass(target, named[0].imported, seen);
    }

    // `export *` forwards every name except `default`.
    if (name === 'default') return undefined;
    let found: ResolvedClass | undefined;
    for (const source of facts.starExports) {
      const target = targetOf(filePath, source);
      if (target === undefined) continue;
      const hit = exportedClass(target, name, seen);
      if (hit === null) return null;
      if (hit === undefined) continue;
      if (found !== undefined && found.facts !== hit.facts) return null;
      found = hit;
    }
    return found;
  };

  // Many controllers import the same base through the same barrel.
  const exportedClasses = new Map<string, ResolvedClass | undefined>();
  const follow = (filePath: string, ref: NestBaseRef | undefined): ResolvedClass | undefined => {
    if (ref === undefined) return undefined;
    if ('local' in ref) {
      const facts = byFile.get(filePath)?.classes.find((cls) => cls.name === ref.local);
      return facts ? { filePath, facts } : undefined;
    }
    const target = targetOf(filePath, ref.source);
    if (target === undefined) return undefined;
    const key = `${target}\0${ref.name}`;
    if (!exportedClasses.has(key)) {
      exportedClasses.set(key, exportedClass(target, ref.name, new Set()) ?? undefined);
    }
    return exportedClasses.get(key);
  };

  const routes = new Map<string, ExtractedDecoratorRoute & { readonly url: string }>();
  for (const { filePath, facts } of files) {
    for (const controller of facts.controllers) {
      const prefix = controller.prefix === '' ? null : controller.prefix;
      const redeclared = new Set(controller.redeclared);
      // Nest registers a controller's handlers from the controller up, and the
      // first handler registered for a verb and URL is the one that answers.
      const claimed = new Set(controller.claimed);
      const walked = new Set<NestClassFacts>();

      let base = follow(filePath, controller.base);
      while (base !== undefined && !walked.has(base.facts)) {
        walked.add(base.facts);
        for (const route of base.facts.routes) {
          if (redeclared.has(route.handlerName)) continue;
          const url = normalizeExtractedRoutePath(route.routePath, prefix);
          const claim = `${route.httpMethod} ${url}`;
          if (claimed.has(claim)) continue;
          claimed.add(claim);
          routes.set(`${filePath}\0${controller.lineNumber}\0${claim}`, {
            filePath,
            routePath: route.routePath,
            httpMethod: route.httpMethod,
            decoratorName: route.decoratorName,
            lineNumber: controller.lineNumber,
            prefix,
            handlerName: route.handlerName,
            handlerFilePath: base.filePath,
            url,
          });
        }
        if (base.facts.names === null) break;
        for (const name of base.facts.names) redeclared.add(name);
        base = follow(base.filePath, base.facts.base);
      }
    }
  }

  // Fact order follows worker scheduling; the output must not.
  return [...routes.values()]
    .sort(
      (left, right) =>
        left.filePath.localeCompare(right.filePath) ||
        left.lineNumber - right.lineNumber ||
        left.url.localeCompare(right.url) ||
        left.httpMethod.localeCompare(right.httpMethod),
    )
    .map(({ url: _url, ...route }) => route);
}
