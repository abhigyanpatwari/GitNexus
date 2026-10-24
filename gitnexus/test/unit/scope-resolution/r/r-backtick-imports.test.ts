/**
 * Backtick-quoted names through the R import helpers. A definition keeps its backticks in the
 * Module scope (`` `%||%` ``), NAMESPACE entries and `importFrom()` carry the bare symbol (`%||%`),
 * and a call site spells the name as written. Each lookup that joins two of these has to compare
 * the symbol, and a synthesised import has to keep the definition's own spelling so the call site
 * and the target file's export both still match it.
 *
 * The unbackticked answers of the same helpers are pinned by `r-import-name-characterisation`.
 */
import { describe, expect, it } from 'vitest';
import type { ParsedFile, ParsedImport, ReferenceSite } from 'gitnexus-shared';
import { extractParsedFile } from '../../../../src/core/ingestion/scope-extractor-bridge.js';
import { rProvider } from '../../../../src/core/ingestion/languages/r.js';
import { populateClassOwnedMembers } from '../../../../src/core/ingestion/scope-resolution/scope/walkers.js';
import type {
  RNamespaceInfo,
  RPackageConfig,
} from '../../../../src/core/ingestion/languages/r/package-config.js';
import {
  isRGlobalNameFallbackPlausible,
  populateRNamespaceImports,
  rFileTopLevel,
} from '../../../../src/core/ingestion/languages/r/namespace-imports.js';
import {
  populateRQualifiedCalls,
  resolveRQualifiedFreeCall,
} from '../../../../src/core/ingestion/languages/r/qualified-call.js';
import { expandRWildcardNames } from '../../../../src/core/ingestion/languages/r/scope-resolver.js';
import {
  resolveRImportTarget,
  resolveRNamedImport,
} from '../../../../src/core/ingestion/languages/r/import-target.js';

function parse(src: string, filePath: string): ParsedFile {
  const parsed = extractParsedFile(rProvider, src, filePath);
  if (parsed === undefined) throw new Error(`no ParsedFile for ${filePath}`);
  populateClassOwnedMembers(parsed);
  return parsed;
}

function config(
  namespaces: Record<string, Partial<RNamespaceInfo>>,
  packages: Record<string, string> = { prov: 'prov', consumer: 'consumer', decoy: 'decoy' },
): RPackageConfig {
  const namespaceInfoByPackageDir = new Map<string, RNamespaceInfo>();
  for (const [name, spec] of Object.entries(namespaces)) {
    namespaceInfoByPackageDir.set(packages[name], {
      hasNamespaceFile: true,
      namedExports: new Set(),
      exportPatterns: [],
      importFrom: [],
      ...spec,
    });
  }
  return { packages: new Map(Object.entries(packages)), namespaceInfoByPackageDir };
}

const importsOf = (parsed: ParsedFile): string[] =>
  parsed.parsedImports
    .filter((i): i is Extract<ParsedImport, { kind: 'named' }> => i.kind === 'named')
    .map((i) => `${i.localName}<-${i.targetRaw}::${i.importedName}`);

describe('rFileTopLevel with backtick-quoted definitions', () => {
  const top = rFileTopLevel(
    parse(
      ['`%||%` <- function(a, b) a', 'plain <- function() 1', '`odd fn` <- function() 2'].join(
        '\n',
      ),
      'p/R/a.R',
    ),
  );

  it('lists a definition by its symbol, whichever way it is written', () => {
    expect([...top.names].sort()).toEqual(['%||%', 'odd fn', 'plain']);
  });

  it('lists the spellings of the names that differ from the symbol', () => {
    expect([...top.writtenAs].sort()).toEqual([
      ['%||%', ['`%||%`']],
      ['odd fn', ['`odd fn`']],
    ]);
  });
});

describe('resolveRNamedImport with backtick-quoted definitions', () => {
  const cfg = config({ prov: { namedExports: new Set(['%||%', 'odd fn']) } });
  const files = [
    parse('`%||%` <- function(a, b) a\n`odd fn` <- function() 1', 'prov/R/ops.R'),
    parse('hidden <- function() 1', 'prov/R/hidden.R'),
  ];

  it('finds the defining file from the NAMESPACE symbol and from the definition spelling', () => {
    expect([
      resolveRNamedImport(cfg, 'prov', '%||%', files),
      resolveRNamedImport(cfg, 'prov', '`%||%`', files),
      resolveRNamedImport(cfg, 'prov', 'odd fn', files),
    ]).toEqual([['prov/R/ops.R'], ['prov/R/ops.R'], ['prov/R/ops.R']]);
  });

  it('still refuses a name the NAMESPACE does not export', () => {
    expect(resolveRNamedImport(cfg, 'prov', 'hidden', files)).toBeNull();
  });

  it('serves a named import carrying the definition spelling through resolveRImportTarget', () => {
    const all = new Set(files.map((f) => f.filePath));
    const named: ParsedImport = {
      kind: 'named',
      localName: '`%||%`',
      importedName: '`%||%`',
      targetRaw: 'prov',
    };
    expect(
      resolveRImportTarget('prov', 'consumer/R/a.R', all, cfg, {
        parsedImport: named,
        parsedFiles: files,
      } as never),
    ).toEqual(['prov/R/ops.R']);
  });

  it('keeps the S3 tail guard exactly where finalize would collide', () => {
    // finalize keys `print.tidy` under "tidy" and a backticked `tidy` under "`tidy`", so only the
    // request spelled like the dotted tail is refused.
    const dotted = [parse('`tidy` <- function(x) x\nprint.tidy <- function(x) x', 'prov/R/t.R')];
    const cfgT = config({ prov: { namedExports: new Set(['tidy']) } });
    expect([
      resolveRNamedImport(cfgT, 'prov', '`tidy`', dotted),
      resolveRNamedImport(cfgT, 'prov', 'tidy', dotted),
    ]).toEqual([['prov/R/t.R'], null]);
  });
});

