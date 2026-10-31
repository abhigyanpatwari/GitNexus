/**
 * Control-flow graphs for PL/SQL are not built yet. The provider still
 * implements `collectSourceCfgs` so the PDG layer treats PL/SQL as a known
 * language that contributes no CFGs, rather than an unhandled one.
 */

import type { CollectedCfgs } from '../../cfg/collect.js';

export function collectPlSqlSourceCfgs(
  _sourceText: string,
  _filePath: string,
  _maxFunctionLines: number,
): CollectedCfgs {
  return { cfgs: [], skipped: { tooManyLines: 0, tooDeeplyNested: 0, buildError: 0 } };
}
