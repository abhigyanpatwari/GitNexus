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
        annotations: [{ name: 'KafkaListener', args: [{ name: 'topics', text: '"${app.topic}"' }] }],
      },
      {
        ownerScopeId: `${filePath}#second` as never,
        ownerFilePath: filePath,
        annotations: [{ name: 'KafkaListener', args: [{ name: 'topics', text: '"${app.topic}"' }] }],
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

  it('records a broker disagreement instead of merging or dropping it', async () => {
    // The broker is inferred from a receiver's NAME, so a disagreement is far
    // more likely to be a bad guess than two brokers sharing an address —
    // and dropping the node would delete a connection the two sides agree on.
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
    expect(output.brokerConflicts).toBe(1);
    expect(output.resolvedDestinations).toBe(1);
    // Both edges survive: the connection is what the two sides agree on.
    expect(output.edges).toBe(2);
    const node = [...graph.iterNodes()].find((candidate) => candidate.label === 'Destination');
    expect(node?.properties.brokerConflict).toBe('kafka,rabbit');
    expect(node?.properties.address).toBe('orders');
  });
});
