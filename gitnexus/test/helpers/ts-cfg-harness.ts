/**
 * Shared TS CFG/taint unit-test harness (#2083 review).
 *
 * Parses real TypeScript source through the worker-side CFG visitor and the
 * scope-capture import interpreter, so taint unit tests run against the exact
 * structures the pipeline feeds `computeReachingDefs` / `matchFunctionSites` /
 * `computeTaintFlows`, never hand-built mocks. Extracted from the byte-identical
 * copies that lived in model-match / propagate / taint-emit / harvest tests.
 */

import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import type { ParsedImport } from 'gitnexus-shared';
import type { SyntaxNode } from '../../src/core/ingestion/utils/ast-helpers.js';
import {
  createTypeScriptCfgVisitor,
  TS_FUNCTION_TYPES,
} from '../../src/core/ingestion/cfg/visitors/typescript.js';
import type { FunctionCfg } from '../../src/core/ingestion/cfg/types.js';
import { emitTsScopeCaptures } from '../../src/core/ingestion/languages/typescript/captures.js';
import { interpretTsImport } from '../../src/core/ingestion/languages/typescript/interpret.js';

const visitor = createTypeScriptCfgVisitor();

export function parse(code: string): SyntaxNode {
  const parser = new Parser();
  parser.setLanguage(TypeScript.typescript);
  return parser.parse(code).rootNode;
}

export function collectFunctions(root: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  const stack = [root];
  while (stack.length) {
    const n = stack.pop() as SyntaxNode;
    if (TS_FUNCTION_TYPES.has(n.type)) out.push(n);
    for (let i = n.namedChildCount - 1; i >= 0; i--) {
      const c = n.namedChild(i);
      if (c) stack.push(c);
    }
  }
  return out;
}

/** The CFG of the function at `index` (default 0). */
export function cfgOf(code: string, index = 0): FunctionCfg {
  const fns = collectFunctions(parse(code));
  const fn = fns[index];
  if (!fn) throw new Error(`no function at index ${index}`);
  const cfg = visitor.buildFunctionCfg(fn, 'fixture.ts');
  if (!cfg) throw new Error('buildFunctionCfg returned undefined');
  return cfg;
}

/** Every function's CFG, in source order. */
export function cfgsOf(code: string): FunctionCfg[] {
  return collectFunctions(parse(code))
    .map((fn) => visitor.buildFunctionCfg(fn, 'fixture.ts'))
    .filter((c): c is FunctionCfg => c !== undefined);
}

/** Real ParsedImports via the TS scope-capture + interpreter path. */
export function importsFor(src: string): ParsedImport[] {
  return emitTsScopeCaptures(src, 'fixture.ts')
    .filter((m) => m['@import.statement'] !== undefined)
    .map((m) => interpretTsImport(m))
    .filter((p): p is ParsedImport => p !== null);
}
