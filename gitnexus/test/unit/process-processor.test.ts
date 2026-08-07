import { describe, it, expect, vi } from 'vitest';
import {
  processProcesses,
  traceFromEntryPoint,
  buildSinkFunctionSet,
  type ProcessDetectionConfig,
} from '../../src/core/ingestion/process-processor.js';
import { computeDynamicMaxProcesses } from '../../src/core/ingestion/pipeline-phases/processes.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { CommunityMembership } from '../../src/core/ingestion/community-processor.js';

describe('processProcesses', () => {
  it('detects no processes in empty graph', async () => {
    const graph = createKnowledgeGraph();
    const result = await processProcesses(graph, []);
    expect(result.processes).toHaveLength(0);
    expect(result.steps).toHaveLength(0);
    expect(result.stats.totalProcesses).toBe(0);
    expect(result.stats.entryPointsFound).toBe(0);
    expect(result.stats.avgStepCount).toBe(0);
  });

  it('detects no processes when there are no CALLS relationships', async () => {
    const graph = createKnowledgeGraph();
    graph.addNode({
      id: 'func:main',
      label: 'Function',
      properties: {
        name: 'main',
        filePath: 'src/index.ts',
        startLine: 1,
        endLine: 10,
        isExported: true,
      },
    });

    const result = await processProcesses(graph, []);
    expect(result.processes).toHaveLength(0);
  });

  it('detects a simple 3-step process with correct structure', async () => {
    const graph = createKnowledgeGraph();

    // Create 3 functions in a chain
    graph.addNode({
      id: 'func:handleRequest',
      label: 'Function',
      properties: {
        name: 'handleRequest',
        filePath: 'src/handler.ts',
        startLine: 1,
        endLine: 10,
        isExported: true,
      },
    });
    graph.addNode({
      id: 'func:validateInput',
      label: 'Function',
      properties: {
        name: 'validateInput',
        filePath: 'src/validator.ts',
        startLine: 1,
        endLine: 5,
        isExported: true,
      },
    });
    graph.addNode({
      id: 'func:saveToDb',
      label: 'Function',
      properties: {
        name: 'saveToDb',
        filePath: 'src/db.ts',
        startLine: 1,
        endLine: 8,
        isExported: true,
      },
    });

    // handleRequest -> validateInput -> saveToDb
    graph.addRelationship({
      id: 'call:1',
      sourceId: 'func:handleRequest',
      targetId: 'func:validateInput',
      type: 'CALLS',
      confidence: 0.9,
      reason: 'import-resolved',
    });
    graph.addRelationship({
      id: 'call:2',
      sourceId: 'func:validateInput',
      targetId: 'func:saveToDb',
      type: 'CALLS',
      confidence: 0.9,
      reason: 'import-resolved',
    });

    const memberships: CommunityMembership[] = [
      { nodeId: 'func:handleRequest', communityId: 'community:0' },
      { nodeId: 'func:validateInput', communityId: 'community:0' },
      { nodeId: 'func:saveToDb', communityId: 'community:0' },
    ];

    const result = await processProcesses(graph, memberships);

    // Must detect at least one process
    expect(result.processes.length).toBeGreaterThan(0);

    // Find the process starting from handleRequest
    const process = result.processes.find((p) => p.entryPointId === 'func:handleRequest');
    expect(process).toBeDefined();
    expect(process!.stepCount).toBe(3);
    expect(process!.entryPointId).toBe('func:handleRequest');
    expect(process!.terminalId).toBe('func:saveToDb');
    expect(process!.processType).toBe('intra_community');
    expect(process!.communities).toEqual(['community:0']);

    // Verify trace order: entry -> middle -> terminal
    expect(process!.trace).toEqual(['func:handleRequest', 'func:validateInput', 'func:saveToDb']);

    // Verify steps are 1-indexed and in correct order
    const processSteps = result.steps.filter((s) => s.processId === process!.id);
    expect(processSteps).toHaveLength(3);
    expect(processSteps[0]).toEqual(
      expect.objectContaining({ nodeId: 'func:handleRequest', step: 1 }),
    );
    expect(processSteps[1]).toEqual(
      expect.objectContaining({ nodeId: 'func:validateInput', step: 2 }),
    );
    expect(processSteps[2]).toEqual(expect.objectContaining({ nodeId: 'func:saveToDb', step: 3 }));

    // Verify label is generated from entry and terminal names
    expect(process!.heuristicLabel).toContain('HandleRequest');
    expect(process!.heuristicLabel).toContain('SaveToDb');

    // Stats should reflect the detected processes
    expect(result.stats.totalProcesses).toBe(result.processes.length);
    expect(result.stats.entryPointsFound).toBeGreaterThan(0);
  });

  it('respects maxTraceDepth config', async () => {
    const graph = createKnowledgeGraph();

    // Create a long chain: f0 -> f1 -> f2 -> f3 -> f4
    for (let i = 0; i < 5; i++) {
      graph.addNode({
        id: `func:f${i}`,
        label: 'Function',
        properties: {
          name: `f${i}`,
          filePath: `src/f${i}.ts`,
          startLine: 1,
          endLine: 5,
          isExported: true,
        },
      });
    }
    for (let i = 0; i < 4; i++) {
      graph.addRelationship({
        id: `call:${i}`,
        sourceId: `func:f${i}`,
        targetId: `func:f${i + 1}`,
        type: 'CALLS',
        confidence: 0.9,
        reason: '',
      });
    }

    const memberships: CommunityMembership[] = Array.from({ length: 5 }, (_, i) => ({
      nodeId: `func:f${i}`,
      communityId: 'community:0',
    }));

    // Limit to 3 steps max depth
    const config: Partial<ProcessDetectionConfig> = { maxTraceDepth: 3 };
    const result = await processProcesses(graph, memberships, undefined, config);

    // Should still find processes, but each trace should be at most maxTraceDepth steps
    expect(result.processes.length).toBeGreaterThan(0);
    for (const process of result.processes) {
      expect(process.stepCount).toBeLessThanOrEqual(3);
    }
  });

  it('detects cross_community processes', async () => {
    const graph = createKnowledgeGraph();

    graph.addNode({
      id: 'func:apiHandler',
      label: 'Function',
      properties: {
        name: 'apiHandler',
        filePath: 'src/api/handler.ts',
        startLine: 1,
        endLine: 10,
        isExported: true,
      },
    });
    graph.addNode({
      id: 'func:dbQuery',
      label: 'Function',
      properties: {
        name: 'dbQuery',
        filePath: 'src/db/query.ts',
        startLine: 1,
        endLine: 5,
        isExported: true,
      },
    });
    graph.addNode({
      id: 'func:formatResponse',
      label: 'Function',
      properties: {
        name: 'formatResponse',
        filePath: 'src/api/format.ts',
        startLine: 1,
        endLine: 5,
        isExported: true,
      },
    });

    // apiHandler -> dbQuery (cross community), apiHandler -> formatResponse (same community)
    graph.addRelationship({
      id: 'call:1',
      sourceId: 'func:apiHandler',
      targetId: 'func:dbQuery',
      type: 'CALLS',
      confidence: 0.9,
      reason: '',
    });
    graph.addRelationship({
      id: 'call:2',
      sourceId: 'func:dbQuery',
      targetId: 'func:formatResponse',
      type: 'CALLS',
      confidence: 0.9,
      reason: '',
    });

    // Put them in different communities
    const memberships: CommunityMembership[] = [
      { nodeId: 'func:apiHandler', communityId: 'community:api' },
      { nodeId: 'func:dbQuery', communityId: 'community:db' },
      { nodeId: 'func:formatResponse', communityId: 'community:api' },
    ];

    const result = await processProcesses(graph, memberships);

    // Must find at least one process
    expect(result.processes.length).toBeGreaterThan(0);

    // The process from apiHandler should be cross_community (touches api + db communities)
    const crossProcess = result.processes.find((p) => p.entryPointId === 'func:apiHandler');
    expect(crossProcess).toBeDefined();
    expect(crossProcess!.processType).toBe('cross_community');
    expect(crossProcess!.communities.length).toBeGreaterThan(1);
    expect(crossProcess!.communities).toContain('community:api');
    expect(crossProcess!.communities).toContain('community:db');

    // Stats should count cross-community
    expect(result.stats.crossCommunityCount).toBeGreaterThan(0);
  });

  it('excludes test files from entry points', async () => {
    const graph = createKnowledgeGraph();

    // Test file function
    graph.addNode({
      id: 'func:testMain',
      label: 'Function',
      properties: {
        name: 'testMain',
        filePath: 'test/unit/main.test.ts',
        startLine: 1,
        endLine: 10,
        isExported: true,
      },
    });
    graph.addNode({
      id: 'func:helper',
      label: 'Function',
      properties: {
        name: 'helper',
        filePath: 'src/helper.ts',
        startLine: 1,
        endLine: 5,
        isExported: true,
      },
    });

    graph.addRelationship({
      id: 'call:1',
      sourceId: 'func:testMain',
      targetId: 'func:helper',
      type: 'CALLS',
      confidence: 0.9,
      reason: '',
    });

    const result = await processProcesses(graph, []);

    // Test files should not be used as entry points
    const testProcess = result.processes.find((p) => p.entryPointId === 'func:testMain');
    expect(testProcess).toBeUndefined();
  });

  it('filters out low-confidence calls (below 0.5)', async () => {
    const graph = createKnowledgeGraph();

    graph.addNode({
      id: 'func:a',
      label: 'Function',
      properties: { name: 'a', filePath: 'src/a.ts', startLine: 1, endLine: 5, isExported: true },
    });
    graph.addNode({
      id: 'func:b',
      label: 'Function',
      properties: { name: 'b', filePath: 'src/b.ts', startLine: 1, endLine: 5, isExported: true },
    });
    graph.addNode({
      id: 'func:c',
      label: 'Function',
      properties: { name: 'c', filePath: 'src/c.ts', startLine: 1, endLine: 5, isExported: true },
    });

    // a -> b with low confidence (fuzzy-global ambiguous), a -> c with high confidence
    graph.addRelationship({
      id: 'call:1',
      sourceId: 'func:a',
      targetId: 'func:b',
      type: 'CALLS',
      confidence: 0.3,
      reason: 'fuzzy-global',
    });
    graph.addRelationship({
      id: 'call:2',
      sourceId: 'func:a',
      targetId: 'func:c',
      type: 'CALLS',
      confidence: 0.9,
      reason: 'import-resolved',
    });

    const result = await processProcesses(graph, []);

    // No process should include func:b since the edge has confidence < 0.5 (MIN_TRACE_CONFIDENCE)
    for (const process of result.processes) {
      expect(process.trace).not.toContain('func:b');
    }
  });

  it('handles cycles without infinite loops', async () => {
    const graph = createKnowledgeGraph();

    graph.addNode({
      id: 'func:a',
      label: 'Function',
      properties: {
        name: 'processItem',
        filePath: 'src/a.ts',
        startLine: 1,
        endLine: 5,
        isExported: true,
      },
    });
    graph.addNode({
      id: 'func:b',
      label: 'Function',
      properties: {
        name: 'validate',
        filePath: 'src/b.ts',
        startLine: 1,
        endLine: 5,
        isExported: true,
      },
    });
    graph.addNode({
      id: 'func:c',
      label: 'Function',
      properties: {
        name: 'retry',
        filePath: 'src/c.ts',
        startLine: 1,
        endLine: 5,
        isExported: true,
      },
    });

    // a -> b -> c -> a (cycle)
    graph.addRelationship({
      id: 'call:1',
      sourceId: 'func:a',
      targetId: 'func:b',
      type: 'CALLS',
      confidence: 0.9,
      reason: '',
    });
    graph.addRelationship({
      id: 'call:2',
      sourceId: 'func:b',
      targetId: 'func:c',
      type: 'CALLS',
      confidence: 0.9,
      reason: '',
    });
    graph.addRelationship({
      id: 'call:3',
      sourceId: 'func:c',
      targetId: 'func:a',
      type: 'CALLS',
      confidence: 0.9,
      reason: '',
    });

    const memberships: CommunityMembership[] = [
      { nodeId: 'func:a', communityId: 'community:0' },
      { nodeId: 'func:b', communityId: 'community:0' },
      { nodeId: 'func:c', communityId: 'community:0' },
    ];

    // Should complete without hanging, and traces should not repeat nodes
    const result = await processProcesses(graph, memberships);
    for (const process of result.processes) {
      const uniqueNodes = new Set(process.trace);
      expect(uniqueNodes.size).toBe(process.trace.length);
    }
  });

  it('respects minSteps default (3) — rejects 2-step traces', async () => {
    const graph = createKnowledgeGraph();

    // Only 2 functions: a -> b (2 steps, below default minSteps of 3)
    graph.addNode({
      id: 'func:caller',
      label: 'Function',
      properties: {
        name: 'caller',
        filePath: 'src/caller.ts',
        startLine: 1,
        endLine: 5,
        isExported: true,
      },
    });
    graph.addNode({
      id: 'func:callee',
      label: 'Function',
      properties: {
        name: 'callee',
        filePath: 'src/callee.ts',
        startLine: 1,
        endLine: 5,
        isExported: true,
      },
    });

    graph.addRelationship({
      id: 'call:1',
      sourceId: 'func:caller',
      targetId: 'func:callee',
      type: 'CALLS',
      confidence: 0.9,
      reason: '',
    });

    const result = await processProcesses(graph, []);

    // Default minSteps is 3, so a 2-step trace (caller -> callee) should be rejected
    expect(result.processes).toHaveLength(0);
  });

  it('calls progress callback with messages', async () => {
    const graph = createKnowledgeGraph();
    const onProgress = vi.fn();

    await processProcesses(graph, [], onProgress);

    expect(onProgress).toHaveBeenCalled();
    // Verify callback receives (message: string, progress: number)
    const [message, progress] = onProgress.mock.calls[0];
    expect(typeof message).toBe('string');
    expect(typeof progress).toBe('number');
    expect(progress).toBeGreaterThanOrEqual(0);
    expect(progress).toBeLessThanOrEqual(100);
  });

  it('limits output to maxProcesses', async () => {
    const graph = createKnowledgeGraph();

    // Create many independent 3-step chains to generate many processes
    for (let chain = 0; chain < 10; chain++) {
      for (let step = 0; step < 3; step++) {
        graph.addNode({
          id: `func:chain${chain}_f${step}`,
          label: 'Function',
          properties: {
            name: `chain${chain}_f${step}`,
            filePath: `src/chain${chain}/f${step}.ts`,
            startLine: 1,
            endLine: 5,
            isExported: true,
          },
        });
      }
      for (let step = 0; step < 2; step++) {
        graph.addRelationship({
          id: `call:chain${chain}_${step}`,
          sourceId: `func:chain${chain}_f${step}`,
          targetId: `func:chain${chain}_f${step + 1}`,
          type: 'CALLS',
          confidence: 0.9,
          reason: '',
        });
      }
    }

    const memberships: CommunityMembership[] = [];
    for (let chain = 0; chain < 10; chain++) {
      for (let step = 0; step < 3; step++) {
        memberships.push({ nodeId: `func:chain${chain}_f${step}`, communityId: 'community:0' });
      }
    }

    const config: Partial<ProcessDetectionConfig> = { maxProcesses: 3 };
    const result = await processProcesses(graph, memberships, undefined, config);

    expect(result.processes.length).toBeLessThanOrEqual(3);
    expect(result.stats.totalProcesses).toBeLessThanOrEqual(3);
  });

  // Regression for #2198: the processesPhase dynamic sizing used to cap at
  // Math.min(300, symbolCount/10). On large repos (>3000 symbols) that silently
  // truncated the process index. The cap was removed by extracting
  // computeDynamicMaxProcesses() — this test exercises the helper directly
  // so it fails if someone reintroduces the 300 ceiling.
  describe('computeDynamicMaxProcesses (#2198)', () => {
    it('returns at least the floor of 20 for tiny repos', () => {
      expect(computeDynamicMaxProcesses(0)).toBe(20);
      expect(computeDynamicMaxProcesses(50)).toBe(20); // 50/10 = 5, floored to 20
      expect(computeDynamicMaxProcesses(199)).toBe(20); // 199/10 ≈ 20
    });

    it('scales linearly within the old 0–3000 range', () => {
      expect(computeDynamicMaxProcesses(500)).toBe(50);
      expect(computeDynamicMaxProcesses(1000)).toBe(100);
      expect(computeDynamicMaxProcesses(2999)).toBe(300);
    });

    it('grows past 300 for large repos — the regression that #2198 fixes', () => {
      // 3001 symbols → 300 (just at the boundary)
      expect(computeDynamicMaxProcesses(3001)).toBe(300);
      // 3100 symbols → 310 — would have been capped to 300 before the fix
      expect(computeDynamicMaxProcesses(3100)).toBe(310);
      // 5000 symbols → 500
      expect(computeDynamicMaxProcesses(5000)).toBe(500);
      // 28000 symbols (real-world large repo) → 2800
      expect(computeDynamicMaxProcesses(28000)).toBe(2800);
    });

    it('does NOT cap at 300 — fails if Math.min(300, ...) is reintroduced', () => {
      const largeRepo = computeDynamicMaxProcesses(10000);
      expect(largeRepo).toBe(1000);
      expect(largeRepo).toBeGreaterThan(300);
    });
  });
});

