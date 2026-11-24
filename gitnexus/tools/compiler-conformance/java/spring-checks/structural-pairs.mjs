import { compareCodeUnits } from '../../compare.mjs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runPipelineFromRepo } from '../../../../dist/core/ingestion/pipeline.js';
import {
  parseRelationSchemaPairs,
  relPairKeyFor,
} from '../../../../dist/core/lbug/rel-pair-routing.js';
import { NODE_TABLES, RELATION_SCHEMA } from '../../../../dist/core/lbug/schema.js';
import { FIXTURES } from '../spring-support.mjs';

export async function verifySpringRelationSchema() {
  const declared = parseRelationSchemaPairs(RELATION_SCHEMA);
  const tables = new Set(NODE_TABLES);
  for (const [fixture, sentinel] of [
    ['spring-constructor-bean-lookup', 'Constructor|CodeElement'],
    ['spring-conditional-app', 'Method|Annotation'],
  ]) {
    const { graph } = await runPipelineFromRepo(path.join(FIXTURES, fixture), () => {}, {
      workerPoolSize: 1,
    });
    const pairs = new Set();
    for (const rel of graph.iterRelationships()) {
      const pair = relPairKeyFor(rel.sourceId, rel.targetId, tables);
      if (pair !== undefined) pairs.add(pair);
    }
    assert.ok(pairs.has(sentinel), `${fixture}: missing ${sentinel}`);
    assert.deepEqual(
      [...pairs].filter((pair) => !declared.has(pair)).sort(compareCodeUnits),
      [],
      fixture,
    );
  }
}
