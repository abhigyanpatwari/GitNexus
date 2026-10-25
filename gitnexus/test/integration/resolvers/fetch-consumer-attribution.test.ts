import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES,
  getNodesByLabelFull,
  getRelationships,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';

// The file that sends the request is the only one a FETCHES edge can name. The
// files that call its request function never mention the URL, so `api_impact`
// reaches them through the function the edge's reason records (#3644).
describe('FETCHES consumer attribution through the pipeline (#3644)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'api-impact-indirect-consumers'),
      () => {},
    );
  }, 60000);

  it('names the function holding the fetch site on the file-level edge', () => {
    expect(
      getNodesByLabelFull(result, 'Function').some(
        (node) => node.name === 'fetchRepos' && node.properties.filePath === 'src/client.ts',
      ),
    ).toBe(true);

    const edges = getRelationships(result, 'FETCHES').filter((e) => e.target === '/api/repos');
    expect(edges.map((e) => [e.sourceFilePath, e.rel.reason])).toEqual([
      ['src/client.ts', 'fetch-url-match|via:Function:src/client.ts:fetchRepos'],
    ]);
  });

  it('reaches the callers one level up through CALLS edges into that function', () => {
    const callers = getRelationships(result, 'CALLS')
      .filter((e) => e.target === 'fetchRepos' && e.targetFilePath === 'src/client.ts')
      .map((e) => `${e.sourceFilePath}:${e.source}`)
      .sort();
    expect(callers).toEqual(['src/app.ts:loadApp', 'src/header.ts:refreshHeader']);
  });
});
