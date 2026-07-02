/**
 * Unit tests for the framework-neutral `di` pipeline phase and the Spring
 * DI field matcher registered behind it (`di-extractors/spring.ts`).
 *
 * Phase-level: verifies that injection-annotated (@Autowired / @Inject)
 * collection-typed fields (List<T>, Set<T>, Collection<T>, Map<K,T>) produce
 * INJECTS edges from the consumer class to every class implementing
 * interface T — using only graph data, no filesystem access — and that
 * Property nodes whose language has no registered matcher are skipped.
 * Non-annotated and @Resource fields produce no edges.
 *
 * Matcher-level: pins `springDiFieldMatcher`'s gate + parse behavior
 * directly, node-shape in / match-or-null out.
 */
import { describe, expect, it } from 'vitest';
import { createKnowledgeGraph } from '../../../src/core/graph/graph.js';
import { diPhase } from '../../../src/core/ingestion/pipeline-phases/di.js';
import { springDiFieldMatcher } from '../../../src/core/ingestion/di-extractors/spring.js';
import { generateId } from '../../../src/lib/utils.js';
import type {
  PhaseResult,
  PipelineContext,
} from '../../../src/core/ingestion/pipeline-phases/types.js';
import type { KnowledgeGraph } from '../../../src/core/graph/types.js';
import type { GraphNode, NodeLabel } from 'gitnexus-shared';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(graph: KnowledgeGraph, repoPath = '/tmp/repo'): PipelineContext {
  return { repoPath, graph, onProgress: () => {}, pipelineStart: 0 };
}

function phaseResult<T>(phaseName: string, output: T): PhaseResult<T> {
  return { phaseName, output, durationMs: 0 };
}

function addClass(
  graph: KnowledgeGraph,
  name: string,
  language: string,
  label: NodeLabel = 'Class',
  extra: Record<string, unknown> = {},
): string {
  const id = generateId(label, name);
  graph.addNode({
    id,
    label,
    properties: { name, filePath: `src/${name}.${language}`, language, ...extra },
  });
  return id;
}

function addInterface(graph: KnowledgeGraph, name: string, language = 'java'): string {
  const id = generateId('Interface', name);
  graph.addNode({
    id,
    label: 'Interface',
    properties: { name, filePath: `src/${name}.java`, language },
  });
  return id;
}

function addImplements(graph: KnowledgeGraph, className: string, ifaceName: string): void {
  const classId = generateId('Class', className);
  const ifaceId = generateId('Interface', ifaceName);
  graph.addRelationship({
    id: generateId('IMPLEMENTS', `${classId}->${ifaceId}`),
    sourceId: classId,
    targetId: ifaceId,
    type: 'IMPLEMENTS',
    confidence: 1.0,
    reason: '',
  });
}

/**
 * Add a Property node (a field) to a class and link it via HAS_PROPERTY.
 *
 * Mirrors the production extraction shape: `rawDeclaredType` is the verbatim
 * type source text with generics preserved (e.g. `List<IFoo>`), while
 * `declaredType` is the generics-stripped simple name (e.g. `List`) — derived
 * here from the raw text. `annotations` carries '@Name' strings and is
 * OMITTED when empty (production conditional-spread shape); it defaults to
 * `['@Autowired']` so the common annotated case stays terse. The phase
 * matches on `rawDeclaredType` and gates on `annotations`.
 */
function addProperty(
  graph: KnowledgeGraph,
  ownerClassName: string,
  fieldName: string,
  rawDeclaredType: string,
  language = 'java',
  annotations: string[] = ['@Autowired'],
): string {
  const ownerId = generateId('Class', ownerClassName);
  const propId = generateId('Property', `${ownerClassName}.${fieldName}`);
  // Production `declaredType` is the simple name with generic args stripped.
  const declaredType = rawDeclaredType.split('<')[0].trim();
  graph.addNode({
    id: propId,
    label: 'Property',
    properties: {
      name: fieldName,
      filePath: `src/${ownerClassName}.${language}`,
      language,
      declaredType,
      rawDeclaredType,
      ...(annotations.length > 0 ? { annotations } : {}),
    },
  });
  graph.addRelationship({
    id: generateId('HAS_PROPERTY', `${ownerId}->${propId}`),
    sourceId: ownerId,
    targetId: propId,
    type: 'HAS_PROPERTY',
    confidence: 1.0,
    reason: '',
  });
  return propId;
}

