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
import {
  parseSpringCollectionType,
  springDiFieldMatcher,
} from '../../../src/core/ingestion/di-extractors/spring.js';
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

/**
 * Add an Interface node. `qualifiedName` mirrors the production shape for
 * languages with a file-scope package declaration (e.g. Java's
 * `com.a.Shape`); when omitted the node carries only the simple `name`, like
 * production interfaces without a package qualifier.
 *
 * The node id is keyed by `language` + the most qualified identity available
 * (production ids embed file path + qualified name), so two same-simple-name
 * interfaces — cross-package or cross-language — are distinct graph nodes,
 * not a silent `addNode` no-op on a duplicate id.
 */
function addInterface(
  graph: KnowledgeGraph,
  name: string,
  language = 'java',
  qualifiedName?: string,
): string {
  const id = generateId('Interface', `${language}:${qualifiedName ?? name}`);
  graph.addNode({
    id,
    label: 'Interface',
    properties: {
      name,
      filePath: `src/${name}.${language}`,
      language,
      ...(qualifiedName !== undefined ? { qualifiedName } : {}),
    },
  });
  return id;
}

/**
 * Link `className` IMPLEMENTS the interface added via `addInterface` with the
 * same (`ifaceName`, `ifaceLanguage`, `ifaceQualifiedName`) identity.
 */
