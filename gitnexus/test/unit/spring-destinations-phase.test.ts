import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import {
  setJavaSpringMessageProducerFacts,
  setJavaSpringNonHttpHandlerFacts,
} from '../../src/core/ingestion/languages/java/capture-side-channel.js';
import { SPRING_CONFIG_DESCRIPTION } from '../../src/core/ingestion/frameworks/spring/config-bindings.js';
import { destinationNodeKey } from '../../src/core/ingestion/destination-key.js';
import { springDestinationsPhase } from '../../src/core/ingestion/pipeline-phases/spring-destinations.js';
import type { SpringDestinationsOutput } from '../../src/core/ingestion/pipeline-phases/spring-destinations.js';
import type {
  PipelineContext,
  PhaseResult,
} from '../../src/core/ingestion/pipeline-phases/types.js';
import type { KnowledgeGraph } from '../../src/core/graph/types.js';
import { generateId } from '../../src/lib/utils.js';

/**
 * Phase-level cover for the things `PipelineResult` cannot show.
 *
 * `runPipelineFromRepo` returns the graph but not the phase outputs, so the
 * refusal counters — the number the feature is actually measured on — are only
 * observable by driving the phase directly. The keying rule is asserted here a
 * second time, from a hand-built pair of facts rather than from source, so a
 * regression shows up whether it comes from the resolver or from the capture.
 */

const OWNER_RANGE = { startLine: 4, startCol: 4, endLine: 6, endCol: 5 } as const;

function callableNode(graph: KnowledgeGraph, filePath: string, name: string): void {
  graph.addNode({
    id: generateId('Method', `${filePath}:${name}`),
    label: 'Method',
    properties: {
      name,
      filePath,
      // Capture ranges are 1-based; graph nodes are 0-based.
      startLine: OWNER_RANGE.startLine - 1,
      endLine: OWNER_RANGE.endLine - 1,
    },
  });
}

async function run(graph: KnowledgeGraph, files: string[]): Promise<SpringDestinationsOutput> {
  const deps = new Map<string, PhaseResult<unknown>>([
    [
      'parse',
      {
        phaseName: 'parse',
        durationMs: 0,
        // `allPaths`, matching the phase: on a run with a storage path the
        // parse phase returns an EMPTY `parsedFiles` and streams them from
        // disk instead, so the path list is the only cursor that always holds.
        output: { allPaths: files, moduleConstants: new Map() },
      },
    ],
    ['scopeResolution', { phaseName: 'scopeResolution', durationMs: 0, output: {} }],
    ['springConfig', { phaseName: 'springConfig', durationMs: 0, output: {} }],
  ]);
  const ctx = {
    repoPath: '/repo',
    graph,
    onProgress: () => {},
    pipelineStart: 0,
  } as unknown as PipelineContext;
  return springDestinationsPhase.execute(ctx, deps) as Promise<SpringDestinationsOutput>;
}

