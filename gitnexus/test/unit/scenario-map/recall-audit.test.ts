/** Source-adjudicated pairs from the PR #3686 audit. Retrieval is not a duplicate verdict. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { bodyKeyOf } from '../../../tools/scenario-map/facet/body-key.js';
import {
  checksContextKey,
  fsModuleReader,
  fsSnapshotReader,
} from '../../../tools/scenario-map/facet/checks.js';
import { loadStaticInventory } from '../../../tools/scenario-map/inventory/cases.js';
import { findCandidates } from '../../../tools/scenario-map/path-coverage/candidates.js';
import { layer1Files } from '../../../tools/scenario-map/path-coverage/prefilter.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const audit = JSON.parse(
  readFileSync(new URL('../../fixtures/scenario-map-recall/audit.json', import.meta.url), 'utf8'),
) as {
  positives: { a: string; b: string; category: string; basis: string }[];
};
const ids = new Set(audit.positives.flatMap(({ a, b }) => [a, b]));
const files = [...new Set([...ids].map((id) => id.slice(0, id.indexOf('#'))))];
const inventory = loadStaticInventory(root, files);
const options = { modules: fsModuleReader(root), snapshots: fsSnapshotReader(root) };
const sites = new Map(inventory.sites.map((site) => [`${site.file}#${site.fullName}`, site]));

describe('manual recall audit: candidate retrieval', () => {
  it('includes the audited files despite differing hooks and re-export contexts', () => {
    expect(layer1Files(root, files).skipped).toEqual([]);
  });

  it.each(audit.positives)(
    'retrieves $a and $b without relying on warm setup coverage',
    ({ a, b }) => {
      const tests = [a, b].map((id) => {
        const site = sites.get(id);
        expect(site, `audited test moved or disappeared: ${id}`).toBeDefined();
        if (!site) throw new Error(id);
        return {
          id,
          blocks: [], // Do not let Jaccard hide a static retrieval regression.
          concurrent: false,
          checksContext: checksContextKey(
            { record: site.record, instance: site.instances?.[0] ?? null, fullName: site.fullName },
            options,
          ),
          bodyKey: bodyKeyOf(site.record),
        };
      });
      expect(findCandidates(tests).pairs).toHaveLength(1);
    },
  );
});
