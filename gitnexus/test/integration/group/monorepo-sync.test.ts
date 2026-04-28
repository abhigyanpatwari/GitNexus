/**
 * Monorepo sync integration — proves that intra-repo service communication
 * (gRPC, Kafka topics, HTTP routes) is detected and matched across service
 * boundaries within a single monorepo.
 *
 * Uses real extractors on fixture files (no LadybugDB).
 */
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GrpcExtractor } from '../../../src/core/group/extractors/grpc-extractor.js';
import { TopicExtractor } from '../../../src/core/group/extractors/topic-extractor.js';
import { HttpRouteExtractor } from '../../../src/core/group/extractors/http-route-extractor.js';
import {
  detectServiceBoundaries,
  assignService,
} from '../../../src/core/group/service-boundary-detector.js';
import { runExactMatch } from '../../../src/core/group/matching.js';
import type { RepoHandle, StoredContract } from '../../../src/core/group/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MONOREPO_DIR = path.resolve(__dirname, '../../fixtures/group/test-monorepo');

const REPO_GROUP_PATH = 'platform/monorepo';
const makeHandle = (): RepoHandle => ({
  id: 'test-monorepo',
  path: REPO_GROUP_PATH,
  repoPath: MONOREPO_DIR,
  storagePath: path.join(MONOREPO_DIR, '.gitnexus'),
});

describe('Monorepo sync integration', () => {
  it('detects service boundaries in fixture monorepo', async () => {
    const boundaries = await detectServiceBoundaries(MONOREPO_DIR);

    expect(boundaries.length).toBe(3);
    const names = boundaries.map((b) => b.serviceName).sort();
    expect(names).toEqual(['auth', 'gateway', 'orders']);
  });

  it('extracts gRPC, topic, and HTTP contracts with service assignments', async () => {
    const handle = makeHandle();
    const boundaries = await detectServiceBoundaries(MONOREPO_DIR);

    const grpcEx = new GrpcExtractor();
    const topicEx = new TopicExtractor();
    const httpEx = new HttpRouteExtractor();

    const grpcContracts = await grpcEx.extract(null, MONOREPO_DIR, handle);
    const topicContracts = await topicEx.extract(null, MONOREPO_DIR, handle);
    const httpContracts = await httpEx.extract(null, MONOREPO_DIR, handle);

    // Assign service boundaries and repo
    const allContracts: StoredContract[] = [
      ...grpcContracts,
      ...topicContracts,
      ...httpContracts,
    ].map((c) => ({
      ...c,
      repo: REPO_GROUP_PATH,
      service: assignService(c.symbolRef.filePath, boundaries),
    }));

    // Verify service assignments exist
    const withService = allContracts.filter((c) => c.service);
    expect(withService.length).toBeGreaterThan(0);

    // Verify we have both providers and consumers
    const providers = allContracts.filter((c) => c.role === 'provider');
    const consumers = allContracts.filter((c) => c.role === 'consumer');
    expect(providers.length).toBeGreaterThan(0);
    expect(consumers.length).toBeGreaterThan(0);

    return allContracts;
  });

  it('produces intra-repo cross-links between monorepo services', async () => {
    const handle = makeHandle();
    const boundaries = await detectServiceBoundaries(MONOREPO_DIR);

    const grpcEx = new GrpcExtractor();
    const topicEx = new TopicExtractor();
    const httpEx = new HttpRouteExtractor();

    const grpcContracts = await grpcEx.extract(null, MONOREPO_DIR, handle);
    const topicContracts = await topicEx.extract(null, MONOREPO_DIR, handle);
    const httpContracts = await httpEx.extract(null, MONOREPO_DIR, handle);

    const allContracts: StoredContract[] = [
      ...grpcContracts,
      ...topicContracts,
      ...httpContracts,
    ].map((c) => ({
      ...c,
      repo: REPO_GROUP_PATH,
      service: assignService(c.symbolRef.filePath, boundaries),
    }));

    const { matched, unmatched } = runExactMatch(allContracts);

    // All links should be intra-repo (same repo, different services)
    for (const link of matched) {
      expect(link.from.repo).toBe(REPO_GROUP_PATH);
      expect(link.to.repo).toBe(REPO_GROUP_PATH);
      expect(link.from.service).not.toBe(link.to.service);
    }

    // Expect at least topic match (user.logged-in: auth→orders)
    const topicLink = matched.find((l) => l.contractId.includes('topic::'));
    expect(topicLink).toBeDefined();
    expect(topicLink!.type).toBe('topic');

    // Expect HTTP match (POST /api/orders: orders→gateway)
    const httpLink = matched.find((l) => l.contractId.includes('http::'));
    expect(httpLink).toBeDefined();

    // Summary: we should have at least 2 cross-links
    expect(matched.length).toBeGreaterThanOrEqual(2);
  });
});
