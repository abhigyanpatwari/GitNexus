import assert from 'node:assert/strict';

const verifiedNote =
  'Source-reference identities and source spans were checked before writing. This validates ingestion provenance, not resolution accuracy or query completeness.';
const unverifiedNote =
  'Some reference edges have only a caller/target identity, extracted-buffer coordinates, or incomplete source provenance. Their original source-site distinctness is unverified; query deduplication is not an integrity check.';

/** Compare a new receipt with its own fixture metadata before bridging a legacy baseline. */
export function parityBody(body, variant, indexes) {
  if (indexes.baseline.relationshipIntegrity !== undefined) return body;
  if (variant === 'baseline') {
    assert(
      !Object.hasOwn(body, 'graph_integrity'),
      'Legacy baseline unexpectedly returned graph_integrity',
    );
    return body;
  }
  assert.equal(variant, 'candidate');
  const receipt = indexes.candidate.relationshipIntegrity;
  assert(
    receipt?.version === 1 &&
      ['checkedSites', 'unverifiedEdges', 'duplicatesSuppressed'].every(
        (key) => Number.isSafeInteger(receipt[key]) && receipt[key] >= 0,
      ),
    'Candidate index has no valid relationship integrity receipt',
  );
  const verified = receipt.unverifiedEdges === 0;
  assert.deepEqual(
    body.graph_integrity,
    {
      status: verified ? 'verified' : 'unverified',
      scope: 'source-reference-ingestion',
      checkedSites: receipt.checkedSites,
      unverifiedEdges: receipt.unverifiedEdges,
      duplicatesSuppressed: receipt.duplicatesSuppressed,
      note: verified ? verifiedNote : unverifiedNote,
    },
    'Candidate graph_integrity does not match its index receipt',
  );
  const comparable = { ...body };
  delete comparable.graph_integrity;
  return comparable;
}
