import { describe, it, expect, beforeEach } from 'vitest';
import { attachJavaFeignRpcCalls } from '../../src/core/ingestion/languages/java/spring-feign-rpc.js';
import type { KnowledgeGraph, GraphNode, GraphRelationship } from '../../src/core/graph/types.js';
import type { ParsedFile } from 'gitnexus-shared';

// ── Test helpers ─────────────────────────────────────────────────────────

function createMockGraph(): KnowledgeGraph {
  const nodes = new Map<string, GraphNode>();
  const rels = new Map<string, GraphRelationship>();

  return {
    addNode(node: GraphNode): void {
      nodes.set(node.id, node);
    },
    addRelationship(rel: GraphRelationship): void {
      rels.set(rel.id, rel);
    },
    removeRelationship(id: string): boolean {
      return rels.delete(id);
    },
    removeNode(id: string): boolean {
      return nodes.delete(id);
    },
    getNode(id: string): GraphNode | undefined {
      return nodes.get(id);
    },
    forEachNode(fn: (node: GraphNode) => void): void {
      for (const n of nodes.values()) fn(n);
    },
    forEachRelationship(fn: (rel: GraphRelationship) => void): void {
      for (const r of rels.values()) fn(r);
    },
    iterRelationships(): IterableIterator<GraphRelationship> {
      return rels.values();
    },
    iterRelationshipsByType(type: string): IterableIterator<GraphRelationship> {
      return (function* () {
        for (const r of rels.values()) {
          if (r.type === type) yield r;
        }
      })();
    },
    forEachRelationshipFields(): void {},
    get nodes() {
      return nodes;
    },
    get relationships() {
      return rels;
    },
  } as unknown as KnowledgeGraph;
}

function makeFile(
  path: string,
  name: string,
  label: string,
  startLine: number,
  endLine: number,
): GraphNode {
  return {
    id: `${label}:${path}:${name}`,
    label,
    properties: { name, filePath: path, startLine, endLine },
  };
}

function makeFeignInterfaceFile(
  path: string,
  methods: Array<{ name: string; startLine: number; endLine: number }>,
): { path: string; content: string; nodes: GraphNode[] } {
  const interfaceName = path.split('/').pop()!.replace('.java', '');
  const methodDecls = methods
    .map((m) => `    WinRpcResponse<Object> ${m.name}(InputDTO input);`)
    .join('\n\n');
  const content = `package com.test;
import org.springframework.cloud.openfeign.FeignClient;

@FeignClient("test-service")
public interface ${interfaceName} {
${methodDecls}
}`;
  const nodes: GraphNode[] = methods.map((m) =>
    makeFile(path, m.name, 'Method', m.startLine, m.endLine),
  );
  return { path, content, nodes };
}

