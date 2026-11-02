import { describe, expect, it } from 'vitest';
import { classify } from '../../bench/receiver-resolution/measure.mjs';

const expectedTarget = 'Method:models.dart:User.save#0';
const wrongTarget = 'Method:models.dart:Address.save#0';
const caller = 'Function:main.dart:awaitParen';
const corpus = {
  ext: '.dart',
  shapes: [
    {
      id: 'awaitParen',
      member: 'save',
      body: '(await svc.getUserAsync()).save();',
      expectedTarget,
    },
  ],
};

function result(targets: string[], outcomes: Record<string, unknown>[] = []) {
  const nodes = new Map([
    [caller, { properties: { name: 'awaitParen', filePath: 'main.dart' } }],
    [expectedTarget, { properties: { name: 'save', filePath: 'models.dart' } }],
    [wrongTarget, { properties: { name: 'save', filePath: 'models.dart' } }],
  ]);
  return {
    graph: {
      getNode: (id: string) => nodes.get(id),
      iterRelationships: () =>
        targets.map((targetId) => ({ type: 'CALLS', sourceId: caller, targetId })),
    },
    resolutionOutcomes: outcomes,
  };
}

function drop(filePath = 'main.dart', siteKind = 'call') {
  return {
    kind: 'suppressed',
    reason: 'receiver-unresolved',
    name: 'save',
    shapeId: 'awaitParen',
    filePath,
    siteKind,
  };
}

describe('receiver measurement target and drop identity', () => {
  it('does not report a same-named method on the wrong owner as resolved', () => {
    expect(classify(corpus, result([wrongTarget]))[0].state).toBe('WRONG-TARGET');
  });

  it('reports an extra wrong target even when the expected method also resolves', () => {
    expect(classify(corpus, result([expectedTarget, wrongTarget]))[0].state).toBe('WRONG-TARGET');
  });

  it('resolves only the expected declaration', () => {
    expect(classify(corpus, result([expectedTarget]))[0].state).toBe('RESOLVES');
  });

  it('keeps untyped controls unresolved and rejects a guessed edge', () => {
    const untyped = { ...corpus, shapes: [{ ...corpus.shapes[0], expectedTarget: null }] };
    expect(classify(untyped, result([], [drop()]))[0].state).toBe('VISIBLE-GAP');
    expect(classify(untyped, result([expectedTarget]))[0].state).toBe('WRONG-TARGET');
  });

  it('does not borrow a drop from another file at the same shape line', () => {
    expect(classify(corpus, result([], [drop('models.dart')]))[0].state).toBe('INVISIBLE-GAP');
  });

  it('does not treat a property-read drop as a missing call diagnostic', () => {
    expect(classify(corpus, result([], [drop('main.dart', 'read')]))[0].state).toBe(
      'INVISIBLE-GAP',
    );
  });

  it('distinguishes an observed call drop from an unrecorded call', () => {
    expect(classify(corpus, result([], [drop()]))[0].state).toBe('VISIBLE-GAP');
    expect(classify(corpus, result([]))[0].state).toBe('INVISIBLE-GAP');
  });
});