describe('springDestinations phase', () => {
  let graph: KnowledgeGraph;

  beforeEach(() => {
    graph = createKnowledgeGraph();
  });

  it('counts every refusal by reason', () => {
    // A decline that incremented nothing would be indistinguishable from a
    // success in the one measure this feature is judged on.
    const filePath = 'src/Refusals.java';
    setJavaSpringNonHttpHandlerFacts(filePath, [
      {
        ownerScopeId: `${filePath}#refuse` as never,
        ownerFilePath: filePath,
        ownerRange: OWNER_RANGE,
        annotations: [
          { name: 'KafkaListener', args: [{ name: 'topicPattern', text: '"orders.*"' }] },
          { name: 'KafkaListener', args: [{ name: 'topics', text: '{}' }] },
          { name: 'KafkaListener', args: [{ name: 'groupId', text: '"g"' }] },
          { name: 'KafkaListener' },
        ],
      },
    ]);
    setJavaSpringMessageProducerFacts(filePath, [
      {
        ownerScopeId: `${filePath}#publish` as never,
        ownerRange: OWNER_RANGE,
        template: 'kafka',
        receiverName: 'kafkaTemplate',
        methodName: 'send',
        args: [{ text: 'record' }],
      },
      {
        ownerScopeId: `${filePath}#publish2` as never,
        ownerRange: OWNER_RANGE,
        template: 'rabbit',
        receiverName: 'rabbitTemplate',
        methodName: 'convertAndSend',
        args: [{ text: 'payload' }],
      },
    ]);
    callableNode(graph, filePath, 'refuse');

    return run(graph, [filePath]).then((output) => {
      expect(output.refusalsByReason).toEqual({
        'topic-pattern': 1,
        'empty-destination-list': 1,
        'no-destination-argument': 1,
        'annotation-arguments-unavailable': 1,
        'producer-arity-unrecognized': 1,
        'rabbit-default-exchange': 1,
      });
      expect(output.resolvedDestinations).toBe(0);
      expect(output.unresolvedDestinations).toBe(0);
      expect(output.edges).toBe(0);
    });
  });

  it('keys two files that write the same placeholder to two distinct nodes', async () => {
    for (const filePath of ['src/A.java', 'src/B.java']) {
      setJavaSpringNonHttpHandlerFacts(filePath, [
        {
          ownerScopeId: `${filePath}#consume` as never,
          ownerFilePath: filePath,
          ownerRange: OWNER_RANGE,
          annotations: [
            { name: 'KafkaListener', args: [{ name: 'topics', text: '"${app.topic}"' }] },
          ],
        },
      ]);
      setJavaSpringMessageProducerFacts(filePath, []);
      callableNode(graph, filePath, 'consume');
    }

    const output = await run(graph, ['src/A.java', 'src/B.java']);
    expect(output.unresolvedDestinations).toBe(2);
    expect(output.resolvedDestinations).toBe(0);
    const nodes = [...graph.iterNodes()].filter((node) => node.label === 'Destination');
    expect(nodes).toHaveLength(2);
    expect(new Set(nodes.map((node) => node.id)).size).toBe(2);
    for (const node of nodes) {
      expect(node.properties.address).toBeUndefined();
      expect(node.properties.configKey).toBe('app.topic');
    }
  });

  it('keys two DIFFERENT placeholders in one callable to two nodes as well', async () => {
    // File plus owner line plus argument position is not unique on its own —
    // two publishes in one method share all three. Merging them would be a
    // false identity of the same kind, only smaller.
    const filePath = 'src/Two.java';
    setJavaSpringNonHttpHandlerFacts(filePath, []);
    setJavaSpringMessageProducerFacts(filePath, [
      {
        ownerScopeId: `${filePath}#publish` as never,
        ownerRange: OWNER_RANGE,
        template: 'kafka',
        receiverName: 'kafkaTemplate',
        methodName: 'send',
        args: [{ text: '"${a.topic}"' }, { text: 'payload' }],
      },
      {
        ownerScopeId: `${filePath}#publish` as never,
        ownerRange: OWNER_RANGE,
        template: 'kafka',
        receiverName: 'kafkaTemplate',
        methodName: 'send',
        args: [{ text: '"${b.topic}"' }, { text: 'payload' }],
      },
    ]);
    callableNode(graph, filePath, 'publish');

    const output = await run(graph, [filePath]);
    expect(output.unresolvedDestinations).toBe(2);
    expect(output.edges).toBe(2);
  });

  it('keys two callables that START ON ONE LINE to two nodes', async () => {
    // `void a() { k.send("${x}", p); } void b() { k.send("${x}", p); }` on one
    // line. The key used to be file + owner START LINE + argument position, so
    // both publishes landed on one node and both hung an edge off it.
    const filePath = 'src/OneLine.java';
    const range = { startLine: 3, startCol: 4, endLine: 3, endCol: 40 } as const;
    setJavaSpringNonHttpHandlerFacts(filePath, []);
    setJavaSpringMessageProducerFacts(filePath, [
      {
        ownerScopeId: `${filePath}#a` as never,
        ownerRange: range,
        template: 'kafka',
        receiverName: 'kafkaTemplate',
        methodName: 'send',
        args: [{ text: '"${app.topic}"' }, { text: 'payload' }],
      },
      {
        ownerScopeId: `${filePath}#b` as never,
        ownerRange: { ...range, startCol: 41, endCol: 80 },
        template: 'kafka',
        receiverName: 'kafkaTemplate',
        methodName: 'send',
        args: [{ text: '"${app.topic}"' }, { text: 'payload' }],
      },
    ]);
    graph.addNode({
      id: generateId('Method', `${filePath}:a`),
      label: 'Method',
      properties: { name: 'a', filePath, startLine: 2, endLine: 2 },
    });

    const output = await run(graph, [filePath]);
    expect(output.unresolvedDestinations).toBe(2);
    const nodes = [...graph.iterNodes()].filter((node) => node.label === 'Destination');
    expect(new Set(nodes.map((node) => node.id)).size).toBe(2);

    // Two identities alone would also hold if one publish had been dropped, so
    // pin the edges: two publishes, landing on two DIFFERENT destinations. That
    // is the regression — both used to hang off a single node.
    const publishes = [...graph.iterRelationshipsByType('PUBLISHES_TO')];
    expect(publishes).toHaveLength(2);
    expect(new Set(publishes.map((rel) => rel.targetId)).size).toBe(2);

    // Both edges leave the SAME callable, and that is not a defect of this
    // phase. With no scope tree here, owner resolution falls back to matching a
    // callable by line range — and the two facts, being on one line, carry the
    // same range, so the fallback can only ever name one owner for both. That
    // is precisely why destination identity must not be derived from the owner:
    // the one thing the fallback cannot distinguish is the one thing that used
    // to collapse the two publishes onto a single node.
    //
    // Adding a second Method node does NOT sharpen this. Two nodes sharing a
    // range make the lookup ambiguous, `exactCallableOwnersByRange` maps that
    // to `null` on purpose, and then NEITHER publish gets a callable — `a`
    // loses its edge as well. Real ingestion resolves through the scope tree
    // and never reaches this path.
    const methodA = generateId('Method', `${filePath}:a`);
    expect(publishes.every((rel) => rel.sourceId === methodA)).toBe(true);
  });

  it('keys two handlers apart even when neither fact carried an owner range', async () => {
    // `ownerRange` is OPTIONAL on a handler fact and required on a producer.
    // Keyed on the line alone the position degraded to 0 for the whole file and
    // every consumer in it collapsed onto one node, invisibly.
    const filePath = 'src/NoRange.java';
    setJavaSpringNonHttpHandlerFacts(filePath, [
      {
        ownerScopeId: `${filePath}#first` as never,
        ownerFilePath: filePath,
        annotations: [
          { name: 'KafkaListener', args: [{ name: 'topics', text: '"${app.topic}"' }] },
        ],
      },
      {
        ownerScopeId: `${filePath}#second` as never,
        ownerFilePath: filePath,
        annotations: [
          { name: 'KafkaListener', args: [{ name: 'topics', text: '"${app.topic}"' }] },
        ],
      },
    ]);
    setJavaSpringMessageProducerFacts(filePath, []);
    graph.addNode({
      id: generateId('File', filePath),
      label: 'File',
      properties: { name: 'NoRange.java', filePath },
    });

    const output = await run(graph, [filePath]);
    expect(output.unresolvedDestinations).toBe(2);
    const nodes = [...graph.iterNodes()].filter((node) => node.label === 'Destination');
    expect(new Set(nodes.map((node) => node.id)).size).toBe(2);
  });

  it('does not merge two config keys that share a default', async () => {
    // `${a.topic:events}` in one file and `${b.topic:events}` in another used to
    // collapse onto one `Destination:events` and report a producer/consumer
    // pair between two services that share nothing but a copy-pasted fallback.
    for (const [filePath, key] of [
      ['src/SvcA.java', 'a.topic'],
      ['src/SvcB.java', 'b.topic'],
    ] as const) {
      setJavaSpringNonHttpHandlerFacts(filePath, [
        {
          ownerScopeId: `${filePath}#consume` as never,
          ownerFilePath: filePath,
          ownerRange: OWNER_RANGE,
          annotations: [
            { name: 'KafkaListener', args: [{ name: 'topics', text: `"\${${key}:events}"` }] },
          ],
        },
      ]);
      setJavaSpringMessageProducerFacts(filePath, []);
      callableNode(graph, filePath, 'consume');
    }

    const output = await run(graph, ['src/SvcA.java', 'src/SvcB.java']);
    expect(output.resolvedDestinations).toBe(0);
    expect(output.unresolvedDestinations).toBe(2);
    const nodes = [...graph.iterNodes()].filter((node) => node.label === 'Destination');
    expect(nodes).toHaveLength(2);
    for (const node of nodes) {
      expect(node.properties.address).toBeUndefined();
      // The default is kept as provenance, so the case stays countable and
      // distinguishable from a bare `${key}`.
      expect(node.properties.configDefault).toBe('events');
      expect(node.properties.resolution).toBe('overridable-config-default');
    }
    expect(new Set(nodes.map((n) => n.properties.configKey))).toEqual(
      new Set(['a.topic', 'b.topic']),
    );
  });

  it('gives two files that write the same SpEL expression two nodes', async () => {
    for (const filePath of ['src/SpelA.java', 'src/SpelB.java']) {
      setJavaSpringNonHttpHandlerFacts(filePath, [
        {
          ownerScopeId: `${filePath}#consume` as never,
          ownerFilePath: filePath,
          ownerRange: OWNER_RANGE,
          annotations: [
            {
              name: 'KafkaListener',
              args: [{ name: 'topics', text: '"#{@kafkaProps.ordersTopic}"' }],
            },
          ],
        },
      ]);
      setJavaSpringMessageProducerFacts(filePath, []);
      callableNode(graph, filePath, 'consume');
    }

    const output = await run(graph, ['src/SpelA.java', 'src/SpelB.java']);
    expect(output.resolvedDestinations).toBe(0);
    expect(output.refusalsByReason['spel-expression']).toBe(2);
    const nodes = [...graph.iterNodes()].filter((node) => node.label === 'Destination');
    expect(nodes).toHaveLength(2);
    for (const node of nodes) expect(node.properties.address).toBeUndefined();
  });

  it('never looks a configuration key up under the empty string', async () => {
    // `${}` used to yield `configKey: ""`, and the phase then queried for it.
    const filePath = 'src/EmptyKey.java';
    graph.addNode({
      id: 'property:empty',
      label: 'Property',
      properties: { name: '', filePath: 'application.yml', description: SPRING_CONFIG_DESCRIPTION },
    });
    setJavaSpringNonHttpHandlerFacts(filePath, [
      {
        ownerScopeId: `${filePath}#consume` as never,
        ownerFilePath: filePath,
        ownerRange: OWNER_RANGE,
        annotations: [{ name: 'KafkaListener', args: [{ name: 'topics', text: '"${}"' }] }],
      },
    ]);
    setJavaSpringMessageProducerFacts(filePath, []);
    callableNode(graph, filePath, 'consume');

    const output = await run(graph, [filePath]);
    expect(output.refusalsByReason['empty-config-key']).toBe(1);
    expect(output.configKeyLinks).toBe(0);
  });

  it('JOINS a Kafka pair on an address a stranger spells the same way', async () => {
    // THE regression. Three sites on one spelling of `orders`: a real Kafka
    // pair — a publisher in one file, a listener in another, genuinely
    // connected — plus an unrelated `@RabbitListener(queues = "orders")`
    // somewhere else in the repository.
    //
    // Withdrawing the address from every site that named it made the third
    // party's word choice enough to disconnect the other two: all three were
    // keyed by site, none carried `address`, and the pair the feature exists to
    // report was split by a file that has nothing to do with either half of it.
    // With the broker in the key the pair meets on `kafka orders` and the
    // stranger gets `rabbit orders`, which costs the pair nothing.
    const publisherFile = 'src/KafkaPublisher.java';
    const listenerFile = 'src/KafkaListener.java';
    const strangerFile = 'src/UnrelatedRabbit.java';

    setJavaSpringNonHttpHandlerFacts(publisherFile, []);
    setJavaSpringMessageProducerFacts(publisherFile, [
      {
        ownerScopeId: `${publisherFile}#publish` as never,
        ownerRange: OWNER_RANGE,
        template: 'kafka',
        receiverName: 'kafkaTemplate',
        methodName: 'send',
        args: [{ text: '"orders"' }, { text: 'payload' }],
      },
    ]);
    callableNode(graph, publisherFile, 'publish');

    setJavaSpringNonHttpHandlerFacts(listenerFile, [
      {
        ownerScopeId: `${listenerFile}#consume` as never,
        ownerFilePath: listenerFile,
        ownerRange: OWNER_RANGE,
        annotations: [{ name: 'KafkaListener', args: [{ name: 'topics', text: '"orders"' }] }],
      },
    ]);
    setJavaSpringMessageProducerFacts(listenerFile, []);
    callableNode(graph, listenerFile, 'consume');

    setJavaSpringNonHttpHandlerFacts(strangerFile, [
      {
        ownerScopeId: `${strangerFile}#consume` as never,
        ownerFilePath: strangerFile,
        ownerRange: OWNER_RANGE,
        annotations: [{ name: 'RabbitListener', args: [{ name: 'queues', text: '"orders"' }] }],
      },
    ]);
    setJavaSpringMessageProducerFacts(strangerFile, []);
    callableNode(graph, strangerFile, 'consume');

    const output = await run(graph, [publisherFile, listenerFile, strangerFile]);
    // Two nodes, both fully connectable, exactly as `GET /x` and `POST /x` are
    // two Routes. Nothing is unresolved and nothing is withdrawn.
    expect(output.resolvedDestinations).toBe(2);
    expect(output.unresolvedDestinations).toBe(0);
    expect(output.edges).toBe(3);

    const nodes = [...graph.iterNodes()].filter((node) => node.label === 'Destination');
    expect(nodes).toHaveLength(2);
    const byBroker = new Map(nodes.map((node) => [String(node.properties.broker), node]));
    const kafka = byBroker.get('kafka');
    const rabbit = byBroker.get('rabbit');
    expect(kafka).toBeDefined();
    expect(rabbit).toBeDefined();
    // Both carry the join key. Withdrawing it is what used to break the pair.
    expect(kafka?.properties.address).toBe('orders');
    expect(rabbit?.properties.address).toBe('orders');
    expect(kafka?.properties.resolution).toBe('literal');
    expect(rabbit?.properties.resolution).toBe('literal');
    // Same `address`, DIFFERENT identity — the broker is what separates them.
    expect(kafka?.id).not.toBe(rabbit?.id);
    // A connecting destination carries no file, so no incremental delete of
    // the stranger's file can cut the pair's node either.
    expect(kafka?.properties.filePath).toBe('');
    expect(rabbit?.properties.filePath).toBe('');

    // Identity alone would also hold if an edge had been dropped, so pin the
    // walk itself: the publisher and the listener meet on ONE node, from two
    // different files, and the stranger is not on it.
    const edgesTo = (id: string) =>
      [...graph.iterRelationships()].filter(
        (edge) =>
          edge.targetId === id && (edge.type === 'PUBLISHES_TO' || edge.type === 'CONSUMES_FROM'),
      );
    const pair = edgesTo(kafka?.id as string);
    expect(pair.map((edge) => edge.type).sort()).toEqual(['CONSUMES_FROM', 'PUBLISHES_TO']);
    expect(new Set(pair.map((edge) => edge.sourceId)).size).toBe(2);
    expect(
      pair.map((edge) => String(graph.getNode(edge.sourceId)?.properties.filePath)).sort(),
    ).toEqual([listenerFile, publisherFile]);

    // And the stranger keeps its own edge onto its own node — the subscription
    // is a real fact, it just is not part of the pair.
    const stray = edgesTo(rabbit?.id as string);
    expect(stray.map((edge) => edge.type)).toEqual(['CONSUMES_FROM']);
    expect(graph.getNode(stray[0]?.sourceId as string)?.properties.filePath).toBe(strangerFile);
  });

  it('gives one address named by two brokers two CONNECTABLE nodes', async () => {
    // The same rule seen from the other side, and the case that used to
    // disconnect both halves: a Kafka topic and a Rabbit queue that share a
    // name are two places, so they are two nodes — but two ORDINARY nodes,
    // each keeping its `address` and each free to meet its own counterpart.
    // Nothing is refused, so `resolution` stays the resolver's own vocabulary.
    const filePath = 'src/TwoBrokers.java';
    setJavaSpringNonHttpHandlerFacts(filePath, [
      {
        ownerScopeId: `${filePath}#consume` as never,
        ownerFilePath: filePath,
        ownerRange: OWNER_RANGE,
        annotations: [{ name: 'RabbitListener', args: [{ name: 'queues', text: '"orders"' }] }],
      },
    ]);
    setJavaSpringMessageProducerFacts(filePath, [
      {
        ownerScopeId: `${filePath}#consume` as never,
        ownerRange: OWNER_RANGE,
        template: 'kafka',
        receiverName: 'kafkaTemplate',
        methodName: 'send',
        args: [{ text: '"orders"' }, { text: 'payload' }],
      },
    ]);
    callableNode(graph, filePath, 'consume');

    const output = await run(graph, [filePath]);
    expect(output.resolvedDestinations).toBe(2);
    expect(output.unresolvedDestinations).toBe(0);
    expect(output.edges).toBe(2);

    const nodes = [...graph.iterNodes()].filter((node) => node.label === 'Destination');
    expect(nodes).toHaveLength(2);
    expect(new Set(nodes.map((node) => node.id)).size).toBe(2);
    for (const node of nodes) {
      expect(node.properties.address).toBe('orders');
      expect(node.properties.name).toBe('orders');
      expect(node.properties.resolution).toBe('literal');
    }
    expect(new Set(nodes.map((node) => node.properties.broker))).toEqual(
      new Set(['kafka', 'rabbit']),
    );

    // Two edges, onto two different nodes: the publish and the subscription
    // are real, and the two-hop walk between them still finds nothing, because
    // they really are unrelated.
    const targets = [...graph.iterRelationships()]
      .filter((edge) => edge.type === 'PUBLISHES_TO' || edge.type === 'CONSUMES_FROM')
      .map((edge) => edge.targetId);
    expect(new Set(targets).size).toBe(2);
  });

  it('does not split a pair that names the SAME broker', async () => {
    // The case the whole feature exists to report: a publisher and a subscriber
    // agreeing on one address over one broker. A key that folded in anything
    // per-site — the file, the owner — would split exactly these pairs and
    // leave the feature emitting nothing but orphans.
    const filePath = 'src/Agree.java';
    setJavaSpringNonHttpHandlerFacts(filePath, [
      {
        ownerScopeId: `${filePath}#consume` as never,
        ownerFilePath: filePath,
        ownerRange: OWNER_RANGE,
        annotations: [{ name: 'KafkaListener', args: [{ name: 'topics', text: '"orders"' }] }],
      },
    ]);
    setJavaSpringMessageProducerFacts(filePath, [
      {
        ownerScopeId: `${filePath}#consume` as never,
        ownerRange: OWNER_RANGE,
        template: 'kafka',
        receiverName: 'kafkaTemplate',
        methodName: 'send',
        args: [{ text: '"orders"' }, { text: 'payload' }],
      },
    ]);
    callableNode(graph, filePath, 'consume');

    const output = await run(graph, [filePath]);
    expect(output.resolvedDestinations).toBe(1);
    expect(output.unresolvedDestinations).toBe(0);
    const nodes = [...graph.iterNodes()].filter((node) => node.label === 'Destination');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.properties.address).toBe('orders');
    expect(output.edges).toBe(2);
  });

  it('keys a second address independently of how many brokers named the first', async () => {
    // Identity is now a function of ONE site — its broker and its address — so
    // no other site can change it. This is the assertion that says so: a second
    // address in the same file, on the same broker as one of the two claimants
    // of the first, is untouched by any of it.
    const filePath = 'src/Mixed.java';
    setJavaSpringNonHttpHandlerFacts(filePath, [
      {
        ownerScopeId: `${filePath}#consume` as never,
        ownerFilePath: filePath,
        ownerRange: OWNER_RANGE,
        annotations: [
          { name: 'RabbitListener', args: [{ name: 'queues', text: '"orders"' }] },
          { name: 'KafkaListener', args: [{ name: 'topics', text: '"shipments"' }] },
        ],
      },
    ]);
    setJavaSpringMessageProducerFacts(filePath, [
      {
        ownerScopeId: `${filePath}#consume` as never,
        ownerRange: OWNER_RANGE,
        template: 'kafka',
        receiverName: 'kafkaTemplate',
        methodName: 'send',
        args: [{ text: '"orders"' }, { text: 'payload' }],
      },
      {
        ownerScopeId: `${filePath}#consume` as never,
        ownerRange: OWNER_RANGE,
        template: 'kafka',
        receiverName: 'kafkaTemplate',
        methodName: 'send',
        args: [{ text: '"shipments"' }, { text: 'payload' }],
      },
    ]);
    callableNode(graph, filePath, 'consume');

    const output = await run(graph, [filePath]);
    // `kafka orders`, `rabbit orders`, `kafka shipments`.
    expect(output.resolvedDestinations).toBe(3);
    expect(output.unresolvedDestinations).toBe(0);
    const shipments = [...graph.iterNodes()].filter(
      (node) => node.label === 'Destination' && node.properties.address === 'shipments',
    );
    // The Kafka listener and the Kafka publish of `shipments` share one node,
    // which is what the second publish above is there to check.
    expect(shipments).toHaveLength(1);
    expect(shipments[0]?.properties.broker).toBe('kafka');
  });
});

