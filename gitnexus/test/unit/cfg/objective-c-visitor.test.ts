import { describe, expect, it } from 'vitest';
import { objectiveCProvider } from '../../../src/core/ingestion/languages/objective-c.js';
import { requireVendoredGrammar } from '../../../src/core/tree-sitter/vendored-grammars.js';
import { collectFunctionCfgs } from '../../../src/core/ingestion/cfg/collect.js';
import { computeReachingDefs } from '../../../src/core/ingestion/cfg/reaching-defs.js';
import { computeControlDependence } from '../../../src/core/ingestion/cfg/control-dependence.js';
import { isExitReachableFromAllBlocks } from '../../../src/core/ingestion/cfg/post-dominators.js';
import {
  emitFileCfgs,
  emitFileCdg,
  emitFileReachingDefs,
} from '../../../src/core/ingestion/cfg/emit.js';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import { allSites, bindingIdx, block, makeCfgHarness, reaches } from '../../helpers/cfg-harness.js';

function harness() {
  expect(objectiveCProvider.cfgVisitor).toBeDefined();
  return makeCfgHarness(
    requireVendoredGrammar('tree-sitter-objc'),
    objectiveCProvider.cfgVisitor!,
    'fixture.m',
  );
}

const method = (body: string, params = '(id)input') =>
  `@implementation Worker\n- (id)run:${params} {\n${body}\n}\n@end`;

