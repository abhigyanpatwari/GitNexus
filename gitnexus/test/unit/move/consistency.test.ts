import { describe, it, expect } from 'vitest';
import {
  summarizeMoveConsistency,
  validateMoveIngestOutput,
} from '../../../src/core/move/consistency.js';
import type { MoveIngestOutput } from '../../../src/core/move/move-ingest.js';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';

function addFileNode(graph: ReturnType<typeof createKnowledgeGraph>, filePath: string): void {
  graph.addNode({
    id: `File:${filePath}`,
    label: 'File',
    properties: { name: filePath.split('/').pop() ?? filePath, filePath },
  });
}

function makeOutput(overrides: Partial<MoveIngestOutput> = {}): MoveIngestOutput {
  return {
    ingestedFiles: new Set<string>(),
    packageRoots: [],
    moduleFileMap: new Map(),
    functionNodeMap: new Map(),
    structNodeMap: new Map(),
    modulePackageMap: new Map(),
    filePackageMap: new Map(),
    callGraphByPackage: new Map(),
    droppedRefs: [],
    functionUsageFailures: [],
    consistencyIssues: [],
    ...overrides,
  };
}

describe('validateMoveIngestOutput', () => {
  it('returns [] for clean input', () => {
    const graph = createKnowledgeGraph();
    const file = 'sources/coin.move';
    addFileNode(graph, file);
    const output = makeOutput({
      ingestedFiles: new Set([file]),
      moduleFileMap: new Map([['0xa::coin', file]]),
      functionNodeMap: new Map([['0xa::coin::register', `Function:${file}:0xa::coin::register`]]),
      structNodeMap: new Map([['0xa::coin::CoinStore', `Struct:${file}:0xa::coin::CoinStore`]]),
      modulePackageMap: new Map([['0xa::coin', '/pkg']]),
      callGraphByPackage: new Map([['/pkg', { '0xa::coin::register': [] }]]),
    });
    expect(validateMoveIngestOutput(graph, output)).toEqual([]);
  });

  it('warns malformed-source-evidence when a module file path does not end in .move', () => {
    const graph = createKnowledgeGraph();
    const output = makeOutput({
      ingestedFiles: new Set(['sources/coin.txt']),
      moduleFileMap: new Map([['0xa::coin', 'sources/coin.txt']]),
    });
    const issues = validateMoveIngestOutput(graph, output);
    const issue = issues.find((i) => i.code === 'malformed-source-evidence');
    expect(issue?.severity).toBe('warning');
    expect(issue?.details?.filePath).toBe('sources/coin.txt');
  });

  it('warns malformed-source-evidence when a module file was not seen by ingestion', () => {
    const graph = createKnowledgeGraph();
    const output = makeOutput({
      // ingestedFiles deliberately empty; no File node either → unknown source.
      moduleFileMap: new Map([['0xa::coin', 'sources/coin.move']]),
    });
    const issues = validateMoveIngestOutput(graph, output);
    expect(
      issues.some((i) => i.code === 'malformed-source-evidence' && i.severity === 'warning'),
    ).toBe(true);
  });

  it('accepts a module whose source is unseen by ingestedFiles but has a File node in the graph', () => {
    const graph = createKnowledgeGraph();
    const file = 'sources/coin.move';
    addFileNode(graph, file);
    const output = makeOutput({
      // ingestedFiles empty — the File node is what saves it.
      moduleFileMap: new Map([['0xa::coin', file]]),
    });
    expect(validateMoveIngestOutput(graph, output)).toEqual([]);
  });

  it('warns missing-owned-caller when an owned caller has no function node', () => {
    const graph = createKnowledgeGraph();
    const file = 'sources/coin.move';
    addFileNode(graph, file);
    const output = makeOutput({
      ingestedFiles: new Set([file]),
      moduleFileMap: new Map([['0xa::coin', file]]),
      modulePackageMap: new Map([['0xa::coin', '/pkg']]),
      // caller's module belongs to /pkg but the caller never got a Function node.
      callGraphByPackage: new Map([['/pkg', { '0xa::coin::register': [] }]]),
    });
    const issues = validateMoveIngestOutput(graph, output);
    const issue = issues.find((i) => i.code === 'missing-owned-caller');
    expect(issue?.severity).toBe('warning');
    expect(issue?.details?.callerQualified).toBe('0xa::coin::register');
  });

  it('does NOT warn missing-owned-caller when the caller is not owned by the current package', () => {
    const graph = createKnowledgeGraph();
    const file = 'sources/coin.move';
    addFileNode(graph, file);
    const output = makeOutput({
      ingestedFiles: new Set([file]),
      moduleFileMap: new Map([['0xa::coin', file]]),
      modulePackageMap: new Map([['0xa::coin', '/pkg']]),
      // Caller module not in modulePackageMap -> foreign -> no warning.
      callGraphByPackage: new Map([['/pkg', { '0xa::other::foreign': [] }]]),
    });
    const issues = validateMoveIngestOutput(graph, output);
    expect(issues.some((i) => i.code === 'missing-owned-caller')).toBe(false);
  });

  it('warns missing-owned-callee when an owned callee module has no function node for the callee', () => {
    const graph = createKnowledgeGraph();
    const file = 'sources/coin.move';
    addFileNode(graph, file);
    const callerId = `Function:${file}:0xa::coin::register`;
    const output = makeOutput({
      ingestedFiles: new Set([file]),
      moduleFileMap: new Map([
        ['0xa::coin', file],
        ['0xa::coin_admin', file],
      ]),
      modulePackageMap: new Map([
        ['0xa::coin', '/pkg'],
        ['0xa::coin_admin', '/pkg'],
      ]),
      functionNodeMap: new Map([['0xa::coin::register', callerId]]),
      callGraphByPackage: new Map([
        ['/pkg', { '0xa::coin::register': ['0xa::coin_admin::missing'] }],
      ]),
    });
    const issues = validateMoveIngestOutput(graph, output);
    const issue = issues.find((i) => i.code === 'missing-owned-callee');
    expect(issue?.severity).toBe('warning');
    expect(issue?.details?.calleeQualified).toBe('0xa::coin_admin::missing');
  });

  it('does NOT warn missing-owned-callee for callees in modules not owned by this repo', () => {
    const graph = createKnowledgeGraph();
    const file = 'sources/coin.move';
    addFileNode(graph, file);
    const callerId = `Function:${file}:0xa::coin::register`;
    const output = makeOutput({
      ingestedFiles: new Set([file]),
      moduleFileMap: new Map([['0xa::coin', file]]),
      modulePackageMap: new Map([['0xa::coin', '/pkg']]),
      functionNodeMap: new Map([['0xa::coin::register', callerId]]),
      callGraphByPackage: new Map([
        // callee module 0x1::aptos_framework::stdlib is not in modulePackageMap → foreign → skip.
        ['/pkg', { '0xa::coin::register': ['0x1::aptos_framework::stdlib_call'] }],
      ]),
    });
    const issues = validateMoveIngestOutput(graph, output);
    expect(issues.some((i) => i.code === 'missing-owned-callee')).toBe(false);
  });

  it('does not warn when inline functions have no callers (move-flow omits inline callees)', () => {
    const graph = createKnowledgeGraph();
    const file = 'sources/m.move';
    addFileNode(graph, file);
    graph.addNode({
      id: 'Function:sources/m.move:0xa::m::helper',
      label: 'Function',
      properties: {
        name: 'helper',
        filePath: file,
        language: 'move',
        qualifiedName: '0xa::m::helper',
        isInline: true,
      },
    });
    graph.addNode({
      id: 'Function:sources/m.move:0xa::m::caller',
      label: 'Function',
      properties: {
        name: 'caller',
        filePath: file,
        language: 'move',
        qualifiedName: '0xa::m::caller',
        isInline: false,
      },
    });
    const output = makeOutput({
      ingestedFiles: new Set([file]),
      moduleFileMap: new Map([['0xa::m', file]]),
      functionNodeMap: new Map([
        ['0xa::m::helper', 'Function:sources/m.move:0xa::m::helper'],
        ['0xa::m::caller', 'Function:sources/m.move:0xa::m::caller'],
      ]),
    });
    const issues = validateMoveIngestOutput(graph, output);
    expect(issues).toEqual([]);
  });

  it('warns when resource targets were silently dropped (ambiguous local name)', () => {
    const graph = createKnowledgeGraph();
    const file = 'sources/m.move';
    addFileNode(graph, file);
    const output = makeOutput({
      ingestedFiles: new Set([file]),
      moduleFileMap: new Map([['0xa::m', file]]),
      droppedRefs: [{ kind: 'resource', sourceId: 'Function:f', target: 'Config' }],
    });
    const issues = validateMoveIngestOutput(graph, output);
    expect(
      issues.some((i) => i.code === 'unresolved-resource-target' && i.severity === 'warning'),
    ).toBe(true);
  });

  it('warns when type, friend, or lambda-host targets were dropped', () => {
    const graph = createKnowledgeGraph();
    const output = makeOutput({
      droppedRefs: [
        { kind: 'type', sourceId: 'Function:f', target: '(u64' },
        { kind: 'friend', sourceId: 'Module:m', target: '0xb::gone' },
        { kind: 'lambda-host', sourceId: 'Function:l', target: '0xa::m::host' },
      ],
    });
    const issues = validateMoveIngestOutput(graph, output);
    for (const code of [
      'unresolved-type-target',
      'unresolved-friend-target',
      'unresolved-lambda-host',
    ] as const) {
      const issue = issues.find((i) => i.code === code);
      expect(issue?.severity).toBe('warning');
      expect(issue?.details?.count).toBe(1);
      expect(
        (issue?.details?.sample as Array<{ kind: string; sourceId: string; target: string }>)?.[0],
      ).toMatchObject({
        kind: expect.any(String),
        sourceId: expect.any(String),
        target: expect.any(String),
      });
    }
  });

  it('errors call-graph-unlinked when no caller resolves despite mapped functions', () => {
    const graph = createKnowledgeGraph();
    const file = 'sources/coin.move';
    addFileNode(graph, file);
    const output = makeOutput({
      ingestedFiles: new Set([file]),
      moduleFileMap: new Map([['0xa::coin', file]]),
      modulePackageMap: new Map([['0xa::coin', '/pkg']]),
      functionNodeMap: new Map([['0xa::coin::register', `Function:${file}:0xa::coin::register`]]),
      // Simulated normalization drift: call_graph came back zero-padded, so
      // NO caller matches facts-derived names - and the ownership checks are
      // also blind to it (caller modules miss modulePackageMap the same way).
      callGraphByPackage: new Map([['/pkg', { '0x000a::coin::register': ['0x000a::coin::mint'] }]]),
    });
    const issues = validateMoveIngestOutput(graph, output);
    const issue = issues.find((i) => i.code === 'call-graph-unlinked');
    expect(issue?.severity).toBe('error');
    expect(issue?.details?.packageRoot).toBe('/pkg');
    // The pre-existing per-caller checks stay silent here - that blindness is
    // exactly why the package-level check exists.
    expect(issues.some((i) => i.code === 'missing-owned-caller')).toBe(false);
  });

  it('does not flag call-graph-unlinked when caller modules resolve (facts-elided callers)', () => {
    const graph = createKnowledgeGraph();
    const file = 'sources/coin.move';
    addFileNode(graph, file);
    const output = makeOutput({
      ingestedFiles: new Set([file]),
      moduleFileMap: new Map([['0xa::coin', file]]),
      modulePackageMap: new Map([['0xa::coin', '/pkg']]),
      functionNodeMap: new Map([['0xa::coin::register', `Function:${file}:0xa::coin::register`]]),
      // The only caller is a #[test] function elided from facts: its MODULE
      // resolves, so this is per-caller warning territory, not systematic
      // qualified-name drift.
      callGraphByPackage: new Map([['/pkg', { '0xa::coin::test_flow': ['0xa::coin::register'] }]]),
    });
    const issues = validateMoveIngestOutput(graph, output);
    expect(issues.some((i) => i.code === 'call-graph-unlinked')).toBe(false);
    expect(issues.some((i) => i.code === 'missing-owned-caller')).toBe(true);
  });

  it('does not flag call-graph-unlinked for a package with no mapped functions', () => {
    const graph = createKnowledgeGraph();
    const file = 'sources/coin.move';
    addFileNode(graph, file);
    const output = makeOutput({
      ingestedFiles: new Set([file]),
      moduleFileMap: new Map([['0xa::coin', file]]),
      modulePackageMap: new Map([['0xa::coin', '/pkg']]),
      // Structs-only package: call graph may list elided test-only functions.
      callGraphByPackage: new Map([['/pkg', { '0xa::coin::test_helper': [] }]]),
    });
    const issues = validateMoveIngestOutput(graph, output);
    expect(issues.some((i) => i.code === 'call-graph-unlinked')).toBe(false);
  });

  it('does not flag call-graph-unlinked when callees resolve (elided test-only caller module)', () => {
    const graph = createKnowledgeGraph();
    const file = 'sources/coin.move';
    addFileNode(graph, file);
    const output = makeOutput({
      ingestedFiles: new Set([file]),
      moduleFileMap: new Map([['0xa::coin', file]]),
      modulePackageMap: new Map([['0xa::coin', '/pkg']]),
      functionNodeMap: new Map([['0xa::coin::register', `Function:${file}:0xa::coin::register`]]),
      // Every caller lives in a test-only MODULE elided from facts, so neither
      // the function nor the module condition can clear the check - but the
      // CALLEES still join facts names, which real drift would break too.
      callGraphByPackage: new Map([['/pkg', { '0xa::coin_tests::flow': ['0xa::coin::register'] }]]),
    });
    const issues = validateMoveIngestOutput(graph, output);
    expect(issues.some((i) => i.code === 'call-graph-unlinked')).toBe(false);
  });

  it('warns when an external module shares an address with repo-local modules', () => {
    const graph = createKnowledgeGraph();
    const file = 'sources/coin.move';
    addFileNode(graph, file);
    graph.addNode({
      id: 'Module::0xa::vanished',
      label: 'Module',
      properties: {
        name: 'vanished',
        filePath: '',
        qualifiedName: '0xa::vanished',
        locationFidelity: 'external',
      },
    });
    const output = makeOutput({
      ingestedFiles: new Set([file]),
      moduleFileMap: new Map([['0xa::coin', file]]),
      modulePackageMap: new Map([['0xa::coin', '/pkg']]),
      callGraphByPackage: new Map([['/pkg', {}]]),
    });
    const issue = validateMoveIngestOutput(graph, output).find(
      (i) => i.code === 'external-module-address-overlap',
    );
    expect(issue?.severity).toBe('warning');
    expect(issue?.details?.sample).toEqual(['0xa::vanished']);
  });

  it('does not warn for external modules at genuinely foreign addresses', () => {
    const graph = createKnowledgeGraph();
    const file = 'sources/coin.move';
    addFileNode(graph, file);
    graph.addNode({
      id: 'Module::0x1::object',
      label: 'Module',
      properties: {
        name: 'object',
        filePath: '',
        qualifiedName: '0x1::object',
        locationFidelity: 'external',
      },
    });
    const output = makeOutput({
      ingestedFiles: new Set([file]),
      moduleFileMap: new Map([['0xa::coin', file]]),
      modulePackageMap: new Map([['0xa::coin', '/pkg']]),
      callGraphByPackage: new Map([['/pkg', {}]]),
    });
    const issues = validateMoveIngestOutput(graph, output);
    expect(issues.some((i) => i.code === 'external-module-address-overlap')).toBe(false);
  });
});

describe('summarizeMoveConsistency', () => {
  it('bounds persisted messages and details', () => {
    const summary = summarizeMoveConsistency([
      {
        code: 'empty-package-facts',
        severity: 'error',
        message: 'm'.repeat(10_000),
        details: { diagnostics: 'd'.repeat(1_000_000) },
      },
    ]);

    expect(JSON.stringify(summary).length).toBeLessThan(5_000);
  });
});
