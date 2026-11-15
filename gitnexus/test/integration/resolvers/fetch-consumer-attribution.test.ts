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
      ['src/client.ts', 'fetch-url-match|fetches:2|via:Function:src/client.ts:fetchRepos'],
    ]);
  });

  it('attributes a request to the function that makes it, not to a helper on the same line', () => {
    // `const decode = (res) => res.json(); return fetch(...).then(decode);` on one
    // line: by span alone the helper would win, and the callers of fetchFile
    // would vanish from the report.
    const edges = getRelationships(result, 'FETCHES').filter((e) => e.target === '/api/file');
    expect(edges.map((e) => [e.sourceFilePath, e.rel.reason])).toEqual([
      ['src/client.ts', 'fetch-url-match|fetches:2|via:Function:src/client.ts:fetchFile'],
    ]);
  });

  it('attributes a request made through a wrapper to the function that calls the wrapper', () => {
    // apiFetch('/api/stats') inside fetchStats, with a helper on the same line:
    // the site comes from the wrapper-call capture, not from a bare fetch().
    const edges = getRelationships(result, 'FETCHES').filter((e) => e.target === '/api/stats');
    expect(edges.map((e) => [e.sourceFilePath, e.rel.reason])).toEqual([
      ['src/stats.ts', 'fetch-url-match|fetches:2|via:Function:src/stats.ts:fetchStats'],
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
