import { describe, expect, it } from 'vitest';
import { createJavaImplicitArrayReceiverChainSynthesizer } from '../../../../src/core/ingestion/languages/java/implicit-array-receiver-captures.js';
import { getJavaParser } from '../../../../src/core/ingestion/languages/java/query.js';
import { nodeToCapture } from '../../../../src/core/ingestion/utils/ast-helpers.js';
import { decodeReceiverChain } from '../../../../src/core/ingestion/utils/receiver-chain-codec.js';
import type { Capture } from 'gitnexus-shared';

function synthesizeSaves(source: string) {
  const tree = getJavaParser().parse(source);
  const synthesize = createJavaImplicitArrayReceiverChainSynthesizer(tree.rootNode);
  const decoded = tree.rootNode
    .descendantsOfType('method_invocation')
    .filter((node) => node.childForFieldName('name')?.text === 'save')
    .map((node) => {
      const captures: Record<string, Capture> = {
        '@reference.call.member': nodeToCapture('@reference.call.member', node),
      };
      synthesize(captures, node.childForFieldName('object'));
      return decodeReceiverChain(captures['@reference.receiver-chain']?.text);
    });
  return { decoded, contexts: synthesize.initializerContexts() };
}

function chains(source: string) {
  return synthesizeSaves(source).decoded;
}

describe('Java implicit instance array receivers', () => {
  it('adds the lexical this base and preserves each index', () => {
    expect(chains('class App { void run() { ((getUsers()))[0][1].save(); } }')).toEqual([
      {
        baseReceiverName: 'this',
        steps: [{ kind: 'call', name: 'getUsers' }, { kind: 'index' }, { kind: 'index' }],
        truncated: false,
      },
    ]);
  });

  it('preserves lexical this inside a lambda', () => {
    expect(
      chains('class App { void run() { Runnable action = () -> getUsers()[0].save(); } }')[0]
        ?.baseReceiverName,
    ).toBe('this');
  });

  it.each([
    ['class App { Object first = getUsers()[0].save(); }', ['this']],
    ['class App { { getUsers()[0].save(); } }', ['this']],
    [
      'enum App { A; Object first = getUsers()[0].save(); { getUsers()[0].save(); } }',
      ['this', 'this'],
    ],
  ])('adds the lexical this base in an instance initializer: %s', (source, bases) => {
    expect(chains(source).map((chain) => chain?.baseReceiverName)).toEqual(bases);
  });

  it('reports only the initializer contexts whose chain was attached', () => {
    const { contexts } = synthesizeSaves(`class App {
      Object first = getUsers()[0].save(), plain = getUsers()[0];
      { getUsers()[0].save(); }
      void run() { getUsers()[0].save(); }
    }`);
    expect(
      contexts.map(({ node, type }) => [node.type, type.childForFieldName('name')?.text]),
    ).toEqual([
      ['method_invocation', 'App'],
      ['block', 'App'],
    ]);
  });

  it('captures an implicit array receiver in an anonymous instance method', () => {
    const source =
      'class App { Object task = new Object() { void run() { getUsers()[0].save(); } }; }';
    expect(chains(source)).toEqual([
      {
        baseReceiverName: 'this',
        steps: [{ kind: 'call', name: 'getUsers' }, { kind: 'index' }],
        truncated: false,
      },
    ]);
  });

  it.each([
    'class App { static Object first = getUsers()[0].save(); }',
    'class App { static { getUsers()[0].save(); } }',
    'interface App { Object FIRST = getUsers()[0].save(); }',
    'class App { void run() { Object value = new Object() { Object first = getUsers()[0].save(); }; } }',
    'class App { static void run() { getUsers()[0].save(); } }',
    'class App { void run() { service.getUsers()[0].save(); } }',
    'class App { void run() { getUsers(1)[0].save(); } }',
    'class App { void run() { getUsers()[0][1][2].save(); } }',
  ])('refuses an unsupported or differently owned receiver: %s', (source) => {
    expect(chains(source)).toEqual([undefined]);
  });
});
