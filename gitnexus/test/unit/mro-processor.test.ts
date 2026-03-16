import { describe, it, expect } from 'vitest';
import { computeMRO } from '../../src/core/ingestion/mro-processor.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { KnowledgeGraph } from '../../src/core/graph/types.js';
import { generateId } from '../../src/lib/utils.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addClass(graph: KnowledgeGraph, name: string, language: string, label: 'Class' | 'Interface' | 'Struct' | 'Trait' = 'Class') {
  const id = generateId(label, name);
  graph.addNode({
    id,
    label,
    properties: { name, filePath: `src/${name}.ts`, language },
  });
  return id;
}

function addMethod(graph: KnowledgeGraph, className: string, methodName: string, classLabel: 'Class' | 'Interface' | 'Struct' | 'Trait' = 'Class') {
  const classId = generateId(classLabel, className);
  const methodId = generateId('Method', `${className}.${methodName}`);
  graph.addNode({
    id: methodId,
    label: 'Method',
    properties: { name: methodName, filePath: `src/${className}.ts` },
  });
  graph.addRelationship({
    id: generateId('HAS_METHOD', `${classId}->${methodId}`),
    sourceId: classId,
    targetId: methodId,
    type: 'HAS_METHOD',
    confidence: 1.0,
    reason: '',
  });
  return methodId;
}

function addExtends(graph: KnowledgeGraph, childName: string, parentName: string, childLabel: 'Class' | 'Struct' = 'Class', parentLabel: 'Class' | 'Interface' | 'Trait' = 'Class') {
  const childId = generateId(childLabel, childName);
  const parentId = generateId(parentLabel, parentName);
  graph.addRelationship({
    id: generateId('EXTENDS', `${childId}->${parentId}`),
    sourceId: childId,
    targetId: parentId,
    type: 'EXTENDS',
    confidence: 1.0,
    reason: '',
  });
}

