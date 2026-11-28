import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

// Entries without `removals` pin an empty set of removed references.
const NO_ROWS = { count: 0, sha256: createHash('sha256').digest('hex') };

let manifest;

export function expectedReferenceAdditions(revision) {
  manifest ??= JSON.parse(
    fs.readFileSync(new URL('./expected-reference-additions.json', import.meta.url), 'utf8'),
  );
  if (Object.hasOwn(manifest, revision)) return manifest[revision];
  // Archived reports use the original two-tree keys. New reports can replay
  // those receipts only for their complete, explicitly audited checkouts.
  if (typeof revision === 'string' && revision.startsWith('checkout-sha256:')) {
    return Object.values(manifest).find((entry) => entry.checkoutFingerprint === revision);
  }
}

/** Check every node field when a pinned compiler comparison adds declaration positions. */
export function assertSemanticNodes(revision, baseline, candidate) {
  const expected = expectedReferenceAdditions(revision)?.declarationPositions;
  if (expected) {
    assert.deepEqual({ baseline, candidate }, expected, 'Unexpected declaration positions');
  } else {
    assert.deepEqual(candidate, baseline, 'Semantic nodes differ');
  }
}

/** Both the parity producer and the performance checker require the same evidence. */
export function assertReferenceAdditionReceipt(revision, receipt, edgeDelta) {
  const expected = expectedReferenceAdditions(revision);
  if (!expected) {
    assert.notEqual(receipt?.mode, 'added-references', 'Unknown reference corpus');
    return;
  }
  assert.equal(receipt?.mode, 'added-references', 'Missing expected added reference receipt');
  assert.deepEqual(receipt.additions, expected.additions, 'Unexpected added reference receipt');
  assert.deepEqual(
    receipt.typeOnlyImports,
    expected.typeOnlyImports,
    'Unexpected type-only imports',
  );
  const removals = expected.removals ?? NO_ROWS;
  assert.deepEqual(receipt.removals ?? NO_ROWS, removals, 'Unexpected removed reference receipt');
  assert.equal(
    edgeDelta,
    expected.additions.count - removals.count,
    'Unexpected reference count change',
  );
}
