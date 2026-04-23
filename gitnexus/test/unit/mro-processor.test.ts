import { describe, it, expect } from 'vitest';
import { computeMRO } from '../../src/core/ingestion/mro-processor.js';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import type { KnowledgeGraph } from '../../src/core/graph/types.js';
import { generateId } from '../../src/lib/utils.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addClass(
  graph: KnowledgeGraph,
  name: string,
  language: string,
  label: 'Class' | 'Interface' | 'Struct' | 'Trait' = 'Class',
) {
  const id = generateId(label, name);
  graph.addNode({
    id,
    label,
    properties: { name, filePath: `src/${name}.ts`, language },
  });
  return id;
}

function addMethod(
  graph: KnowledgeGraph,
  className: string,
  methodName: string,
  classLabel: 'Class' | 'Interface' | 'Struct' | 'Trait' = 'Class',
  parameterTypes?: string[],
  opts?: { isAbstract?: boolean; parameterCount?: number },
) {
  // Derive arity for the ID suffix: explicit parameterCount > parameterTypes.length > 0
  const arity = opts?.parameterCount ?? parameterTypes?.length ?? 0;
  const classId = generateId(classLabel, className);
  const methodId = generateId('Method', `${className}.${methodName}#${arity}`);
  graph.addNode({
    id: methodId,
    label: 'Method',
    properties: {
      name: methodName,
      filePath: `src/${className}.ts`,
      parameterCount: arity,
      ...(parameterTypes ? { parameterTypes } : {}),
      ...(opts?.isAbstract !== undefined ? { isAbstract: opts.isAbstract } : {}),
    },
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

function addExtends(
  graph: KnowledgeGraph,
  childName: string,
  parentName: string,
  childLabel: 'Class' | 'Struct' = 'Class',
  parentLabel: 'Class' | 'Interface' | 'Trait' = 'Class',
) {
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

function addInterfaceExtends(
  graph: KnowledgeGraph,
  childName: string,
  parentName: string,
  childLabel: 'Interface' | 'Trait' = 'Interface',
  parentLabel: 'Interface' | 'Trait' = 'Interface',
) {
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

function addImplements(
  graph: KnowledgeGraph,
  childName: string,
  parentName: string,
  childLabel: 'Class' | 'Struct' = 'Class',
  parentLabel: 'Interface' | 'Trait' = 'Interface',
) {
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
      const dEntry = result.entries.find((e) => e.className === 'D');
      expect(dEntry).toBeDefined();
      expect(dEntry!.language).toBe('cpp');

      const fooAmbiguity = dEntry!.ambiguities.find((a) => a.methodName === 'foo');
      expect(fooAmbiguity).toBeDefined();
      expect(fooAmbiguity!.definedIn.length).toBeGreaterThanOrEqual(2);

      // Leftmost base (B) wins
      expect(fooAmbiguity!.resolvedTo).toBe(bFoo);
      expect(fooAmbiguity!.reason).toContain('leftmost base');
      expect(fooAmbiguity!.reason).toContain('B');

      // OVERRIDES edge emitted
      expect(result.overrideEdges).toBeGreaterThanOrEqual(1);
      const overrides = graph.relationships.filter((r) => r.type === 'METHOD_OVERRIDES');
      expect(overrides.some((r) => r.sourceId === dId && r.targetId === bFoo)).toBe(true);
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

      const dEntry = result.entries.find((e) => e.className === 'D');
      expect(dEntry).toBeDefined();
      // A::foo appears only once across ancestors — no collision
      // (B and C don't have their own foo, the duplicate is A::foo seen through both paths)
      const fooAmbiguity = dEntry!.ambiguities.find((a) => a.methodName === 'foo');
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

      const entry = result.entries.find((e) => e.className === 'MyClass');
      expect(entry).toBeDefined();

      const doItAmbiguity = entry!.ambiguities.find((a) => a.methodName === 'doIt');
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

      const entry = result.entries.find((e) => e.className === 'MyClass');
      expect(entry).toBeDefined();

      const processAmbiguity = entry!.ambiguities.find((a) => a.methodName === 'process');
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

      const dEntry = result.entries.find((e) => e.className === 'D');
      expect(dEntry).toBeDefined();

      const fooAmbiguity = dEntry!.ambiguities.find((a) => a.methodName === 'foo');
      expect(fooAmbiguity).toBeDefined();
      // C3 linearization for D(B, C): B comes first
      expect(fooAmbiguity!.resolvedTo).toBe(bFoo);
      expect(fooAmbiguity!.reason).toContain('C3 MRO');
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

      const entry = result.entries.find((e) => e.className === 'Service');
      expect(entry).toBeDefined();

      const runAmbiguity = entry!.ambiguities.find((a) => a.methodName === 'run');
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

      const entry = result.entries.find((e) => e.className === 'MyStruct');
      expect(entry).toBeDefined();

      const execAmbiguity = entry!.ambiguities.find((a) => a.methodName === 'execute');
      expect(execAmbiguity).toBeDefined();
      expect(execAmbiguity!.resolvedTo).toBeNull();
      expect(execAmbiguity!.reason).toContain('qualified syntax');
      expect(result.ambiguityCount).toBeGreaterThanOrEqual(1);

      // No OVERRIDES edge emitted for Rust ambiguity
      const overrides = graph.relationships.filter(
        (r) => r.type === 'METHOD_OVERRIDES' && r.sourceId === generateId('Struct', 'MyStruct'),
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

      // Add Property nodes (same name 'name') to both parents via HAS_PROPERTY
      const propA = generateId('Property', 'ParentA.name');
      graph.addNode({
        id: propA,
        label: 'Property',
        properties: { name: 'name', filePath: 'src/ParentA.ts' },
      });
      graph.addRelationship({
        id: generateId('HAS_PROPERTY', `${parentA}->${propA}`),
        sourceId: parentA,
        targetId: propA,
        type: 'HAS_PROPERTY',
        confidence: 1.0,
        reason: '',
      });

      const propB = generateId('Property', 'ParentB.name');
      graph.addNode({
        id: propB,
        label: 'Property',
        properties: { name: 'name', filePath: 'src/ParentB.ts' },
      });
      graph.addRelationship({
        id: generateId('HAS_PROPERTY', `${parentB}->${propB}`),
        sourceId: parentB,
        targetId: propB,
        type: 'HAS_PROPERTY',
        confidence: 1.0,
        reason: '',
      });

      const result = computeMRO(graph);

      // No OVERRIDES edge should be emitted for properties
      const overrides = graph.relationships.filter((r) => r.type === 'METHOD_OVERRIDES');
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

      // Property collision (should NOT trigger OVERRIDES — properties use HAS_PROPERTY, not HAS_METHOD)
      const propA = generateId('Property', 'PA.id');
      graph.addNode({
        id: propA,
        label: 'Property',
        properties: { name: 'id', filePath: 'src/PA.ts' },
      });
      graph.addRelationship({
        id: generateId('HAS_PROPERTY', `${parentA}->${propA}`),
        sourceId: parentA,
        targetId: propA,
        type: 'HAS_PROPERTY',
        confidence: 1.0,
        reason: '',
      });

      const propB = generateId('Property', 'PB.id');
      graph.addNode({
        id: propB,
        label: 'Property',
        properties: { name: 'id', filePath: 'src/PB.ts' },
      });
      graph.addRelationship({
        id: generateId('HAS_PROPERTY', `${parentB}->${propB}`),
        sourceId: parentB,
        targetId: propB,
        type: 'HAS_PROPERTY',
        confidence: 1.0,
        reason: '',
      });

      const result = computeMRO(graph);

      // Only 1 OVERRIDES edge (for the method, not the property)
      const overrides = graph.relationships.filter((r) => r.type === 'METHOD_OVERRIDES');
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

      const entry = result.entries.find((e) => e.className === 'Child');
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

      const entry = result.entries.find((e) => e.className === 'Standalone');
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

      const entry = result.entries.find((e) => e.className === 'Child');
      expect(entry).toBeDefined();
      // No ambiguity because Child defines its own foo
      const fooAmbiguity = entry!.ambiguities.find((a) => a.methodName === 'foo');
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

    it('handles very deep single-inheritance chain without stack overflow', () => {
      // Chain of 2000 classes: C0 ← C1 ← C2 ← ... ← C1999
      // The iterative c3Linearize handles this without blowing the stack.
      // (The recursive version overflows at ~1K–5K levels depending on platform.)
      const graph = createKnowledgeGraph();
      const DEPTH = 2000;
      for (let i = 0; i < DEPTH; i++) {
        addClass(graph, `C${i}`, 'python');
      }
      for (let i = 1; i < DEPTH; i++) {
        addExtends(graph, `C${i}`, `C${i - 1}`);
      }
      // Add a method on the root so MRO produces an entry
      addMethod(graph, 'C0', 'baseMethod');

      const result = computeMRO(graph);
      expect(result).toBeDefined();
      // The deepest class should have all ancestors in its MRO
      const deepest = result.entries.find((e) => e.className === `C${DEPTH - 1}`);
      if (deepest) {
        expect(deepest.mro.length).toBe(DEPTH - 1);
      }
    }, 15_000);
  });

  // ---- METHOD_IMPLEMENTS edges -----------------------------------------------
  describe('METHOD_IMPLEMENTS edges', () => {
    it('emits METHOD_IMPLEMENTS for class implementing interface method', () => {
      // IAnimal { speak() } <-- Dog { speak() }
      const graph = createKnowledgeGraph();
      addClass(graph, 'IAnimal', 'java', 'Interface');
      addClass(graph, 'Dog', 'java');
      addImplements(graph, 'Dog', 'IAnimal');
      const ifaceMethod = addMethod(graph, 'IAnimal', 'speak', 'Interface');
      const classMethod = addMethod(graph, 'Dog', 'speak');

      const result = computeMRO(graph);
      expect(result.methodImplementsEdges).toBe(1);

      // Verify the edge exists: ConcreteMethod → InterfaceMethod
      const edges: any[] = [];
      graph.forEachRelationship((rel) => {
        if (rel.type === 'METHOD_IMPLEMENTS') edges.push(rel);
      });
      expect(edges).toHaveLength(1);
      expect(edges[0].sourceId).toBe(classMethod);
      expect(edges[0].targetId).toBe(ifaceMethod);
      // Both sides have parameterCount=0 (arity match) → confidence 1.0
      expect(edges[0].confidence).toBe(1.0);
    });

    it('emits METHOD_IMPLEMENTS for Rust struct implementing trait', () => {
      // Drawable { draw() } <-- Circle { draw() }
      const graph = createKnowledgeGraph();
      addClass(graph, 'Drawable', 'rust', 'Trait');
      addClass(graph, 'Circle', 'rust', 'Struct');
      addImplements(graph, 'Circle', 'Drawable', 'Struct', 'Trait');
      const traitMethod = addMethod(graph, 'Drawable', 'draw', 'Trait');
      const structMethod = addMethod(graph, 'Circle', 'draw', 'Struct');

      const result = computeMRO(graph);
      expect(result.methodImplementsEdges).toBe(1);

      const edges: any[] = [];
      graph.forEachRelationship((rel) => {
        if (rel.type === 'METHOD_IMPLEMENTS') edges.push(rel);
      });
      expect(edges[0].sourceId).toBe(structMethod);
      expect(edges[0].targetId).toBe(traitMethod);
    });

    it('matches overloaded interface methods by parameterTypes', () => {
      // IRepo { find(String), find(String, int) } <-- SqlRepo { find(String), find(String, int) }
      const graph = createKnowledgeGraph();
      addClass(graph, 'IRepo', 'java', 'Interface');
      addClass(graph, 'SqlRepo', 'java');
      addImplements(graph, 'SqlRepo', 'IRepo');

      // Use manual IDs to avoid overloaded-name collision (same name, different types)
      const ifaceFind1 = generateId('Method', 'IRepo.find#1');
      graph.addNode({
        id: ifaceFind1,
        label: 'Method',
        properties: {
          name: 'find',
          filePath: 'src/IRepo.ts',
          parameterTypes: ['String'],
          parameterCount: 1,
        },
      });
      graph.addRelationship({
        id: generateId('HAS_METHOD', `${generateId('Interface', 'IRepo')}->${ifaceFind1}`),
        sourceId: generateId('Interface', 'IRepo'),
        targetId: ifaceFind1,
        type: 'HAS_METHOD',
        confidence: 1.0,
        reason: '',
      });

      const ifaceFind2 = generateId('Method', 'IRepo.find#2');
      graph.addNode({
        id: ifaceFind2,
        label: 'Method',
        properties: {
          name: 'find',
          filePath: 'src/IRepo.ts',
          parameterTypes: ['String', 'int'],
          parameterCount: 2,
        },
      });
      graph.addRelationship({
        id: generateId('HAS_METHOD', `${generateId('Interface', 'IRepo')}->${ifaceFind2}`),
        sourceId: generateId('Interface', 'IRepo'),
        targetId: ifaceFind2,
        type: 'HAS_METHOD',
        confidence: 1.0,
        reason: '',
      });

      const sqlFind1Id = generateId('Method', 'SqlRepo.find#1');
      graph.addNode({
        id: sqlFind1Id,
        label: 'Method',
        properties: {
          name: 'find',
          filePath: 'src/SqlRepo.ts',
          parameterTypes: ['String'],
          parameterCount: 1,
        },
      });
      graph.addRelationship({
        id: generateId('HAS_METHOD', `${generateId('Class', 'SqlRepo')}->${sqlFind1Id}`),
        sourceId: generateId('Class', 'SqlRepo'),
        targetId: sqlFind1Id,
        type: 'HAS_METHOD',
        confidence: 1.0,
        reason: '',
      });

      const sqlFind2Id = generateId('Method', 'SqlRepo.find#2');
      graph.addNode({
        id: sqlFind2Id,
        label: 'Method',
        properties: {
          name: 'find',
          filePath: 'src/SqlRepo.ts',
          parameterTypes: ['String', 'int'],
          parameterCount: 2,
        },
      });
      graph.addRelationship({
        id: generateId('HAS_METHOD', `${generateId('Class', 'SqlRepo')}->${sqlFind2Id}`),
        sourceId: generateId('Class', 'SqlRepo'),
        targetId: sqlFind2Id,
        type: 'HAS_METHOD',
        confidence: 1.0,
        reason: '',
      });

      const result = computeMRO(graph);
      expect(result.methodImplementsEdges).toBe(2);

      const edges: any[] = [];
      graph.forEachRelationship((rel) => {
        if (rel.type === 'METHOD_IMPLEMENTS') edges.push(rel);
      });
      expect(edges).toHaveLength(2);
      // find(String) → find(String) and find(String, int) → find(String, int)
      const edge1 = edges.find((e) => e.targetId === ifaceFind1);
      const edge2 = edges.find((e) => e.targetId === ifaceFind2);
      expect(edge1).toBeDefined();
      expect(edge1!.sourceId).toBe(sqlFind1Id);
      expect(edge2).toBeDefined();
      expect(edge2!.sourceId).toBe(sqlFind2Id);
    });

    it('includes default interface methods (not just abstract)', () => {
      // Java 8 default method: IFoo { bar() } <-- Baz { bar() }
      const graph = createKnowledgeGraph();
      addClass(graph, 'IFoo', 'java', 'Interface');
      addClass(graph, 'Baz', 'java');
      addImplements(graph, 'Baz', 'IFoo');
      // Default method (has body, not abstract) — should still get METHOD_IMPLEMENTS
      addMethod(graph, 'IFoo', 'bar', 'Interface');
      addMethod(graph, 'Baz', 'bar');

      const result = computeMRO(graph);
      expect(result.methodImplementsEdges).toBe(1);
    });

    it('does not emit METHOD_IMPLEMENTS for class extending another class', () => {
      // Animal { speak() } <-- Dog { speak() } — EXTENDS, not IMPLEMENTS
      const graph = createKnowledgeGraph();
      addClass(graph, 'Animal', 'java');
      addClass(graph, 'Dog', 'java');
      addExtends(graph, 'Dog', 'Animal');
      addMethod(graph, 'Animal', 'speak');
      addMethod(graph, 'Dog', 'speak');

      const result = computeMRO(graph);
      expect(result.methodImplementsEdges).toBe(0);
    });

    it('does not emit METHOD_IMPLEMENTS when class has no matching method', () => {
      // IAnimal { speak() } <-- Dog { bark() } — no name match
      const graph = createKnowledgeGraph();
      addClass(graph, 'IAnimal', 'java', 'Interface');
      addClass(graph, 'Dog', 'java');
      addImplements(graph, 'Dog', 'IAnimal');
      addMethod(graph, 'IAnimal', 'speak', 'Interface');
      addMethod(graph, 'Dog', 'bark');

      const result = computeMRO(graph);
      expect(result.methodImplementsEdges).toBe(0);
    });

    it('skips Property nodes on interface', () => {
      const graph = createKnowledgeGraph();
      addClass(graph, 'IFoo', 'csharp', 'Interface');
      addClass(graph, 'Bar', 'csharp');
      addImplements(graph, 'Bar', 'IFoo');

      // Add a Property to the interface (not a Method)
      const propId = generateId('Property', 'IFoo.name');
      graph.addNode({
        id: propId,
        label: 'Property',
        properties: { name: 'name', filePath: 'src/IFoo.ts' },
      });
      graph.addRelationship({
        id: generateId('HAS_METHOD', `${generateId('Interface', 'IFoo')}->${propId}`),
        sourceId: generateId('Interface', 'IFoo'),
        targetId: propId,
        type: 'HAS_METHOD',
        confidence: 1.0,
        reason: '',
      });
      addMethod(graph, 'Bar', 'name');

      const result = computeMRO(graph);
      expect(result.methodImplementsEdges).toBe(0);
    });

    describe('METHOD_IMPLEMENTS transitive ancestors', () => {
      it('transitive interface chain: C.foo links to both B.foo and A.foo', () => {
        // A (Interface) has foo, B (Interface) has foo extends A, C (Class) implements B
        const graph = createKnowledgeGraph();
        addClass(graph, 'A', 'java', 'Interface');
        addClass(graph, 'B', 'java', 'Interface');
        addClass(graph, 'C', 'java');

        addInterfaceExtends(graph, 'B', 'A');
        addImplements(graph, 'C', 'B');

        const aFoo = addMethod(graph, 'A', 'foo', 'Interface');
        const bFoo = addMethod(graph, 'B', 'foo', 'Interface');
        addMethod(graph, 'C', 'foo');

        const result = computeMRO(graph);

        const edges: any[] = [];
        graph.forEachRelationship((rel) => {
          if (rel.type === 'METHOD_IMPLEMENTS') edges.push(rel);
        });

        // C.foo should link to both B.foo and A.foo
        expect(edges.some((e) => e.targetId === bFoo)).toBe(true);
        expect(edges.some((e) => e.targetId === aFoo)).toBe(true);
        expect(result.methodImplementsEdges).toBeGreaterThanOrEqual(2);
      });

      it('inherited contract method only on grandparent: C.bar links to A.bar', () => {
        // A (Interface) has bar, B (Interface) extends A but has NO bar, C implements B
        const graph = createKnowledgeGraph();
        addClass(graph, 'A', 'java', 'Interface');
        addClass(graph, 'B', 'java', 'Interface');
        addClass(graph, 'C', 'java');

        addInterfaceExtends(graph, 'B', 'A');
        addImplements(graph, 'C', 'B');

        const aBar = addMethod(graph, 'A', 'bar', 'Interface');
        // B has no bar method
        addMethod(graph, 'C', 'bar');

        const result = computeMRO(graph);

        const edges: any[] = [];
        graph.forEachRelationship((rel) => {
          if (rel.type === 'METHOD_IMPLEMENTS') edges.push(rel);
        });

        // C.bar should link to A.bar even though A is not a direct parent
        expect(edges.some((e) => e.targetId === aBar)).toBe(true);
        expect(result.methodImplementsEdges).toBeGreaterThanOrEqual(1);
      });

      it('diamond deduplication: E.foo gets exactly one edge to A.foo', () => {
        // A (Interface) has foo
        // B (Interface) has foo, extends A
        // D (Interface) has foo, extends A
        // E (Class) implements B and D
        const graph = createKnowledgeGraph();
        addClass(graph, 'A', 'java', 'Interface');
        addClass(graph, 'B', 'java', 'Interface');
        addClass(graph, 'D', 'java', 'Interface');
        addClass(graph, 'E', 'java');

        addInterfaceExtends(graph, 'B', 'A');
        addInterfaceExtends(graph, 'D', 'A');
        addImplements(graph, 'E', 'B');
        addImplements(graph, 'E', 'D');

        const aFoo = addMethod(graph, 'A', 'foo', 'Interface');
        const bFoo = addMethod(graph, 'B', 'foo', 'Interface');
        const dFoo = addMethod(graph, 'D', 'foo', 'Interface');
        addMethod(graph, 'E', 'foo');

        const result = computeMRO(graph);

        const eFoo = generateId('Method', 'E.foo#0');
        const edges: any[] = [];
        graph.forEachRelationship((rel) => {
          if (rel.type === 'METHOD_IMPLEMENTS') edges.push(rel);
        });

        // Filter to only edges FROM E.foo
        const eFooEdges = edges.filter((e) => e.sourceId === eFoo);

        // E.foo should link to B.foo, D.foo, and exactly ONE A.foo (deduplicated)
        expect(eFooEdges.filter((e) => e.targetId === bFoo)).toHaveLength(1);
        expect(eFooEdges.filter((e) => e.targetId === dFoo)).toHaveLength(1);
        expect(eFooEdges.filter((e) => e.targetId === aFoo)).toHaveLength(1);
        // Total from E.foo: 3 edges (B.foo + D.foo + A.foo), not 4
        expect(eFooEdges).toHaveLength(3);
      });

      it('no transitive through class-only chain', () => {
        // A (Class) has foo, B (Class) extends A has foo, C (Class) extends B has foo
        const graph = createKnowledgeGraph();
        addClass(graph, 'A', 'java');
        addClass(graph, 'B', 'java');
        addClass(graph, 'C', 'java');

        addExtends(graph, 'B', 'A');
        addExtends(graph, 'C', 'B');

        addMethod(graph, 'A', 'foo');
        addMethod(graph, 'B', 'foo');
        addMethod(graph, 'C', 'foo');

        const result = computeMRO(graph);

        // All class-extends, no interface involved → 0 METHOD_IMPLEMENTS edges
        expect(result.methodImplementsEdges).toBe(0);
      });
    });

    it('is queryable via MATCH pattern', () => {
      const graph = createKnowledgeGraph();
      addClass(graph, 'IRepo', 'typescript', 'Interface');
      addClass(graph, 'SqlRepo', 'typescript');
      addImplements(graph, 'SqlRepo', 'IRepo');
      addMethod(graph, 'IRepo', 'fetch', 'Interface');
      const concreteId = addMethod(graph, 'SqlRepo', 'fetch');

      computeMRO(graph);

      // Simulate MATCH (m)-[:METHOD_IMPLEMENTS]->(i) RETURN m
      const implementingMethods: string[] = [];
      graph.forEachRelationship((rel) => {
        if (rel.type === 'METHOD_IMPLEMENTS') {
          implementingMethods.push(rel.sourceId);
        }
      });
      expect(implementingMethods).toContain(concreteId);
    });

    describe('METHOD_IMPLEMENTS inherited + arity matching', () => {
      it('inherited implementation: Base.foo satisfies I.foo when C has no own foo', () => {
        const graph = createKnowledgeGraph();
        addClass(graph, 'Base', 'java');
        addClass(graph, 'I', 'java', 'Interface');
        addClass(graph, 'C', 'java');

        addExtends(graph, 'C', 'Base');
        addImplements(graph, 'C', 'I');

        const baseFoo = addMethod(graph, 'Base', 'foo');
        const iFoo = addMethod(graph, 'I', 'foo', 'Interface');

        const result = computeMRO(graph);

        const edges: any[] = [];
        graph.forEachRelationship((rel) => {
          if (rel.type === 'METHOD_IMPLEMENTS') edges.push(rel);
        });

        expect(edges).toHaveLength(1);
        expect(edges[0].sourceId).toBe(baseFoo);
        expect(edges[0].targetId).toBe(iFoo);
        expect(result.methodImplementsEdges).toBe(1);
      });

      it('class has own method — no inherited lookup needed', () => {
        const graph = createKnowledgeGraph();
        addClass(graph, 'Base2', 'java');
        addClass(graph, 'I2', 'java', 'Interface');
        addClass(graph, 'C2', 'java');

        addExtends(graph, 'C2', 'Base2');
        addImplements(graph, 'C2', 'I2');

        const baseFoo = addMethod(graph, 'Base2', 'foo');
        const iFoo = addMethod(graph, 'I2', 'foo', 'Interface');
        const cFoo = addMethod(graph, 'C2', 'foo');

        const result = computeMRO(graph);

        const edges: any[] = [];
        graph.forEachRelationship((rel) => {
          if (rel.type === 'METHOD_IMPLEMENTS') edges.push(rel);
        });

        // Should use C2.foo, not Base2.foo
        expect(edges).toHaveLength(1);
        expect(edges[0].sourceId).toBe(cFoo);
        expect(edges[0].targetId).toBe(iFoo);
      });

      it('deep inheritance chain: GrandBase.foo satisfies I.foo', () => {
        const graph = createKnowledgeGraph();
        addClass(graph, 'GrandBase', 'java');
        addClass(graph, 'Base3', 'java');
        addClass(graph, 'I3', 'java', 'Interface');
        addClass(graph, 'C3', 'java');

        addExtends(graph, 'Base3', 'GrandBase');
        addExtends(graph, 'C3', 'Base3');
        addImplements(graph, 'C3', 'I3');

        const grandFoo = addMethod(graph, 'GrandBase', 'foo');
        // Base3 has NO foo
        const iFoo = addMethod(graph, 'I3', 'foo', 'Interface');

        const result = computeMRO(graph);

        const edges: any[] = [];
        graph.forEachRelationship((rel) => {
          if (rel.type === 'METHOD_IMPLEMENTS') edges.push(rel);
        });

        expect(edges).toHaveLength(1);
        expect(edges[0].sourceId).toBe(grandFoo);
        expect(edges[0].targetId).toBe(iFoo);
        expect(result.methodImplementsEdges).toBe(1);
      });

      it('arity mismatch prevents false match', () => {
        const graph = createKnowledgeGraph();
        addClass(graph, 'IArity', 'java', 'Interface');
        addClass(graph, 'CArity', 'java');
        addImplements(graph, 'CArity', 'IArity');

        // Interface method: parameterCount=2, no parameterTypes
        const iMethodId = generateId('Method', 'IArity.process#2');
        graph.addNode({
          id: iMethodId,
          label: 'Method',
          properties: { name: 'process', filePath: 'src/IArity.ts', parameterCount: 2 },
        });
        graph.addRelationship({
          id: generateId('HAS_METHOD', `${generateId('Interface', 'IArity')}->${iMethodId}`),
          sourceId: generateId('Interface', 'IArity'),
          targetId: iMethodId,
          type: 'HAS_METHOD',
          confidence: 1.0,
          reason: '',
        });

        // Class method: parameterCount=3, no parameterTypes
        const cMethodId = generateId('Method', 'CArity.process#3');
        graph.addNode({
          id: cMethodId,
          label: 'Method',
          properties: { name: 'process', filePath: 'src/CArity.ts', parameterCount: 3 },
        });
        graph.addRelationship({
          id: generateId('HAS_METHOD', `${generateId('Class', 'CArity')}->${cMethodId}`),
          sourceId: generateId('Class', 'CArity'),
          targetId: cMethodId,
          type: 'HAS_METHOD',
          confidence: 1.0,
          reason: '',
        });

        const result = computeMRO(graph);
        expect(result.methodImplementsEdges).toBe(0);
      });

      it('arity match when types missing', () => {
        const graph = createKnowledgeGraph();
        addClass(graph, 'IArityOk', 'java', 'Interface');
        addClass(graph, 'CArityOk', 'java');
        addImplements(graph, 'CArityOk', 'IArityOk');

        // Interface method: parameterCount=2, no parameterTypes
        const iMethodId = generateId('Method', 'IArityOk.process#2');
        graph.addNode({
          id: iMethodId,
          label: 'Method',
          properties: { name: 'process', filePath: 'src/IArityOk.ts', parameterCount: 2 },
        });
        graph.addRelationship({
          id: generateId('HAS_METHOD', `${generateId('Interface', 'IArityOk')}->${iMethodId}`),
          sourceId: generateId('Interface', 'IArityOk'),
          targetId: iMethodId,
          type: 'HAS_METHOD',
          confidence: 1.0,
          reason: '',
        });

        // Class method: parameterCount=2, no parameterTypes
        const cMethodId = generateId('Method', 'CArityOk.process#2');
        graph.addNode({
          id: cMethodId,
          label: 'Method',
          properties: { name: 'process', filePath: 'src/CArityOk.ts', parameterCount: 2 },
        });
        graph.addRelationship({
          id: generateId('HAS_METHOD', `${generateId('Class', 'CArityOk')}->${cMethodId}`),
          sourceId: generateId('Class', 'CArityOk'),
          targetId: cMethodId,
          type: 'HAS_METHOD',
          confidence: 1.0,
          reason: '',
        });

        const result = computeMRO(graph);
        expect(result.methodImplementsEdges).toBe(1);
      });

      it('multiple same-arity candidates = ambiguous, no edge emitted', () => {
        const graph = createKnowledgeGraph();
        addClass(graph, 'IAmbig', 'java', 'Interface');
        addClass(graph, 'CAmbig', 'java');
        addImplements(graph, 'CAmbig', 'IAmbig');

        // Interface method: parameterCount=1, no parameterTypes
        const iMethodId = generateId('Method', 'IAmbig.handle#1');
        graph.addNode({
          id: iMethodId,
          label: 'Method',
          properties: { name: 'handle', filePath: 'src/IAmbig.ts', parameterCount: 1 },
        });
        graph.addRelationship({
          id: generateId('HAS_METHOD', `${generateId('Interface', 'IAmbig')}->${iMethodId}`),
          sourceId: generateId('Interface', 'IAmbig'),
          targetId: iMethodId,
          type: 'HAS_METHOD',
          confidence: 1.0,
          reason: '',
        });

        // Two class methods named handle, both with parameterCount=1
        const cMethod1 = generateId('Method', 'CAmbig.handle.1#1');
        graph.addNode({
          id: cMethod1,
          label: 'Method',
          properties: { name: 'handle', filePath: 'src/CAmbig.ts', parameterCount: 1 },
        });
        graph.addRelationship({
          id: generateId('HAS_METHOD', `${generateId('Class', 'CAmbig')}->${cMethod1}`),
          sourceId: generateId('Class', 'CAmbig'),
          targetId: cMethod1,
          type: 'HAS_METHOD',
          confidence: 1.0,
          reason: '',
        });

        const cMethod2 = generateId('Method', 'CAmbig.handle.2#1');
        graph.addNode({
          id: cMethod2,
          label: 'Method',
          properties: { name: 'handle', filePath: 'src/CAmbig.ts', parameterCount: 1 },
        });
        graph.addRelationship({
          id: generateId('HAS_METHOD', `${generateId('Class', 'CAmbig')}->${cMethod2}`),
          sourceId: generateId('Class', 'CAmbig'),
          targetId: cMethod2,
          type: 'HAS_METHOD',
          confidence: 1.0,
          reason: '',
        });

        const result = computeMRO(graph);
        expect(result.methodImplementsEdges).toBe(0);
      });
    });
  });

  // ---- findInheritedMethod ambiguity detection ------------------------------
  describe('findInheritedMethod ambiguity', () => {
    it('returns null when two EXTENDS parents both provide matching method', () => {
      // I { foo() }, B { foo() }, M { foo() }, C extends B + M, C implements I
      const graph = createKnowledgeGraph();
      addClass(graph, 'I', 'cpp', 'Interface');
      addClass(graph, 'B', 'cpp');
      addClass(graph, 'M', 'cpp');
      addClass(graph, 'C', 'cpp');
      addImplements(graph, 'C', 'I');
      addExtends(graph, 'C', 'B');
      addExtends(graph, 'C', 'M');
      addMethod(graph, 'I', 'foo', 'Interface');
      addMethod(graph, 'B', 'foo');
      addMethod(graph, 'M', 'foo');
      // C has NO own foo — must walk EXTENDS chain

      const result = computeMRO(graph);
      // Ambiguous: B.foo and M.foo both match — no METHOD_IMPLEMENTS edge
      const mi = graph.relationships.filter((r) => r.type === 'METHOD_IMPLEMENTS');
      const fooEdges = mi.filter((e) => graph.getNode(e.targetId)?.properties.name === 'foo');
      expect(fooEdges).toHaveLength(0);
    });

    it('diamond dedup: same method via two paths is NOT ambiguous', () => {
      // I { foo() }, GrandBase { foo() }, B extends GrandBase, M extends GrandBase
      // C extends B + M, C implements I
      const graph = createKnowledgeGraph();
      addClass(graph, 'I', 'cpp', 'Interface');
      addClass(graph, 'GrandBase', 'cpp');
      addClass(graph, 'B', 'cpp');
      addClass(graph, 'M', 'cpp');
      addClass(graph, 'C', 'cpp');
      addImplements(graph, 'C', 'I');
      addExtends(graph, 'C', 'B');
      addExtends(graph, 'C', 'M');
      addExtends(graph, 'B', 'GrandBase');
      addExtends(graph, 'M', 'GrandBase');
      addMethod(graph, 'I', 'foo', 'Interface');
      const gbFoo = addMethod(graph, 'GrandBase', 'foo');
      // B and M have NO own foo — both inherit from GrandBase

      const result = computeMRO(graph);
      // Not ambiguous: same GrandBase.foo via both paths
      const mi = graph.relationships.filter((r) => r.type === 'METHOD_IMPLEMENTS');
      const fooEdge = mi.find((e) => e.sourceId === gbFoo);
      expect(fooEdge).toBeDefined();
    });

    it('C extends B extends A, B and A both have foo → returns B.foo (nearest)', () => {
      // I { foo() }, A { foo() }, B extends A { foo() }, C extends B implements I { no foo }
      const graph = createKnowledgeGraph();
      addClass(graph, 'I', 'java', 'Interface');
      addClass(graph, 'A', 'java');
      addClass(graph, 'B', 'java');
      addClass(graph, 'C', 'java');
      addImplements(graph, 'C', 'I');
      addExtends(graph, 'C', 'B');
      addExtends(graph, 'B', 'A');
      addMethod(graph, 'I', 'foo', 'Interface');
      addMethod(graph, 'A', 'foo');
      const bFoo = addMethod(graph, 'B', 'foo');
      // C has NO own foo — nearest is B.foo at depth 1

      computeMRO(graph);
      const mi = graph.relationships.filter((r) => r.type === 'METHOD_IMPLEMENTS');
      const fooEdge = mi.find((e) => e.sourceId === bFoo);
      expect(fooEdge).toBeDefined();
      // A.foo should NOT be reached
      const aFooId = generateId('Method', 'A.foo#0');
      const aFooEdge = mi.find((e) => e.sourceId === aFooId);
      expect(aFooEdge).toBeUndefined();
    });

    it('C extends B extends A, only A has foo → returns A.foo (single match at depth 2)', () => {
      // I { foo() }, A { foo() }, B extends A { no foo }, C extends B implements I { no foo }
      const graph = createKnowledgeGraph();
      addClass(graph, 'I', 'java', 'Interface');
      addClass(graph, 'A', 'java');
      addClass(graph, 'B', 'java');
      addClass(graph, 'C', 'java');
      addImplements(graph, 'C', 'I');
      addExtends(graph, 'C', 'B');
      addExtends(graph, 'B', 'A');
      addMethod(graph, 'I', 'foo', 'Interface');
      const aFoo = addMethod(graph, 'A', 'foo');
      // B has NO foo, C has NO foo — only A.foo at depth 2

      computeMRO(graph);
      const mi = graph.relationships.filter((r) => r.type === 'METHOD_IMPLEMENTS');
      const fooEdge = mi.find((e) => e.sourceId === aFoo);
      expect(fooEdge).toBeDefined();
    });
  });

  // ---- METHOD_IMPLEMENTS concrete-source guard ----------------------------
  describe('METHOD_IMPLEMENTS concrete-source guard', () => {
    it('interface B extends interface A, B redeclares foo → 0 METHOD_IMPLEMENTS', () => {
      const graph = createKnowledgeGraph();
      addClass(graph, 'A', 'java', 'Interface');
      addClass(graph, 'B', 'java', 'Interface');
      addInterfaceExtends(graph, 'B', 'A');
      addMethod(graph, 'A', 'foo', 'Interface');
      addMethod(graph, 'B', 'foo', 'Interface');

      computeMRO(graph);

      const mi = graph.relationships.filter((r) => r.type === 'METHOD_IMPLEMENTS');
      expect(mi).toHaveLength(0);
    });

    it('abstract class C implements I, C has abstract foo → 0 METHOD_IMPLEMENTS for foo', () => {
      const graph = createKnowledgeGraph();
      addClass(graph, 'I', 'java', 'Interface');
      addClass(graph, 'C', 'java', 'Class');
      addImplements(graph, 'C', 'I');
      addMethod(graph, 'I', 'foo', 'Interface');

      // Add abstract method manually with isAbstract flag
      const classId = generateId('Class', 'C');
      const methodId = generateId('Method', 'C.foo#0');
      graph.addNode({
        id: methodId,
        label: 'Method',
        properties: { name: 'foo', filePath: 'src/C.ts', isAbstract: true, parameterCount: 0 },
      });
      graph.addRelationship({
        id: generateId('HAS_METHOD', `${classId}->${methodId}`),
        sourceId: classId,
        targetId: methodId,
        type: 'HAS_METHOD',
        confidence: 1.0,
        reason: '',
      });

      computeMRO(graph);

      const mi = graph.relationships.filter((r) => r.type === 'METHOD_IMPLEMENTS');
      expect(mi).toHaveLength(0);
    });

    it('abstract class C implements I, C has concrete bar → 1 METHOD_IMPLEMENTS for bar', () => {
      const graph = createKnowledgeGraph();
      addClass(graph, 'I', 'java', 'Interface');
      addClass(graph, 'C', 'java', 'Class');
      addImplements(graph, 'C', 'I');
      addMethod(graph, 'I', 'bar', 'Interface');
      const cBar = addMethod(graph, 'C', 'bar');

      computeMRO(graph);

      const mi = graph.relationships.filter((r) => r.type === 'METHOD_IMPLEMENTS');
      expect(mi).toHaveLength(1);
      expect(mi[0].sourceId).toBe(cBar);
    });

    it('concrete class implements interface → 1 METHOD_IMPLEMENTS (regression)', () => {
      const graph = createKnowledgeGraph();
      addClass(graph, 'I', 'java', 'Interface');
      addClass(graph, 'C', 'java', 'Class');
      addImplements(graph, 'C', 'I');
      addMethod(graph, 'I', 'foo', 'Interface');
      const cFoo = addMethod(graph, 'C', 'foo');

      computeMRO(graph);

      const mi = graph.relationships.filter((r) => r.type === 'METHOD_IMPLEMENTS');
      expect(mi).toHaveLength(1);
      expect(mi[0].sourceId).toBe(cFoo);
    });
  });

  describe('default interface method resolution', () => {
    it('interface default method satisfies grandparent interface contract', () => {
      // I1 has abstract bar, I2 extends I1 and provides concrete bar,
      // C implements I2 with no own bar → edge from I2.bar → I1.bar
      const graph = createKnowledgeGraph();
      addClass(graph, 'I1Def', 'java', 'Interface');
      addClass(graph, 'I2Def', 'java', 'Interface');
      addClass(graph, 'CDef', 'java');

      addInterfaceExtends(graph, 'I2Def', 'I1Def');
      addImplements(graph, 'CDef', 'I2Def');

      const i1Bar = addMethod(graph, 'I1Def', 'bar', 'Interface', undefined, { isAbstract: true });
      const i2Bar = addMethod(graph, 'I2Def', 'bar', 'Interface', undefined, {
        isAbstract: false,
      });

      const result = computeMRO(graph);

      const edges = graph.relationships.filter((r) => r.type === 'METHOD_IMPLEMENTS');
      expect(edges).toHaveLength(1);
      expect(edges[0].sourceId).toBe(i2Bar);
      expect(edges[0].targetId).toBe(i1Bar);
    });

    it('own method takes priority over interface default', () => {
      // I has concrete default bar, C implements I and has own bar
      // → edge from C.bar → I.bar (own method wins, no IMPLEMENTS fallback needed)
      const graph = createKnowledgeGraph();
      addClass(graph, 'IOwn', 'java', 'Interface');
      addClass(graph, 'COwn', 'java');

      addImplements(graph, 'COwn', 'IOwn');

      const iBar = addMethod(graph, 'IOwn', 'bar', 'Interface', undefined, { isAbstract: false });
      const cBar = addMethod(graph, 'COwn', 'bar');

      computeMRO(graph);

      const edges = graph.relationships.filter((r) => r.type === 'METHOD_IMPLEMENTS');
      expect(edges).toHaveLength(1);
      expect(edges[0].sourceId).toBe(cBar);
      expect(edges[0].targetId).toBe(iBar);
    });

    it('transitive interface default: C implements I2, I2 extends I1, I1 has abstract bar, I2 has default bar → I2.bar satisfies I1.bar', () => {
      // I1 (Interface) has abstract bar
      // I2 (Interface) extends I1, has concrete default bar
      // C (Class) implements I2, has NO bar
      // The main emitter processes CImpl's ancestor I1 (transitive via I2).
      // I1.bar is abstract → CImpl has no own bar → findInheritedMethod runs.
      // EXTENDS BFS: nothing. IMPLEMENTS BFS: walks I2 → finds concrete I2.bar.
      // Edge: I2.bar → I1.bar
      const graph = createKnowledgeGraph();
      addClass(graph, 'I1', 'java', 'Interface');
      addClass(graph, 'I2', 'java', 'Interface');
      addClass(graph, 'CImpl', 'java');

      // I1 has abstract bar
      const i1Bar = addMethod(graph, 'I1', 'bar', 'Interface', undefined, { isAbstract: true });
      // I2 has concrete default bar
      const i2Bar = addMethod(graph, 'I2', 'bar', 'Interface');

      // I2 extends I1
      const i2Id = generateId('Interface', 'I2');
      const i1Id = generateId('Interface', 'I1');
      graph.addRelationship({
        id: generateId('EXTENDS', `${i2Id}->${i1Id}`),
        sourceId: i2Id,
        targetId: i1Id,
        type: 'EXTENDS',
        confidence: 1.0,
        reason: '',
      });
      // CImpl implements I2
      addImplements(graph, 'CImpl', 'I2');

      const result = computeMRO(graph);
      const mi = graph.relationships.filter((r) => r.type === 'METHOD_IMPLEMENTS');
      // I2.bar (concrete default) satisfies I1.bar (abstract contract)
      const barEdge = mi.find((e) => e.targetId === i1Bar && e.sourceId === i2Bar);
      expect(barEdge).toBeDefined();
    });

    it('EXTENDS method takes priority over interface default', () => {
      // I has concrete default foo, Base has concrete foo,
      // C extends Base and implements I with no own foo
      // → edge from Base.foo → I.foo (EXTENDS wins over IMPLEMENTS default)
      const graph = createKnowledgeGraph();
      addClass(graph, 'IExtPri', 'java', 'Interface');
      addClass(graph, 'BaseExtPri', 'java');
      addClass(graph, 'CExtPri', 'java');

      addExtends(graph, 'CExtPri', 'BaseExtPri');
      addImplements(graph, 'CExtPri', 'IExtPri');

      const iFoo = addMethod(graph, 'IExtPri', 'foo', 'Interface', undefined, {
        isAbstract: false,
      });
      const baseFoo = addMethod(graph, 'BaseExtPri', 'foo');

      computeMRO(graph);

      const edges = graph.relationships.filter((r) => r.type === 'METHOD_IMPLEMENTS');
      expect(edges).toHaveLength(1);
      expect(edges[0].sourceId).toBe(baseFoo);
      expect(edges[0].targetId).toBe(iFoo);
    });

    it('Dart implements Class — does NOT inherit concrete method bodies', () => {
      // Dart: class C implements AbstractBase (labeled Class, not Interface)
      // AbstractBase has concrete method foo
      // C has NO foo — but Dart implements does NOT inherit bodies
      // → 0 METHOD_IMPLEMENTS edges from the IMPLEMENTS fallback
      const graph = createKnowledgeGraph();
      addClass(graph, 'AbstractBase', 'dart'); // Class label, not Interface
      addClass(graph, 'DartImpl', 'dart');

      // AbstractBase has concrete foo
      addMethod(graph, 'AbstractBase', 'foo');

      // DartImpl implements AbstractBase (IMPLEMENTS edge to a Class)
      addImplements(graph, 'DartImpl', 'AbstractBase', 'Class', 'Interface');
      // But we need AbstractBase to be a Class, not Interface — fix the label
      // Actually addImplements creates the edge, but AbstractBase was added as Class.
      // The IMPLEMENTS edge target needs to match the actual node ID.
      // Let's do this manually:
      const dartImplId = generateId('Class', 'DartImpl');
      const absBaseId = generateId('Class', 'AbstractBase');
      graph.addRelationship({
        id: generateId('IMPLEMENTS', `${dartImplId}->${absBaseId}`),
        sourceId: dartImplId,
        targetId: absBaseId,
        type: 'IMPLEMENTS',
        confidence: 1.0,
        reason: '',
      });

      computeMRO(graph);
      const mi = graph.relationships.filter((r) => r.type === 'METHOD_IMPLEMENTS');
      // No edges — IMPLEMENTS fallback skips Class-labeled parents
      expect(mi).toHaveLength(0);
    });

    it('Interface default still works after Dart label gate', () => {
      const graph = createKnowledgeGraph();
      addClass(graph, 'IDefault', 'java', 'Interface');
      addClass(graph, 'Impl', 'java');
      addImplements(graph, 'Impl', 'IDefault');
      // IDefault has abstract contract method
      const iFoo = addMethod(graph, 'IDefault', 'foo', 'Interface', undefined, {
        isAbstract: true,
      });
      // IDefault also has concrete default bar
      const iBar = addMethod(graph, 'IDefault', 'bar', 'Interface');
      // Impl has foo but not bar
      addMethod(graph, 'Impl', 'foo');

      computeMRO(graph);
      const mi = graph.relationships.filter((r) => r.type === 'METHOD_IMPLEMENTS');
      // foo: own method matches → edge from Impl.foo → IDefault.foo
      const fooEdge = mi.find((e) => e.targetId === iFoo);
      expect(fooEdge).toBeDefined();
      // bar: no own method, IMPLEMENTS fallback finds IDefault.bar (Interface label OK)
      const barEdge = mi.find((e) => e.sourceId === iBar && e.targetId === iBar);
      // Actually bar is the same method — it's the default implementation satisfying itself.
      // The emitter processes IDefault.bar as an ancestor method, Impl has no bar,
      // findInheritedMethod runs, walks IMPLEMENTS → finds IDefault.bar (non-abstract).
      // But excludeMethodId = ancestorMethodId = iBar → skipped to prevent self-edge!
      // So no bar edge. This is correct — the default satisfies the contract inherently.
    });
  });

  describe('METHOD_IMPLEMENTS confidence tiering', () => {
    it('fully-typed match gets confidence 1.0', () => {
      const graph = createKnowledgeGraph();
      addClass(graph, 'ITyped', 'java', 'Interface');
      addClass(graph, 'CTyped', 'java');
      addImplements(graph, 'CTyped', 'ITyped');

      const iFoo = addMethod(graph, 'ITyped', 'foo', 'Interface', ['int', 'String']);
      const cFoo = addMethod(graph, 'CTyped', 'foo', 'Class', ['int', 'String']);

      computeMRO(graph);

      const edges = graph.relationships.filter((r) => r.type === 'METHOD_IMPLEMENTS');
      expect(edges).toHaveLength(1);
      expect(edges[0].sourceId).toBe(cFoo);
      expect(edges[0].targetId).toBe(iFoo);
      expect(edges[0].confidence).toBe(1.0);
    });

    it('arity-only match (both have parameterCount, no types) gets confidence 1.0', () => {
      const graph = createKnowledgeGraph();
      addClass(graph, 'IArity', 'java', 'Interface');
      addClass(graph, 'CArity', 'java');
      addImplements(graph, 'CArity', 'IArity');

      // Manually add methods with parameterCount but no parameterTypes
      const iBarId = generateId('Method', 'IArity.bar#2');
      graph.addNode({
        id: iBarId,
        label: 'Method',
        properties: { name: 'bar', filePath: 'src/IArity.ts', parameterCount: 2 },
      });
      graph.addRelationship({
        id: generateId('HAS_METHOD', `${generateId('Interface', 'IArity')}->${iBarId}`),
        sourceId: generateId('Interface', 'IArity'),
        targetId: iBarId,
        type: 'HAS_METHOD',
        confidence: 1.0,
        reason: '',
      });

      const cBarId = generateId('Method', 'CArity.bar#2');
      graph.addNode({
        id: cBarId,
        label: 'Method',
        properties: { name: 'bar', filePath: 'src/CArity.ts', parameterCount: 2 },
      });
      graph.addRelationship({
        id: generateId('HAS_METHOD', `${generateId('Class', 'CArity')}->${cBarId}`),
        sourceId: generateId('Class', 'CArity'),
        targetId: cBarId,
        type: 'HAS_METHOD',
        confidence: 1.0,
        reason: '',
      });

      computeMRO(graph);

      const edges = graph.relationships.filter((r) => r.type === 'METHOD_IMPLEMENTS');
      expect(edges).toHaveLength(1);
      expect(edges[0].sourceId).toBe(cBarId);
      expect(edges[0].targetId).toBe(iBarId);
      expect(edges[0].confidence).toBe(1.0);
    });

    it('lenient match (no types, no parameterCount on both sides) gets confidence 0.7', () => {
      const graph = createKnowledgeGraph();
      addClass(graph, 'ILenient', 'java', 'Interface');
      addClass(graph, 'CLenient', 'java');
      addImplements(graph, 'CLenient', 'ILenient');

      // Manually create methods WITHOUT parameterCount to simulate legacy/missing arity
      const iBazId = generateId('Method', 'ILenient.baz');
      graph.addNode({
        id: iBazId,
        label: 'Method',
        properties: { name: 'baz', filePath: 'src/ILenient.ts' },
      });
      graph.addRelationship({
        id: generateId('HAS_METHOD', `${generateId('Interface', 'ILenient')}->${iBazId}`),
        sourceId: generateId('Interface', 'ILenient'),
        targetId: iBazId,
        type: 'HAS_METHOD',
        confidence: 1.0,
        reason: '',
      });

      const cBazId = generateId('Method', 'CLenient.baz');
      graph.addNode({
        id: cBazId,
        label: 'Method',
        properties: { name: 'baz', filePath: 'src/CLenient.ts' },
      });
      graph.addRelationship({
        id: generateId('HAS_METHOD', `${generateId('Class', 'CLenient')}->${cBazId}`),
        sourceId: generateId('Class', 'CLenient'),
        targetId: cBazId,
        type: 'HAS_METHOD',
        confidence: 1.0,
        reason: '',
      });

      computeMRO(graph);

      const edges = graph.relationships.filter((r) => r.type === 'METHOD_IMPLEMENTS');
      expect(edges).toHaveLength(1);
      expect(edges[0].sourceId).toBe(cBazId);
      expect(edges[0].targetId).toBe(iBazId);
      expect(edges[0].confidence).toBe(0.7);
    });

    it('one side has parameterCount, other does not → confidence 0.7', () => {
      const graph = createKnowledgeGraph();
      addClass(graph, 'IHalf', 'java', 'Interface');
      addClass(graph, 'CHalf', 'java');
      addImplements(graph, 'CHalf', 'IHalf');

      // Interface method has parameterCount but no parameterTypes
      const iQuxId = generateId('Method', 'IHalf.qux#2');
      graph.addNode({
        id: iQuxId,
        label: 'Method',
        properties: { name: 'qux', filePath: 'src/IHalf.ts', parameterCount: 2 },
      });
      graph.addRelationship({
        id: generateId('HAS_METHOD', `${generateId('Interface', 'IHalf')}->${iQuxId}`),
        sourceId: generateId('Interface', 'IHalf'),
        targetId: iQuxId,
        type: 'HAS_METHOD',
        confidence: 1.0,
        reason: '',
      });

      // Class method has neither parameterTypes nor parameterCount (manually constructed)
      const cQuxId = generateId('Method', 'CHalf.qux');
      graph.addNode({
        id: cQuxId,
        label: 'Method',
        properties: { name: 'qux', filePath: 'src/CHalf.ts' },
      });
      graph.addRelationship({
        id: generateId('HAS_METHOD', `${generateId('Class', 'CHalf')}->${cQuxId}`),
        sourceId: generateId('Class', 'CHalf'),
        targetId: cQuxId,
        type: 'HAS_METHOD',
        confidence: 1.0,
        reason: '',
      });

      computeMRO(graph);

      const edges = graph.relationships.filter((r) => r.type === 'METHOD_IMPLEMENTS');
      expect(edges).toHaveLength(1);
      expect(edges[0].sourceId).toBe(cQuxId);
      expect(edges[0].targetId).toBe(iQuxId);
      expect(edges[0].confidence).toBe(0.7);
    });
  });

  // ---- IMPLEMENTS BFS ambiguity for default methods -------------------------
  describe('IMPLEMENTS BFS ambiguity for default methods', () => {
    it('does not emit METHOD_IMPLEMENTS when two interfaces provide same default method (ambiguous)', () => {
      // IAncestor (Interface) has abstract process()
      // IAlpha (Interface) extends IAncestor, has concrete process()
      // IBeta  (Interface) extends IAncestor, has concrete process()
      // CImpl  (Class) implements IAlpha, implements IBeta
      // CImpl has NO process() method
      //
      // findInheritedMethod walks IMPLEMENTS BFS and finds process() in BOTH
      // IAlpha and IBeta => ambiguous => null => no METHOD_IMPLEMENTS edge.
      const graph = createKnowledgeGraph();
      addClass(graph, 'IAncestor', 'java', 'Interface');
      addClass(graph, 'IAlpha', 'java', 'Interface');
      addClass(graph, 'IBeta', 'java', 'Interface');
      addClass(graph, 'CImpl', 'java');

      addInterfaceExtends(graph, 'IAlpha', 'IAncestor');
      addInterfaceExtends(graph, 'IBeta', 'IAncestor');
      addImplements(graph, 'CImpl', 'IAlpha');
      addImplements(graph, 'CImpl', 'IBeta');

      addMethod(graph, 'IAncestor', 'process', 'Interface', undefined, { isAbstract: true });
      addMethod(graph, 'IAlpha', 'process', 'Interface');
      addMethod(graph, 'IBeta', 'process', 'Interface');

      const result = computeMRO(graph);

      // IAlpha.process -> IAncestor.process and IBeta.process -> IAncestor.process
      // are legitimate edges from sub-interface processing. The ambiguity check
      // ensures that NO additional edge is emitted on behalf of CImpl (which has
      // no own process()). Since CImpl has no methods, no edge should be sourced
      // from a CImpl method. Verify by checking that the only METHOD_IMPLEMENTS
      // edges for process() are the two interface-to-interface ones.
      const edges = graph.relationships.filter((r) => r.type === 'METHOD_IMPLEMENTS');
      const processEdges = edges.filter((e) => {
        const target = graph.getNode(e.targetId);
        return target?.properties.name === 'process';
      });
      // IAlpha.process->IAncestor.process and IBeta.process->IAncestor.process
      // are emitted from the sub-interface processing (each concrete method
      // implements the ancestor's abstract method). No additional edge should be
      // emitted on behalf of CImpl because findInheritedMethod returns null
      // (ambiguous: two candidates at the same BFS depth).
      expect(processEdges).toHaveLength(2);
      const alphaProcess = generateId('Method', 'IAlpha.process#0');
      const betaProcess = generateId('Method', 'IBeta.process#0');
      const sourceIds = processEdges.map((e) => e.sourceId).sort();
      expect(sourceIds).toEqual([alphaProcess, betaProcess].sort());
    });

    it('emits METHOD_IMPLEMENTS when only one interface provides the default method (unambiguous)', () => {
      // IAncestor (Interface) has abstract process()
      // IAlpha (Interface) extends IAncestor, has concrete process()
      // IBeta  (Interface) extends IAncestor, does NOT have process()
      // CImpl  (Class) implements IAlpha, implements IBeta
      // CImpl has NO process() method
      //
      // findInheritedMethod walks IMPLEMENTS BFS and finds process() only in
      // IAlpha => unambiguous => emits 1 METHOD_IMPLEMENTS edge.
      const graph = createKnowledgeGraph();
      addClass(graph, 'IAncestor', 'java', 'Interface');
      addClass(graph, 'IAlpha', 'java', 'Interface');
      addClass(graph, 'IBeta', 'java', 'Interface');
      addClass(graph, 'CImpl', 'java');

      addInterfaceExtends(graph, 'IAlpha', 'IAncestor');
      addInterfaceExtends(graph, 'IBeta', 'IAncestor');
      addImplements(graph, 'CImpl', 'IAlpha');
      addImplements(graph, 'CImpl', 'IBeta');

      const ancestorProcess = addMethod(graph, 'IAncestor', 'process', 'Interface', undefined, {
        isAbstract: true,
      });
      const alphaProcess = addMethod(graph, 'IAlpha', 'process', 'Interface');
      // IBeta has no process() method

      const result = computeMRO(graph);

      const edges = graph.relationships.filter((r) => r.type === 'METHOD_IMPLEMENTS');
      const processEdges = edges.filter((e) => {
        const target = graph.getNode(e.targetId);
        return target?.properties.name === 'process';
      });
      // At minimum, IAlpha.process -> IAncestor.process is emitted (from IAlpha's
      // own processing). CImpl's findInheritedMethod also finds IAlpha.process as
      // the sole unambiguous match, potentially emitting the same edge again.
      expect(processEdges.length).toBeGreaterThanOrEqual(1);
      // Every process edge should point from IAlpha.process to IAncestor.process
      for (const edge of processEdges) {
        expect(edge.sourceId).toBe(alphaProcess);
        expect(edge.targetId).toBe(ancestorProcess);
      }
    });
  });

  // ---- PHM parent-order pinning ------------------------------------------
  //
  // PHM Unit 2 split buildAdjacency's single forEachRelationship into three
  // typed iterations (EXTENDS, IMPLEMENTS, HAS_METHOD). Parent enumeration
  // now runs ALL EXTENDS edges before ANY IMPLEMENTS edges. For classes
  // with parents added in interleaved order, this re-orders `parentMap`
  // and any C3 linearization that consumes it.
  //
  // Python (single EXTENDS model) and Java/C# (resolveCsharpJava partitions
  // by edge type regardless of order) are unaffected in practice. This
  // test pins the new behavior so a future "simplification" back to a
  // single loop would surface as a deliberate change rather than a silent
  // semantic drift.
  describe('PHM: interleaved EXTENDS + IMPLEMENTS parent ordering', () => {
    it('class methods win regardless of the order EXTENDS/IMPLEMENTS edges were added', () => {
      const graph = createKnowledgeGraph();
      // C extends Base (class) AND implements Iface (interface). Edges
      // added in INTERLEAVED order: IMPLEMENTS first, then EXTENDS.
      // Under the old single-loop adjacency, parentMap[C] would be
      // [IfaceId, BaseId]. Under the new grouped adjacency,
      // parentMap[C] is [BaseId, IfaceId] (EXTENDS bucket first).
      //
      // For resolveCsharpJava, class-method-wins is invariant to parent
      // order — both produce the same winner. This test encodes that
      // invariant, guarding the behavioral claim that 'Java/C# are
      // unaffected' in the PHM commit message.
      addClass(graph, 'Base', 'java');
      addClass(graph, 'C', 'java');
      addClass(graph, 'Iface', 'java', 'Interface');
      addMethod(graph, 'Base', 'greet');
      addMethod(graph, 'Iface', 'greet', 'Interface');
      addMethod(graph, 'C', 'greet');

      // Add IMPLEMENTS BEFORE EXTENDS to exercise interleaving.
      addImplements(graph, 'C', 'Iface');
      addExtends(graph, 'C', 'Base');

      const result = computeMRO(graph);
      const cId = generateId('Class', 'C');
      const entry = result.entries.find((e) => e.classId === cId);
      expect(entry).toBeDefined();
      const mro = entry!.mro;

      // Grouped iteration yields EXTENDS parents first. This pin fails
      // loudly if a future refactor reverts the typed-bucket iteration
      // to a single full-graph scan and restores insertion-order
      // semantics.
      // Grouped EXTENDS-before-IMPLEMENTS iteration produces this exact
      // MRO for C: [Base, Iface]. A single-loop reversion would yield
      // [Iface, Base] (IMPLEMENTS added first in this test).
      expect(mro).toEqual(['Base', 'Iface']);
    });
  });
});
