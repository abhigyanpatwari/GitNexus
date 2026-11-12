/**
 * Characterisation of the R import and name-lookup helpers over names written WITHOUT backticks.
 *
 * `rFileTopLevel`, `resolveRNamedImport`, `populateRNamespaceImports`, the global-name-fallback
 * veto, `expandRWildcardNames` and `populateRQualifiedCalls` all compare a NAMESPACE symbol or a
 * call site's name with a definition's binding key. Reading backtick-quoted names through them
 * (`rBareName`) must not change a single answer for the common case, so the whole observable
 * output over a set of unbackticked layouts is pinned here. The snapshot was recorded before the
 * backtick change and has not been edited since.
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
  rRecordedPackageTopLevelNames,
} from '../../../../src/core/ingestion/languages/r/namespace-imports.js';
import {
  populateRQualifiedCalls,
  resolveRQualifiedFreeCall,
} from '../../../../src/core/ingestion/languages/r/qualified-call.js';
import { expandRWildcardNames } from '../../../../src/core/ingestion/languages/r/scope-resolver.js';
import { resolveRNamedImport } from '../../../../src/core/ingestion/languages/r/import-target.js';

function parse(src: string, filePath: string): ParsedFile {
  const parsed = extractParsedFile(rProvider, src, filePath);
  if (parsed === undefined) throw new Error(`no ParsedFile for ${filePath}`);
  populateClassOwnedMembers(parsed);
  return parsed;
}

const sorted = (values: Iterable<string>): string[] => [...values].sort();

const SOURCES: Record<string, string> = {
  'corelib/R/a.R': [
    'helper <- function(x) x',
    'filter <- function(x) x',
    'print.tidy <- function(x) x',
    'tidy <- function(x) x',
    'shared <- function() 1',
    'make <- function() { inner <- function() 1; inner() }',
    'Stack <- R6::R6Class("Stack", public = list(push = function(v) v))',
  ].join('\n'),
  'corelib/R/b.R': ['shared <- function() 2', 'only_b <- function() 3', 'dup <- 1'].join('\n'),
  'analytics/R/use.R': [
    'run_all <- function() { helper(1); filter(2); tidy(3); shared(); only_b(); corelib::helper(4) }',
    'own_filter <- function() 1',
  ].join('\n'),
  'analytics/R/own.R': 'filter <- function(x) x\nhidden <- function() 1',
  'decoy/R/d.R': 'helper <- function(x) x\nshared <- function() 9',
};

const NAMESPACES: Record<string, RNamespaceInfo> = {
  corelib: {
    hasNamespaceFile: true,
    namedExports: new Set(['helper', 'tidy', 'shared', 'only_b', 'Stack']),
    exportPatterns: [],
    importFrom: [],
  },
  analytics: {
    hasNamespaceFile: true,
    namedExports: new Set(),
    exportPatterns: [],
    importFrom: [
      { pkg: 'corelib', name: 'helper' },
      { pkg: 'corelib', name: 'filter' },
      { pkg: 'corelib', name: 'tidy' },
      { pkg: 'corelib', name: 'shared' },
      { pkg: 'corelib', name: 'only_b' },
      { pkg: 'corelib', name: 'print.tidy' },
      { pkg: 'corelib', name: 'missing_fn' },
      { pkg: 'corelib', name: 'dup' },
      { pkg: 'corelib', name: 'Stack' },
      { pkg: 'dplyr', name: 'mutate' },
      { pkg: 'decoy', name: 'helper' },
    ],
  },
};

function config(): RPackageConfig {
  return {
    packages: new Map([
      ['corelib', 'corelib'],
      ['analytics', 'analytics'],
      ['decoy', 'decoy'],
    ]),
    namespaceInfoByPackageDir: new Map(Object.entries(NAMESPACES)),
  };
}

function namedImports(parsed: ParsedFile): string[] {
  return parsed.parsedImports
    .filter((i): i is Extract<ParsedImport, { kind: 'named' }> => i.kind === 'named')
    .map((i) => JSON.stringify([i.localName, i.importedName, i.targetRaw]));
}

describe('unbackticked R import and name lookups (characterisation)', () => {
  it('answers exactly as before the backtick change', () => {
    const cfg = config();
    const files = Object.entries(SOURCES).map(([path, src]) => parse(src, path));

    const topLevel = Object.fromEntries(
      files.map((f) => {
        const t = rFileTopLevel(f);
        return [f.filePath, { names: sorted(t.names), dottedTails: sorted(t.dottedTails) }];
      }),
    );

    const resolve = (pkg: string, name: string) =>
      resolveRNamedImport(cfg, pkg, name, files)?.slice() ?? null;
    const named: Record<string, string[] | null> = {};
    for (const pkg of ['corelib', 'decoy', 'dplyr', '"corelib"']) {
      for (const name of [
        'helper',
        'filter',
        'tidy',
        'print.tidy',
        'shared',
        'only_b',
        'dup',
        'Stack',
        'missing_fn',
        'hidden',
      ]) {
        named[`${pkg}::${name}`] = resolve(pkg, name);
      }
    }

    populateRNamespaceImports(files, { resolutionConfig: cfg });
    const imports = Object.fromEntries(files.map((f) => [f.filePath, namedImports(f)]));
    const recorded = Object.fromEntries(
      [...(rRecordedPackageTopLevelNames(cfg) ?? [])].map(([pkg, names]) => [pkg, sorted(names)]),
    );

    const veto: Record<string, boolean> = {};
    for (const name of ['helper', 'filter', 'tidy', 'shared', 'mutate', 'print.tidy', 'nothing']) {
      for (const candidate of ['corelib/R/a.R', 'decoy/R/d.R', 'analytics/R/own.R']) {
        for (const rawQualifiedName of [undefined, 'corelib::' + name, 'decoy::' + name]) {
          veto[`${name}|${candidate}|${rawQualifiedName ?? '-'}`] = isRGlobalNameFallbackPlausible({
            callerParsed: { filePath: 'analytics/R/use.R' },
            candidate: { filePath: candidate },
            resolutionConfig: cfg,
            site: { name, rawQualifiedName },
          });
        }
      }
    }

    const wildcard = Object.fromEntries(
      files.map((f) => [f.filePath, expandRWildcardNames(f.moduleScope, files).slice()]),
    );

    const qualified = files.map((f) => f);
    let line = 0;
    const callFor = (name: string, rawQualifiedName: string): ReferenceSite =>
      ({
        kind: 'call',
        name,
        rawQualifiedName,
        atRange: { startLine: ++line, startCol: 0, endLine: line, endCol: 10 },
      }) as unknown as ReferenceSite;
    const caller = parse('x <- 1', 'scripts/q.R');
    const sites = [
      callFor('helper', 'corelib::helper'),
      callFor('shared', 'corelib::shared'),
      callFor('tidy', 'corelib::tidy'),
      callFor('mutate', 'dplyr::mutate'),
      callFor('nothing', 'corelib::nothing'),
    ];
    qualified.push({ ...caller, referenceSites: sites } as ParsedFile);
    populateRQualifiedCalls(qualified, { resolutionConfig: cfg });
    const last = qualified[qualified.length - 1];
    const qualifiedOut = {
      kept: last.referenceSites.map((s) => s.name),
      precise: sites.map((s) => resolveRQualifiedFreeCall(s, last)?.filePath ?? null),
    };

    expect({ topLevel, named, imports, recorded, veto, wildcard, qualifiedOut }).toMatchSnapshot();
  });
});
