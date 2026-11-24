import { compareCodeUnits } from '../../compare.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runPipelineFromRepo } from '../../../../src/core/ingestion/pipeline.js';
import { getRelationships } from '../../../../test/helpers/resolution-graph.js';

type Observation =
  | { type: 'node'; name: string; label: string; file: string; properties: Record<string, unknown> }
  | {
      type: string;
      from?: string;
      fromFile?: string;
      to?: string;
      reason?: string;
      projection: 'filePath' | 'id' | 'name' | 'label';
      exact?: string[];
      includes?: string[];
      excludes?: string[];
      only?: string;
    };

const directory = path.resolve(import.meta.dirname, '../../../../test/fixtures/java-products');
const projects: Record<string, Observation[]> = JSON.parse(
  readFileSync(path.join(directory, 'observations.json'), 'utf8'),
);

for (const [project, observations] of Object.entries(projects)) {
  test(project, async () => {
    const pipeline = await runPipelineFromRepo(path.resolve(directory, project), () => {});
    assert.ok(observations.length);
    for (const observation of observations) {
      if ('properties' in observation) {
        const matches = pipeline.graph.nodes.filter(
          (node) =>
            node.label === observation.label &&
            node.properties.name === observation.name &&
            node.properties.filePath === observation.file,
        );
        assert.equal(matches.length, 1, observation.name);
        assert.partialDeepStrictEqual(matches[0].properties, observation.properties);
        continue;
      }
      const { type, from, fromFile, to, reason, projection, exact, includes, excludes } =
        observation;
      const message = JSON.stringify(observation);
      assert.ok(
        pipeline.graph.nodes.some(
          (node) =>
            (!from || node.properties.name === from) &&
            (!fromFile || node.properties.filePath === fromFile),
        ),
        message,
      );
      const values = getRelationships(pipeline, type)
        .filter(
          (edge) =>
            (!from || edge.source === from) &&
            (!fromFile || edge.sourceFilePath === fromFile) &&
            (!to || edge.target === to) &&
            (!reason || edge.rel.reason === reason),
        )
        .map(
          (edge) =>
            ({
              id: edge.rel.targetId,
              filePath: edge.targetFilePath,
              name: edge.target,
              label: edge.targetLabel,
            })[projection],
        );
      if (observation.only)
        assert.ok(values.length && values.every((value) => value === observation.only), message);
      if (exact)
        assert.deepEqual(values.sort(compareCodeUnits), [...exact].sort(compareCodeUnits), message);
      for (const value of includes ?? []) assert.ok(values.includes(value), message);
      for (const value of excludes ?? []) assert.ok(!values.includes(value), message);
    }
  });
}
