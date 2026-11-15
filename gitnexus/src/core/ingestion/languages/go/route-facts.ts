import type Parser from 'tree-sitter';
import type { ParsedFile } from 'gitnexus-shared';
import { compareCodeUnits } from '../../../../lib/utils.js';
import { logger } from '../../../logger.js';
import type { LanguageProvider } from '../../language-provider.js';
import {
  collectGoRouteFacts,
  goRouteFramework,
  materializeGoRoute,
  type GoRouteCandidateFacts,
} from '../../route-extractors/go-gin-echo.js';
import type { ExtractedDecoratorRoute } from '../../workers/parse-worker.js';

/**
 * Direct framework routes and registrations on a wrapper package's router
 * (`func Init(s *core.Engine)`, where `core.Engine = gin.Engine` in a
 * dependency the indexer cannot read).
 *
 * The worker records every such registration as a configuration-free
 * candidate (`collectGoRouteFacts`), so the parse cache never depends on
 * user config. Direct roots already identify their framework. Other roots
 * become routes only when declared in `goRouterAliases` on the main thread.
 */
export const extractGoRouteFacts = (
  tree: Parser.Tree,
  _parsedFile: ParsedFile,
  lineOffset: number,
): GoRouteCandidateFacts | undefined => collectGoRouteFacts(tree, lineOffset);

const isCandidateFacts = (facts: unknown): facts is GoRouteCandidateFacts =>
  typeof facts === 'object' &&
  facts !== null &&
  Array.isArray((facts as GoRouteCandidateFacts).roots);

/** Root types logged in the "not configured" summary. */
const SUMMARY_LIMIT = 5;

export const resolveGoRouteFacts: NonNullable<LanguageProvider['resolveRouteFacts']> = (
  files,
  context,
) => {
  const aliases = new Map<string, string>();
  for (const alias of context.routeHookConfig?.routeFrameworkAliases ?? []) {
    aliases.set(`${alias.importPath}\u0000${alias.type}`, alias.framework);
  }
  const out: ExtractedDecoratorRoute[] = [];
  const emittedByRoot = new Map<string, number>();
  const droppedByRoot = new Map<string, number>();
  let candidates = 0;
  for (const { filePath, facts } of files) {
    if (!isCandidateFacts(facts)) continue;
    for (const root of facts.roots) {
      const rootKey = `${root.importPath}.${root.typeName}`;
      const frameworkName =
        root.framework ?? aliases.get(`${root.importPath}\u0000${root.typeName}`);
      const framework = frameworkName && goRouteFramework(frameworkName);
      if (!root.framework) candidates += root.routes.length;
      if (!framework) {
        droppedByRoot.set(rootKey, (droppedByRoot.get(rootKey) ?? 0) + root.routes.length);
        continue;
      }
      if (!root.framework)
        emittedByRoot.set(rootKey, (emittedByRoot.get(rootKey) ?? 0) + root.routes.length);
      for (const candidate of root.routes) {
        out.push(materializeGoRoute(filePath, candidate, framework));
      }
    }
  }

  for (const [rootKey, count] of emittedByRoot) {
    logger.debug(
      { rootType: rootKey, routes: count },
      'go routes: emitted routes through a configured router alias',
    );
  }
  if (droppedByRoot.size > 0) {
    const top = [...droppedByRoot.entries()]
      .sort((a, b) => b[1] - a[1] || compareCodeUnits(a[0], b[0]))
      .slice(0, SUMMARY_LIMIT)
      .map(([rootType, dropped]) => ({ rootType, dropped }));
    logger.info(
      {
        candidates,
        emitted: [...emittedByRoot.values()].reduce((sum, count) => sum + count, 0),
        unconfiguredRootTypes: droppedByRoot.size,
        top,
      },
      'go routes: dropped verb registrations on unconfigured router types; if one is a ' +
        'gin/echo engine alias, declare it in goRouterAliases',
    );
  }
  return out;
};