/**
 * D1/D2 — the trace walk must reach DEEP flows, not just shallow ones.
 *
 * The walk stops after a fixed NUMBER of traces, so traversal order decides
 * which traces those are. Breadth-first reached every shallow terminal before
 * any deep one, so the quota filled with the shortest paths in the graph and
 * the walk stopped — `maxTraceDepth` was never approached.
 *
 * Measured on a 75k-node repo before the fix: of 300 processes NONE exceeded 7
 * steps and 90% were 3-4, so a multi-hop business flow had no process that
 * could represent it and `query` could only rank the mechanical pairs that did
 * exist. What looked like a ranking problem was a construction problem.
 *
 * This fixture is that shape in miniature: one deep chain competing with enough
 * shallow branches to exhaust the trace budget before the chain is reached.
 */
describe('process depth (D1/D2)', () => {
  // Drives the walk DIRECTLY. Through `processProcesses` this is unobservable:
  // `findEntryPoints` returns several starting points, so the deep chain is
  // traced from inside it whatever the traversal order does — a test there
  // passes under BOTH traversals and guards nothing.
  const cfg = { maxTraceDepth: 10, maxBranching: 4, maxProcesses: 75, minSteps: 3 };

  const deepAndShallow = (order: readonly string[]): Map<string, string[]> => {
    // Fan-out is capped at maxBranching (4), so the budget is exhausted BELOW
    // the entry: three shallow branches carrying four immediate terminals each
    // = 12 traces, exactly the walk budget (maxBranching * 3). Breadth-first
    // records all twelve and stops before descending the deep branch at all.
    const calls = new Map<string, string[]>();
    calls.set('entry', [...order]);
    for (const b of ['s1', 's2', 's3']) {
      calls.set(b, [`${b}_l1`, `${b}_l2`, `${b}_l3`, `${b}_l4`]);
    }
    for (let i = 1; i <= 7; i++) calls.set(`d${i}`, [`d${i + 1}`]);
    return calls;
  };

  it('descends a deep chain instead of spending the budget on shallow branches', () => {
    const traces = traceFromEntryPoint('entry', deepAndShallow(['d1', 's1', 's2', 's3']), cfg);
    const deepest = Math.max(0, ...traces.map((t) => t.length));
    // Shallow terminals are 3 nodes. Anything longer proves it descended.
    expect(deepest).toBeGreaterThan(3);
  });

  // Sibling ORDER, which the walk previously got backwards: `slice` selected
  // the first N callees while `pop()` explored them last-first, so the budget
  // went to the LAST-declared branch. For `main() { init(); …; shutdown(); }`
  // that spends the walk on `shutdown` and can drop `init` — the earliest steps
  // of a flow, which is the opposite of what a process describes.
  //
  // The consequence is honest and worth pinning: with a fixed trace budget, a
  // deep branch declared AFTER enough shallow ones is not reached. That is a
  // budget limitation, not a traversal one, and it must not be silent.
  it('follows source order, so an early deep branch wins and a late one may not', () => {
    const early = traceFromEntryPoint('entry', deepAndShallow(['d1', 's1', 's2', 's3']), cfg);
    const late = traceFromEntryPoint('entry', deepAndShallow(['s1', 's2', 's3', 'd1']), cfg);
    expect(Math.max(0, ...early.map((t) => t.length))).toBeGreaterThan(3);
    // Not asserted as a desirable outcome — asserted so a change to the budget
    // shows up here rather than silently altering which flows exist.
    expect(Math.max(0, ...late.map((t) => t.length))).toBe(3);
  });
  // The `processProcesses`-level depth test that used to sit here was VACUOUS,
  // and the note at the top of this describe says exactly why: `findEntryPoints`
  // returns several starting points, so the deep chain gets traced from inside
  // it whatever the traversal does. Measured: under breadth-first the same
  // fixture still yielded a deepest stepCount of 8, so the assertion passed
  // with the production change reverted and guarded nothing.
  //
  // What IS observable at this level is which traces survive SELECTION, and
  // that is asserted in the diversity describe below. Traversal order is
  // asserted against `traceFromEntryPoint` directly, above.
});

