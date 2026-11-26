import { compareCodeUnits } from '../compare.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export { runPipelineFromRepo } from '../../../dist/core/ingestion/pipeline.js';
export { FIXTURES } from './spring-support.mjs';
export { getRelationships, writeFixtureRepo } from '../../../test/helpers/resolution-graph.ts';

export function copyResolutionProject(root, name) {
  const dir = fileURLToPath(new URL('../../../test/fixtures/java-resolution/', import.meta.url));
  fs.cpSync(path.join(dir, name), root, {
    recursive: true,
    filter: (source) => path.basename(source) !== 'resolution.json',
  });
}

export function getNodesByLabelFull({ graph }, label) {
  return [...graph.iterNodes()]
    .filter((n) => n.label === label)
    .map(({ properties }) => ({ name: properties.name, properties }))
    .sort((a, b) => compareCodeUnits(a.name, b.name));
}

export function getNodesByLabel(result, label) {
  return getNodesByLabelFull(result, label)
    .map((n) => n.name)
    .sort(compareCodeUnits);
}

export function edgeSet(edges) {
  return edges.map((edge) => edge.source + ' → ' + edge.target).sort(compareCodeUnits);
}

export function getResolutionOutcomes(result) {
  return result.resolutionOutcomes ?? [];
}
