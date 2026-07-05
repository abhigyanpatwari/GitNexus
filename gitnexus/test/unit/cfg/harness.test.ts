import { describe, it, expect } from 'vitest';
import TypeScript from 'tree-sitter-typescript';
import { createTypeScriptCfgVisitor } from '../../../src/core/ingestion/cfg/visitors/typescript.js';
import type { CfgVisitor, FunctionCfg } from '../../../src/core/ingestion/cfg/types.js';
import type { SyntaxNode } from '../../../src/core/ingestion/utils/ast-helpers.js';
import { makeCfgHarness } from '../../helpers/cfg-harness.js';
import { cfgOf as tsBoundCfgOf } from '../../helpers/ts-cfg-harness.js';

describe('makeCfgHarness — language-parameterized CFG harness (#2195 U1)', () => {
  it('reproduces the TS-bound harness CFG when driven with the TS grammar+visitor', () => {
    const code = 'function f(x: number) { if (x > 0) { a(); } else { b(); } return x; }';
    const generic = makeCfgHarness(
      TypeScript.typescript,
      createTypeScriptCfgVisitor(),
      'fixture.ts',
    ).cfgOf(code);
    // The thin TS binding (ts-cfg-harness) must be a pure delegate of the
    // generalized engine: same grammar + visitor + filePath ⇒ identical CFG.
    expect(generic).toEqual(tsBoundCfgOf(code));
  });

  it('delegates function discovery to visitor.isFunction (no hardcoded TS node set)', () => {
    // Stub visitor: recognizes ONLY arrow_function and emits a sentinel 1-block
    // CFG. If the harness carried TS-specific function detection it would
    // over-collect (function_declaration, method_definition, …); delegating to
    // isFunction means it finds exactly the arrows — proving zero TS coupling.
    const built: string[] = [];
    const stub: CfgVisitor<SyntaxNode> = {
      isFunction: (n) => n.type === 'arrow_function',
      buildFunctionCfg: (fn, filePath): FunctionCfg => {
        built.push(fn.type);
        return {
          filePath,
          functionStartLine: fn.startPosition.row + 1,
          functionEndLine: fn.endPosition.row + 1,
          functionStartColumn: fn.startPosition.column,
          entryIndex: 0,
          exitIndex: 1,
          blocks: [
            { index: 0, startLine: 1, endLine: 1, text: '', kind: 'entry' },
            { index: 1, startLine: 1, endLine: 1, text: '', kind: 'exit' },
          ],
          edges: [{ from: 0, to: 1, kind: 'seq' }],
        };
      },
    };
    const code = [
      'function fd() { return 1; }',
      'const a = () => 2;',
      'const b = (x) => x + 1;',
    ].join('\n');
    const cfgs = makeCfgHarness(TypeScript.typescript, stub, 'stub.ts').cfgsOf(code);
    expect(cfgs).toHaveLength(2); // the two arrows; the function_declaration is ignored
    expect(built).toEqual(['arrow_function', 'arrow_function']);
  });
});
