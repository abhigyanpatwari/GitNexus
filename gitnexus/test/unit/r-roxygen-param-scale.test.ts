/**
 * `extractParameter` runs once per formal and reads the roxygen block above the function each time.
 * The block is read once per function now: 2,000 formals under 2,000 `@param` lines took 11.9 s
 * (formals x lines); the bound below is generous for the linear cost, which is well under a second.
 */
import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import R from '@eagleoutice/tree-sitter-r';
import { SupportedLanguages } from 'gitnexus-shared';
import { buildTypeEnv } from '../../src/core/ingestion/type-env.js';

const parser = new Parser();
parser.setLanguage(R as Parameters<Parser['setLanguage']>[0]);

describe('roxygen @param types of a function with many formals and many doc lines', () => {
  it('binds every documented formal, in time linear in formals + lines', () => {
    const count = 2_000;
    const params = Array.from({ length: count }, (_, i) => `p${String(i)}`);
    const source = [
      'Circle <- R6::R6Class("Circle", public = list(area = function() 1))',
      ...params.map((p) => `#' @param ${p} Circle`),
      `fn <- function(${params.join(', ')}) 1`,
    ].join('\n');
    const tree = parser.parse(source, undefined, { bufferSize: 1 << 24 });

    const start = performance.now();
    const env = buildTypeEnv(tree, SupportedLanguages.R);
    const elapsed = performance.now() - start;

    let bound = 0;
    for (const [, scope] of env.allScopes()) {
      for (const type of scope.values()) if (type === 'Circle') bound++;
    }
    expect(bound).toBe(count);
    // The quadratic version took 11.9 s here; the linear one a few hundred milliseconds.
    expect(elapsed).toBeLessThan(4_000);
  }, 60_000);

  it('keeps each function its own block: the cache is per assignment', () => {
    const tree = parser.parse(
      [
        'A <- R6::R6Class("A", public = list(m = function() 1))',
        'B <- R6::R6Class("B", public = list(m = function() 1))',
        "#' @param x A",
        'f <- function(x) x',
        "#' @param x B",
        'g <- function(x) x',
      ].join('\n'),
      undefined,
      { bufferSize: 1 << 24 },
    );
    const env = buildTypeEnv(tree, SupportedLanguages.R);
    const types: string[] = [];
    for (const [, scope] of env.allScopes()) {
      const type = scope.get('x');
      if (type !== undefined) types.push(type);
    }
    expect(types.sort()).toEqual(['A', 'B']);
  });
});