/** Collect all INJECTS relationships currently in the graph. */
function injectsEdges(graph: KnowledgeGraph) {
  return graph.relationships.filter((r) => r.type === 'INJECTS');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('di phase', () => {
  it('creates INJECTS edges from consumer to every implementer of T', async () => {
    const graph = createKnowledgeGraph();

    // Interface IFoo
    addInterface(graph, 'IFoo');

    // Two implementers
    addClass(graph, 'FooImpl1', 'java');
    addClass(graph, 'FooImpl2', 'java');
    addImplements(graph, 'FooImpl1', 'IFoo');
    addImplements(graph, 'FooImpl2', 'IFoo');

    // Consumer with @Autowired List<IFoo>
    addClass(graph, 'MyService', 'java');
    addProperty(graph, 'MyService', 'foos', 'List<IFoo>');

    const output = await diPhase.execute(
      makeCtx(graph),
      new Map([['mro', phaseResult('mro', { entries: [] })]]),
    );

    const edges = injectsEdges(graph);
    const targets = new Set(edges.map((e) => e.targetId));
    const sources = new Set(edges.map((e) => e.sourceId));

    // Exactly 2 edges, both from MyService
    expect(edges).toHaveLength(2);
    expect(sources.size).toBe(1);
    expect(sources.has(generateId('Class', 'MyService'))).toBe(true);

    // Targets are the two implementers (not IFoo, not MyService)
    expect(targets.has(generateId('Class', 'FooImpl1'))).toBe(true);
    expect(targets.has(generateId('Class', 'FooImpl2'))).toBe(true);

    // Edge metadata
    for (const edge of edges) {
      expect(edge.type).toBe('INJECTS');
      expect(edge.confidence).toBe(0.8);
      expect(edge.reason).toBe('Spring DI: @Autowired List<IFoo>');
    }

    // Output stats
    expect(output.injectsEdges).toBe(2);
    expect(output.fieldsScanned).toBe(1);
  });

  it('does not create self-edges when the consumer also implements T', async () => {
    const graph = createKnowledgeGraph();

    addInterface(graph, 'IFoo');
    addClass(graph, 'FooImpl1', 'java');
    addClass(graph, 'FooImpl2', 'java');
    // MyService ALSO implements IFoo — must not inject into itself
    addClass(graph, 'MyService', 'java');
    addImplements(graph, 'FooImpl1', 'IFoo');
    addImplements(graph, 'FooImpl2', 'IFoo');
    addImplements(graph, 'MyService', 'IFoo');
    addProperty(graph, 'MyService', 'foos', 'List<IFoo>');

    await diPhase.execute(makeCtx(graph), new Map());

    const edges = injectsEdges(graph);
    const myServiceId = generateId('Class', 'MyService');

    // No self-edge
    expect(edges.some((e) => e.sourceId === myServiceId && e.targetId === myServiceId)).toBe(false);

    // Still injects into the OTHER two implementers
    expect(edges).toHaveLength(2);
    const targets = new Set(edges.map((e) => e.targetId));
    expect(targets.has(generateId('Class', 'FooImpl1'))).toBe(true);
    expect(targets.has(generateId('Class', 'FooImpl2'))).toBe(true);
  });

  it('creates no edges when no @Autowired collection fields exist', async () => {
    const graph = createKnowledgeGraph();

    addInterface(graph, 'IFoo');
    addClass(graph, 'FooImpl1', 'java');
    addImplements(graph, 'FooImpl1', 'IFoo');
    addClass(graph, 'MyService', 'java');
    // A non-collection field — should be ignored
    addProperty(graph, 'MyService', 'foo', 'IFoo');

    const output = await diPhase.execute(makeCtx(graph), new Map());

    expect(injectsEdges(graph)).toHaveLength(0);
    expect(output.injectsEdges).toBe(0);
    expect(output.fieldsScanned).toBe(0);
  });

  it('creates no edges for a node carrying only the generics-stripped declaredType', async () => {
    const graph = createKnowledgeGraph();

    addInterface(graph, 'IFoo');
    addClass(graph, 'FooImpl1', 'java');
    addImplements(graph, 'FooImpl1', 'IFoo');
    addClass(graph, 'MyService', 'java');

    // Production shape when rawDeclaredType plumbing regresses: only the
    // stripped simple name ("List") reaches the graph. The field IS
    // injection-annotated (it passes the annotation gate), so this pins the
    // rawDeclaredType-missing skip path: the phase must NOT fall back to
    // declaredType — zero edges, zero fields scanned (and an isDev warning
    // flags the plumbing-contract breach).
    const ownerId = generateId('Class', 'MyService');
    const propId = generateId('Property', 'MyService.foos');
    graph.addNode({
      id: propId,
      label: 'Property',
      properties: {
        name: 'foos',
        filePath: 'src/MyService.java',
        language: 'java',
        declaredType: 'List',
        annotations: ['@Autowired'],
      },
    });
    graph.addRelationship({
      id: generateId('HAS_PROPERTY', `${ownerId}->${propId}`),
      sourceId: ownerId,
      targetId: propId,
      type: 'HAS_PROPERTY',
      confidence: 1.0,
      reason: '',
    });

    const output = await diPhase.execute(makeCtx(graph), new Map());

    expect(injectsEdges(graph)).toHaveLength(0);
    expect(output.injectsEdges).toBe(0);
    expect(output.fieldsScanned).toBe(0);
  });

  it('skips non-Java Property nodes', async () => {
    const graph = createKnowledgeGraph();

    addInterface(graph, 'IFoo');
    addClass(graph, 'FooImpl1', 'java');
    addImplements(graph, 'FooImpl1', 'IFoo');

    // TypeScript consumer — even though the declared type looks like a Spring
    // collection, the language is not Java, so it must be skipped.
    addClass(graph, 'TsConsumer', 'typescript');
    addProperty(graph, 'TsConsumer', 'foos', 'List<IFoo>', 'typescript');

    const output = await diPhase.execute(makeCtx(graph), new Map());

    expect(injectsEdges(graph)).toHaveLength(0);
    expect(output.injectsEdges).toBe(0);
    expect(output.fieldsScanned).toBe(0);
  });

  it('handles Set<T>, Collection<T>, and Map<K,T> collection shapes', async () => {
    const graph = createKnowledgeGraph();

    addInterface(graph, 'IPlugin');
    addClass(graph, 'CorePlugin', 'java');
    addClass(graph, 'ExtraPlugin', 'java');
    addImplements(graph, 'CorePlugin', 'IPlugin');
    addImplements(graph, 'ExtraPlugin', 'IPlugin');

    // Three consumers, one per collection shape
    addClass(graph, 'SetConsumer', 'java');
    addProperty(graph, 'SetConsumer', 'plugins', 'Set<IPlugin>');

    addClass(graph, 'CollectionConsumer', 'java');
    addProperty(graph, 'CollectionConsumer', 'plugins', 'Collection<IPlugin>');

    addClass(graph, 'MapConsumer', 'java');
    // Map<K,V> — V (IPlugin) is the injected bean type
    addProperty(graph, 'MapConsumer', 'plugins', 'Map<String,IPlugin>');

    await diPhase.execute(makeCtx(graph), new Map());

    const edges = injectsEdges(graph);

    // 3 consumers × 2 implementers = 6 edges
    expect(edges).toHaveLength(6);

    const reasons = new Set(edges.map((e) => e.reason));
    expect(reasons.has('Spring DI: @Autowired Set<IPlugin>')).toBe(true);
    expect(reasons.has('Spring DI: @Autowired Collection<IPlugin>')).toBe(true);
    expect(reasons.has('Spring DI: @Autowired Map<IPlugin>')).toBe(true);
  });

  it('is a no-op on a graph with no Java Property nodes (early exit)', async () => {
    const graph = createKnowledgeGraph();

    addInterface(graph, 'IFoo');
    addClass(graph, 'FooImpl1', 'java');
    addImplements(graph, 'FooImpl1', 'IFoo');

    // Non-Java property — should trigger early exit
    addClass(graph, 'PyConsumer', 'python');
    addProperty(graph, 'PyConsumer', 'foos', 'List<IFoo>', 'python');

    const output = await diPhase.execute(makeCtx(graph), new Map());

    expect(output.injectsEdges).toBe(0);
    expect(output.fieldsScanned).toBe(0);
    expect(injectsEdges(graph)).toHaveLength(0);
  });

  it('creates no edges when the interface T has no implementers', async () => {
    const graph = createKnowledgeGraph();

    addInterface(graph, 'INobody');
    addClass(graph, 'MyService', 'java');
    addProperty(graph, 'MyService', 'things', 'List<INobody>');

    const output = await diPhase.execute(makeCtx(graph), new Map());

    expect(injectsEdges(graph)).toHaveLength(0);
    expect(output.injectsEdges).toBe(0);
    // The field was scanned (1), but no implementers exist
    expect(output.fieldsScanned).toBe(1);
  });

  it('deduplicates edges when multiple fields inject the same interface', async () => {
    const graph = createKnowledgeGraph();

    addInterface(graph, 'IFoo');
    addClass(graph, 'FooImpl1', 'java');
    addImplements(graph, 'FooImpl1', 'IFoo');

    // Same consumer, two different fields both typed List<IFoo>
    addClass(graph, 'MyService', 'java');
    addProperty(graph, 'MyService', 'foos1', 'List<IFoo>');
    addProperty(graph, 'MyService', 'foos2', 'List<IFoo>');

    await diPhase.execute(makeCtx(graph), new Map());

    // Only 1 edge MyService → FooImpl1 (deduped by edge ID)
    const edges = injectsEdges(graph);
    expect(edges).toHaveLength(1);
    expect(edges[0].sourceId).toBe(generateId('Class', 'MyService'));
    expect(edges[0].targetId).toBe(generateId('Class', 'FooImpl1'));
  });

  // -------------------------------------------------------------------------
  // Injection-annotation gate (PR #2200 U2)
  // -------------------------------------------------------------------------

  it('creates edges for @Inject fields and states @Inject in the reason', async () => {
    const graph = createKnowledgeGraph();

    addInterface(graph, 'IFoo');
    addClass(graph, 'FooImpl1', 'java');
    addImplements(graph, 'FooImpl1', 'IFoo');
    addClass(graph, 'MyService', 'java');
    addProperty(graph, 'MyService', 'foos', 'List<IFoo>', 'java', ['@Inject']);

    const output = await diPhase.execute(makeCtx(graph), new Map());

    const edges = injectsEdges(graph);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      sourceId: generateId('Class', 'MyService'),
      targetId: generateId('Class', 'FooImpl1'),
      reason: 'Spring DI: @Inject List<IFoo>',
    });
    expect(output.fieldsScanned).toBe(1);
  });

  it('creates no edges for a plain (non-annotated) collection field of a known interface', async () => {
    const graph = createKnowledgeGraph();

    addInterface(graph, 'IFoo');
    addClass(graph, 'FooImpl1', 'java');
    addImplements(graph, 'FooImpl1', 'IFoo');
    addClass(graph, 'MyService', 'java');
    // The false-positive class the review flagged: a collection field with NO
    // injection annotation is never injected by the container.
    addProperty(graph, 'MyService', 'cache', 'List<IFoo>', 'java', []);

    const output = await diPhase.execute(makeCtx(graph), new Map());

    expect(injectsEdges(graph)).toHaveLength(0);
    expect(output.injectsEdges).toBe(0);
    expect(output.fieldsScanned).toBe(0);
  });

  it('creates no edges for @Resource fields (deliberate exclusion)', async () => {
    const graph = createKnowledgeGraph();

    addInterface(graph, 'IFoo');
    addClass(graph, 'FooImpl1', 'java');
    addImplements(graph, 'FooImpl1', 'IFoo');
    addClass(graph, 'MyService', 'java');
    // @Resource (JSR-250) resolves by bean NAME first (defaulting to the
    // field name), injecting a single named collection bean — the opposite of
    // the collect-all-implementers fan-out INJECTS models. Its exclusion from
    // the gate is deliberate; this test pins it.
    addProperty(graph, 'MyService', 'named', 'List<IFoo>', 'java', ['@Resource']);

    const output = await diPhase.execute(makeCtx(graph), new Map());

    expect(injectsEdges(graph)).toHaveLength(0);
    expect(output.injectsEdges).toBe(0);
    expect(output.fieldsScanned).toBe(0);
  });

  it('matches any injection annotation when the field carries multiple annotations', async () => {
    const graph = createKnowledgeGraph();

    addInterface(graph, 'IFoo');
    addClass(graph, 'FooImpl1', 'java');
    addImplements(graph, 'FooImpl1', 'IFoo');
    addClass(graph, 'MyService', 'java');
    // Non-injection annotations surround the injection one — the gate must
    // match @Autowired anywhere in the set, not just first position.
    addProperty(graph, 'MyService', 'foos', 'List<IFoo>', 'java', [
      '@Nullable',
      '@Autowired',
      '@Qualifier',
    ]);

    const output = await diPhase.execute(makeCtx(graph), new Map());

    const edges = injectsEdges(graph);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      sourceId: generateId('Class', 'MyService'),
      targetId: generateId('Class', 'FooImpl1'),
      reason: 'Spring DI: @Autowired List<IFoo>',
    });
    expect(output.fieldsScanned).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Matcher registry routing (PR #2200 U3)
  // -------------------------------------------------------------------------

  it('skips Property nodes whose language has no registered matcher', async () => {
    const graph = createKnowledgeGraph();

    addInterface(graph, 'IFoo');
    addClass(graph, 'FooImpl1', 'java');
    addImplements(graph, 'FooImpl1', 'IFoo');

    // A supported language with NO DI_MATCHERS entry: the node carries the
    // full annotated-collection shape, but no matcher is registered for
    // 'python', so the phase must produce zero candidates.
    addClass(graph, 'PyConsumer', 'python');
    addProperty(graph, 'PyConsumer', 'foos', 'List<IFoo>', 'python', ['@Autowired']);

    const output = await diPhase.execute(makeCtx(graph), new Map());

    expect(injectsEdges(graph)).toHaveLength(0);
    expect(output.injectsEdges).toBe(0);
    expect(output.fieldsScanned).toBe(0);
  });

  it('skips Property nodes whose language string is not a SupportedLanguages value', async () => {
    const graph = createKnowledgeGraph();

    addInterface(graph, 'IFoo');
    addClass(graph, 'FooImpl1', 'java');
    addImplements(graph, 'FooImpl1', 'IFoo');

    // An arbitrary language string outside the enum exercises the
    // isSupportedLanguage narrowing guard in the phase's routing.
    addClass(graph, 'FortranConsumer', 'fortran');
    addProperty(graph, 'FortranConsumer', 'foos', 'List<IFoo>', 'fortran', ['@Autowired']);

    const output = await diPhase.execute(makeCtx(graph), new Map());

    expect(injectsEdges(graph)).toHaveLength(0);
    expect(output.injectsEdges).toBe(0);
    expect(output.fieldsScanned).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Matcher-level tests (di-extractors/spring.ts)
// ---------------------------------------------------------------------------

/** Hand-build a Property GraphNode for direct matcher calls. */
function matcherNode(properties: {
  name: string;
  rawDeclaredType?: string;
  annotations?: string[];
  language?: string;
}): GraphNode {
  const { name, ...rest } = properties;
  return {
    id: generateId('Property', name),
    label: 'Property',
    properties: { name, filePath: `src/Owner.java`, language: 'java', ...rest },
  };
}

describe('springDiFieldMatcher', () => {
  it('returns the parsed match for an @Autowired collection field', () => {
    const match = springDiFieldMatcher(
      matcherNode({ name: 'foos', rawDeclaredType: 'List<IFoo>', annotations: ['@Autowired'] }),
    );
    expect(match).toEqual({
      collectionType: 'List',
      elementTypeName: 'IFoo',
      matchedAnnotation: '@Autowired',
      reason: 'Spring DI: @Autowired List<IFoo>',
    });
  });

  it('parses Map<K,T> to the value type T', () => {
    const match = springDiFieldMatcher(
      matcherNode({
        name: 'plugins',
        rawDeclaredType: 'Map<String,IPlugin>',
        annotations: ['@Inject'],
      }),
    );
    expect(match).toEqual({
      collectionType: 'Map',
      elementTypeName: 'IPlugin',
      matchedAnnotation: '@Inject',
      reason: 'Spring DI: @Inject Map<IPlugin>',
    });
  });

  it('returns null for a non-annotated collection field', () => {
    expect(
      springDiFieldMatcher(matcherNode({ name: 'cache', rawDeclaredType: 'List<IFoo>' })),
    ).toBe(null);
  });

  it('returns null for @Resource (deliberate exclusion) and other non-injection annotations', () => {
    expect(
      springDiFieldMatcher(
        matcherNode({ name: 'named', rawDeclaredType: 'List<IFoo>', annotations: ['@Resource'] }),
      ),
    ).toBe(null);
    expect(
      springDiFieldMatcher(
        matcherNode({ name: 'q', rawDeclaredType: 'List<IFoo>', annotations: ['@Qualifier'] }),
      ),
    ).toBe(null);
  });

  it('returns null for an annotated non-collection field', () => {
    expect(
      springDiFieldMatcher(
        matcherNode({ name: 'foo', rawDeclaredType: 'IFoo', annotations: ['@Autowired'] }),
      ),
    ).toBe(null);
  });

  it('returns null for an annotated field with no rawDeclaredType (plumbing breach)', () => {
    expect(springDiFieldMatcher(matcherNode({ name: 'foos', annotations: ['@Autowired'] }))).toBe(
      null,
    );
  });

  it("ignores node language — routing is the DI_MATCHERS registry's job", () => {
    // The matcher never reads properties.language: a valid Spring shape on a
    // 'python'-tagged node still matches. The phase-level registry routing
    // (tested above) is what keeps non-Java nodes away from this matcher.
    const match = springDiFieldMatcher(
      matcherNode({
        name: 'foos',
        rawDeclaredType: 'List<IFoo>',
        annotations: ['@Autowired'],
        language: 'python',
      }),
    );
    expect(match).toMatchObject({ collectionType: 'List', elementTypeName: 'IFoo' });
  });
});
