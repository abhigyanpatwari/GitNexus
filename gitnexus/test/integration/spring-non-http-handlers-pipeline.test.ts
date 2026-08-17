import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GraphNode } from 'gitnexus-shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import {
  loadParseCache,
  PARSE_CACHE_VERSION,
  pruneCache,
  saveParseCache,
  type ParseCache,
} from '../../src/storage/parse-cache.js';
import {
  getDurableParsedFileDir,
  pruneAndSaveDurableParsedFileStore,
} from '../../src/storage/parsedfile-store.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'spring-non-http-handler-app');

describe('Spring non-HTTP handler entry points (#2417)', () => {
  let result: PipelineResult;
  let methods: GraphNode[];

  beforeAll(async () => {
    result = await runPipelineFromRepo(FIXTURE, () => {}, {});
    // Kotlin enum members currently use the graph's Function label; they are
    // still class-owned callables and participate in process detection.
    methods = [...result.graph.iterNodes()].filter(
      (node) => node.label === 'Method' || node.label === 'Function',
    );
  }, 60_000);

  function methodNamed(name: string, fileSuffix: string): GraphNode {
    const matches = methods.filter(
      (method) =>
        method.properties.name === name && String(method.properties.filePath).endsWith(fileSuffix),
    );
    if (matches.length !== 1) {
      throw new Error(
        `${fileSuffix}#${name} should resolve to one callable, found ${matches.length}`,
      );
    }
    return matches[0];
  }

  it.each([
    ['refreshProjection', 'ScheduledJobs.java', 'spring-scheduled-handler'],
    ['onOrderCreated', 'ApplicationEvents.java', 'spring-event-handler'],
    ['consumeOrder', 'MessageConsumers.java', 'spring-message-handler'],
    ['onKotlinEvent', 'AliasedEvents.kt', 'spring-event-handler'],
    ['runLiteralJob', 'XxlJobs.java', 'xxl-job-handler'],
    ['runConstantJob', 'XxlJobs.java', 'xxl-job-handler'],
    ['runKotlinJob', 'AliasedXxlJob.kt', 'xxl-job-handler'],
    ['refreshAfterEvent', 'ScheduledJobs.java', 'spring-non-http-handler'],
    ['warmSingleton', 'SingletonHandlers.kt', 'spring-scheduled-handler'],
    ['onCompanionEvent', 'SingletonHandlers.kt', 'spring-event-handler'],
    ['consumeEnumMessage', 'SingletonHandlers.kt', 'spring-message-handler'],
    ['fakeBeanServiceActivator', 'ServiceActivators.java', 'spring-message-handler'],
  ])('marks %s in %s as a framework-managed process entry point', (methodName, file, reason) => {
    const method = methodNamed(methodName, file);
    expect(method.properties.astFrameworkMultiplier).toBe(3);
    expect(method.properties.astFrameworkReason).toBe(reason);
  });

  it.each([
    ['fakeEventHandler', 'CustomAnnotationHandler.java'],
    ['fakeXxlJobHandler', 'CustomAnnotationHandler.java'],
  ])(
    'fails closed for the same-name annotation on %s in %s imported from an unrelated package',
    (methodName, file) => {
      const method = methodNamed(methodName, file);
      expect(method.properties.astFrameworkMultiplier).toBeUndefined();
      expect(method.properties.astFrameworkReason).toBeUndefined();
    },
  );

  it.each([
    ['interfaceEvent', 'ListenerContract.kt'],
    ['targetedReceiverIsNotAHandler', 'UseSiteTarget.kt'],
    ['beanFactoryServiceActivator', 'ServiceActivators.java'],
  ])(
    'does not promote excluded callable %s in %s into a provider entry point',
    (methodName, file) => {
      const method = methodNamed(methodName, file);
      expect(method.properties.astFrameworkMultiplier).toBeUndefined();
      expect(method.properties.astFrameworkReason).toBeUndefined();
    },
  );

  it('preserves an existing same-strength framework reason', () => {
    const method = methodNamed('consumeOverWebSocket', 'MessageConsumers.java');
    expect(method.properties.astFrameworkMultiplier).toBe(3);
    expect(method.properties.astFrameworkReason).toBe('jaxrs-annotation');
  });

  it('does not model non-HTTP framework handlers as HTTP routes', () => {
    const routes: GraphNode[] = [];
    result.graph.forEachNode((node) => {
      if (node.label === 'Route') routes.push(node);
    });
    expect(routes).toEqual([]);
  });

  it.each([
    ['refreshProjection', 'ScheduledJobs.java'],
    ['onOrderCreated', 'ApplicationEvents.java'],
    ['consumeOrder', 'MessageConsumers.java'],
    ['onKotlinEvent', 'AliasedEvents.kt'],
    ['runLiteralJob', 'XxlJobs.java'],
    ['runConstantJob', 'XxlJobs.java'],
    ['runKotlinJob', 'AliasedXxlJob.kt'],
    ['refreshAfterEvent', 'ScheduledJobs.java'],
    ['warmSingleton', 'SingletonHandlers.kt'],
    ['onCompanionEvent', 'SingletonHandlers.kt'],
    ['consumeEnumMessage', 'SingletonHandlers.kt'],
    ['fakeBeanServiceActivator', 'ServiceActivators.java'],
  ])('starts process/context output from %s in %s', (methodName, file) => {
    const method = methodNamed(methodName, file);
    const process = result.processResult?.processes.find(
      (candidate) => candidate.entryPointId === method.id,
    );
    if (process === undefined) throw new Error(`${methodName} should start a detected process`);

    const entryStep = [...result.graph.iterRelationships()].find(
      (relationship) =>
        relationship.type === 'STEP_IN_PROCESS' &&
        relationship.sourceId === method.id &&
        relationship.targetId === process.id &&
        relationship.step === 1,
    );
    expect(entryStep, `${methodName} should be step 1 of its process`).toBeDefined();
  });
});

