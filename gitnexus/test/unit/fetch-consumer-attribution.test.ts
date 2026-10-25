/**
 * The FETCHES edge is file-level; its reason names the callables whose spans
 * contain the request sites, one `|via:<id>` field each, so `api_impact` can
 * follow their CALLS edges one level up (#3644). The containment rule is the
 * R3-6 sink rule: innermost span wins, lines 0-based on both sides.
 */
import { describe, it, expect } from 'vitest';
import type { NodeLabel } from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { KnowledgeGraph } from '../../src/core/graph/types.js';
import { processNextjsFetchRoutes } from '../../src/core/ingestion/call-processor.js';
import type { ExtractedFetchCall } from '../../src/core/ingestion/workers/parse-worker.js';

const FILE = 'src/client.ts';
const REPOS = new Map([['/api/repos', ['GET /api/repos']]]);

function addCallable(
  graph: KnowledgeGraph,
  id: string,
  startLine: number,
  endLine: number,
  label: NodeLabel = 'Function',
  filePath = FILE,
): void {
  graph.addNode({
    id,
    label,
    properties: { name: id.split(':').pop() ?? id, filePath, startLine, endLine },
  });
}

const site = (
  lineNumber: number,
  filePath = FILE,
  fetchURL = '/api/repos',
): ExtractedFetchCall => ({
  filePath,
  fetchURL,
  lineNumber,
});

const reasons = (graph: KnowledgeGraph): string[] =>
  [...graph.iterRelationshipsByType('FETCHES')].map((r) => r.reason);