function addImplements(graph: KnowledgeGraph, childName: string, parentName: string, childLabel: 'Class' | 'Struct' = 'Class', parentLabel: 'Interface' | 'Trait' = 'Interface') {
  const childId = generateId(childLabel, childName);
  const parentId = generateId(parentLabel, parentName);
  graph.addRelationship({
    id: generateId('IMPLEMENTS', `${childId}->${parentId}`),
    sourceId: childId,
    targetId: parentId,
    type: 'IMPLEMENTS',
    confidence: 1.0,
    reason: '',
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeMRO', () => {

  // ---- C++ diamond --------------------------------------------------------
  describe('C++ diamond inheritance', () => {
    it('leftmost base wins when both B and C override foo', () => {
      // Diamond: A <- B, A <- C, B <- D, C <- D
      const graph = createKnowledgeGraph();
      const aId = addClass(graph, 'A', 'cpp');
      const bId = addClass(graph, 'B', 'cpp');
      const cId = addClass(graph, 'C', 'cpp');
      const dId = addClass(graph, 'D', 'cpp');

      addExtends(graph, 'B', 'A');
      addExtends(graph, 'C', 'A');
      addExtends(graph, 'D', 'B'); // B is leftmost
      addExtends(graph, 'D', 'C');

      // A has foo, B overrides foo, C overrides foo
      addMethod(graph, 'A', 'foo');
      const bFoo = addMethod(graph, 'B', 'foo');
      const cFoo = addMethod(graph, 'C', 'foo');

      const result = computeMRO(graph);

      // D should have an entry with ambiguity on foo
      const dEntry = result.entries.find(e => e.className === 'D');
      expect(dEntry).toBeDefined();
      expect(dEntry!.language).toBe('cpp');

      const fooAmbiguity = dEntry!.ambiguities.find(a => a.methodName === 'foo');
      expect(fooAmbiguity).toBeDefined();
      expect(fooAmbiguity!.definedIn.length).toBeGreaterThanOrEqual(2);

      // Leftmost base (B) wins
      expect(fooAmbiguity!.resolvedTo).toBe(bFoo);
      expect(fooAmbiguity!.reason).toContain('C++ leftmost');
      expect(fooAmbiguity!.reason).toContain('B');

      // OVERRIDES edge emitted
      expect(result.overrideEdges).toBeGreaterThanOrEqual(1);
      const overrides = graph.relationships.filter(r => r.type === 'OVERRIDES');
      expect(overrides.some(r => r.sourceId === dId && r.targetId === bFoo)).toBe(true);
    });

    it('no ambiguity when foo only in A (diamond no override)', () => {
      // Diamond: A <- B, A <- C, B <- D, C <- D, but only A has foo
      const graph = createKnowledgeGraph();
      addClass(graph, 'A', 'cpp');
      addClass(graph, 'B', 'cpp');
      addClass(graph, 'C', 'cpp');
      addClass(graph, 'D', 'cpp');

      addExtends(graph, 'B', 'A');
      addExtends(graph, 'C', 'A');
      addExtends(graph, 'D', 'B');
      addExtends(graph, 'D', 'C');

      // Only A has foo
      addMethod(graph, 'A', 'foo');

      const result = computeMRO(graph);

      const dEntry = result.entries.find(e => e.className === 'D');
      expect(dEntry).toBeDefined();
      // A::foo appears only once across ancestors — no collision
      // (B and C don't have their own foo, the duplicate is A::foo seen through both paths)
      const fooAmbiguity = dEntry!.ambiguities.find(a => a.methodName === 'foo');
      expect(fooAmbiguity).toBeUndefined();
    });
  });

  // ---- C# class + interface -----------------------------------------------
  describe('C# class + interface', () => {
    it('class method beats interface default', () => {
      const graph = createKnowledgeGraph();
      const classId = addClass(graph, 'MyClass', 'csharp');
      const baseId = addClass(graph, 'BaseClass', 'csharp');
      const ifaceId = addClass(graph, 'IDoSomething', 'csharp', 'Interface');

      addExtends(graph, 'MyClass', 'BaseClass');
      addImplements(graph, 'MyClass', 'IDoSomething');

      const baseDoIt = addMethod(graph, 'BaseClass', 'doIt');
      const ifaceDoIt = addMethod(graph, 'IDoSomething', 'doIt', 'Interface');

      const result = computeMRO(graph);

      const entry = result.entries.find(e => e.className === 'MyClass');
      expect(entry).toBeDefined();

      const doItAmbiguity = entry!.ambiguities.find(a => a.methodName === 'doIt');
      expect(doItAmbiguity).toBeDefined();
      // Class method wins
      expect(doItAmbiguity!.resolvedTo).toBe(baseDoIt);
      expect(doItAmbiguity!.reason).toContain('class method wins');
    });

    it('multiple interface methods with same name are ambiguous', () => {
      const graph = createKnowledgeGraph();
      addClass(graph, 'MyClass', 'csharp');
      addClass(graph, 'IFoo', 'csharp', 'Interface');
      addClass(graph, 'IBar', 'csharp', 'Interface');

      addImplements(graph, 'MyClass', 'IFoo');
      addImplements(graph, 'MyClass', 'IBar');

      addMethod(graph, 'IFoo', 'process', 'Interface');
      addMethod(graph, 'IBar', 'process', 'Interface');

      const result = computeMRO(graph);

      const entry = result.entries.find(e => e.className === 'MyClass');
      expect(entry).toBeDefined();

      const processAmbiguity = entry!.ambiguities.find(a => a.methodName === 'process');
      expect(processAmbiguity).toBeDefined();
      expect(processAmbiguity!.resolvedTo).toBeNull();
      expect(processAmbiguity!.reason).toContain('ambiguous');
      expect(result.ambiguityCount).toBeGreaterThanOrEqual(1);
    });
  });

  // ---- Python C3 ----------------------------------------------------------
  describe('Python C3 linearization', () => {
    it('C3 order determines winner in diamond with overrides', () => {
      // Diamond: A <- B, A <- C, B <- D, C <- D
      // class D(B, C) → C3 MRO: B, C, A
      const graph = createKnowledgeGraph();
      addClass(graph, 'A', 'python');
      addClass(graph, 'B', 'python');
      addClass(graph, 'C', 'python');
      const dId = addClass(graph, 'D', 'python');

      addExtends(graph, 'B', 'A');
      addExtends(graph, 'C', 'A');
      addExtends(graph, 'D', 'B'); // B first → leftmost in C3
      addExtends(graph, 'D', 'C');

      addMethod(graph, 'A', 'foo');
      const bFoo = addMethod(graph, 'B', 'foo');
      addMethod(graph, 'C', 'foo');

      const result = computeMRO(graph);

      const dEntry = result.entries.find(e => e.className === 'D');
      expect(dEntry).toBeDefined();

      const fooAmbiguity = dEntry!.ambiguities.find(a => a.methodName === 'foo');
      expect(fooAmbiguity).toBeDefined();
      // C3 linearization for D(B, C): B comes first
      expect(fooAmbiguity!.resolvedTo).toBe(bFoo);
      expect(fooAmbiguity!.reason).toContain('Python C3');
    });
  });

  // ---- Java class + interface ---------------------------------------------
  describe('Java class + interface', () => {
    it('class method beats interface default', () => {
      const graph = createKnowledgeGraph();
      addClass(graph, 'Service', 'java');
      addClass(graph, 'BaseService', 'java');
      addClass(graph, 'Runnable', 'java', 'Interface');

      addExtends(graph, 'Service', 'BaseService');
      addImplements(graph, 'Service', 'Runnable');

      const baseRun = addMethod(graph, 'BaseService', 'run');
      addMethod(graph, 'Runnable', 'run', 'Interface');

      const result = computeMRO(graph);

      const entry = result.entries.find(e => e.className === 'Service');
      expect(entry).toBeDefined();

      const runAmbiguity = entry!.ambiguities.find(a => a.methodName === 'run');
      expect(runAmbiguity).toBeDefined();
      expect(runAmbiguity!.resolvedTo).toBe(baseRun);
      expect(runAmbiguity!.reason).toContain('class method wins');
    });
  });

  // ---- Rust trait conflicts -----------------------------------------------
  describe('Rust trait conflicts', () => {
    it('trait conflicts result in null resolution with qualified syntax reason', () => {
      const graph = createKnowledgeGraph();
      addClass(graph, 'MyStruct', 'rust', 'Struct');
      addClass(graph, 'TraitA', 'rust', 'Trait');
      addClass(graph, 'TraitB', 'rust', 'Trait');

      addImplements(graph, 'MyStruct', 'TraitA', 'Struct', 'Trait');
      addImplements(graph, 'MyStruct', 'TraitB', 'Struct', 'Trait');

      addMethod(graph, 'TraitA', 'execute', 'Trait');
      addMethod(graph, 'TraitB', 'execute', 'Trait');

      const result = computeMRO(graph);

      const entry = result.entries.find(e => e.className === 'MyStruct');
      expect(entry).toBeDefined();

      const execAmbiguity = entry!.ambiguities.find(a => a.methodName === 'execute');
      expect(execAmbiguity).toBeDefined();
      expect(execAmbiguity!.resolvedTo).toBeNull();
      expect(execAmbiguity!.reason).toContain('qualified syntax');
      expect(result.ambiguityCount).toBeGreaterThanOrEqual(1);

      // No OVERRIDES edge emitted for Rust ambiguity
      const overrides = graph.relationships.filter(
        r => r.type === 'OVERRIDES' && r.sourceId === generateId('Struct', 'MyStruct')
      );
      expect(overrides).toHaveLength(0);
    });
  });

  // ---- Property collisions don't trigger OVERRIDES ------------------------
  describe('Property nodes excluded from OVERRIDES', () => {
    it('property name collision across parents does not emit OVERRIDES edge', () => {
      const graph = createKnowledgeGraph();
      const parentA = addClass(graph, 'ParentA', 'typescript');
      const parentB = addClass(graph, 'ParentB', 'typescript');
      const child = addClass(graph, 'Child', 'typescript');

      addExtends(graph, 'Child', 'ParentA');
      addExtends(graph, 'Child', 'ParentB');

      // Add Property nodes (same name 'name') to both parents via HAS_METHOD
      const propA = generateId('Property', 'ParentA.name');
      graph.addNode({ id: propA, label: 'Property', properties: { name: 'name', filePath: 'src/ParentA.ts' } });
      graph.addRelationship({
        id: generateId('HAS_METHOD', `${parentA}->${propA}`),
        sourceId: parentA, targetId: propA, type: 'HAS_METHOD', confidence: 1.0, reason: '',
      });

      const propB = generateId('Property', 'ParentB.name');
      graph.addNode({ id: propB, label: 'Property', properties: { name: 'name', filePath: 'src/ParentB.ts' } });
      graph.addRelationship({
        id: generateId('HAS_METHOD', `${parentB}->${propB}`),
        sourceId: parentB, targetId: propB, type: 'HAS_METHOD', confidence: 1.0, reason: '',
      });

      const result = computeMRO(graph);

      // No OVERRIDES edge should be emitted for properties
      const overrides = graph.relationships.filter(r => r.type === 'OVERRIDES');
      expect(overrides).toHaveLength(0);
      expect(result.overrideEdges).toBe(0);
    });

    it('method collision still triggers OVERRIDES even when properties also collide', () => {
      const graph = createKnowledgeGraph();
      const parentA = addClass(graph, 'PA', 'cpp');
      const parentB = addClass(graph, 'PB', 'cpp');
      addClass(graph, 'Ch', 'cpp');

      addExtends(graph, 'Ch', 'PA');
      addExtends(graph, 'Ch', 'PB');

      // Method collision (should trigger OVERRIDES)
      const methodA = addMethod(graph, 'PA', 'doWork');
      addMethod(graph, 'PB', 'doWork');

      // Property collision (should NOT trigger OVERRIDES)
      const propA = generateId('Property', 'PA.id');
      graph.addNode({ id: propA, label: 'Property', properties: { name: 'id', filePath: 'src/PA.ts' } });
      graph.addRelationship({
        id: generateId('HAS_METHOD', `${parentA}->${propA}`),
        sourceId: parentA, targetId: propA, type: 'HAS_METHOD', confidence: 1.0, reason: '',
      });

      const propB = generateId('Property', 'PB.id');
      graph.addNode({ id: propB, label: 'Property', properties: { name: 'id', filePath: 'src/PB.ts' } });
      graph.addRelationship({
        id: generateId('HAS_METHOD', `${parentB}->${propB}`),
        sourceId: parentB, targetId: propB, type: 'HAS_METHOD', confidence: 1.0, reason: '',
      });

      const result = computeMRO(graph);

      // Only 1 OVERRIDES edge (for the method, not the property)
      const overrides = graph.relationships.filter(r => r.type === 'OVERRIDES');
      expect(overrides).toHaveLength(1);
      expect(overrides[0].targetId).toBe(methodA); // leftmost base wins for C++
      expect(result.overrideEdges).toBe(1);
    });
  });

  // ---- No ambiguity: single parent ----------------------------------------
  describe('single parent, no ambiguity', () => {
    it('single parent with unique methods produces no ambiguities', () => {
      const graph = createKnowledgeGraph();
      addClass(graph, 'Parent', 'typescript');
      addClass(graph, 'Child', 'typescript');

      addExtends(graph, 'Child', 'Parent');

      addMethod(graph, 'Parent', 'foo');
      addMethod(graph, 'Parent', 'bar');

      const result = computeMRO(graph);

      const entry = result.entries.find(e => e.className === 'Child');
      expect(entry).toBeDefined();
      expect(entry!.ambiguities).toHaveLength(0);
    });
  });

  // ---- No parents: standalone class not in entries ------------------------
  describe('standalone class', () => {
    it('class with no parents is not included in entries', () => {
      const graph = createKnowledgeGraph();
      addClass(graph, 'Standalone', 'typescript');
      addMethod(graph, 'Standalone', 'doStuff');

      const result = computeMRO(graph);

      const entry = result.entries.find(e => e.className === 'Standalone');
      expect(entry).toBeUndefined();
      expect(result.overrideEdges).toBe(0);
      expect(result.ambiguityCount).toBe(0);
    });
  });

  // ---- Own method shadows ancestor ----------------------------------------
  describe('own method shadows ancestor', () => {
    it('class defining its own method suppresses ambiguity', () => {
      const graph = createKnowledgeGraph();
      addClass(graph, 'Base1', 'cpp');
      addClass(graph, 'Base2', 'cpp');
      addClass(graph, 'Child', 'cpp');

      addExtends(graph, 'Child', 'Base1');
      addExtends(graph, 'Child', 'Base2');

      addMethod(graph, 'Base1', 'foo');
      addMethod(graph, 'Base2', 'foo');
      addMethod(graph, 'Child', 'foo'); // own method

      const result = computeMRO(graph);

      const entry = result.entries.find(e => e.className === 'Child');
      expect(entry).toBeDefined();
      // No ambiguity because Child defines its own foo
      const fooAmbiguity = entry!.ambiguities.find(a => a.methodName === 'foo');
      expect(fooAmbiguity).toBeUndefined();
    });
  });

  // ---- Empty graph --------------------------------------------------------
  describe('empty graph', () => {
    it('returns empty result for graph with no classes', () => {
      const graph = createKnowledgeGraph();
      const result = computeMRO(graph);
      expect(result.entries).toHaveLength(0);
      expect(result.overrideEdges).toBe(0);
      expect(result.ambiguityCount).toBe(0);
    });
  });

  // ---- Cyclic inheritance (P1 fix) ----------------------------------------
  describe('cyclic inheritance', () => {
    it('does not stack overflow on cyclic Python hierarchy', () => {
      // A extends B, B extends A — cyclic
      const graph = createKnowledgeGraph();
      addClass(graph, 'A', 'python');
      addClass(graph, 'B', 'python');
      addExtends(graph, 'A', 'B');
      addExtends(graph, 'B', 'A');
      addMethod(graph, 'A', 'foo');
      addMethod(graph, 'B', 'foo');

      // Should NOT throw — c3Linearize returns null, falls back to BFS
      const result = computeMRO(graph);
      expect(result).toBeDefined();
      // Both A and B have parents, so both get entries
      expect(result.entries.length).toBeGreaterThanOrEqual(1);
    });

    it('handles 3-node cycle gracefully', () => {
      // A → B → C → A
      const graph = createKnowledgeGraph();
      addClass(graph, 'X', 'python');
      addClass(graph, 'Y', 'python');
      addClass(graph, 'Z', 'python');
      addExtends(graph, 'X', 'Y');
      addExtends(graph, 'Y', 'Z');
      addExtends(graph, 'Z', 'X');

      const result = computeMRO(graph);
      expect(result).toBeDefined();
    });
  });
});
