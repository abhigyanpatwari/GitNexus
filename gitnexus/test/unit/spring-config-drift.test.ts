import { describe, expect, it } from 'vitest';
import type { GraphNode } from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { collectSpringConfigConsumerDriftFiles } from '../../src/core/incremental/spring-config-drift.js';

function consumerNode(
  id: string,
  filePath: string,
  description?: string,
  label = 'Property',
): GraphNode {
  return {
    id,
    label,
    properties: {
      name: id,
      filePath,
      ...(description === undefined ? {} : { description }),
    },
  } as GraphNode;
}

describe('collectSpringConfigConsumerDriftFiles', () => {
  it('finds consumers that become unresolved after a config key is deleted', () => {
    const graph = createKnowledgeGraph();
    graph.addNode(
      consumerNode(
        'property:timeout',
        'src/main/kotlin/Service.kt',
        'Property; Spring config unresolved: service.timeout',
      ),
    );

    expect(
      collectSpringConfigConsumerDriftFiles(graph, [
        {
          id: 'property:timeout',
          description: 'Property',
        },
      ]),
    ).toEqual(new Set(['src/main/kotlin/Service.kt']));
  });

  it('finds newly unresolved consumers even when the persisted row is absent', () => {
    const graph = createKnowledgeGraph();
    graph.addNode(
      consumerNode(
        'property:timeout',
        'src/main/kotlin/Service.kt',
        'Spring config unresolved: service.timeout',
      ),
    );

    expect(collectSpringConfigConsumerDriftFiles(graph, [])).toEqual(
      new Set(['src/main/kotlin/Service.kt']),
    );
  });

  it('finds consumers that become resolved and ignores unrelated description changes', () => {
    const graph = createKnowledgeGraph();
    graph.addNode(
      consumerNode('class:service', 'src/main/kotlin/Service.kt', 'Updated docs', 'Class'),
    );
    graph.addNode(
      consumerNode('function:helper', 'src/main/kotlin/Helper.kt', undefined, 'Function'),
    );

    expect(
      collectSpringConfigConsumerDriftFiles(graph, [
        {
          id: 'class:service',
          description: 'Old docs; Spring config unresolved: service',
        },
        {
          id: 'function:helper',
          description: 'Spring config unresolved: ignored',
        },
      ]),
    ).toEqual(new Set(['src/main/kotlin/Service.kt']));
  });

  it('does not rewrite consumers whose unresolved keys are unchanged', () => {
    const graph = createKnowledgeGraph();
    graph.addNode(
      consumerNode(
        'property:timeout',
        'src/main/kotlin/Service.kt',
        'Spring config unresolved: service.timeout; Existing docs',
      ),
    );

    expect(
      collectSpringConfigConsumerDriftFiles(graph, [
        {
          id: 'property:timeout',
          description: 'Existing docs; Spring config unresolved: service.timeout',
        },
      ]),
    ).toEqual(new Set());
  });
});
