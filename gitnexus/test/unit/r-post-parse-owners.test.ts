import { describe, it, expect } from 'vitest';
import { SupportedLanguages } from 'gitnexus-shared';
import type { GraphRelationship, NodeLabel } from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { createSemanticModel } from '../../src/core/ingestion/model/semantic-model.js';
import { attachDeferredROwners } from '../../src/core/ingestion/r-post-parse.js';
import { generateId } from '../../src/lib/utils.js';

// Characterisation tests for the R deferred-owner attach (fork #19, step 1).
// R classes are calls (`R6::R6Class`, `setRefClass`, `setMethod`), so the worker cannot always name
// an owner node; it leaves an `ownerNameHint` string that `attachDeferredROwners` resolves once every
// Class is registered. These tests pin that behaviour before it moves behind `LanguageProvider.postParse`.

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

  it('(b) leaves the hint and registers nothing when two classes share the name', () => {
    const { graph, model, addClass, addMember, edges } = setup();
    const first = addClass('Foo', 'R/a.R');
    addClass('Foo', 'R/b.R');
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
});