describe('Spring non-HTTP handler durable warm parse cache (#2417)', () => {
  it('replays identical Java/Kotlin handler metadata without spawning workers', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-spring-non-http-warm-'));
    const storage = path.join(temp, 'storage');
    try {
      const coldCache: ParseCache = {
        version: PARSE_CACHE_VERSION,
        entries: new Map(),
        usedKeys: new Set(),
        storagePath: storage,
        onDiskKeys: new Set(),
      };
      const cold = await runPipelineFromRepo(FIXTURE, () => {}, {
        skipGraphPhases: true,
        workerPoolSize: 1,
        parseCache: coldCache,
      });
      expect(cold.usedWorkerPool).toBe(true);

      pruneCache(coldCache, coldCache.usedKeys);
      const savedKeys = await saveParseCache(storage, coldCache);
      expect(savedKeys.length).toBeGreaterThan(0);
      await pruneAndSaveDurableParsedFileStore(
        getDurableParsedFileDir(storage),
        PARSE_CACHE_VERSION,
        new Set(savedKeys),
      );

      const warmCache = await loadParseCache(storage);
      expect(warmCache.onDiskKeys).toEqual(new Set(savedKeys));
      const warm = await runPipelineFromRepo(FIXTURE, () => {}, {
        skipGraphPhases: true,
        workerPoolSize: 1,
        parseCache: warmCache,
      });
      expect(warm.usedWorkerPool).toBe(false);

      const project = (pipeline: PipelineResult) =>
        [...pipeline.graph.iterNodes()]
          .filter(
            (node) =>
              (node.label === 'Method' || node.label === 'Function') &&
              node.properties.astFrameworkMultiplier === 3,
          )
          .map((node) => ({
            file: path.basename(String(node.properties.filePath)),
            name: node.properties.name,
            multiplier: node.properties.astFrameworkMultiplier,
            reason: node.properties.astFrameworkReason,
          }))
          .sort((left, right) =>
            `${left.file}#${left.name}`.localeCompare(`${right.file}#${right.name}`),
          );

      const coldMetadata = project(cold);
      expect(project(warm)).toEqual(coldMetadata);
      expect(coldMetadata).toEqual(
        expect.arrayContaining([
          {
            file: 'ScheduledJobs.java',
            name: 'refreshProjection',
            multiplier: 3,
            reason: 'spring-scheduled-handler',
          },
          {
            file: 'AliasedEvents.kt',
            name: 'onKotlinEvent',
            multiplier: 3,
            reason: 'spring-event-handler',
          },
          {
            file: 'XxlJobs.java',
            name: 'runLiteralJob',
            multiplier: 3,
            reason: 'xxl-job-handler',
          },
          {
            file: 'AliasedXxlJob.kt',
            name: 'runKotlinJob',
            multiplier: 3,
            reason: 'xxl-job-handler',
          },
          {
            file: 'SingletonHandlers.kt',
            name: 'warmSingleton',
            multiplier: 3,
            reason: 'spring-scheduled-handler',
          },
        ]),
      );
      expect(coldMetadata.some((method) => method.name === 'beanFactoryServiceActivator')).toBe(
        false,
      );
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }, 120_000);
});