function makeCallerFile(
  path: string,
  feignTypeName: string,
  fieldName: string,
  calls: Array<{ methodName: string; line: number }>,
  funcName: string = 'doWork',
): { path: string; content: string; node: GraphNode } {
  const callLines = calls
    .map((c) => `        Object result = ${fieldName}.${c.methodName}(input);`)
    .join('\n');
  const content = `package com.test;
public class Caller {
    @Autowired
    private ${feignTypeName} ${fieldName};

    public Object ${funcName}() {
${callLines}
        return result;
    }
}`;
  // Function spans from `public Object` (line 6) to closing `}` (line 10)
  return {
    path,
    content,
    node: makeFile(path, funcName, 'Method', 6, 10),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('attachJavaFeignRpcCalls', () => {
  let graph: KnowledgeGraph;
  let fileContents: Map<string, string>;
  let parsedFiles: ParsedFile[];

  beforeEach(() => {
    graph = createMockGraph();
    fileContents = new Map();
    parsedFiles = [];
  });

  it('emits CALLS edge from caller to Feign interface method', () => {
    // Feign interface
    const feign = makeFeignInterfaceFile('ExeRulesRpcService.java', [
      { name: 'getRules', startLine: 8, endLine: 10 },
    ]);
    for (const n of feign.nodes) graph.addNode(n);
    fileContents.set(feign.path, feign.content);
    parsedFiles.push({ filePath: feign.path, scopes: [] } as ParsedFile);

    // Caller
    const caller = makeCallerFile('Caller.java', 'ExeRulesRpcService', 'exeRules', [
      { methodName: 'getRules', line: 15 },
    ]);
    graph.addNode(caller.node);
    fileContents.set(caller.path, caller.content);
    parsedFiles.push({ filePath: caller.path, scopes: [] } as ParsedFile);

    attachJavaFeignRpcCalls(graph, parsedFiles, fileContents);

    const feignCalls = [...graph.iterRelationshipsByType('CALLS')];
    expect(feignCalls.length).toBe(1);
    expect(feignCalls[0].sourceId).toBe(caller.node.id);
    expect(feignCalls[0].targetId).toBe(feign.nodes[0].id);
    expect(feignCalls[0].confidence).toBe(0.85);
    expect(feignCalls[0].reason).toContain('Feign RPC');
  });

  it('handles multiple methods on a single Feign interface', () => {
    const feign = makeFeignInterfaceFile('OrderRpcService.java', [
      { name: 'getOrder', startLine: 8, endLine: 10 },
      { name: 'createOrder', startLine: 12, endLine: 14 },
      { name: 'deleteOrder', startLine: 16, endLine: 18 },
    ]);
    for (const n of feign.nodes) graph.addNode(n);
    fileContents.set(feign.path, feign.content);
    parsedFiles.push({ filePath: feign.path, scopes: [] } as ParsedFile);

    const caller = makeCallerFile('Caller.java', 'OrderRpcService', 'rpc', [
      { methodName: 'getOrder', line: 15 },
      { methodName: 'createOrder', line: 16 },
    ]);
    graph.addNode(caller.node);
    fileContents.set(caller.path, caller.content);
    parsedFiles.push({ filePath: caller.path, scopes: [] } as ParsedFile);

    attachJavaFeignRpcCalls(graph, parsedFiles, fileContents);

    const feignCalls = [...graph.iterRelationshipsByType('CALLS')];
    expect(feignCalls.length).toBe(2);
    const targetNames = feignCalls.map((r) => graph.getNode(r.targetId)?.properties.name);
    expect(targetNames).toContain('getOrder');
    expect(targetNames).toContain('createOrder');
  });

  it('handles multiple Feign interfaces injected in the same class', () => {
    const feign1 = makeFeignInterfaceFile('ServiceARpc.java', [
      { name: 'methodA', startLine: 8, endLine: 10 },
    ]);
    for (const n of feign1.nodes) graph.addNode(n);
    fileContents.set(feign1.path, feign1.content);
    parsedFiles.push({ filePath: feign1.path, scopes: [] } as ParsedFile);

    const feign2 = makeFeignInterfaceFile('ServiceBRpc.java', [
      { name: 'methodB', startLine: 8, endLine: 10 },
    ]);
    for (const n of feign2.nodes) graph.addNode(n);
    fileContents.set(feign2.path, feign2.content);
    parsedFiles.push({ filePath: feign2.path, scopes: [] } as ParsedFile);

    // Caller with both
    const content = `package com.test;
public class Caller {
    @Autowired
    private ServiceARpc serviceA;
    @Autowired
    private ServiceBRpc serviceB;

    public void doWork() {
        serviceA.methodA(input);
        serviceB.methodB(input);
    }
}`;
    const callerNode = makeFile('Caller.java', 'doWork', 'Method', 8, 13);
    graph.addNode(callerNode);
    fileContents.set('Caller.java', content);
    parsedFiles.push({ filePath: 'Caller.java', scopes: [] } as ParsedFile);

    attachJavaFeignRpcCalls(graph, parsedFiles, fileContents);

    const feignCalls = [...graph.iterRelationshipsByType('CALLS')];
    expect(feignCalls.length).toBe(2);
  });

  it('does not emit edges when no Feign interfaces exist', () => {
    const caller = makeCallerFile('Caller.java', 'NonFeignService', 'svc', [
      { methodName: 'doSomething', line: 15 },
    ]);
    graph.addNode(caller.node);
    fileContents.set(caller.path, caller.content);
    parsedFiles.push({ filePath: caller.path, scopes: [] } as ParsedFile);

    attachJavaFeignRpcCalls(graph, parsedFiles, fileContents);

    const feignCalls = [...graph.iterRelationshipsByType('CALLS')];
    expect(feignCalls.length).toBe(0);
  });

  it('skips calls to methods not declared on the Feign interface', () => {
    const feign = makeFeignInterfaceFile('MyRpc.java', [
      { name: 'existingMethod', startLine: 8, endLine: 10 },
    ]);
    for (const n of feign.nodes) graph.addNode(n);
    fileContents.set(feign.path, feign.content);
    parsedFiles.push({ filePath: feign.path, scopes: [] } as ParsedFile);

    const caller = makeCallerFile('Caller.java', 'MyRpc', 'rpc', [
      { methodName: 'existingMethod', line: 15 },
      { methodName: 'nonExistentMethod', line: 16 },
    ]);
    graph.addNode(caller.node);
    fileContents.set(caller.path, caller.content);
    parsedFiles.push({ filePath: caller.path, scopes: [] } as ParsedFile);

    attachJavaFeignRpcCalls(graph, parsedFiles, fileContents);

    const feignCalls = [...graph.iterRelationshipsByType('CALLS')];
    expect(feignCalls.length).toBe(1);
    expect(graph.getNode(feignCalls[0].targetId)?.properties.name).toBe('existingMethod');
  });

  it('avoids duplicate edges on repeated calls', () => {
    const feign = makeFeignInterfaceFile('DupRpc.java', [
      { name: 'call', startLine: 8, endLine: 10 },
    ]);
    for (const n of feign.nodes) graph.addNode(n);
    fileContents.set(feign.path, feign.content);
    parsedFiles.push({ filePath: feign.path, scopes: [] } as ParsedFile);

    const content = `package com.test;
public class Caller {
    @Autowired
    private DupRpc rpc;
    public void doWork() {
        rpc.call(input);
        rpc.call(input);
        rpc.call(input);
    }
}`;
    const callerNode = makeFile('Caller.java', 'doWork', 'Method', 5, 10);
    graph.addNode(callerNode);
    fileContents.set('Caller.java', content);
    parsedFiles.push({ filePath: 'Caller.java', scopes: [] } as ParsedFile);

    attachJavaFeignRpcCalls(graph, parsedFiles, fileContents);

    const feignCalls = [...graph.iterRelationshipsByType('CALLS')];
    expect(feignCalls.length).toBe(1);
  });

  it('detects field without explicit @Autowired', () => {
    const feign = makeFeignInterfaceFile('SimpleRpc.java', [
      { name: 'ping', startLine: 8, endLine: 10 },
    ]);
    for (const n of feign.nodes) graph.addNode(n);
    fileContents.set(feign.path, feign.content);
    parsedFiles.push({ filePath: feign.path, scopes: [] } as ParsedFile);

    const content = `package com.test;
public class Caller {
    private SimpleRpc simpleRpc;
    public void doWork() {
        simpleRpc.ping(input);
    }
}`;
    const callerNode = makeFile('Caller.java', 'doWork', 'Method', 4, 7);
    graph.addNode(callerNode);
    fileContents.set('Caller.java', content);
    parsedFiles.push({ filePath: 'Caller.java', scopes: [] } as ParsedFile);

    attachJavaFeignRpcCalls(graph, parsedFiles, fileContents);

    const feignCalls = [...graph.iterRelationshipsByType('CALLS')];
    expect(feignCalls.length).toBe(1);
  });

  it('detects @Resource injection', () => {
    const feign = makeFeignInterfaceFile('ResourceRpc.java', [
      { name: 'getData', startLine: 8, endLine: 10 },
    ]);
    for (const n of feign.nodes) graph.addNode(n);
    fileContents.set(feign.path, feign.content);
    parsedFiles.push({ filePath: feign.path, scopes: [] } as ParsedFile);

    const content = `package com.test;
public class Caller {
    @Resource
    private ResourceRpc resourceRpc;
    public void doWork() {
        resourceRpc.getData(input);
    }
}`;
    const callerNode = makeFile('Caller.java', 'doWork', 'Method', 5, 8);
    graph.addNode(callerNode);
    fileContents.set('Caller.java', content);
    parsedFiles.push({ filePath: 'Caller.java', scopes: [] } as ParsedFile);

    attachJavaFeignRpcCalls(graph, parsedFiles, fileContents);

    const feignCalls = [...graph.iterRelationshipsByType('CALLS')];
    expect(feignCalls.length).toBe(1);
  });

  it('does not emit self-referencing edges', () => {
    // Feign method itself has the same nodeId as caller (edge case)
    const feign = makeFeignInterfaceFile('SelfRpc.java', [
      { name: 'method', startLine: 8, endLine: 12 },
    ]);
    // Make the feign method also be the caller
    const callerNode = feign.nodes[0];
    // Put caller content in the feign file path
    const content = `package com.test;
@FeignClient("test")
public interface SelfRpc {
    WinRpcResponse<Object> method(InputDTO input);
}`;
    graph.addNode(callerNode);
    fileContents.set('SelfRpc.java', content);
    parsedFiles.push({ filePath: 'SelfRpc.java', scopes: [] } as ParsedFile);

    attachJavaFeignRpcCalls(graph, parsedFiles, fileContents);

    const feignCalls = [...graph.iterRelationshipsByType('CALLS')];
    // Self-reference should be filtered
    for (const r of feignCalls) {
      expect(r.sourceId).not.toBe(r.targetId);
    }
  });

  it('handles Feign interface with value-quoted service name', () => {
    const content = `package com.test;
import org.springframework.cloud.openfeign.FeignClient;

@FeignClient(value = "my-service")
public interface ValueQuoteRpc {
    WinRpcResponse<Object> fetch(DataDTO input);
}`;
    const feignNode = makeFile('ValueQuoteRpc.java', 'fetch', 'Method', 7, 9);
    graph.addNode(feignNode);
    fileContents.set('ValueQuoteRpc.java', content);
    parsedFiles.push({ filePath: 'ValueQuoteRpc.java', scopes: [] } as ParsedFile);

    const caller = makeCallerFile('Caller.java', 'ValueQuoteRpc', 'valueRpc', [
      { methodName: 'fetch', line: 15 },
    ]);
    graph.addNode(caller.node);
    fileContents.set(caller.path, caller.content);
    parsedFiles.push({ filePath: caller.path, scopes: [] } as ParsedFile);

    attachJavaFeignRpcCalls(graph, parsedFiles, fileContents);

    const feignCalls = [...graph.iterRelationshipsByType('CALLS')];
    expect(feignCalls.length).toBe(1);
  });

  it('skips when Feign field is declared but method is never called', () => {
    const feign = makeFeignInterfaceFile('UnusedRpc.java', [
      { name: 'unused', startLine: 8, endLine: 10 },
    ]);
    for (const n of feign.nodes) graph.addNode(n);
    fileContents.set(feign.path, feign.content);
    parsedFiles.push({ filePath: feign.path, scopes: [] } as ParsedFile);

    const content = `package com.test;
public class Caller {
    private UnusedRpc unusedRpc;
    public void doWork() {
        System.out.println("no rpc call");
    }
}`;
    const callerNode = makeFile('Caller.java', 'doWork', 'Method', 4, 6);
    graph.addNode(callerNode);
    fileContents.set('Caller.java', content);
    parsedFiles.push({ filePath: 'Caller.java', scopes: [] } as ParsedFile);

    attachJavaFeignRpcCalls(graph, parsedFiles, fileContents);

    const feignCalls = [...graph.iterRelationshipsByType('CALLS')];
    expect(feignCalls.length).toBe(0);
  });

  it('scans multiple functions in the same file', () => {
    const feign = makeFeignInterfaceFile('MultiRpc.java', [
      { name: 'first', startLine: 8, endLine: 10 },
      { name: 'second', startLine: 12, endLine: 14 },
    ]);
    for (const n of feign.nodes) graph.addNode(n);
    fileContents.set(feign.path, feign.content);
    parsedFiles.push({ filePath: feign.path, scopes: [] } as ParsedFile);

    const content = `package com.test;
public class Caller {
    private MultiRpc multiRpc;
    public void methodA() {
        multiRpc.first(input);
    }
    public void methodB() {
        multiRpc.second(input);
    }
}`;
    const nodeA = makeFile('Caller.java', 'methodA', 'Method', 4, 6);
    const nodeB = makeFile('Caller.java', 'methodB', 'Method', 7, 9);
    graph.addNode(nodeA);
    graph.addNode(nodeB);
    fileContents.set('Caller.java', content);
    parsedFiles.push({ filePath: 'Caller.java', scopes: [] } as ParsedFile);

    attachJavaFeignRpcCalls(graph, parsedFiles, fileContents);

    const feignCalls = [...graph.iterRelationshipsByType('CALLS')];
    expect(feignCalls.length).toBe(2);
  });
});
