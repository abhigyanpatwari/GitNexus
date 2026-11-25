import { compareCodeUnits } from '../../compare.mjs';
import assert from 'node:assert/strict';
import { runtimeParseIdentity, springFixture } from '../spring-support.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../../../dist/core/ingestion/pipeline.js';
import {
  getJavaSpringMessageProducerFacts,
  getJavaSpringNonHttpHandlerFacts,
} from '../../../../dist/core/ingestion/languages/java/capture-side-channel.js';
import {
  getKotlinSpringMessageProducerFacts,
  getKotlinSpringNonHttpHandlerFacts,
} from '../../../../dist/core/ingestion/languages/kotlin/capture-side-channel.js';
import {
  loadParseCache,
  pruneCache,
  saveParseCache,
} from '../../../../dist/storage/parse-cache.js';
import {
  getDurableParsedFileDir,
  pruneAndSaveDurableParsedFileStore,
} from '../../../../dist/storage/parsedfile-store.js';
import { isDeepStrictEqual } from 'node:util';
function messagingFileRows(filePath, java) {
  const rows = [];
  const file = path.basename(filePath);
  const producers = java
    ? getJavaSpringMessageProducerFacts(filePath)
    : getKotlinSpringMessageProducerFacts(filePath);
  for (const producer of producers) {
    rows.push({
      kind: 'producer',
      file,
      detail: `${producer.template} ${producer.receiverName}.${producer.methodName}`,
      ...(producer.args === undefined
        ? {}
        : {
            args: producer.args,
          }),
    });
  }
  const handlers = java
    ? getJavaSpringNonHttpHandlerFacts(filePath)
    : getKotlinSpringNonHttpHandlerFacts(filePath);
  for (const handler of handlers) {
    for (const annotation of handler.annotations) {
      rows.push({
        kind: 'annotation',
        file,
        detail: annotation.name,
        ...(annotation.args === undefined
          ? {}
          : {
              args: annotation.args,
            }),
      });
    }
  }
  return rows;
}

function messagingSnapshot(pipeline) {
  const filePaths = new Set();
  for (const node of pipeline.graph.iterNodes()) {
    const filePath = node.properties.filePath;
    if (typeof filePath === 'string') filePaths.add(filePath);
  }
  const rows = [];
  for (const filePath of [...filePaths].sort(compareCodeUnits)) {
    const java = filePath.endsWith('.java');
    const kotlin = filePath.endsWith('.kt');
    if (!java && !kotlin) continue;
    rows.push(...messagingFileRows(filePath, java));
  }
  return rows;
}

