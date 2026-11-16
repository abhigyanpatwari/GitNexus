import { describe, expect, it } from 'vitest';
import { createJavaImplicitArrayReceiverChainSynthesizer } from '../../../../src/core/ingestion/languages/java/implicit-array-receiver-captures.js';
import { getJavaParser } from '../../../../src/core/ingestion/languages/java/query.js';
import { nodeToCapture } from '../../../../src/core/ingestion/utils/ast-helpers.js';
import { decodeReceiverChain } from '../../../../src/core/ingestion/utils/receiver-chain-codec.js';
import type { Capture } from 'gitnexus-shared';

function chains(source: string) {
  const tree = getJavaParser().parse(source);
  const synthesize = createJavaImplicitArrayReceiverChainSynthesizer(tree.rootNode);
  return tree.rootNode
    .descendantsOfType('method_invocation')
    .filter((node) => node.childForFieldName('name')?.text === 'save')
    .map((node) => {
      const captures: Record<string, Capture> = {
        '@reference.call.member': nodeToCapture('@reference.call.member', node),
      };
      synthesize(captures, node.childForFieldName('object'));
      return decodeReceiverChain(captures['@reference.receiver-chain']?.text);
    });
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
    'class App { static void run() { getUsers()[0].save(); } }',
    'class App { void run() { service.getUsers()[0].save(); } }',
    'class App { void run() { getUsers(1)[0].save(); } }',
    'class App { void run() { Object value = new Object() { void nested() { getUsers()[0].save(); } }; } }',
  ])('refuses an unsupported or differently owned receiver: %s', (source) => {
    expect(chains(source)).toEqual([undefined]);
  });
});