describe('sink-terminated flows (R3-6)', () => {
  const addFn = (
    graph: ReturnType<typeof createKnowledgeGraph>,
    id: string,
    line: number,
  ): void => {
    graph.addNode({
      id,
      label: 'Function',
      properties: {
        name: id.split(':')[1],
        filePath: 'src/flow.ts',
        startLine: line,
        endLine: line + 2,
      },
    });
  };
  const addCall = (
    graph: ReturnType<typeof createKnowledgeGraph>,
    from: string,
    to: string,
  ): void => {
    graph.addRelationship({
      id: `rel:${from}->${to}`,
      sourceId: from,
      targetId: to,
      type: 'CALLS',
      confidence: 1,
      reason: 'test',
    });
  };

  /**
   * The shape the whole item is about: a business flow whose meaningful
   * endpoint CALLS ONWARD into helpers. `placeOrder` is where the program does
   * something; `formatDate` is merely where control stops.
   */
  const flowGraph = (): ReturnType<typeof createKnowledgeGraph> => {
    const graph = createKnowledgeGraph();
    addFn(graph, 'func:scan', 1);
    addFn(graph, 'func:score', 10);
    addFn(graph, 'func:placeOrder', 20);
    addFn(graph, 'func:formatDate', 30);
    addFn(graph, 'func:pad', 40);
    addCall(graph, 'func:scan', 'func:score');
    addCall(graph, 'func:score', 'func:placeOrder');
    addCall(graph, 'func:placeOrder', 'func:formatDate');
    addCall(graph, 'func:formatDate', 'func:pad');
    return graph;
  };

  // `placeOrder` spans lines 20-22, so an outward action on line 21 belongs to
  // it — the attribution the file-level FETCHES edge could not express.
  const ORDER_SITE = [{ filePath: 'src/flow.ts', lineNumber: 21 }];

  it('ends a trace where the program reaches outward', async () => {
    const result = await processProcesses(flowGraph(), [], undefined, {}, ORDER_SITE);
    expect(result.processes.map((p) => p.terminalId)).toContain('func:placeOrder');
  });

  // The half a naive implementation gets wrong: emitting the sink trace at the
  // walk and then letting subset-removal delete it one step later is a no-op,
  // because a sink-terminated flow is BY DEFINITION a prefix of the longer
  // chain that runs on past it.
  it('keeps the sink flow even though it is a prefix of a longer chain', async () => {
    const result = await processProcesses(flowGraph(), [], undefined, {}, ORDER_SITE);
    const terminals = result.processes.map((p) => p.terminalId);
    expect(terminals).toContain('func:placeOrder');
    // The longer chain still exists — the two answer different questions.
    expect(terminals).toContain('func:pad');
  });

  it('ranks the sink flow above the leaf chain', async () => {
    const result = await processProcesses(flowGraph(), [], undefined, {}, ORDER_SITE);
    const first = result.processes[0]?.terminalId;
    expect(first).toBe('func:placeOrder');
  });

  // Without sites, behaviour must be exactly what it was.
  it('changes nothing when no outward action is known', async () => {
    const result = await processProcesses(flowGraph(), [], undefined, {}, []);
    expect(result.processes.map((p) => p.terminalId)).not.toContain('func:placeOrder');
  });

  it('attributes a site to the INNERMOST enclosing function', () => {
    const graph = createKnowledgeGraph();
    // An outer function spanning the inner one; the inner performs the call.
    graph.addNode({
      id: 'func:outer',
      label: 'Function',
      properties: { name: 'outer', filePath: 'src/a.ts', startLine: 1, endLine: 50 },
    });
    graph.addNode({
      id: 'func:inner',
      label: 'Function',
      properties: { name: 'inner', filePath: 'src/a.ts', startLine: 10, endLine: 20 },
    });
    const sinks = buildSinkFunctionSet(graph, [{ filePath: 'src/a.ts', lineNumber: 15 }]);
    expect(sinks.has('func:inner')).toBe(true);
    expect(sinks.has('func:outer')).toBe(false);
  });
});