describe('populateRNamespaceImports with backtick-quoted definitions', () => {
  const caller = () => parse('run <- function() 1', 'consumer/R/use.R');

  it('synthesises the import with the spelling the definition and the call site use', () => {
    const files = [caller(), parse('`%||%` <- function(a, b) a', 'prov/R/ops.R')];
    populateRNamespaceImports(files, {
      resolutionConfig: config({
        consumer: { importFrom: [{ pkg: 'prov', name: '%||%' }] },
        prov: { namedExports: new Set(['%||%']) },
      }),
    });
    expect(importsOf(files[0])).toEqual(['`%||%`<-prov::`%||%`']);
  });

  it('adds one import per spelling when the provider writes the name two ways', () => {
    const files = [
      caller(),
      parse('f <- function() 1', 'prov/R/a.R'),
      parse('`f` <- function() 2', 'prov/R/b.R'),
    ];
    populateRNamespaceImports(files, {
      resolutionConfig: config({ consumer: { importFrom: [{ pkg: 'prov', name: 'f' }] } }),
    });
    expect(importsOf(files[0]).sort()).toEqual(['`f`<-prov::`f`', 'f<-prov::f']);
  });

  it('lets a backtick-defined top-level function of the caller package mask its import', () => {
    const files = [
      caller(),
      parse('`op` <- function() 0', 'consumer/R/own.R'),
      parse('`op` <- function() 1', 'prov/R/ops.R'),
    ];
    populateRNamespaceImports(files, {
      resolutionConfig: config({ consumer: { importFrom: [{ pkg: 'prov', name: 'op' }] } }),
    });
    expect(files.map(importsOf)).toEqual([[], [], []]);
  });
});

describe('isRGlobalNameFallbackPlausible with backtick-quoted names', () => {
  const verdict = (siteName: string, candidate: string, rawQualifiedName?: string) => {
    const cfg = config({
      consumer: { importFrom: [{ pkg: 'prov', name: '%||%' }] },
      prov: {},
    });
    const files = [
      parse('run <- function() 1', 'consumer/R/use.R'),
      parse('`%||%` <- function(a, b) a', 'prov/R/ops.R'),
      parse('`%||%` <- function(a, b) b', 'decoy/R/ops.R'),
    ];
    populateRNamespaceImports(files, { resolutionConfig: cfg });
    return isRGlobalNameFallbackPlausible({
      callerParsed: { filePath: 'consumer/R/use.R' },
      candidate: { filePath: candidate },
      resolutionConfig: cfg,
      site: { name: siteName, rawQualifiedName },
    });
  };

  it('vetoes a guess in another package for a backticked call the NAMESPACE imports from prov', () => {
    expect(verdict('`%||%`', 'decoy/R/ops.R')).toBe(false);
  });

  it('allows the guess inside the providing package', () => {
    expect(verdict('`%||%`', 'prov/R/ops.R')).toBe(true);
  });

  it('judges a qualified call by the provider defining the symbol, however the call spells it', () => {
    expect(verdict('`%||%`', 'decoy/R/ops.R', 'prov::`%||%`')).toBe(false);
  });
});

describe('expandRWildcardNames with backtick-quoted definitions', () => {
  it('returns the definition spelling, which is the name the importing scope binds', () => {
    const target = parse(
      '`%||%` <- function(a, b) a\nplain <- function() 1\nnested <- function() { `inner` <- function() 2 }',
      'prov/R/ops.R',
    );
    expect([...expandRWildcardNames(target.moduleScope, [target])].sort()).toEqual([
      '`%||%`',
      'nested',
      'plain',
    ]);
  });
});

describe('populateRQualifiedCalls with backtick-quoted definitions', () => {
  const run = (defSrc: string, callName: string) => {
    // prov exports f: a private name is not reachable through `::` from a script.
    const cfg = config({ prov: { namedExports: new Set(['f']) } });
    const site = {
      kind: 'call',
      name: callName,
      rawQualifiedName: 'prov::f',
      atRange: { startLine: 1, startCol: 0, endLine: 1, endCol: 8 },
    } as unknown as ReferenceSite;
    const files = [
      parse(defSrc, 'prov/R/a.R'),
      { ...parse('x <- 1', 'scripts/q.R'), referenceSites: [site] } as ParsedFile,
    ];
    populateRQualifiedCalls(files, { resolutionConfig: cfg });
    return {
      kept: files[1].referenceSites.length,
      precise: resolveRQualifiedFreeCall(site, files[1])?.filePath ?? null,
    };
  };

  it('attributes a call written without backticks to a definition written with them', () => {
    expect(run('`f` <- function() 1', 'f')).toEqual({ kept: 1, precise: 'prov/R/a.R' });
  });

  it('attributes a call written with backticks to a definition written without them', () => {
    expect(run('f <- function() 1', '`f`')).toEqual({ kept: 1, precise: 'prov/R/a.R' });
  });

  it('drops the call when the package defines the symbol twice, once with backticks', () => {
    expect(run('f <- function() 1\n`f` <- function() 2', 'f')).toEqual({
      kept: 0,
      precise: null,
    });
  });
});
