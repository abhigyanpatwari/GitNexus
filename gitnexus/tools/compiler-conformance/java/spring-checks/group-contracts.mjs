import { compareCodeUnits } from '../../compare.mjs';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { HttpRouteExtractor } from '../../../../dist/core/group/extractors/http-route-extractor.js';
import { GrpcExtractor } from '../../../../dist/core/group/extractors/grpc-extractor.js';
import { ThriftExtractor } from '../../../../dist/core/group/extractors/thrift-extractor.js';
import { TopicExtractor } from '../../../../dist/core/group/extractors/topic-extractor.js';
import { detectServiceBoundaries } from '../../../../dist/core/group/service-boundary-detector.js';
import { buildProviderIndex, runWildcardMatch } from '../../../../dist/core/group/matching.js';
import { runPipelineFromRepo } from '../../../../dist/core/ingestion/pipeline.js';
import { springProject, withPersistedGraph } from '../spring-support.mjs';

const domains = {
  'http-route': HttpRouteExtractor,
  grpc: GrpcExtractor,
  thrift: ThriftExtractor,
  topic: TopicExtractor,
};
const fixture = (domain, file) => path.join(springProject('group-contracts'), domain, file);
function cases(domain) {
  const entries = JSON.parse(readFileSync(fixture(domain, 'cases.json'), 'utf8'));
  const projects = readdirSync(fixture(domain, ''), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort(compareCodeUnits);
  assert.deepEqual(
    entries.map((entry) => entry.project).sort(compareCodeUnits),
    projects,
    domain + ' fixture inventory',
  );
  return entries;
}
const repoHandle = (root) => ({
  id: 'test-repo',
  path: 'test/backend',
  repoPath: root,
  storagePath: path.join(root, '.gitnexus'),
});

function ordered(rows) {
  // Compare the JSON transport shape independent of filesystem enumeration order.
  const transportRows = JSON.stringify(rows, (key, value) => {
    if (typeof value === 'string' && ['filePath', 'servicePath', 'symbolUid'].includes(key))
      return value.replaceAll('\\', '/');
    return value;
  });
  return JSON.parse(transportRows).sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
}

async function verifyLegacyGraph(root, route, sourceRoute) {
  const { graph } = await runPipelineFromRepo(root, () => {});
  const nodes = [...graph.iterNodes()];
  const handler = nodes.find((n) => n.label === 'Method' && n.properties.name === 'list');
  assert.ok(handler, 'Expected the published handler method');
  // Old Route rows lacked the HTTP verb and handler ID. Keep their original
  // edge reason so the extractor must recover the method from the source.
  // The Java index predates the Go service file in the mixed repository.
  if (sourceRoute) {
    for (const node of nodes.filter((n) => n.properties.filePath === sourceRoute.filePath))
      graph.removeNode(node.id);
  }
  const routes = nodes.filter((n) => n.label === 'Route');
  const covered = routes.find((n) => n.properties.name === route && n.properties.method === 'GET');
  assert.ok(covered, route);
  for (const other of routes) if (other !== covered) graph.removeNode(other.id);
  delete covered.properties.method;
  delete covered.properties.handlerSymbolId;
  for (const edge of graph.iterRelationshipsByType('HANDLES_ROUTE'))
    edge.reason = 'decorator-GetMapping';
  await withPersistedGraph('legacy-routes', root, graph, async (execute) => {
    const extracted = await new HttpRouteExtractor().extract(execute, root, repoHandle(root));
    const getRoutes = extracted.filter((c) => c.contractId === 'http::GET::/api/v2/users');
    assert.equal(getRoutes.length, 1);
    assert.partialDeepStrictEqual(getRoutes[0], {
      role: 'provider',
      symbolUid: handler.id,
      confidence: 0.9,
      meta: { extractionStrategy: 'graph_assisted' },
    });
    if (sourceRoute) {
      const health = extracted.find((c) => c.contractId === sourceRoute.contractId);
      assert.partialDeepStrictEqual(health, {
        role: 'provider',
        symbolName: sourceRoute.handler,
        symbolRef: { filePath: sourceRoute.filePath },
        meta: { extractionStrategy: 'source_scan' },
      });
    }
  });
}

function verifyWildcard(result, contractId) {
  const [providers, consumers] = result.map((rows, index) =>
    rows.map((c) => ({ ...c, repo: index ? 'consumer' : 'provider' })),
  );
  const wildcards = consumers.filter((c) => c.role === 'consumer' && c.contractId.endsWith('/*'));
  const { matched } = runWildcardMatch(wildcards, buildProviderIndex([...providers, ...consumers]));
  assert.equal(matched.length, 1);
  assert.partialDeepStrictEqual(matched[0], {
    contractId,
    matchType: 'wildcard',
    from: { repo: 'consumer' },
    to: { repo: 'provider' },
  });
}

async function verifyExtractionFixture(domain, spec) {
  const root = fixture(domain, spec.project);
  if (spec.graphRoute) return verifyLegacyGraph(root, spec.graphRoute, spec.sourceRoute);
  const projects = spec.wildcard
    ? ['provider', 'consumer'].map((name) => path.join(root, name))
    : [root];
  const Extractor = domains[domain];
  const extract =
    domain === 'boundary'
      ? detectServiceBoundaries
      : (project) => new Extractor().extract(null, project, repoHandle(project));
  const outputs = [];
  for (const [index, project] of projects.entries()) {
    const expected = spec.wildcard ? spec.expected[index] : spec.expected;
    for (let run = 0; run < (spec.repeat ?? 1); run++) {
      const contracts = await extract(project);
      assert.deepEqual(ordered(contracts), ordered(expected));
      outputs.push(contracts);
    }
  }
  if (spec.wildcard) verifyWildcard(outputs, spec.wildcard);
}

export async function verifyGroupExtraction() {
  for (const domain of [...Object.keys(domains), 'boundary']) {
    for (const spec of cases(domain)) {
      try {
        await verifyExtractionFixture(domain, spec);
      } catch (error) {
        throw new Error(domain + ': ' + spec.name, { cause: error });
      }
    }
  }
}

export async function verifyJavaKotlinContractParity() {
  for (const { name, project, expected } of cases('parity')) {
    for (const language of ['java', 'kotlin']) {
      const root = path.join(fixture('parity', project), language);
      const result = await new HttpRouteExtractor().extract(null, root, repoHandle(root));
      const projection = result.map(({ role, contractId, meta, confidence }) => ({
        role,
        contractId,
        framework: meta.framework,
        confidence,
      }));
      assert.deepEqual(ordered(projection), ordered(expected), name + ' ' + language);
    }
  }
}
