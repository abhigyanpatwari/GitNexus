/**
 * Shared pure-path taint harness over the pdg-repo fixture (#2083 M3 U7).
 *
 * Runs the SAME per-function pipeline the in-phase emit driver runs —
 * collect CFGs → site-safety gate → match → zero-match fast path →
 * `computeReachingDefs` → `computeTaintFlows` — but build-free on the main
 * thread (parse via tree-sitter directly, like reaching-defs-snapshot).
 *
 * Two consumers, deliberately fed from ONE module so they cannot drift:
 *  - `taint-snapshot.test.ts` serializes the per-function results (AE1/AE3);
 *  - `pipeline-pdg.test.ts` sums findings/kills as the EXPECTED stored-row
 *    counts for the sparse-persistence gate (AE2): the real worker pipeline
 *    must persist exactly one TAINTED row per pure-path finding and one
 *    SANITIZES row per kill — O(findings), never a REACHING_DEF-style
 *    explosion.
 *
 * Limits mirror the run.ts derivation: findings/hops caps at their U5
 * defaults, `maxFacts` at the RD-edge-cap formula's default product
 * (`DEFAULT_PDG_MAX_REACHING_DEF_FACTS_PER_FUNCTION` — same number).
 */
import fs from 'fs';
import path from 'path';
import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import type { ParsedImport } from 'gitnexus-shared';
import { collectFunctionCfgs } from '../../src/core/ingestion/cfg/collect.js';
import { computeReachingDefs } from '../../src/core/ingestion/cfg/reaching-defs.js';
import { DEFAULT_PDG_MAX_REACHING_DEF_FACTS_PER_FUNCTION } from '../../src/core/ingestion/cfg/emit.js';
import { getProvider } from '../../src/core/ingestion/languages/index.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import { hasTaintSafeSites } from '../../src/core/ingestion/taint/site-safety.js';
import { buildTaintImportIndex, matchFunctionSites } from '../../src/core/ingestion/taint/match.js';
import { TS_JS_TAINT_MODEL } from '../../src/core/ingestion/taint/typescript-model.js';
import {
  computeTaintFlows,
  DEFAULT_PDG_MAX_TAINT_FINDINGS_PER_FUNCTION,
  DEFAULT_PDG_MAX_TAINT_HOPS,
  type FunctionTaintResult,
} from '../../src/core/ingestion/taint/propagate.js';
import type { FunctionCfg } from '../../src/core/ingestion/cfg/types.js';

/** The taint-bearing fixture files (sample.ts is the zero-match control). */
export const TAINT_FIXTURE_FILES = ['vuln.ts', 'taint-cases.ts', 'sample.ts'] as const;

/**
 * Hand-built `ParsedImport` lists matching each fixture file's import
 * statements (the build-free path has no extractor run). MUST stay in sync
 * with the fixture sources — the AE2 equality against the real pipeline
 * (which uses extracted `parsedImports`) breaks loudly if they drift.
 */
export const TAINT_FIXTURE_IMPORTS: Record<string, readonly ParsedImport[]> = {
  'vuln.ts': [
    { kind: 'named', localName: 'exec', importedName: 'exec', targetRaw: 'child_process' },
  ],
  'taint-cases.ts': [
    { kind: 'named', localName: 'exec', importedName: 'exec', targetRaw: 'child_process' },
  ],
  'sample.ts': [],
};

export interface FixtureFunctionTaint {
  readonly file: string;
  readonly startLine: number;
  readonly cfg: FunctionCfg;
  /**
   * `no-match`     — the zero-match fast path skipped the solver entirely;
   * `unsafe-sites` — `hasTaintSafeSites` rejected the harvest;
   * otherwise the `computeTaintFlows` status (`computed` / `coverage-gap`).
   */
  readonly status: 'no-match' | 'unsafe-sites' | FunctionTaintResult['status'];
  /** Present iff the solver ran (status `computed` or `coverage-gap`). */
  readonly flows?: FunctionTaintResult;
}

/** Run the pure taint path over one fixture file. Deterministic. */
export function computeFixtureFileTaint(
  fixtureDir: string,
  file: string,
): readonly FixtureFunctionTaint[] {
  const visitor = getProvider(SupportedLanguages.TypeScript).cfgVisitor;
  if (!visitor) throw new Error('no cfgVisitor for TypeScript');
  const source = fs.readFileSync(path.join(fixtureDir, file), 'utf8');
  const parser = new Parser();
  parser.setLanguage(TypeScript.typescript);
  const cfgs = collectFunctionCfgs(parser.parse(source).rootNode, visitor, file).cfgs;

  const imports = TAINT_FIXTURE_IMPORTS[file];
  if (imports === undefined) {
    throw new Error(`no FIXTURE_IMPORTS entry for ${file} — add it (see module doc)`);
  }
  const importIndex = buildTaintImportIndex(imports);

  return cfgs.map((cfg) => {
    const base = { file, startLine: cfg.functionStartLine, cfg };
    if (!hasTaintSafeSites(cfg)) return { ...base, status: 'unsafe-sites' as const };
    const matches = matchFunctionSites(cfg, TS_JS_TAINT_MODEL, importIndex);
    if (!matches.hasSource || !matches.hasSink) return { ...base, status: 'no-match' as const };
    const defUse = computeReachingDefs(cfg, {
      maxFacts: DEFAULT_PDG_MAX_REACHING_DEF_FACTS_PER_FUNCTION,
    });
    const flows = computeTaintFlows(cfg, defUse, matches, {
      maxFindingsPerFunction: DEFAULT_PDG_MAX_TAINT_FINDINGS_PER_FUNCTION,
      maxHops: DEFAULT_PDG_MAX_TAINT_HOPS,
    });
    return { ...base, status: flows.status, flows };
  });
}

/** Run the pure taint path over the whole fixture battery, in file order. */
export function computeFixtureTaint(fixtureDir: string): readonly FixtureFunctionTaint[] {
  return TAINT_FIXTURE_FILES.flatMap((f) => computeFixtureFileTaint(fixtureDir, f));
}

/** Pure-path totals — the AE2 expected stored-row counts. */
export function fixtureTaintTotals(fixtureDir: string): { findings: number; kills: number } {
  let findings = 0;
  let kills = 0;
  for (const fn of computeFixtureTaint(fixtureDir)) {
    findings += fn.flows?.findings.length ?? 0;
    kills += fn.flows?.kills.length ?? 0;
  }
  return { findings, kills };
}
