import type Parser from 'tree-sitter';
import type { ParsedFile } from 'gitnexus-shared';
import { compareCodeUnits } from '../../../../lib/utils.js';
import { logger } from '../../../logger.js';
import type { LanguageProvider } from '../../language-provider.js';
import {
  ECHO_ROUTE_SOURCE,
  extractGoRouteCandidates,
  GIN_ROUTE_SOURCE,
  type GoRouteCandidateFacts,
  type GoRouteHandlerFact,
} from '../../route-extractors/go-gin-echo.js';
import type { ExtractedDecoratorRoute } from '../../workers/parse-worker.js';

/**
 * Routes registered on a router whose type comes from a wrapper package
 * (`func Init(s *core.Engine)`, where `core.Engine = gin.Engine` in a
 * dependency the indexer cannot read).
 *
 * The worker records every such registration as a configuration-free
 * candidate (`extractGoRouteCandidates`), so the parse cache never depends on
 * user config. Here, on the main thread, a candidate becomes a gin/echo route
 * only when the user declared its root type in `goRouterAliases`; everything
 * else is dropped, exactly as before the candidates existed.
 */
export const extractGoRouteFacts = (
  tree: Parser.Tree,
  _parsedFile: ParsedFile,
  lineOffset: number,
): GoRouteCandidateFacts | undefined => extractGoRouteCandidates(tree, lineOffset);

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
  for (const alias of context.routeFrameworkAliases ?? []) {
    aliases.set(`${alias.importPath}.${alias.type}`, alias.framework);
  }
  const out: ExtractedDecoratorRoute[] = [];
  const emittedByRoot = new Map<string, number>();
  const droppedByRoot = new Map<string, number>();
  let candidates = 0;
  for (const { filePath, facts } of files) {
    if (!isCandidateFacts(facts)) continue;
    for (const root of facts.roots) {
      const rootKey = `${root.importPath}.${root.typeName}`;
      candidates += root.routes.length;
      const framework = aliases.get(rootKey);
      if (framework !== 'gin' && framework !== 'echo') {
        droppedByRoot.set(rootKey, (droppedByRoot.get(rootKey) ?? 0) + root.routes.length);
        continue;
      }
      emittedByRoot.set(rootKey, (emittedByRoot.get(rootKey) ?? 0) + root.routes.length);
      for (const candidate of root.routes) {
        const handler: GoRouteHandlerFact = framework === 'gin' ? candidate.gin : candidate.echo;
        out.push({
          filePath,
          routePath: candidate.routePath,
          httpMethod: candidate.httpMethod,
          decoratorName: candidate.httpMethod,
          lineNumber: candidate.lineNumber,
          prefix: null,
          source: framework === 'gin' ? GIN_ROUTE_SOURCE : ECHO_ROUTE_SOURCE,
          ...handler,
        });
      }
    }
  }

  for (const [rootKey, count] of emittedByRoot) {
    logger.debug(
      { rootType: rootKey, framework: aliases.get(rootKey), routes: count },
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
        emitted: out.length,
        unconfiguredRootTypes: droppedByRoot.size,
        top,
      },
      'go routes: dropped verb registrations on unconfigured router types; if one is a ' +
        'gin/echo engine alias, declare it in goRouterAliases',
    );
  }
  return out;
};
