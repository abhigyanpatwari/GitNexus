/**
 * R gives scope resolution no export verdict. `SymbolDefinition.isExported` is tri-state and
 * `undefined` means "unknown" (finalization then keeps its prior behaviour); R's export checker
 * says "public" for every graph node and the NAMESPACE refinement later flips graph nodes to
 * private, but neither writes a verdict onto a scope definition. That is deliberate: a
 * `library()` of a local package makes every top-level name visible, as `devtools::load_all()`
 * does (docs/languages/r-provider.md, Resolution model), so resolution must not treat a name
 * NAMESPACE omits as module-private. A verdict of `false` would make finalization drop it from
 * wildcard providers.
 */
import { describe, expect, it } from 'vitest';
import { extractParsedFile } from '../../../../src/core/ingestion/scope-extractor-bridge.js';
import { rProvider } from '../../../../src/core/ingestion/languages/r.js';

describe('R scope definitions carry no export verdict', () => {
  const parsed = extractParsedFile(
    rProvider,
    [
      'exported_fn <- function() 1',
      'Widget <- R6Class("Widget", public = list(size = 1, grow = function() 1))',
      'setClass("Point", representation(x = "numeric"))',
      'setGeneric("area", function(shape) standardGeneric("area"))',
    ].join('\n'),
    'R/a.R',
  );

  it('extracts functions, classes and members (positive control)', () => {
    const types = new Set(parsed?.localDefs.map((d) => d.type));
    expect(types.has('Function')).toBe(true);
    expect(types.has('Class')).toBe(true);
    expect(types.has('Method')).toBe(true);
  });

  it('leaves isExported unset on every definition', () => {
    expect(parsed?.localDefs.length).toBeGreaterThan(0);
    for (const def of parsed?.localDefs ?? []) {
      expect(def.isExported, `${def.type} ${def.qualifiedName}`).toBeUndefined();
    }
  });
});
