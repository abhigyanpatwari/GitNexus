/**
 * The R unique-name fallback veto refuses a candidate bound inside another function, and only that:
 * a top-level definition, a candidate it cannot inspect, and every non-function kind stay plausible.
 */
import { describe, expect, it } from 'vitest';
import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import { extractParsedFile } from '../../../../src/core/ingestion/scope-extractor-bridge.js';
import { rProvider } from '../../../../src/core/ingestion/languages/r.js';
import { isRGlobalNameFallbackPlausible } from '../../../../src/core/ingestion/languages/r/namespace-imports.js';

const SOURCE = [
  'make_counter <- function() {',
  '  inner_fn <- function() 2',
  '  Inner <- setRefClass("Inner", fields = list(a = "numeric"))',
  '  inner_fn',
  '}',
  'top_fn <- function() 1',
].join('\n');

const parsed = (): ParsedFile => {
  const file = extractParsedFile(rProvider, SOURCE, 'R/a.R');
  if (file === undefined) throw new Error('no ParsedFile');
  return file;
};

const defNamed = (file: ParsedFile, name: string): SymbolDefinition => {
  const def = file.localDefs.find((d) => d.qualifiedName?.split('.').pop() === name);
  if (def === undefined) throw new Error(`no def ${name}`);
  return def;
};

const verdict = (
  file: ParsedFile,
  candidate: Pick<SymbolDefinition, 'nodeId' | 'filePath' | 'type'>,
  withParse = true,
): boolean =>
  isRGlobalNameFallbackPlausible({
    callerParsed: { filePath: 'R/b.R' },
    candidate,
    parsedFileOf: withParse ? (p) => (p === file.filePath ? file : undefined) : undefined,
    site: { name: 'x' },
  });

describe('isRGlobalNameFallbackPlausible: closure-local candidates', () => {
  it('refuses a function bound inside another function', () => {
    const file = parsed();
    expect(verdict(file, defNamed(file, 'inner_fn'))).toBe(false);
    expect(verdict(file, defNamed(file, 'Inner'))).toBe(false);
  });

  it('keeps a top-level function', () => {
    const file = parsed();
    expect(verdict(file, defNamed(file, 'top_fn'))).toBe(true);
    expect(verdict(file, defNamed(file, 'make_counter'))).toBe(true);
  });

  it('does not judge a candidate the scope model does not hold (a graph node id)', () => {
    const file = parsed();
    expect(
      verdict(file, { nodeId: 'Function:R/a.R:inner_fn', filePath: 'R/a.R', type: 'Function' }),
    ).toBe(true);
  });

  it('cannot decide without the candidate parse, and allows', () => {
    const file = parsed();
    expect(verdict(file, defNamed(file, 'inner_fn'), false)).toBe(true);
    expect(
      isRGlobalNameFallbackPlausible({
        callerParsed: { filePath: 'R/b.R' },
        candidate: { filePath: 'R/a.R' },
        site: { name: 'x' },
      }),
    ).toBe(true);
  });
});