describe('process selection diversity (R2-3)', () => {
  const addFn = (graph: ReturnType<typeof createKnowledgeGraph>, id: string): void => {
    graph.addNode({
      id,
      label: 'Function',
      properties: { name: id.split(':')[1], filePath: 'src/a.ts', startLine: 1, endLine: 2 },
    });
  };
  const addCall = (
    graph: ReturnType<typeof createKnowledgeGraph>,
    from: string,
    to: string,
  ): void => {
    graph.addRelationship({
      id: `rel:${from}->${to}`,
      sourceId: from,
      targetId: to,
      type: 'CALLS',
      confidence: 1,
      reason: 'test',
    });
  };

  // The shape that crowded the reporting repo's list: many entry points whose
  // deepest chains all bottom out in the SAME utility, plus a shorter flow
  // ending somewhere of its own. Ranking on depth alone hands every slot to
  // the first group and the reader learns one thing many times.
  it('does not let one terminal take every slot', async () => {
    const graph = createKnowledgeGraph();

    // Six entry points, each with a 5-node chain into one shared utility.
    addFn(graph, 'func:sharedUtil');
    for (let e = 1; e <= 6; e++) {
      let prev = `func:entry${e}`;
      addFn(graph, prev);
      for (let i = 1; i <= 3; i++) {
        const mid = `func:e${e}_m${i}`;
        addFn(graph, mid);
        addCall(graph, prev, mid);
        prev = mid;
      }
      addCall(graph, prev, 'func:sharedUtil');
    }

    // One shorter, distinct flow — the "business flow" analogue.
    addFn(graph, 'func:ownEntry');
    addFn(graph, 'func:ownMid');
    addFn(graph, 'func:ownTerminal');
    addCall(graph, 'func:ownEntry', 'func:ownMid');
    addCall(graph, 'func:ownMid', 'func:ownTerminal');

    const result = await processProcesses(graph, [], undefined, { maxProcesses: 4 });
    const terminals = result.processes.map((p) => p.terminalId);
    const sharedCount = terminals.filter((t) => t === 'func:sharedUtil').length;

    // Under depth-only ranking every one of the four slots goes to a
    // five-node chain ending in sharedUtil.
    expect(sharedCount).toBeLessThan(terminals.length);
    expect(new Set(terminals).size).toBeGreaterThan(1);
  });

  it('keeps a shorter flow with its own terminal rather than a fifth duplicate', async () => {
    const graph = createKnowledgeGraph();
    addFn(graph, 'func:sharedUtil');
    for (let e = 1; e <= 6; e++) {
      let prev = `func:entry${e}`;
      addFn(graph, prev);
      for (let i = 1; i <= 3; i++) {
        const mid = `func:e${e}_m${i}`;
        addFn(graph, mid);
        addCall(graph, prev, mid);
        prev = mid;
      }
      addCall(graph, prev, 'func:sharedUtil');
    }
    addFn(graph, 'func:ownEntry');
    addFn(graph, 'func:ownMid');
    addFn(graph, 'func:ownTerminal');
    addCall(graph, 'func:ownEntry', 'func:ownMid');
    addCall(graph, 'func:ownMid', 'func:ownTerminal');

    const result = await processProcesses(graph, [], undefined, { maxProcesses: 4 });
    expect(result.processes.map((p) => p.terminalId)).toContain('func:ownTerminal');
  });
});
