import assert from 'node:assert/strict';
import fs from 'node:fs';

let manifest;

export function expectedReferenceAdditions(revision) {
  manifest ??= JSON.parse(
    fs.readFileSync(new URL('./expected-reference-additions.json', import.meta.url), 'utf8'),
  );
  return Object.hasOwn(manifest, revision) ? manifest[revision] : undefined;
}

/** Both the parity producer and the performance checker require the same evidence. */
export function assertReferenceAdditionReceipt(revision, receipt, edgeDelta) {
  const expected = expectedReferenceAdditions(revision);
  if (!expected) {
    assert.notEqual(receipt?.mode, 'added-references', 'Unknown reference corpus');
    return;
  }
  assert.equal(receipt?.mode, 'added-references', 'Missing expected added reference receipt');
  assert.deepEqual(receipt.additions, expected, 'Unexpected added reference receipt');
  assert.equal(edgeDelta, expected.count, 'Unexpected added reference count');
}
