import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyJavaLocalNameClaims } from '../../../dist/core/ingestion/languages/java/local-name-claims.js';
import { getJavaParser } from '../../../dist/core/ingestion/languages/java/query.js';
import { nodeToCapture } from '../../../dist/core/ingestion/utils/ast-helpers.js';

export function checkLocalClaims(file) {
  const tree = getJavaParser().parse(readFileSync(file, 'utf8'));
  const block = tree.rootNode
    .descendantsOfType('block')
    .find((node) => node.text.includes('var copy'));
  const anchor = nodeToCapture('@scope.block', block);
  const merge = (text) => {
    const claim = {
      '@scope.block': anchor,
      '@scope.name-claims': { ...anchor, name: '@scope.name-claims', text },
    };
    return applyJavaLocalNameClaims(tree.rootNode, [claim])[0]['@scope.name-claims'].text;
  };
  for (const unreadable of ['{not json', '{"name":"prior"}'])
    assert.equal(merge(unreadable), unreadable);
  assert.deepEqual(
    JSON.parse(merge('[{"name":"prior","kind":"blocked"}]')).map((claim) => claim.name),
    ['prior', 'copy'],
  );
  const blocks = new Map(
    applyJavaLocalNameClaims(tree.rootNode, []).map((match) => [
      match['@scope.block']?.text,
      JSON.parse(match['@scope.name-claims']?.text ?? '[]').map((claim) => claim.name),
    ]),
  );
  assert.deepEqual(blocks.get('{ int inner = 0;}'), ['inner']);
  assert.deepEqual(blocks.get('{ if (ready) { int inner = 0;}User same = input; }'), ['same']);
}
