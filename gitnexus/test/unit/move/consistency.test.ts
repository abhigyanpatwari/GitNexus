import { describe, it, expect } from 'vitest';
import { validateMoveIngestOutput } from '../../../src/core/move/consistency.js';
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
      droppedResourceRefs: [{ fnNodeId: 'Function:f', target: 'Config' }],
    });
    const issues = validateMoveIngestOutput(graph, output);
    expect(
      issues.some((i) => i.code === 'unresolved-resource-target' && i.severity === 'warning'),
    ).toBe(true);
  });
});