function addImplements(
  graph: KnowledgeGraph,
  className: string,
  ifaceName: string,
  ifaceLanguage = 'java',
  ifaceQualifiedName?: string,
): void {
  const classId = generateId('Class', className);
  const ifaceId = generateId('Interface', `${ifaceLanguage}:${ifaceQualifiedName ?? ifaceName}`);
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
 * Mirrors the production extraction shape: `typeText` is the verbatim type
 * source text with generics preserved (e.g. `List<IFoo>`), stored as
 * `rawDeclaredType`, while `declaredType` is the generics-stripped simple
 * name (e.g. `List`) — derived here from the raw text. `annotations` carries
 * '@Name' strings and is OMITTED when empty (production conditional-spread
 * shape); it defaults to `['@Autowired']` so the common annotated case stays
 * terse. The phase matches on `rawDeclaredType` and gates on `annotations`.
 *
 * `rawDeclaredType` defaults to `typeText`; pass `null` to OMIT the property
 * entirely — the shape a rawDeclaredType-plumbing regression produces, where
 * only the stripped `declaredType` reaches the graph.
 */
function addProperty(
  graph: KnowledgeGraph,
  ownerClassName: string,
  fieldName: string,
  typeText: string,
  language = 'java',
  annotations: string[] = ['@Autowired'],
  rawDeclaredType: string | null = typeText,
): string {
  const ownerId = generateId('Class', ownerClassName);
  const propId = generateId('Property', `${ownerClassName}.${fieldName}`);
  // Production `declaredType` is the simple name with generic args stripped.
  const declaredType = typeText.split('<')[0].trim();
  graph.addNode({
    id: propId,
    label: 'Property',
    properties: {
      name: fieldName,
      filePath: `src/${ownerClassName}.${language}`,
      language,
      declaredType,
      ...(rawDeclaredType !== null ? { rawDeclaredType } : {}),
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
    // stripped simple name ("List") reaches the graph (rawDeclaredType: null
    // opt-out). The field IS injection-annotated (it passes the annotation
    // gate), so this pins the rawDeclaredType-missing skip path: the phase
    // must NOT fall back to declaredType — zero edges, zero fields scanned
    // (and an isDev warning flags the plumbing-contract breach).
    addProperty(graph, 'MyService', 'foos', 'List<IFoo>', 'java', ['@Autowired'], null);

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

  // -------------------------------------------------------------------------
  // Language- and qualified-name-scoped interface resolution (PR #2200 U4)
  // -------------------------------------------------------------------------

  it.each([
    ['com.a.Shape inserted first', ['com.a.Shape', 'com.b.Shape'] as const],
    ['com.b.Shape inserted first', ['com.b.Shape', 'com.a.Shape'] as const],
  ])(
    'fails closed on a two-package same-simple-name collision (%s)',
    async (_label, [firstQn, secondQn]) => {
      const graph = createKnowledgeGraph();

      // Two Java interfaces named `Shape` in different packages. Insertion
      // order is the it.each parameter: identical assertions across both
      // orders pin order-independence (never last-writer-wins).
      addInterface(graph, 'Shape', 'java', firstQn);
      addInterface(graph, 'Shape', 'java', secondQn);
      addClass(graph, 'ShapeAImpl', 'java');
      addImplements(graph, 'ShapeAImpl', 'Shape', 'java', 'com.a.Shape');
      addClass(graph, 'ShapeBImpl', 'java');
      addImplements(graph, 'ShapeBImpl', 'Shape', 'java', 'com.b.Shape');

      addClass(graph, 'MyService', 'java');
      addProperty(graph, 'MyService', 'shapes', 'List<Shape>');

      const output = await diPhase.execute(makeCtx(graph), new Map());

      // Bare `Shape` is ambiguous within Java → fail closed, observable skip.
      expect(injectsEdges(graph)).toHaveLength(0);
      expect(output).toMatchObject({
        injectsEdges: 0,
        fieldsScanned: 1,
        ambiguousSkipped: 1,
      });
    },
  );

  it.each([
    ['typescript interface inserted first', ['typescript', 'java'] as const],
    ['java interface inserted first', ['java', 'typescript'] as const],
  ])(
    'resolves a bare name only within the candidate language (%s)',
    async (_label, [firstLang, secondLang]) => {
      const graph = createKnowledgeGraph();

      // A TS `interface Shape` and a Java `interface Shape` (unique WITHIN
      // Java). The Java consumer's bare `Shape` must resolve to the Java
      // interface regardless of which language's node was inserted first.
      addInterface(graph, 'Shape', firstLang);
      addInterface(graph, 'Shape', secondLang);
      addClass(graph, 'TsShapeImpl', 'typescript');
      addImplements(graph, 'TsShapeImpl', 'Shape', 'typescript');
      addClass(graph, 'JavaShapeImpl', 'java');
      addImplements(graph, 'JavaShapeImpl', 'Shape', 'java');

      addClass(graph, 'MyService', 'java');
      addProperty(graph, 'MyService', 'shapes', 'List<Shape>');

      const output = await diPhase.execute(makeCtx(graph), new Map());

      // Edges ONLY to the Java implementer — the TS implementer never
      // participates in a Java candidate's resolution.
      const edges = injectsEdges(graph);
      expect(edges).toHaveLength(1);
      expect(edges[0]).toMatchObject({
        sourceId: generateId('Class', 'MyService'),
        targetId: generateId('Class', 'JavaShapeImpl'),
      });
      expect(output).toMatchObject({
        injectsEdges: 1,
        fieldsScanned: 1,
        ambiguousSkipped: 0,
      });
    },
  );

  it('resolves a qualified element type via qualifiedName despite simple-name ambiguity', async () => {
    const graph = createKnowledgeGraph();

    addInterface(graph, 'Shape', 'java', 'com.a.Shape');
    addInterface(graph, 'Shape', 'java', 'com.b.Shape');
    addClass(graph, 'ShapeAImpl', 'java');
    addImplements(graph, 'ShapeAImpl', 'Shape', 'java', 'com.a.Shape');
    addClass(graph, 'ShapeBImpl', 'java');
    addImplements(graph, 'ShapeBImpl', 'Shape', 'java', 'com.b.Shape');

    // The field spells the element type fully qualified — exact qualifiedName
    // lookup, unaffected by the bare-name ambiguity.
    addClass(graph, 'MyService', 'java');
    addProperty(graph, 'MyService', 'shapes', 'List<com.a.Shape>');

    const output = await diPhase.execute(makeCtx(graph), new Map());

    const edges = injectsEdges(graph);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      sourceId: generateId('Class', 'MyService'),
      targetId: generateId('Class', 'ShapeAImpl'),
      reason: 'Spring DI: @Autowired List<com.a.Shape>',
    });
    expect(output).toMatchObject({
      injectsEdges: 1,
      fieldsScanned: 1,
      ambiguousSkipped: 0,
    });
  });

  it.each([
    ['module A inserted first', ['moduleA', 'moduleB'] as const],
    ['module B inserted first', ['moduleB', 'moduleA'] as const],
  ])(
    'fails closed on a duplicate-qualifiedName collision (%s)',
    async (_label, [firstModule, secondModule]) => {
      const graph = createKnowledgeGraph();

      // Two Java interfaces BOTH carrying qualifiedName `com.a.Shape` — the
      // realistic monorepo shape where the same package+name is duplicated
      // across modules or main/test source roots (a Java qualifiedName has no
      // file-path component). Distinct node ids (production ids embed the
      // file path), identical qualifiedName; insertion order is the it.each
      // parameter: identical assertions across both orders pin
      // order-independence (never last-writer-wins).
      const addModuleShape = (module: string): string => {
        const id = generateId('Interface', `java:${module}:com.a.Shape`);
        graph.addNode({
          id,
          label: 'Interface',
          properties: {
            name: 'Shape',
            filePath: `${module}/src/Shape.java`,
            language: 'java',
            qualifiedName: 'com.a.Shape',
          },
        });
        return id;
      };
      const firstIfaceId = addModuleShape(firstModule);
      const secondIfaceId = addModuleShape(secondModule);

      // One implementer per module's interface, so a wrong (last-writer-wins)
      // resolution WOULD have implementers to fan out to.
      const implAId = addClass(graph, 'ShapeAImpl', 'java');
      const implBId = addClass(graph, 'ShapeBImpl', 'java');
      graph.addRelationship({
        id: generateId('IMPLEMENTS', `${implAId}->${firstIfaceId}`),
        sourceId: implAId,
        targetId: firstIfaceId,
        type: 'IMPLEMENTS',
        confidence: 1.0,
        reason: '',
      });
      graph.addRelationship({
        id: generateId('IMPLEMENTS', `${implBId}->${secondIfaceId}`),
        sourceId: implBId,
        targetId: secondIfaceId,
        type: 'IMPLEMENTS',
        confidence: 1.0,
        reason: '',
      });

      // The field spells the element type fully qualified — the dotted branch.
      addClass(graph, 'MyService', 'java');
      addProperty(graph, 'MyService', 'shapes', 'List<com.a.Shape>');

      const output = await diPhase.execute(makeCtx(graph), new Map());

      // Qualified `com.a.Shape` is ambiguous within Java → fail closed,
      // observable skip — regardless of which module's node indexed first.
      expect(injectsEdges(graph)).toHaveLength(0);
      expect(output).toMatchObject({
        injectsEdges: 0,
        fieldsScanned: 1,
        ambiguousSkipped: 1,
      });
    },
  );

  it('fails closed even when the consumer shares a package with one collision party (pinned)', async () => {
    const graph = createKnowledgeGraph();

    addInterface(graph, 'Shape', 'java', 'com.a.Shape');
    addInterface(graph, 'Shape', 'java', 'com.b.Shape');
    addClass(graph, 'ShapeAImpl', 'java');
    addImplements(graph, 'ShapeAImpl', 'Shape', 'java', 'com.a.Shape');
    addClass(graph, 'ShapeBImpl', 'java');
    addImplements(graph, 'ShapeBImpl', 'Shape', 'java', 'com.b.Shape');

    // The consumer lives in com.a — Java source would resolve its bare
    // `Shape` to com.a.Shape. Resolution has NO package awareness today, so
    // this is still an ambiguous fail-closed skip. PINNED as current
    // behavior: the same-package tiebreaker is a deliberate, documented
    // follow-up (see the plan's Deferred work); implementing it must flip
    // this test knowingly.
    addClass(graph, 'MyService', 'java', 'Class', { qualifiedName: 'com.a.MyService' });
    addProperty(graph, 'MyService', 'shapes', 'List<Shape>');

    const output = await diPhase.execute(makeCtx(graph), new Map());

    expect(injectsEdges(graph)).toHaveLength(0);
    expect(output).toMatchObject({
      injectsEdges: 0,
      fieldsScanned: 1,
      ambiguousSkipped: 1,
    });
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
    // Wrapper identity and the gating annotation are visible in the reason.
    expect(match).toEqual({
      elementTypeName: 'IFoo',
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
    // The Map wrapper and the @Inject annotation are visible in the reason.
    expect(match).toEqual({
      elementTypeName: 'IPlugin',
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

  // -------------------------------------------------------------------------
  // Collection-type parser (PR #2200 U5) — table-driven, exact outputs.
  // Every ACCEPT/REJECT shape here was executed as a failing (or must-keep-
  // passing) case during the review; the module docstring documents each
  // rejection.
  // -------------------------------------------------------------------------

  it.each<[string, string, { collectionType: string; elementTypeName: string }]>([
    // Existing happy shapes — must keep parsing identically.
    ['plain List', 'List<IFoo>', { collectionType: 'List', elementTypeName: 'IFoo' }],
    ['plain Set', 'Set<IFoo>', { collectionType: 'Set', elementTypeName: 'IFoo' }],
    [
      'plain Collection',
      'Collection<IFoo>',
      { collectionType: 'Collection', elementTypeName: 'IFoo' },
    ],
    ['plain Map', 'Map<String,IPlugin>', { collectionType: 'Map', elementTypeName: 'IPlugin' }],
    // Generic Map KEY: the old `[^,]+` regex stopped at the nested comma and
    // captured garbage — the depth-aware split must yield the value type.
    ['generic Map key', 'Map<Pair<A,B>, IFoo>', { collectionType: 'Map', elementTypeName: 'IFoo' }],
    // Bounded wildcards — idiomatic Spring collection injection.
    [
      'upper-bounded wildcard',
      'List<? extends IFoo>',
      { collectionType: 'List', elementTypeName: 'IFoo' },
    ],
    [
      'lower-bounded wildcard',
      'List<? super IFoo>',
      { collectionType: 'List', elementTypeName: 'IFoo' },
    ],
    // Whitespace normalization: padded generics, padded Map comma, and a
    // multi-line declaration (raw tree-sitter .text can span lines).
    ['padded element', 'List< IFoo >', { collectionType: 'List', elementTypeName: 'IFoo' }],
    ['padded Map comma', 'Map<String , IFoo>', { collectionType: 'Map', elementTypeName: 'IFoo' }],
    [
      'multi-line declaration',
      'Map<\n    String,\n    IFoo\n>',
      { collectionType: 'Map', elementTypeName: 'IFoo' },
    ],
    // Package-qualified WRAPPER: recognized by its last dotted segment; the
    // qualifier is stripped from the wrapper only.
    [
      'qualified wrapper',
      'java.util.List<IFoo>',
      { collectionType: 'List', elementTypeName: 'IFoo' },
    ],
    [
      'qualified Map wrapper',
      'java.util.Map<String, IFoo>',
      { collectionType: 'Map', elementTypeName: 'IFoo' },
    ],
    // Dotted ELEMENT keeps its dots — resolved via qualifiedName downstream.
    [
      'qualified element',
      'List<com.a.Shape>',
      { collectionType: 'List', elementTypeName: 'com.a.Shape' },
    ],
    [
      'wildcard + qualified element',
      'Set<? extends com.a.Shape>',
      { collectionType: 'Set', elementTypeName: 'com.a.Shape' },
    ],
  ])('parseSpringCollectionType accepts %s: %j', (_label, raw, expected) => {
    expect(parseSpringCollectionType(raw)).toEqual(expected);
  });

  it.each<[string, string]>([
    // Element itself generic — unresolvable as a single interface.
    ['nested-generic element', 'Map<String, List<IFoo>>'],
    ['nested-generic behind wildcard', 'List<? extends List<IFoo>>'],
    // Unbounded wildcard — no element type to fan out to.
    ['unbounded wildcard', 'List<?>'],
    // Arrays — not the collect-all-implementers shape INJECTS models.
    ['array type', 'IFoo[]'],
    ['array of collections', 'List<IFoo>[]'],
    ['array element', 'List<IFoo[]>'],
    // Non-collection types.
    ['bare interface', 'IFoo'],
    ['non-collection wrapper', 'Optional<IFoo>'],
    // Wrong generic arity.
    ['Map with one argument', 'Map<String>'],
    ['List with two arguments', 'List<A, B>'],
    ['empty argument list', 'List<>'],
    // Block comments inside generics are not stripped — fail closed.
    ['block comment in generics', 'List</*x*/IFoo>'],
    // Unbalanced brackets — fail closed.
    ['unbalanced brackets', 'List<IFoo>>'],
  ])('parseSpringCollectionType rejects %s: %j → null', (_label, raw) => {
    expect(parseSpringCollectionType(raw)).toBeNull();
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
    expect(match).toMatchObject({
      elementTypeName: 'IFoo',
      reason: 'Spring DI: @Autowired List<IFoo>',
    });
  });
});