export async function verifyNonHttpHandlers() {
  const parseIdentity = await runtimeParseIdentity();
  const FIXTURE = springFixture('spring-non-http-handler-app');
  /**
   * Every Spring messaging fact the capture side channels hold for a pipeline
   * run, keyed by the file paths that run actually produced.
   *
   * Deliberately covers BOTH fact families. A snapshot of only the new producer
   * list would still match after a change that stopped capturing the handler
   * annotations it sits next to.
   */

  // Spring non-HTTP handler entry points (#2417)

  let methods;
  function methodNamed(name, fileSuffix) {
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
  /** Capture facts are keyed by the same file path the graph records. */
  function filePathOf(methodName, fileSuffix) {
    return String(methodNamed(methodName, fileSuffix).properties.filePath);
  }
  const result = await runPipelineFromRepo(FIXTURE, () => {}, {}); // Kotlin enum members currently use the graph's Function label; they are
  // still class-owned callables and participate in process detection.
  methods = [...result.graph.iterNodes()].filter(
    (node) => node.label === 'Method' || node.label === 'Function',
  );
  // marks %s in %s as a framework-managed process entry point
  for (const [methodName, file, reason] of [
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
  ]) {
    const method = methodNamed(methodName, file);
    assert.equal(method.properties.astFrameworkMultiplier, 3);
    assert.equal(method.properties.astFrameworkReason, reason);
  }
  // fails closed for the same-name annotation on %s in %s imported from an unrelated package
  for (const [methodName, file] of [
    ['fakeEventHandler', 'CustomAnnotationHandler.java'],
    ['fakeXxlJobHandler', 'CustomAnnotationHandler.java'],
  ]) {
    const method = methodNamed(methodName, file);
    assert.equal(method.properties.astFrameworkMultiplier, undefined);
    assert.equal(method.properties.astFrameworkReason, undefined);
  }
  // does not promote excluded callable %s in %s into a provider entry point
  for (const [methodName, file] of [
    ['interfaceEvent', 'ListenerContract.kt'],
    ['targetedReceiverIsNotAHandler', 'UseSiteTarget.kt'],
    ['beanFactoryServiceActivator', 'ServiceActivators.java'],
  ]) {
    const method = methodNamed(methodName, file);
    assert.equal(method.properties.astFrameworkMultiplier, undefined);
    assert.equal(method.properties.astFrameworkReason, undefined);
  }
  // preserves an existing same-strength framework reason

  const method = methodNamed('consumeOverWebSocket', 'MessageConsumers.java');
  assert.equal(method.properties.astFrameworkMultiplier, 3);
  assert.equal(method.properties.astFrameworkReason, 'jaxrs-annotation');
  // carries Java annotation arguments across the worker boundary
  {
    const facts = getJavaSpringNonHttpHandlerFacts(
      filePathOf('consumeOrder', 'MessageConsumers.java'),
    );
    const observed = facts.flatMap((fact) => fact.annotations.map((a) => [a.name, a.args]));
    for (const row of [
      [
        'KafkaListener',
        [
          {
            name: 'topics',
            text: '"orders"',
          },
        ],
      ],
    ])
      assert.ok(
        observed.some((item) => isDeepStrictEqual(item, row)),
        'Missing row ' + JSON.stringify(row),
      );
  }
  // carries Kotlin annotation arguments across the worker boundary
  {
    const facts = getKotlinSpringNonHttpHandlerFacts(
      filePathOf('consumeEnumMessage', 'SingletonHandlers.kt'),
    );
    const observed = facts.flatMap((fact) => fact.annotations.map((a) => [a.name, a.args]));
    for (const row of [
      [
        'KafkaListener',
        [
          {
            name: 'topics',
            text: '["enum-orders"]',
          },
        ],
      ],
      // A marker annotation ships no argument list at all.
      ['EventListener', undefined],
    ])
      assert.ok(
        observed.some((item) => isDeepStrictEqual(item, row)),
        'Missing row ' + JSON.stringify(row),
      );
  }
  // carries %s producer facts across the worker boundary
  for (const [file, method, getFacts, expected] of [
    [
      'OrderPublishers.java',
      'publishLiteralDestination',
      getJavaSpringMessageProducerFacts,
      [
        '"orders"',
        'SHIPMENTS_TOPIC',
        'ordersTopic',
        'exchange',
        '"queue.orders"',
        '"orders-out-0"',
      ],
    ],
    [
      'OrderPublishers.kt',
      'publishLiteralDestination',
      getKotlinSpringMessageProducerFacts,
      [
        '"orders"',
        'Destinations.SHIPMENTS',
        'ordersTopic',
        'exchange',
        '"queue.orders"',
        '"orders-out-0"',
      ],
    ],
  ]) {
    const facts = getFacts(filePathOf(method, file));
    const observed = facts.map((fact) => fact.template);
    for (const row of ['kafka', 'rabbit', 'jms', 'stream-bridge'])
      assert.ok(
        observed.some((item) => isDeepStrictEqual(item, row)),
        'Missing row ' + JSON.stringify(row),
      );
    // A literal, a constant, and a configuration-backed name all yield a fact,
    // and none of them is resolved at capture time.
    assert.deepStrictEqual(
      facts.map((fact) => fact.args?.[0]?.text),
      expected,
    );
  }
  // does not model non-HTTP framework handlers as HTTP routes

  const routes = [];
  result.graph.forEachNode((node) => {
    if (node.label === 'Route') routes.push(node);
  });
  assert.deepStrictEqual(routes, []);
  // starts process/context output from %s in %s
  for (const [methodName, file] of [
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
  ]) {
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
    assert.notEqual(entryStep, undefined, `${methodName} should be step 1 of its process`);
  }
  // Spring non-HTTP handler durable warm parse cache (#2417)

  // replays identical Java/Kotlin handler metadata without spawning workers

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-spring-non-http-warm-'));
  const storage = path.join(temp, 'storage');
  try {
    const coldCache = {
      identity: parseIdentity,
      entries: new Map(),
      usedKeys: new Set(),
      storagePath: storage,
      writeStoragePath: storage,
      onDiskKeys: new Set(),
    };
    const cold = await runPipelineFromRepo(FIXTURE, () => {}, {
      skipGraphPhases: true,
      workerPoolSize: 1,
      parseCache: coldCache,
    });
    assert.equal(cold.usedWorkerPool, true);
    // The side-channel stores are keyed by file path and hold only the most
    // recent run, so the cold snapshot has to be taken before the warm run
    // overwrites them.
    const coldMessaging = messagingSnapshot(cold);
    pruneCache(coldCache, coldCache.usedKeys);
    const savedKeys = await saveParseCache(storage, coldCache);
    assert.ok(savedKeys.length > 0);
    await pruneAndSaveDurableParsedFileStore(
      getDurableParsedFileDir(storage),
      parseIdentity.base,
      new Set(savedKeys),
    );
    const warmCache = await loadParseCache(storage, parseIdentity, storage);
    assert.deepStrictEqual(warmCache.onDiskKeys, new Set(savedKeys));
    const warm = await runPipelineFromRepo(FIXTURE, () => {}, {
      skipGraphPhases: true,
      workerPoolSize: 1,
      parseCache: warmCache,
    });
    assert.equal(warm.usedWorkerPool, false);

    // A warm run replays worker output verbatim, so the messaging facts have
    // to survive the ParsedFile round trip exactly.
    assert.deepStrictEqual(messagingSnapshot(warm), coldMessaging);

    // Equality alone would also hold for two empty snapshots, and a snapshot
    // pooled across languages would let a Java regression hide behind Kotlin
    // rows, so each family is pinned per language and by content.
    const rowsIn = (file, kind) =>
      coldMessaging.filter((row) => row.file === file && row.kind === kind);
    assert.deepStrictEqual(
      rowsIn('OrderPublishers.java', 'producer').map((row) => row.detail),
      [
        'kafka kafkaTemplate.send',
        'kafka this.kafkaTemplate.send',
        'kafka kafkaTemplate.send',
        'rabbit rabbitTemplate.convertAndSend',
        'jms jmsTemplate.convertAndSend',
        'stream-bridge streamBridge.send',
      ],
    );
    assert.deepStrictEqual(
      rowsIn('OrderPublishers.kt', 'producer').map((row) => row.detail),
      [
        'kafka kafkaTemplate.send',
        'kafka this.kafkaTemplate.send',
        'kafka kafkaTemplate.send',
        'rabbit rabbitTemplate.convertAndSend',
        'jms jmsTemplate.convertAndSend',
        'stream-bridge streamBridge.send',
      ],
    );
    // A literal, a constant, and a configuration-backed name all survive the
    // round trip unresolved.
    assert.deepStrictEqual(
      rowsIn('OrderPublishers.java', 'producer').map((row) => row.args?.[0]?.text),
      [
        '"orders"',
        'SHIPMENTS_TOPIC',
        'ordersTopic',
        'exchange',
        '"queue.orders"',
        '"orders-out-0"',
      ],
    );
    // Both languages must still carry annotation arguments, and an annotation
    // written without an argument list stays distinguishable from one written
    // with an empty list.
    assert.equal(
      rowsIn('MessageConsumers.java', 'annotation').some((row) => row.args !== undefined),
      true,
    );
    assert.equal(
      rowsIn('SingletonHandlers.kt', 'annotation').some((row) => row.args !== undefined),
      true,
    );
    assert.equal(
      rowsIn('SingletonHandlers.kt', 'annotation').some((row) => row.args === undefined),
      true,
    );
    const project = (pipeline) =>
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
    assert.deepStrictEqual(project(warm), coldMetadata);
    const observed = coldMetadata;
    for (const row of [
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
    ])
      assert.ok(
        observed.some((item) => isDeepStrictEqual(item, row)),
        'Missing row ' + JSON.stringify(row),
      );
    assert.equal(
      coldMetadata.some((method) => method.name === 'beanFactoryServiceActivator'),
      false,
    );
  } finally {
    fs.rmSync(temp, {
      recursive: true,
      force: true,
    });
  }
}
