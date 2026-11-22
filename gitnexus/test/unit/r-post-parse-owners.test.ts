import { describe, it, expect } from 'vitest';
import { SupportedLanguages } from 'gitnexus-shared';
import type { GraphRelationship, NodeLabel } from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { createSemanticModel } from '../../src/core/ingestion/model/semantic-model.js';
import { attachDeferredROwners } from '../../src/core/ingestion/languages/r/post-parse.js';
import { generateId } from '../../src/lib/utils.js';
import { _captureLogger } from '../../src/core/logger.js';

// Characterisation tests for the R deferred-owner attach.
// R classes are calls (`R6::R6Class`, `setRefClass`, `setMethod`), so the worker cannot always name
// an owner node; it leaves an `ownerNameHint` string that `attachDeferredROwners` resolves once every
// Class is registered. These tests pin that behaviour.

const FILE = 'R/a.R';

const setup = () => {
  const graph = createKnowledgeGraph();
  const model = createSemanticModel();

  const addClass = (name: string, filePath = FILE): string => {
    const id = `Class:${filePath}:${name}`;
    graph.addNode({
      id,
      label: 'Class',
      properties: { name, filePath, language: SupportedLanguages.R },
    });
    model.symbols.add(filePath, name, id, 'Class');
    return id;
  };

  const addMember = (
    label: 'Method' | 'Property',
    name: string,
    properties: Record<string, unknown>,
    opts: { language?: SupportedLanguages; ownerId?: string; filePath?: string } = {},
  ): string => {
    const filePath = opts.filePath ?? FILE;
    const id = `${label}:${filePath}:${name}`;
    graph.addNode({
      id,
      label: label as NodeLabel,
      properties: {
        name,
        filePath,
        language: opts.language ?? SupportedLanguages.R,
        ...properties,
      },
    });
    model.symbols.add(
      filePath,
      name,
      id,
      label,
      opts.ownerId === undefined ? undefined : { ownerId: opts.ownerId },
    );
    return id;
  };

  const edges = (type: string): GraphRelationship[] => {
    const out: GraphRelationship[] = [];
    graph.forEachRelationship((r) => {
      if (r.type === type) out.push(r);
    });
    return out;
  };

  return { graph, model, addClass, addMember, edges };
};