describe('destinationNodeKey', () => {
  // Tested directly rather than through the phase. The address-only branch is
  // UNREACHABLE from Spring — `SpringDestinationCandidate.broker` is required
  // and every annotation rule and producer template supplies one — so driving
  // it through a phase would mean staging a fact the capture layer cannot
  // produce, and the test would read as though the branch were live.
  it('puts a known broker in the key', () => {
    expect(destinationNodeKey('kafka', 'orders')).toBe('kafka orders');
  });

  it('keeps two brokers on one address apart', () => {
    expect(destinationNodeKey('kafka', 'orders')).not.toBe(destinationNodeKey('rabbit', 'orders'));
  });

  it('degrades to the address alone when no broker is known', () => {
    // The shape the next language gets: an address captured without a broker to
    // attest to still keys a node, because silence about the broker is not a
    // claim about it. Empty string is treated as absent for the same reason —
    // it is what a caller that has nothing to say tends to pass.
    expect(destinationNodeKey(undefined, 'orders')).toBe('orders');
    expect(destinationNodeKey('', 'orders')).toBe('orders');
  });
});

/**
 * AsyncAPI documents as a second source of destinations.
 *
 * DIRECTION IS THE ASSERTION THAT MATTERS. A swapped send/receive mapping
 * emits both edge types, both nodes, and a fully connected graph — only with
 * every arrow reversed. Any test that asserts a node or an edge EXISTS passes
 * identically under the broken mapping, so each test below names the edge TYPE
 * it expects for a given action.
 */
