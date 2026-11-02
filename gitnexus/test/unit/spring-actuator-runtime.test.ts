import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import {
  importSpringActuatorRuntime,
  MAX_RUNTIME_RECORDS,
} from '../../src/core/ingestion/frameworks/spring/actuator-runtime.js';
import type { GraphNode } from 'gitnexus-shared';

describe('Spring Actuator runtime import bounds', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports mappings truncated at the runtime record limit', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-actuator-cap-'));
    tempDirs.push(repo);
    const entries = Array.from({ length: MAX_RUNTIME_RECORDS + 1 }, () => ({
      predicate: '{GET [/bounded]}',
      details: {
        requestMappingConditions: { methods: ['GET'], patterns: ['/bounded'] },
      },
    }));
    fs.writeFileSync(
      path.join(repo, 'mappings.json'),
      JSON.stringify({
        contexts: {
          application: {
            mappings: { dispatcherServlets: { dispatcherServlet: entries } },
          },
        },
      }),
    );

    const stats = await importSpringActuatorRuntime(createKnowledgeGraph(), repo, 'mappings.json');

    expect(stats.mappings).toBe(1);
    expect(stats.truncatedEndpoints).toEqual(['mappings']);
  });

  it('does not confirm duplicate runtime routes whose resolved handlers disagree', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-actuator-conflict-'));
    tempDirs.push(repo);
    fs.writeFileSync(
      path.join(repo, 'mappings.json'),
      JSON.stringify({
        contexts: {
          parent: {
            mappings: {
              dispatcherServlets: {
                dispatcherServlet: [runtimeMapping('com.example.ParentController')],
              },
            },
          },
          child: {
            mappings: {
              dispatcherServlets: {
                dispatcherServlet: [runtimeMapping('com.example.ChildController')],
              },
            },
          },
        },
      }),
    );
    const graph = createKnowledgeGraph();
    for (const [ownerName, methodId] of [
      ['ParentController', 'Method:parent'],
      ['ChildController', 'Method:child'],
    ] as const) {
      const ownerId = `Class:${ownerName}`;
      graph.addNode(
        node(ownerId, 'Class', ownerName, `${ownerName}.java`, {
          qualifiedName: `com.example.${ownerName}`,
        }),
      );
      graph.addNode(
        node(methodId, 'Method', 'list', `${ownerName}.java`, {
          parameterCount: 0,
          parameterTypes: [],
        }),
      );
      graph.addRelationship({
        id: `HAS_METHOD:${ownerId}:${methodId}`,
        sourceId: ownerId,
        targetId: methodId,
        type: 'HAS_METHOD',
        confidence: 1,
        reason: 'test',
      });
    }

    await importSpringActuatorRuntime(graph, repo, 'mappings.json');
    const route = [...graph.iterNodes()].find(
      (candidate) =>
        candidate.label === 'Route' && candidate.properties.name === '/context-conflict',
    );

    expect(route?.properties).toMatchObject({
      runtimeConfirmed: false,
      runtimeSource: 'spring-actuator',
      runtimeStatus: 'handler-conflict',
    });
    expect(route?.properties.handlerSymbolId).toBeUndefined();
    expect(
      [...graph.iterRelationshipsByType('HANDLES_ROUTE')].some(
        (edge) => edge.targetId === route?.id,
      ),
    ).toBe(false);
  });
});

function runtimeMapping(className: string) {
  return {
    predicate: '{GET [/context-conflict]}',
    details: {
      handlerMethod: {
        className,
        name: 'list',
        descriptor: '()Ljava/lang/String;',
      },
      requestMappingConditions: {
        methods: ['GET'],
        patterns: ['/context-conflict'],
      },
    },
  };
}

function node(
  id: string,
  label: GraphNode['label'],
  name: string,
  filePath: string,
  properties: Record<string, unknown>,
): GraphNode {
  return {
    id,
    label,
    properties: { name, filePath, ...properties },
  };
}
