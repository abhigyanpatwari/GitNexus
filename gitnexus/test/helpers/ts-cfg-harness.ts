/**
 * Shared TS CFG/taint unit-test harness (#2083 review).
 *
 * Parses real TypeScript source through the worker-side CFG visitor and the
 * scope-capture import interpreter, so taint unit tests run against the exact
 * structures the pipeline feeds `computeReachingDefs` / `matchFunctionSites` /
 * `computeTaintFlows`, never hand-built mocks. Extracted from the byte-identical
 * copies that lived in model-match / propagate / taint-emit / harvest tests.
 *
 * The grammar-agnostic engine now lives in {@link makeCfgHarness} (#2195 U1);
 * this module is the thin TS binding that preserves the original exports.
 */
import TypeScript from 'tree-sitter-typescript';
import type { ParsedImport } from 'gitnexus-shared';
import { createTypeScriptCfgVisitor } from '../../src/core/ingestion/cfg/visitors/typescript.js';
import { emitTsScopeCaptures } from '../../src/core/ingestion/languages/typescript/captures.js';
import { interpretTsImport } from '../../src/core/ingestion/languages/typescript/interpret.js';
import { makeCfgHarness } from './cfg-harness.js';

const harness = makeCfgHarness(TypeScript.typescript, createTypeScriptCfgVisitor(), 'fixture.ts');

export const parse = harness.parse;
export const collectFunctions = harness.collectFunctions;
export const cfgOf = harness.cfgOf;
export const cfgsOf = harness.cfgsOf;

/** Real ParsedImports via the TS scope-capture + interpreter path. */
export function importsFor(src: string): ParsedImport[] {
  return emitTsScopeCaptures(src, 'fixture.ts')
    .filter((m) => m['@import.statement'] !== undefined)
    .map((m) => interpretTsImport(m))
    .filter((p): p is ParsedImport => p !== null);
}
