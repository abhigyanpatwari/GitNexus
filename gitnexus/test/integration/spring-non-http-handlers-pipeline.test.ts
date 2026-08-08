import path from 'node:path';
import type { GraphNode } from 'gitnexus-shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../src/types/pipeline.js';

const FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'spring-non-http-handler-app');

describe('Spring non-HTTP handler entry points (#2417)', () => {
  let result: PipelineResult;
  const methods = new Map<string, GraphNode>();

  beforeAll(async () => {
    result = await runPipelineFromRepo(FIXTURE, () => {}, {});
    result.graph.forEachNode((node) => {
      if (node.label === 'Method') methods.set(node.properties.name, node);
    });
  }, 60_000);

  function methodNamed(name: string): GraphNode {
    const method = methods.get(name);
    if (method === undefined) throw new Error(`${name} should be extracted`);
    return method;
  }

  it.each([
    ['refreshProjection', 'spring-scheduled-handler'],
    ['onOrderCreated', 'spring-event-handler'],
    ['consumeOrder', 'spring-message-handler'],
    ['onKotlinEvent', 'spring-event-handler'],
    ['runLiteralJob', 'xxl-job-handler'],
    ['runConstantJob', 'xxl-job-handler'],
    ['runKotlinJob', 'xxl-job-handler'],
    ['refreshAfterEvent', 'spring-non-http-handler'],
  ])('marks %s as a framework-managed process entry point', (methodName, reason) => {
    const method = methodNamed(methodName);
    expect(method.properties.astFrameworkMultiplier).toBe(3);
    expect(method.properties.astFrameworkReason).toBe(reason);
  });

  it.each(['fakeEventHandler', 'fakeXxlJobHandler'])(
    'fails closed for the same-name annotation on %s imported from an unrelated package',
    (methodName) => {
      const method = methodNamed(methodName);
      expect(method.properties.astFrameworkMultiplier).toBeUndefined();
      expect(method.properties.astFrameworkReason).toBeUndefined();
    },
  );

  it.each(['interfaceEvent', 'targetedReceiverIsNotAHandler'])(
    'does not promote excluded callable %s into a provider entry point',
    (methodName) => {
      const method = methodNamed(methodName);
      expect(method.properties.astFrameworkMultiplier).toBeUndefined();
      expect(method.properties.astFrameworkReason).toBeUndefined();
    },
  );

  it('preserves an existing same-strength framework reason', () => {
    const method = methodNamed('consumeOverWebSocket');
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
    'refreshProjection',
    'onOrderCreated',
    'consumeOrder',
    'onKotlinEvent',
    'runLiteralJob',
    'runConstantJob',
    'runKotlinJob',
    'refreshAfterEvent',
  ])('starts process/context output from %s', (methodName) => {
    const method = methodNamed(methodName);
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
