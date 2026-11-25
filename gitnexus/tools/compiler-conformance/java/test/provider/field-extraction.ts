import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createFieldExtractor } from '../../../../../src/core/ingestion/field-extractors/generic.js';
import { javaConfig } from '../../../../../src/core/ingestion/field-extractors/configs/jvm.js';
import type { FieldExtractorContext } from '../../../../../src/core/ingestion/field-types.js';
import type { TypeEnvironment } from '../../../../../src/core/ingestion/type-env.js';
import { createSemanticModel } from '../../../../../src/core/ingestion/model/semantic-model.js';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import { SupportedLanguages } from '../../../../../src/config/supported-languages.js';

// Mock context for tests. symbolTable comes from createSemanticModel().symbols
// (the facade) rather than createSymbolTable() (the raw leaf) — this mirrors
// production, where FieldExtractorContext always receives the SemanticModel-
// wrapped facade so any .add() write dispatches through the owner-scoped
// registries. No current field extractor calls symbolTable.add(), but
// matching the production shape prevents silent drift if a future extractor
// starts registering dynamically-discovered properties.
const createMockContext = (): FieldExtractorContext => ({
  typeEnv: {
    lookup: () => undefined,
    constructorBindings: [],
    fileScope: () => new Map(),
    allScopes: () => new Map(),
    constructorTypeMap: new Map(),
    flush: () => {},
  } satisfies TypeEnvironment,
  symbolTable: createSemanticModel().symbols,
  filePath: 'test.ts',
  language: SupportedLanguages.TypeScript,
});

// ---------------------------------------------------------------------------
// Java config — rawDeclaredType: verbatim generic type text (PR #2200 U1)
// and annotations: '@Name' strings from the modifiers child (PR #2200 U2)
// ---------------------------------------------------------------------------

describe('GenericFieldExtractor — Java (rawDeclaredType + annotations)', () => {
  const parser = new Parser();
  const extractor = createFieldExtractor(javaConfig);
  const mockContext = createMockContext();
  mockContext.language = SupportedLanguages.Java;
  mockContext.filePath = 'Test.java';

  /** Parse `src` and return the first class_declaration node. */
  function classNode(src: string) {
    parser.setLanguage(Java);
    const tree = parser.parse(src);
    const node = tree.rootNode.child(0);
    if (!node) throw new Error('no class node');
    return node;
  }

  for (const example of [
    {
      field: 'private List<Shape> shapes;',
      name: 'shapes',
      type: 'List',
      rawDeclaredType: 'List<Shape>',
    },
    {
      field: 'private Set<T> items;',
      name: 'items',
      type: 'Set',
      rawDeclaredType: 'Set<T>',
    },
    {
      field: 'private Map<String, Foo> byName;',
      name: 'byName',
      type: 'Map',
      rawDeclaredType: 'Map<String, Foo>',
    },
    {
      // Non-generic field: rawDeclaredType is PRESENT and equals the type text.
      field: 'private String name;',
      name: 'name',
      type: 'String',
      rawDeclaredType: 'String',
    },
    {
      // Qualified generic: raw text preserved verbatim; simple name still last segment.
      field: 'private java.util.List<Shape> shapes;',
      name: 'shapes',
      type: 'List',
      rawDeclaredType: 'java.util.List<Shape>',
    },
  ] as const) {
    it(`extracts type "${example.type}" and rawDeclaredType "${example.rawDeclaredType}" from \`${example.field}\``, () => {
      const { field, name, type, rawDeclaredType } = example;

      const result = extractor.extract(classNode(`class C { ${field} }`), mockContext);

      assert.notEqual(result, null);
      assert.equal(result!.fields.length, 1);
      assert.partialDeepStrictEqual(result!.fields[0], { name, type, rawDeclaredType });
    });
  }

  for (const example of [
    {
      // marker_annotation node type (no arguments).
      field: '@Autowired private List<Shape> shapes;',
      annotations: ['@Autowired'],
    },
    {
      // `annotation` node type (with arguments), not `marker_annotation` —
      // the name comes from the annotation's `name` field.
      field: '@Autowired(required=false) private List<Shape> shapes;',
      annotations: ['@Autowired'],
    },
    {
      // Multiple annotations on one field — all are collected, in order.
      field: '@Nullable @Autowired @Qualifier("shapeBeans") private List<Shape> shapes;',
      annotations: ['@Nullable', '@Autowired', '@Qualifier'],
    },
  ] as const) {
    it(`extracts annotations ${example.annotations} from \`${example.field}\``, () => {
      const { field, annotations } = example;

      const result = extractor.extract(classNode(`class C { ${field} }`), mockContext);

      assert.notEqual(result, null);
      assert.equal(result!.fields.length, 1);
      assert.partialDeepStrictEqual(result!.fields[0], { name: 'shapes', annotations });
    });
  }

  it('omits annotations entirely for a non-annotated field', () => {
    const result = extractor.extract(
      classNode('class C { private List<Shape> shapes; }'),
      mockContext,
    );

    assert.notEqual(result, null);
    assert.equal(result!.fields.length, 1);
    assert.ok(!Object.hasOwn(result!.fields[0], 'annotations'));
  });

  it('still extracts the field when extractRawType/extractAnnotations throw (per-hook isolation)', () => {
    // A throwing hook must degrade to a field WITHOUT raw/annotations — never
    // escape buildField: an escaped throw reaches the language-group catch
    // upstream (processFileGroup) and silently drops every remaining file in
    // the group (#2286-review guard pattern).
    const throwingExtractor = createFieldExtractor({
      ...javaConfig,
      extractRawType: () => {
        throw new Error('unexpected node shape');
      },
      extractAnnotations: () => {
        throw new Error('unexpected node shape');
      },
    });

    const result = throwingExtractor.extract(
      classNode('class C { @Autowired private List<Shape> shapes; }'),
      mockContext,
    );

    assert.notEqual(result, null);
    assert.equal(result!.fields.length, 1);
    assert.partialDeepStrictEqual(result!.fields[0], { name: 'shapes', type: 'List' });
    assert.ok(!Object.hasOwn(result!.fields[0], 'rawDeclaredType'));
    assert.ok(!Object.hasOwn(result!.fields[0], 'annotations'));
  });
});