describe('FETCHES consumer attribution (#3644)', () => {
  it('names the callable whose span contains the request site', () => {
    const graph = createKnowledgeGraph();
    addCallable(graph, 'Function:src/client.ts:fetchRepos', 2, 6);

    processNextjsFetchRoutes(graph, [site(3)], REPOS);

    expect(reasons(graph)).toEqual(['fetch-url-match|via:Function:src/client.ts:fetchRepos']);
  });

  it('keeps one edge per file and route, naming every requesting callable in code-unit order', () => {
    const graph = createKnowledgeGraph();
    addCallable(graph, 'Function:src/client.ts:refresh', 10, 14);
    addCallable(graph, 'Function:src/client.ts:fetchRepos', 2, 6);

    // Two sites in one file for one route used to collide on the edge id, with
    // the first one winning; now they share the edge.
    processNextjsFetchRoutes(graph, [site(12), site(3)], REPOS);

    const edges = [...graph.iterRelationshipsByType('FETCHES')];
    expect(edges).toHaveLength(1);
    expect(edges[0].sourceId).toBe('File:src/client.ts');
    expect(edges[0].targetId).toBe('Route:GET /api/repos');
    // `fetches:` counts the file's matching call sites, as before.
    expect(edges[0].reason).toBe(
      'fetch-url-match|fetches:2|via:Function:src/client.ts:fetchRepos|via:Function:src/client.ts:refresh',
    );
  });

  it('picks the innermost callable, a method or constructor as well as a function', () => {
    const graph = createKnowledgeGraph();
    addCallable(graph, 'Function:src/client.ts:outer', 10, 30);
    addCallable(graph, 'Function:src/client.ts:outer.inner', 12, 14);
    addCallable(graph, 'Method:src/client.ts:Client.load', 40, 45, 'Method');
    addCallable(graph, 'Constructor:src/client.ts:Client.constructor', 50, 52, 'Constructor');
    addCallable(graph, 'Class:src/client.ts:Client', 38, 60, 'Class');

    processNextjsFetchRoutes(graph, [site(13), site(42), site(51)], REPOS);

    expect(reasons(graph)).toEqual([
      'fetch-url-match|fetches:3' +
        '|via:Constructor:src/client.ts:Client.constructor' +
        '|via:Function:src/client.ts:outer.inner' +
        '|via:Method:src/client.ts:Client.load',
    ]);
  });

  it('leaves the reason as before when no callable contains the site', () => {
    const graph = createKnowledgeGraph();
    addCallable(graph, 'Function:src/client.ts:fetchRepos', 2, 6);

    // A module-scope call, and a file the graph has no spans for.
    processNextjsFetchRoutes(graph, [site(50), site(3, 'src/other.ts')], REPOS);

    expect(reasons(graph)).toEqual(['fetch-url-match', 'fetch-url-match']);
  });

  it('does not attribute a site to a callable of another file at the same lines', () => {
    const graph = createKnowledgeGraph();
    addCallable(graph, 'Function:src/client.ts:fetchRepos', 2, 6);
    addCallable(graph, 'Function:src/other.ts:load', 2, 6, 'Function', 'src/other.ts');

    processNextjsFetchRoutes(graph, [site(3, 'src/other.ts')], REPOS);

    expect(reasons(graph)).toEqual(['fetch-url-match|via:Function:src/other.ts:load']);
  });

  it('appends the attribution after the multi-fetch count', () => {
    const graph = createKnowledgeGraph();
    addCallable(graph, 'Function:src/client.ts:fetchRepos', 2, 6);
    addCallable(graph, 'Function:src/client.ts:readFile', 10, 14);
    const routes = new Map([
      ['/api/repos', ['GET /api/repos']],
      ['/api/file', ['GET /api/file']],
    ]);

    processNextjsFetchRoutes(graph, [site(3), site(12, FILE, '/api/file')], routes);

    expect(reasons(graph)).toEqual([
      'fetch-url-match|fetches:2|via:Function:src/client.ts:fetchRepos',
      'fetch-url-match|fetches:2|via:Function:src/client.ts:readFile',
    ]);
  });

  it('appends the attribution after the accessed keys', () => {
    const graph = createKnowledgeGraph();
    addCallable(graph, 'Function:src/client.ts:fetchRepos', 2, 6);
    const contents = new Map([[FILE, 'const { repos, total } = await res.json();']]);

    processNextjsFetchRoutes(graph, [site(3)], REPOS, contents);

    expect(reasons(graph)).toEqual([
      'fetch-url-match|keys:repos,total|via:Function:src/client.ts:fetchRepos',
    ]);
  });

  it('prefers the enclosing callable the parser recorded over the innermost span', () => {
    const graph = createKnowledgeGraph();
    // `const decode = (res) => res.json(); return fetch('/api/repos').then(decode);`
    // on one line: the helper's span is smaller, but the request belongs to fetchRepos.
    addCallable(graph, 'Function:src/client.ts:fetchRepos', 2, 4);
    addCallable(graph, 'Function:src/client.ts:fetchRepos.decode', 3, 3);

    processNextjsFetchRoutes(
      graph,
      [{ ...site(3), enclosingId: 'Function:src/client.ts:fetchRepos' }],
      REPOS,
    );

    expect(reasons(graph)).toEqual(['fetch-url-match|via:Function:src/client.ts:fetchRepos']);
  });

  it('falls back to the span when the recorded callable is not in the graph', () => {
    const graph = createKnowledgeGraph();
    addCallable(graph, 'Function:src/client.ts:fetchRepos', 2, 6);

    processNextjsFetchRoutes(
      graph,
      [{ ...site(3), enclosingId: 'Function:src/client.ts:skipped' }],
      REPOS,
    );

    expect(reasons(graph)).toEqual(['fetch-url-match|via:Function:src/client.ts:fetchRepos']);
  });

  it('leaves out an id that contains the field separator rather than splitting the reason', () => {
    const graph = createKnowledgeGraph();
    // A type tag from an overload collision can carry a union type.
    addCallable(graph, 'Function:src/client.ts:load#1~string|number', 2, 6);

    processNextjsFetchRoutes(graph, [site(3)], REPOS);

    expect(reasons(graph)).toEqual(['fetch-url-match']);
  });
});