describe('springDestinations phase — AsyncAPI documents', () => {
  let graph: KnowledgeGraph;

  beforeEach(() => {
    graph = createKnowledgeGraph();
  });

  const KAFKA_DOCUMENT = `
asyncapi: 3.0.0
info: { title: Order Service, version: 1.0.0 }
servers:
  broker: { host: "example:9092", protocol: kafka }
channels:
  outbound:
    address: orders
    servers: [{ $ref: "#/servers/broker" }]
  inbound:
    address: shipments
    servers: [{ $ref: "#/servers/broker" }]
operations:
  publishOrder:
    action: send
    channel: { $ref: "#/channels/outbound" }
  onShipment:
    action: receive
    channel: { $ref: "#/channels/inbound" }
`;

  async function specDir(body: string = KAFKA_DOCUMENT): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'gnx-phase-spec-'));
    await writeFile(path.join(dir, 'asyncapi.yaml'), body, 'utf-8');
    return dir;
  }

  async function runWithSpec(
    files: string[],
    asyncApiSpecPath: string | undefined,
  ): Promise<SpringDestinationsOutput> {
    const deps = new Map<string, PhaseResult<unknown>>([
      [
        'parse',
        {
          phaseName: 'parse',
          durationMs: 0,
          output: { allPaths: files, moduleConstants: new Map() },
        },
      ],
      ['scopeResolution', { phaseName: 'scopeResolution', durationMs: 0, output: {} }],
      ['springConfig', { phaseName: 'springConfig', durationMs: 0, output: {} }],
    ]);
    const ctx = {
      repoPath: '/repo',
      graph,
      onProgress: () => {},
      pipelineStart: 0,
      ...(asyncApiSpecPath === undefined ? {} : { options: { asyncApiSpecPath } }),
    } as unknown as PipelineContext;
    return springDestinationsPhase.execute(ctx, deps) as Promise<SpringDestinationsOutput>;
  }

  function edgesFrom(address: string): { type: string; sourceId: string }[] {
    const target = generateId('Destination', destinationNodeKey('kafka', address));
    return [...graph.iterRelationships()]
      .filter((r) => r.targetId === target)
      .map((r) => ({ type: r.type, sourceId: r.sourceId }));
  }

  it('maps `send` to PUBLISHES_TO and `receive` to CONSUMES_FROM', async () => {
    const output = await runWithSpec([], await specDir());

    expect(output.specDocuments?.operations).toBe(2);
    expect(output.specDocuments?.destinations).toBe(2);
    expect(output.specDocuments?.edges).toBe(2);

    // Swapping the mapping would leave both of these arrays non-empty and both
    // nodes present; only the TYPE distinguishes the two readings.
    expect(edgesFrom('orders').map((e) => e.type)).toEqual(['PUBLISHES_TO']);
    expect(edgesFrom('shipments').map((e) => e.type)).toEqual(['CONSUMES_FROM']);
  });

  it('gives a spec-minted destination NO file path, and its own provenance', async () => {
    await runWithSpec([], await specDir());
    const node = [...graph.iterNodes()].find(
      (n) => n.id === generateId('Destination', destinationNodeKey('kafka', 'orders')),
    );
    // `filePath: ''` is load-bearing, not cosmetic: a connecting destination is
    // shared by every site that names it, and the incremental writeback deletes
    // by file. Stamping it with the document's path would make a shared node
    // collateral damage of that document's next change, taking every OTHER
    // referrer's edge with it via DETACH DELETE.
    expect(node?.properties.filePath).toBe('');
    // Distinct from `'specification'`, which belongs to the address cascade and
    // means a CODE candidate was resolved through the step-4 hook — a claim
    // about source that this node is not making.
    expect(node?.properties.resolution).toBe('asyncapi-document');
  });

  it('reads documents even when the source pass found no messaging at all', async () => {
    // The early return used to be keyed on source sites alone. A repository
    // whose broker this codebase has no patterns for is exactly the case a
    // published document covers, so skipping documents there would drop the
    // feature where it is most needed.
    const output = await runWithSpec([], await specDir());
    expect(output.resolvedDestinations).toBe(0);
    expect(output.specDocuments?.destinations).toBe(2);
  });

  it('lands a document and a source site on ONE node for one (broker, address)', async () => {
    const filePath = 'src/Orders.java';
    setJavaSpringNonHttpHandlerFacts(filePath, []);
    setJavaSpringMessageProducerFacts(filePath, [
      {
        ownerScopeId: `${filePath}#publish` as never,
        ownerRange: OWNER_RANGE,
        template: 'kafka',
        receiverName: 'kafkaTemplate',
        methodName: 'send',
        args: [{ text: '"orders"' }, { text: 'payload' }],
      },
    ]);
    callableNode(graph, filePath, 'publish');

    const output = await runWithSpec([filePath], await specDir());

    const nodeId = generateId('Destination', destinationNodeKey('kafka', 'orders'));
    const nodes = [...graph.iterNodes()].filter((n) => n.id === nodeId);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].properties.address).toBe('orders');
    // The source pass ran first and owns the provenance; the document joined
    // its node rather than minting a second one.
    expect(nodes[0].properties.resolution).toBe('literal');
    expect(output.resolvedDestinations).toBe(1);
    expect(output.specDocuments?.destinations).toBe(1);
    // Two edges into one node — the publisher's and the document's — which is
    // the whole point: both halves of a conversation meet on one node. Asserted
    // by TYPE rather than by count: a count of two survives a reversal in
    // either of the two paths that produced them.
    expect(edgesFrom('orders').map((e) => e.type)).toEqual(['PUBLISHES_TO', 'PUBLISHES_TO']);
  });

  it('hangs the edge off the document’s REAL File node when it is in the repo', async () => {
    // The in-repo branch is the one the code calls "strictly better", and it is
    // the branch that decides whether the graph grows a permanent pseudo-File
    // node per document. Without a test, deleting it is invisible.
    const dir = await specDir();
    // `repoPath` is the fixture directory, so the document resolves inside it.
    const deps = new Map<string, PhaseResult<unknown>>([
      ['parse', { phaseName: 'parse', durationMs: 0, output: { allPaths: [], moduleConstants: new Map() } }],
      ['scopeResolution', { phaseName: 'scopeResolution', durationMs: 0, output: {} }],
      ['springConfig', { phaseName: 'springConfig', durationMs: 0, output: {} }],
    ]);
    const ctx = {
      repoPath: dir,
      graph,
      onProgress: () => {},
      pipelineStart: 0,
      options: { asyncApiSpecPath: 'asyncapi.yaml' },
    } as unknown as PipelineContext;
    // The document sits at <dir>/asyncapi.yaml, so its repo-relative path is
    // `asyncapi.yaml`; register that File node and expect the edge to use it.
    const inRepoId = generateId('File', 'asyncapi.yaml');
    graph.addNode({
      id: inRepoId,
      label: 'File',
      properties: { name: 'asyncapi.yaml', filePath: 'asyncapi.yaml' },
    });
    await springDestinationsPhase.execute(ctx, deps);
    const [edge] = edgesFrom('orders');
    expect(edge.sourceId).toBe(inRepoId);
    expect(edge.sourceId).not.toBe(generateId('File', 'asyncapi:asyncapi.yaml'));
  });

  it('never lets a document give an unresolved destination an address', async () => {
    const filePath = 'src/Placeholder.java';
    setJavaSpringNonHttpHandlerFacts(filePath, [
      {
        ownerScopeId: `${filePath}#consume` as never,
        ownerFilePath: filePath,
        ownerRange: OWNER_RANGE,
        annotations: [{ name: 'KafkaListener', args: [{ name: 'topics', text: '"${app.topic}"' }] }],
      },
    ]);
    setJavaSpringMessageProducerFacts(filePath, []);
    callableNode(graph, filePath, 'consume');

    const output = await runWithSpec([filePath], await specDir());

    expect(output.unresolvedDestinations).toBe(1);
    const unresolved = [...graph.iterNodes()].filter(
      (n) => n.label === 'Destination' && n.properties.resolution === 'unresolved-config-key',
    );
    expect(unresolved).toHaveLength(1);
    // The document names real addresses, and one of them may even be the value
    // behind this placeholder — but nothing here knows that, so the node keeps
    // its location key and stays unjoinable.
    expect(unresolved[0].properties.address).toBeUndefined();
  });

  it('hangs the edge off a synthetic File when the document is outside the repo', async () => {
    await runWithSpec([], await specDir());
    const [edge] = edgesFrom('orders');
    const source = [...graph.iterNodes()].find((n) => n.id === edge.sourceId);
    expect(source?.label).toBe('File');
    expect(String(source?.properties.filePath)).toBe('asyncapi:asyncapi.yaml');
  });

  it('omits the stats block entirely when no path was configured', async () => {
    // Absent must stay distinguishable from "configured and found nothing":
    // a mistyped directory and a repository with no documents need different
    // answers from an operator, and one zero cannot say which happened.
    const output = await runWithSpec([], undefined);
    expect(output.specDocuments).toBeUndefined();
    expect('specDocuments' in output).toBe(false);
  });

  it('reports a configured path that yielded nothing, rather than staying silent', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'gnx-phase-spec-empty-'));
    const output = await runWithSpec([], empty);
    expect(output.specDocuments).toEqual({
      symlinksSkipped: 0,
      truncated: false,
      scanned: 0,
      accepted: 0,
      operations: 0,
      destinations: 0,
      edges: 0,
      refusalsByReason: {},
    });
  });
});