describe('Objective-C CFG and PDG with the vendored grammar', () => {
  it('registers C functions, methods and independent nested blocks, excluding declarations', () => {
    const h = harness();
    const source = `@interface Worker\n- (id)run:(id)input;\n@end\n${method(`
      void (^done)(id) = ^(id inner) { [self consume:inner]; };
      return input;
    `)}\nint twice(int value) { return value * 2; }`;
    const root = h.parse(source);
    expect(root.hasError).toBe(false);
    const { cfgs, skipped } = collectFunctionCfgs(
      root,
      objectiveCProvider.cfgVisitor!,
      'fixture.m',
    );
    expect(cfgs).toHaveLength(3);
    expect(skipped.buildError).toBe(0);
    expect(cfgs[0].bindings?.some((b) => b.name === 'inner')).toBe(false);
    expect(cfgs[1].bindings).toContainEqual(
      expect.objectContaining({ name: 'inner', kind: 'param' }),
    );
    expect(allSites(cfgs[0]).some((s) => s.callee?.includes('consume'))).toBe(false);
    expect(allSites(cfgs[1]).some((s) => s.callee === 'self.consume:')).toBe(true);
  });

  it('harvests method parameters, pointer locals and message arguments without selector/type bindings', () => {
    const cfg = harness().cfgOf(
      method(
        `
      Worker *result = [self transform:input fallback:backup];
      return result;
    `,
        '(id)input backup:(id)backup',
      ),
    );
    const result = bindingIdx(cfg, 'result');
    expect(cfg.bindings).toContainEqual(
      expect.objectContaining({ name: 'input', kind: 'param', formalIndex: 0 }),
    );
    expect(cfg.bindings).toContainEqual(
      expect.objectContaining({ name: 'backup', kind: 'param', formalIndex: 1 }),
    );
    expect(cfg.bindings?.map((b) => b.name)).not.toEqual(
      expect.arrayContaining(['transform', 'fallback', 'Worker']),
    );
    expect(allSites(cfg)).toContainEqual(
      expect.objectContaining({
        callee: 'self.transform:fallback:',
        resultDefs: [result],
        args: [[bindingIdx(cfg, 'input')], [bindingIdx(cfg, 'backup')]],
      }),
    );
    expect(computeReachingDefs(cfg).facts).toContainEqual(
      expect.objectContaining({
        bindingIdx: result,
        def: expect.objectContaining({ blockIndex: block(cfg, 'Worker *result') }),
        use: expect.objectContaining({ blockIndex: block(cfg, 'return result') }),
      }),
    );
  });

  it.each(['{ [self consume:item]; }', '[self consume:item];'])(
    'models fast enumeration with body %s',
    (body) => {
      const cfg = harness().cfgOf(method(`for (id item in input) ${body}\nreturn input;`));
      const head = block(cfg, 'for (id item in input)');
      const consume = block(cfg, '[self consume:item]');
      expect(cfg.edges).toContainEqual({ from: head, to: consume, kind: 'cond-true' });
      expect(cfg.edges).toContainEqual({ from: consume, to: head, kind: 'loop-back' });
      expect(
        computeReachingDefs(cfg).facts.some(
          (f) => f.bindingIdx === bindingIdx(cfg, 'item') && f.use.blockIndex === consume,
        ),
      ).toBe(true);
      expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
    },
  );

  it('keeps enumeration variables scoped without shadowing the later parameter use', () => {
    const cfg = harness().cfgOf(
      method(`for (id input in input) { [self consume:input]; }\nreturn input;`),
    );
    const inputs = cfg.bindings!.flatMap((b, i) => (b.name === 'input' ? [i] : []));
    expect(inputs).toHaveLength(2);
    const use = cfg.blocks[block(cfg, 'return input')].statements![0].uses;
    expect(use).toContain(inputs[0]);
    expect(use).not.toContain(inputs[1]);
  });

  it('models ordinary C branches/loops and emits generic CFG, CDG and reaching-definition edges', () => {
    const cfg = harness().cfgOf(
      method(`
      id result = input;
      for (int i = 0; i < 2; i++) { if (input) { result = [self transform:input]; } }
      return result;
    `),
    );
    expect(computeControlDependence(cfg).edges.length).toBeGreaterThan(0);
    const graph = createKnowledgeGraph();
    expect(emitFileCfgs(graph, [cfg]).edges).toBeGreaterThan(0);
    expect(emitFileCdg(graph, [cfg]).edges).toBeGreaterThan(0);
    expect(emitFileReachingDefs(graph, [cfg]).edges).toBeGreaterThan(0);
    expect(new Set(graph.relationships.map((r) => r.type))).toEqual(
      new Set(['CFG', 'CDG', 'REACHING_DEF']),
    );
  });

  it('routes returns through finally and declares each catch parameter in its own scope', () => {
    const cfg = harness().cfgOf(
      method(`
      @try { if (input) { return input; } @throw input; }
      @catch (NSException *error) { [self recover:error]; }
      @catch (id other) { [self recover:other]; }
      @finally { [self cleanup]; }
      return nil;
    `),
    );
    const returning = block(cfg, 'return input');
    const cleanup = cfg.edges.find((edge) => edge.from === returning && edge.kind === 'return')!.to;
    expect(cfg.blocks[cleanup].text).toContain('[self cleanup]');
    expect(cfg.edges).not.toContainEqual({ from: returning, to: cfg.exitIndex, kind: 'return' });
    expect(cfg.bindings).toContainEqual(expect.objectContaining({ name: 'error', kind: 'catch' }));
    expect(cfg.bindings).toContainEqual(expect.objectContaining({ name: 'other', kind: 'catch' }));
    expect(reaches(cfg, block(cfg, '@throw input'), block(cfg, '[self recover:other]'))).toBe(true);
    expect(isExitReachableFromAllBlocks(cfg)).toBe(true);
  });

  it('does not resume normal flow after a return through finally', () => {
    const cfg = harness().cfgOf(
      method(`
      @try { return input; } @finally { [self cleanup]; }
      [self unreachable];
      return nil;
    `),
    );
    const returning = block(cfg, 'return input');
    expect(reaches(cfg, returning, cfg.exitIndex)).toBe(true);
    expect(reaches(cfg, returning, block(cfg, '[self unreachable]'))).toBe(false);
    expect(reaches(cfg, cfg.entryIndex, block(cfg, '[self unreachable]'))).toBe(false);
  });

  it('keeps normal, return and break continuations separate after finally', () => {
    const cfg = harness().cfgOf(
      method(`
      while (input) {
        @try {
          if ([self returning]) { return input; }
          if ([self stopping]) { break; }
          [self normal];
        } @finally { [self cleanup]; }
        [self continued];
      }
      [self afterLoop];
      return nil;
    `),
    );
    const continued = block(cfg, '[self continued]');
    expect(reaches(cfg, block(cfg, '[self normal]'), continued)).toBe(true);
    expect(reaches(cfg, block(cfg, 'return input'), continued)).toBe(false);
    expect(reaches(cfg, block(cfg, 'return input'), block(cfg, '[self afterLoop]'))).toBe(false);
    expect(reaches(cfg, block(cfg, 'break;'), continued)).toBe(false);
    expect(reaches(cfg, block(cfg, 'break;'), block(cfg, '[self afterLoop]'))).toBe(true);
  });

  it('lets a finally jump replace a return using the cleanup lexical loop context', () => {
    const cfg = harness().cfgOf(
      method(`
      while (input) {
        @try { while (input) { return input; } }
        @finally { break; }
        [self unreachable];
      }
      [self afterLoop];
      return nil;
    `),
    );
    const returning = block(cfg, 'return input');
    expect(reaches(cfg, returning, block(cfg, '[self afterLoop]'))).toBe(true);
    expect(reaches(cfg, returning, block(cfg, '[self unreachable]'))).toBe(false);
  });

  it.each(['return nil;', '@throw input;'])(
    'lets cleanup completion %s replace normal and return continuations',
    (completion) => {
      const cfg = harness().cfgOf(
        method(`
        @try { if (input) { return input; } [self normal]; }
        @finally { ${completion} }
        [self unreachable];
      `),
      );
      for (const from of [block(cfg, 'return input'), block(cfg, '[self normal]')]) {
        expect(reaches(cfg, from, cfg.exitIndex)).toBe(true);
        expect(reaches(cfg, from, block(cfg, '[self unreachable]'))).toBe(false);
      }
    },
  );

  it('keeps cleanup-local goto labels within their completion replay', () => {
    const cfg = harness().cfgOf(
      method(`
      @try { if (input) { return input; } [self normal]; }
      @finally { goto done; done: [self cleanup]; }
      [self continued];
      return nil;
    `),
    );
    expect(reaches(cfg, block(cfg, '[self normal]'), block(cfg, '[self continued]'))).toBe(true);
    expect(reaches(cfg, block(cfg, 'return input'), block(cfg, '[self continued]'))).toBe(false);
  });

  it('threads crossing break/continue through finally while preserving breaks inside the try', () => {
    const cfg = harness().cfgOf(
      method(`
      while (input) {
        @try { while (input) { break; } if (input) { continue; } break; }
        @finally { [self cleanup]; }
      }
      return input;
    `),
    );
    const breaks = cfg.blocks.filter((b) => b.text === 'break;');
    expect(
      cfg.edges.some(
        (e) =>
          e.from === breaks[0].index &&
          cfg.blocks[e.to].text.includes('[self cleanup]') &&
          e.kind === 'break',
      ),
    ).toBe(false);
    const breakCleanup = cfg.edges.find(
      (edge) => edge.from === breaks[1].index && edge.kind === 'break',
    )!.to;
    const continueCleanup = cfg.edges.find(
      (edge) => edge.from === block(cfg, 'continue;') && edge.kind === 'continue',
    )!.to;
    expect(cfg.blocks[breakCleanup].text).toContain('[self cleanup]');
    expect(cfg.blocks[continueCleanup].text).toContain('[self cleanup]');
    expect(breakCleanup).not.toBe(continueCleanup);
  });

  it('walks synchronized and autoreleasepool bodies, preserving return termination', () => {
    const cfg = harness().cfgOf(
      method(`
      @synchronized (input) { if (input) { return input; } }
      @autoreleasepool { return nil; }
      [self unreachable];
    `),
    );
    expect(reaches(cfg, block(cfg, 'return input'), block(cfg, '[self unreachable]'))).toBe(false);
    expect(reaches(cfg, cfg.entryIndex, block(cfg, '[self unreachable]'))).toBe(false);
  });

  it('threads forward gotos out of try through cleanup without detouring in-region gotos', () => {
    const cfg = harness().cfgOf(
      method(`
      @try { goto inside; inside: [self step]; goto outside; }
      @finally { [self cleanup]; }
      outside: return input;
    `),
    );
    const cleanup = cfg.edges.find(
      (edge) => edge.from === block(cfg, 'goto outside;') && edge.kind === 'seq',
    )!.to;
    expect(cfg.blocks[cleanup].text).toContain('[self cleanup]');
    expect(cfg.edges).toContainEqual({
      from: block(cfg, 'goto inside;'),
      to: block(cfg, '[self step]'),
      kind: 'seq',
    });
    expect(cfg.edges).toContainEqual({
      from: block(cfg, 'goto outside;'),
      to: cleanup,
      kind: 'seq',
    });
    expect(cfg.edges).not.toContainEqual({
      from: block(cfg, 'goto outside;'),
      to: block(cfg, 'return input;'),
      kind: 'seq',
    });
    expect(reaches(cfg, cleanup, block(cfg, 'return input;'))).toBe(true);
  });

  it('an empty try does not enter its catch on normal completion', () => {
    const cfg = harness().cfgOf(
      method(`@try {} @catch (id error) { return error; }\nreturn input;`),
    );
    expect(reaches(cfg, cfg.entryIndex, block(cfg, 'return input;'))).toBe(true);
    expect(reaches(cfg, cfg.entryIndex, block(cfg, 'return error;'))).toBe(false);
  });

  it('a rethrow from catch executes finally before reaching the outer catch', () => {
    const cfg = harness().cfgOf(
      method(`
      @try {
        @try { @throw input; }
        @catch (id error) { @throw; }
        @finally { [self cleanup]; }
      } @catch (id outer) { [self recover:outer]; }
      return input;
    `),
    );
    const rethrow = cfg.blocks.find((b) => b.text === '@throw;')!.index;
    const cleanup = block(cfg, '[self cleanup]');
    expect(cfg.edges).toContainEqual({ from: rethrow, to: cleanup, kind: 'throw' });
    expect(reaches(cfg, cleanup, block(cfg, '[self recover:outer]'))).toBe(true);
    const withoutCleanup = {
      ...cfg,
      edges: cfg.edges.filter((edge) => edge.from !== cleanup && edge.to !== cleanup),
    };
    expect(reaches(withoutCleanup, rethrow, block(cfg, '[self recover:outer]'))).toBe(false);
    expect(
      reaches(withoutCleanup, block(cfg, '@throw input;'), block(cfg, '[self recover:outer]')),
    ).toBe(false);
  });

  it('preserves source line and column anchors after provider preprocessing', () => {
    const source = `NS_ASSUME_NONNULL_BEGIN\n${method('return [self transform:input];')}\nNS_ASSUME_NONNULL_END`;
    const prepared = objectiveCProvider.preprocessSource!(source, 'fixture.m');
    const root = harness().parse(prepared);
    const cfg = collectFunctionCfgs(root, objectiveCProvider.cfgVisitor!, 'fixture.m').cfgs[0];
    expect(cfg.functionStartLine).toBe(3);
    expect(cfg.functionStartColumn).toBe(0);
    expect(allSites(cfg)[0].at).toEqual([4, 7]);
  });
});