describe('attachDeferredROwners', () => {
  it.each([
    ['Method', 'HAS_METHOD'],
    ['Property', 'HAS_PROPERTY'],
  ] as const)(
    '(a) resolves a unique class hint on a %s: ownerId, edge, registry, shared def',
    (label, edgeType) => {
      const { graph, model, addClass, addMember, edges } = setup();
      const ownerId = addClass('Foo');
      const nodeId = addMember(label, 'run', { ownerNameHint: 'Foo' });

      attachDeferredROwners(graph, model, label, edgeType);

      const node = graph.getNode(nodeId)!;
      expect(node.properties.ownerId).toBe(ownerId);
      expect(node.properties).not.toHaveProperty('ownerNameHint');

      const rels = edges(edgeType);
      expect(rels).toHaveLength(1);
      expect(rels[0]).toEqual({
        id: generateId(edgeType, `${ownerId}->${nodeId}`),
        sourceId: ownerId,
        targetId: nodeId,
        type: edgeType,
        confidence: 1.0,
        reason: '',
      });

      const registered =
        label === 'Method'
          ? model.methods.lookupAllByOwner(ownerId, 'run')
          : model.fields.lookupAllByOwner(ownerId, 'run');
      expect(registered).toHaveLength(1);
      expect(registered[0].nodeId).toBe(nodeId);
      // The registered def is the same object the symbol table holds, and it now carries the owner.
      const [def] = model.symbols.lookupExactAll(FILE, 'run');
      expect(registered[0]).toBe(def);
      expect(def.ownerId).toBe(ownerId);
    },
  );

  it('only attaches nodes of the requested label', () => {
    const { graph, model, addClass, addMember, edges } = setup();
    addClass('Foo');
    const propId = addMember('Property', 'field', { ownerNameHint: 'Foo' });

    attachDeferredROwners(graph, model, 'Method', 'HAS_METHOD');

    expect(edges('HAS_METHOD')).toHaveLength(0);
    expect(graph.getNode(propId)!.properties.ownerNameHint).toBe('Foo');
    expect(graph.getNode(propId)!.properties).not.toHaveProperty('ownerId');
  });

  it('(b) leaves the hint and registers nothing when two classes share the name and the member sits in neither file', () => {
    const { graph, model, addClass, addMember, edges } = setup();
    const first = addClass('Foo', 'R/b.R');
    addClass('Foo', 'R/c.R');
    const nodeId = addMember('Method', 'run', { ownerNameHint: 'Foo' });

    attachDeferredROwners(graph, model, 'Method', 'HAS_METHOD');

    const node = graph.getNode(nodeId)!;
    expect(node.properties.ownerNameHint).toBe('Foo');
    expect(node.properties).not.toHaveProperty('ownerId');
    expect(edges('HAS_METHOD')).toHaveLength(0);
    expect(model.methods.lookupAllByOwner(first, 'run')).toHaveLength(0);
    expect(model.symbols.lookupExactAll(FILE, 'run')[0].ownerId).toBeUndefined();
  });

  it('(c) leaves the hint and registers nothing when no class has the name', () => {
    const { graph, model, addMember, edges } = setup();
    const nodeId = addMember('Method', 'run', { ownerNameHint: 'Missing' });

    attachDeferredROwners(graph, model, 'Method', 'HAS_METHOD');

    const node = graph.getNode(nodeId)!;
    expect(node.properties.ownerNameHint).toBe('Missing');
    expect(node.properties).not.toHaveProperty('ownerId');
    expect(edges('HAS_METHOD')).toHaveLength(0);
  });

  it('(d) does not touch a non-R node that carries a hint-looking property', () => {
    const { graph, model, addClass, addMember, edges } = setup();
    addClass('Foo');
    const nodeId = addMember(
      'Method',
      'run',
      { ownerNameHint: 'Foo' },
      { language: SupportedLanguages.Python, filePath: 'src/a.py' },
    );

    attachDeferredROwners(graph, model, 'Method', 'HAS_METHOD');

    const node = graph.getNode(nodeId)!;
    expect(node.properties.ownerNameHint).toBe('Foo');
    expect(node.properties).not.toHaveProperty('ownerId');
    expect(edges('HAS_METHOD')).toHaveLength(0);
  });

  it('(f) ignores a same-named class of another language when picking the owner', () => {
    const { graph, model, addClass, addMember, edges } = setup();
    const ownerId = addClass('Foo');
    const pyId = 'Class:src/a.py:Foo';
    graph.addNode({
      id: pyId,
      label: 'Class',
      properties: { name: 'Foo', filePath: 'src/a.py', language: SupportedLanguages.Python },
    });
    model.symbols.add('src/a.py', 'Foo', pyId, 'Class');
    const nodeId = addMember('Method', 'run', { ownerNameHint: 'Foo' });

    attachDeferredROwners(graph, model, 'Method', 'HAS_METHOD');

    expect(graph.getNode(nodeId)!.properties.ownerId).toBe(ownerId);
    expect(edges('HAS_METHOD').map((r) => r.sourceId)).toEqual([ownerId]);
  });

  it('(g) leaves the hint when the only class of that name is in another language', () => {
    const { graph, model, addMember, edges } = setup();
    const pyId = 'Class:src/a.py:Foo';
    graph.addNode({
      id: pyId,
      label: 'Class',
      properties: { name: 'Foo', filePath: 'src/a.py', language: SupportedLanguages.Python },
    });
    model.symbols.add('src/a.py', 'Foo', pyId, 'Class');
    const nodeId = addMember('Method', 'run', { ownerNameHint: 'Foo' });

    attachDeferredROwners(graph, model, 'Method', 'HAS_METHOD');

    const node = graph.getNode(nodeId)!;
    expect(node.properties.ownerNameHint).toBe('Foo');
    expect(node.properties).not.toHaveProperty('ownerId');
    expect(edges('HAS_METHOD')).toHaveLength(0);
  });

  it('(e) an already-owned node drops its hint and is never re-attached or double-registered', () => {
    const { graph, model, addClass, addMember, edges } = setup();
    const ownerId = addClass('Foo');
    const otherId = addClass('Bar');
    // Owned up front: the def is registered once by the semantic model because it carries an ownerId,
    // and the hint points at a DIFFERENT (unique) class to prove no re-resolution happens.
    const nodeId = addMember('Method', 'run', { ownerId, ownerNameHint: 'Bar' }, { ownerId });
    expect(model.methods.lookupAllByOwner(ownerId, 'run')).toHaveLength(1);

    attachDeferredROwners(graph, model, 'Method', 'HAS_METHOD');

    const node = graph.getNode(nodeId)!;
    expect(node.properties.ownerId).toBe(ownerId);
    expect(node.properties).not.toHaveProperty('ownerNameHint');
    expect(edges('HAS_METHOD')).toHaveLength(0);
    expect(model.methods.lookupAllByOwner(ownerId, 'run')).toHaveLength(1);
    expect(model.methods.lookupAllByOwner(otherId, 'run')).toHaveLength(0);
    expect(model.symbols.lookupExactAll(FILE, 'run')[0].ownerId).toBe(ownerId);
  });

  it('(h) a class defined twice in one file is one class: both of its members attach', () => {
    const { graph, model, addClass, addMember, edges } = setup();
    const ownerId = addClass('Foo');
    // The worker registers a class once per definition; two definitions in one file share a node id.
    model.symbols.add(FILE, 'Foo', ownerId, 'Class');
    expect(model.types.lookupClassByName('Foo')).toHaveLength(2);
    const method = addMember('Method', 'run', { ownerNameHint: 'Foo' });
    const field = addMember('Property', 'x', { ownerNameHint: 'Foo' });

    attachDeferredROwners(graph, model, 'Method', 'HAS_METHOD');
    attachDeferredROwners(graph, model, 'Property', 'HAS_PROPERTY');

    expect(graph.getNode(method)!.properties.ownerId).toBe(ownerId);
    expect(graph.getNode(field)!.properties.ownerId).toBe(ownerId);
    expect(edges('HAS_METHOD').map((r) => r.sourceId)).toEqual([ownerId]);
    expect(edges('HAS_PROPERTY').map((r) => r.sourceId)).toEqual([ownerId]);
  });

  it('(i) classes of one name in two files: each member attaches to the class of its own file', () => {
    const { graph, model, addClass, addMember, edges } = setup();
    const inR = addClass('Stack', 'R/a.R');
    const inTests = addClass('Stack', 'tests/helper.R');
    const m1 = addMember('Method', 'push', { ownerNameHint: 'Stack' }, { filePath: 'R/a.R' });
    const m2 = addMember(
      'Method',
      'push',
      { ownerNameHint: 'Stack' },
      { filePath: 'tests/helper.R' },
    );

    attachDeferredROwners(graph, model, 'Method', 'HAS_METHOD');

    expect(graph.getNode(m1)!.properties.ownerId).toBe(inR);
    expect(graph.getNode(m2)!.properties.ownerId).toBe(inTests);
    expect(
      edges('HAS_METHOD')
        .map((r) => `${r.sourceId}->${r.targetId}`)
        .sort(),
    ).toEqual([`${inR}->${m1}`, `${inTests}->${m2}`].sort());
    expect(model.methods.lookupAllByOwner(inR, 'push').map((d) => d.nodeId)).toEqual([m1]);
    expect(model.methods.lookupAllByOwner(inTests, 'push').map((d) => d.nodeId)).toEqual([m2]);
  });

  it('(j) a file that defines the class twice and another file that defines it once still resolve to the member file', () => {
    const { graph, model, addClass, addMember } = setup();
    const inA = addClass('Foo', 'R/a.R');
    model.symbols.add('R/a.R', 'Foo', inA, 'Class');
    addClass('Foo', 'R/b.R');
    const nodeId = addMember('Method', 'run', { ownerNameHint: 'Foo' }, { filePath: 'R/a.R' });

    attachDeferredROwners(graph, model, 'Method', 'HAS_METHOD');

    expect(graph.getNode(nodeId)!.properties.ownerId).toBe(inA);
  });

  it('(k) names the ambiguous class in one warning, once per call, when the own file cannot decide', () => {
    const { graph, model, addClass, addMember } = setup();
    addClass('Foo', 'R/a.R');
    addClass('Foo', 'R/b.R');
    // `Bar` is defined in neither of the member files twice over: both files define it.
    addClass('Bar', 'R/a.R');
    addClass('Bar', 'R/b.R');
    const m1 = addMember('Method', 'one', { ownerNameHint: 'Foo' }, { filePath: 'R/c.R' });
    addMember('Method', 'two', { ownerNameHint: 'Foo' }, { filePath: 'R/d.R' });
    addMember('Method', 'three', { ownerNameHint: 'Bar' }, { filePath: 'R/c.R' });
    const cap = _captureLogger();
    let messages: string[];
    try {
      attachDeferredROwners(graph, model, 'Method', 'HAS_METHOD');
      messages = cap.records().map((r) => String(r.msg ?? ''));
    } finally {
      cap.restore();
    }

    expect(graph.getNode(m1)!.properties.ownerNameHint).toBe('Foo');
    expect(messages).toHaveLength(1);
    const message = messages[0];
    expect(message).toContain('"Bar", "Foo"');
    expect(message).toContain('2 class name(s)');
  });

  it('(l) a missing class, or one in another language, does not warn', () => {
    const { graph, model, addMember } = setup();
    addMember('Method', 'run', { ownerNameHint: 'Missing' });
    const cap = _captureLogger();
    try {
      attachDeferredROwners(graph, model, 'Method', 'HAS_METHOD');
      expect(cap.records()).toHaveLength(0);
    } finally {
      cap.restore();
    }
  });
});
