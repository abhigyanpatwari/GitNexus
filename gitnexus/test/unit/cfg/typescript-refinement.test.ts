import { describe, expect, it } from 'vitest';
import { cfgOf, parse } from '../../helpers/ts-cfg-harness.js';
import {
  createRefinementFileContext,
  readPredicate,
  readValueExpression,
} from '../../../src/core/ingestion/cfg/visitors/typescript-refinement.js';
import type { SyntaxNode } from '../../../src/core/ingestion/utils/ast-helpers.js';

import { collectFunctionCfgs } from '../../../src/core/ingestion/cfg/collect.js';
import { createTypeScriptCfgVisitor } from '../../../src/core/ingestion/cfg/visitors/typescript.js';
import { createFunctionRefinement } from '../../../src/core/ingestion/taint/guard-refinement.js';
import {
  applyValueEffect,
  provesInertCommand,
  UNKNOWN_VALUE,
} from '../../../src/core/ingestion/taint/value-refinement.js';

function find(root: SyntaxNode, type: string): SyntaxNode {
  if (root.type === type) return root;
  for (const child of root.namedChildren) {
    try {
      return find(child, type);
    } catch {
      /* next subtree */
    }
  }
  throw new Error(`No ${type}`);
}

function predicate(source: string) {
  const root = parse(source);
  return readPredicate(
    find(root, 'if_statement').childForFieldName('condition')!,
    () => 0,
    createRefinementFileContext(root),
  );
}

describe('normalized predicate and expression facts', () => {
  it.each(['"prefix\narguments"', '/prefix\narguments/'])(
    'preserves error-recovery uses and conservative fallback inside %s',
    (literal) => {
      const cfg = cfgOf(`function f(x) { const value = ${literal}; consume(x, value); }`);
      const recovered = cfg.bindings!.findIndex((binding) => binding.name === 'arguments');
      expect(recovered).toBeGreaterThanOrEqual(0);
      expect(
        cfg.blocks.flatMap((block) => (block.statements ?? []).flatMap((s) => s.uses)),
      ).toContain(recovered);
      expect(cfg.refinementSafe).toBe(false);
      expect(createFunctionRefinement(cfg).guards.status).toBe('fallback');
    },
  );

  it.each([
    '{command}',
    '{9: command}',
    '[command]',
    '[, command]',
    '...command',
    '{command = fallback()}',
    '{nested: {command}}',
  ])('keeps non-identity formal bindings conservative: %s', (pattern) => {
    const cfg = cfgOf(`function f(${pattern}: any) { consume(command); }`);
    expect(cfg.refinementSafe).toBe(false);
    expect(createFunctionRefinement(cfg).guards.status).toBe('fallback');
  });

  it('preserves guard and value identity through embedded coordinate mappings', () => {
    const root = parse(`const SHA_RE = /^[0-9a-f]{7,40}$/;
function f(ref: string) {
  if (!SHA_RE.test(ref)) return;
  consume('git show ' + ref);
}`);
    for (const mapLine of [undefined, (row: number) => row + 12]) {
      const { cfgs } = collectFunctionCfgs(
        root,
        createTypeScriptCfgVisitor(),
        'Component.vue',
        0,
        12,
        mapLine,
      );
      expect(cfgs).toHaveLength(1);
      const cfg = cfgs[0];
      expect(cfg.functionStartLine).toBe(14);
      const refinement = createFunctionRefinement(cfg);
      const values = cfg.blocks.flatMap((block) =>
        (block.statements ?? []).flatMap((statement, index) =>
          (statement.sites ?? []).flatMap((site, siteIndex) =>
            site.callee === 'consume'
              ? [
                  applyValueEffect(
                    refinement.argument(block.index, index, siteIndex, 0),
                    UNKNOWN_VALUE,
                  ),
                ]
              : [],
          ),
        ),
      );
      expect(values).toHaveLength(1);
      expect(provesInertCommand(values[0], ['git show '])).toBe(true);
    }
  });

  it('resolves the immutable module validator and its accepted polarity', () => {
    const fact = predicate(
      'const SHA_RE = /^[0-9a-f]{7,40}$/; function f(ref: string) { if (!SHA_RE.test(ref)) return; }',
    );
    expect(fact).toMatchObject({ subject: 0, accepts: false, restriction: { min: 7, max: 40 } });
  });

  it('recognizes an inline regex validator without treating it as a named callee', () => {
    expect(
      predicate('function f(ref: string) { if (!/^[0-9a-f]{7,40}$/.test(ref)) return; }'),
    ).toMatchObject({ subject: 0, accepts: false, restriction: { min: 7, max: 40 } });
  });

  it.each([
    'const SHA_RE = /^[0-9a-f]{7,40}$/m; function f(ref: string) { if (!SHA_RE.test(ref)) return; }',
    'const SHA_RE = /^[0-9a-f]{7,40}$/; SHA_RE.test = other; function f(ref: string) { if (!SHA_RE.test(ref)) return; }',
    'const SHA_RE = /^[0-9a-f]{7,40}$/; function f(SHA_RE: any, ref: string) { if (!SHA_RE.test(ref)) return; }',
    'const SHA_RE = /^[0-9a-f]{7,40}$/; export { SHA_RE }; function f(ref: string) { if (!SHA_RE.test(ref)) return; }',
    'import { SHA_RE } from "./patterns"; function f(ref: string) { if (!SHA_RE.test(ref)) return; }',
    '/x/.constructor.prototype.test = () => true; function f(ref: string) { if (!/^[0-9a-f]{7,40}$/.test(ref)) return; }',
    'const OTHER = /x/; OTHER.constructor.prototype.test = () => true; function f(ref: string) { if (!/^[0-9a-f]{7,40}$/.test(ref)) return; }',
    'const SHA_RE = /^[0-9a-f]{7,40}$/; mutate(SHA_RE); function f(ref: string) { if (!/^[0-9a-f]{7,40}$/.test(ref)) return; }',
    String.raw`\u0067lobalThis.RegExp.prototype.test = () => true; function f(ref: string) { if (!/^[0-9a-f]{7,40}$/.test(ref)) return; }`,
    'globalThis.RegExp.prototype.test = () => true; function f(ref: string) { if (!/^[0-9a-f]{7,40}$/.test(ref)) return; }',
    'eval("RegExp.prototype.test = () => true"); function f(ref: string) { if (!/^[0-9a-f]{7,40}$/.test(ref)) return; }',
  ])('retains unknown validator identity, mutation and unsupported flags', (source) => {
    expect(predicate(source)).toBeUndefined();
  });

  it('strict literal equality establishes a primitive without a cast assumption', () => {
    expect(predicate('function f(ref: any) { if (ref !== "abcdef0") return; }')).toMatchObject({
      subject: 0,
      accepts: false,
      establishesPrimitive: true,
    });
  });

  it('normalizes exact literal concatenation and rejects unknown transformations', () => {
    const expression = find(parse('const value = "git " + args;'), 'binary_expression');
    expect(readValueExpression(expression, () => 2)).toEqual({
      kind: 'concat',
      parts: [
        { kind: 'literal', value: 'git ' },
        { kind: 'binding', binding: 2 },
      ],
    });
    expect(
      readValueExpression(find(parse('transform(args);'), 'call_expression'), () => 2),
    ).toEqual({ kind: 'unknown' });
    expect(
      readValueExpression(find(parse('new Wrapper(args);'), 'new_expression'), () => 2),
    ).toEqual({ kind: 'non-string' });
  });
});
