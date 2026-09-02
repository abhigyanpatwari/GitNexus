import { beforeEach, describe, expect, it } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import {
  setJavaSpringMessageProducerFacts,
  setJavaSpringNonHttpHandlerFacts,
} from '../../src/core/ingestion/languages/java/capture-side-channel.js';
import { SPRING_CONFIG_DESCRIPTION } from '../../src/core/ingestion/frameworks/spring/config-bindings.js';
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

  it('DISCONNECTS an address two brokers claim, and says why on both nodes', async () => {
    // A Kafka topic and a Rabbit queue that share a name are two places. Keyed
    // on the address they were one node, and an ordinary PUBLISHES_TO /
    // CONSUMES_FROM traversal then reported a connection between a publisher
    // and a subscriber that have nothing to do with each other. The
    // `brokerConflict` property this used to write does not prevent that: a
    // flag on the node does not un-join the edges that already landed on it.
    //
    // So both sides are keyed by SITE and neither carries `address` — the join
    // is impossible rather than merely discouraged. The diagnosis survives on
    // both nodes, which is the half a plain "drop the node" would have lost.
    const filePath = 'src/Conflict.java';
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
    // One ADDRESS in conflict, two nodes minted for it, and neither connects.
    expect(output.brokerConflicts).toBe(1);
    expect(output.resolvedDestinations).toBe(0);
    expect(output.unresolvedDestinations).toBe(2);

    const nodes = [...graph.iterNodes()].filter((node) => node.label === 'Destination');
    expect(nodes).toHaveLength(2);
    expect(new Set(nodes.map((node) => node.id)).size).toBe(2);
    for (const node of nodes) {
      // The structural half: no `address`, so no join by address is possible.
      expect(node.properties.address).toBeUndefined();
      // The diagnostic half: both brokers, named, on both nodes.
      expect(node.properties.brokerConflict).toBe('kafka,rabbit');
      expect(node.properties.resolution).toBe('broker-conflict');
      // The address itself is perfectly readable; only its broker is in doubt.
      expect(node.properties.name).toBe('orders');
      // Keyed by site means owned by a file, like every other site-keyed node.
      expect(node.properties.filePath).toBe(filePath);
    }
    expect(new Set(nodes.map((node) => node.properties.broker))).toEqual(
      new Set(['kafka', 'rabbit']),
    );

    // Both edges are still emitted — each side really does publish to or
    // consume from SOMETHING — but they now land on different nodes, so the
    // two-hop walk that used to connect the two sides finds nothing.
    expect(output.edges).toBe(2);
    const targets = [...graph.iterRelationships()]
      .filter((edge) => edge.type === 'PUBLISHES_TO' || edge.type === 'CONSUMES_FROM')
      .map((edge) => edge.targetId);
    expect(new Set(targets).size).toBe(2);
  });

  it('does not disconnect when both sides name the SAME broker', async () => {
    // The negative half of the rule above, and the case the whole feature
    // exists to report: a publisher and a subscriber agreeing on one address
    // over one broker. A conflict test that fired on a repeated broker rather
    // than a DIFFERING one would split exactly these pairs and leave the
    // feature emitting nothing but orphans.
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
    expect(output.brokerConflicts).toBe(0);
    expect(output.resolvedDestinations).toBe(1);
    expect(output.unresolvedDestinations).toBe(0);
    const nodes = [...graph.iterNodes()].filter((node) => node.label === 'Destination');
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.properties.address).toBe('orders');
    expect(nodes[0]?.properties.brokerConflict).toBeUndefined();
    expect(output.edges).toBe(2);
  });

  it('leaves an unrelated address alone when another one conflicts', async () => {
    // The conflict is decided per ADDRESS, in a pass of its own. A pass that
    // tracked the disagreement at any coarser grain — per file, per broker —
    // would take a working destination down with the broken one.
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
    expect(output.brokerConflicts).toBe(1);
    const shipments = [...graph.iterNodes()].filter(
      (node) => node.label === 'Destination' && node.properties.address === 'shipments',
    );
    expect(shipments).toHaveLength(1);
    expect(shipments[0]?.properties.brokerConflict).toBeUndefined();
    expect(output.resolvedDestinations).toBe(1);
    expect(output.unresolvedDestinations).toBe(2);
  });
});
