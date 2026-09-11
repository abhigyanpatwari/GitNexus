import { describe, it, expect, beforeAll } from 'vitest';
import Parser from 'tree-sitter';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import { createParserForLanguage } from '../../src/core/tree-sitter/parser-loader.js';
import { DART_QUERIES } from '../../src/core/ingestion/tree-sitter-queries.js';

/**
 * A Dart field whose value is a constructor call parses the callee as a SECOND
 * (identifier) sibling of the field name:
 *
 *   final TextEditingController _title = TextEditingController();
 *   → initialized_identifier[ identifier "_title",
 *                             identifier "TextEditingController", selector ]
 *
 * Unanchored, `(identifier) @name` matched both siblings and minted a phantom
 * Property/Variable named after the TYPE next to the real field. The same shape
 * applies to static_final_declaration (class statics and top-level final/const),
 * so all five graph-node rules anchor @name to the first named child.
 *
 * Regression guard: no captured name may be a type that only ever appears on the
 * right-hand side, and every real declared name must still be captured.
 */

const CODE = `class S {
  final TextEditingController _title = TextEditingController();
  final TextEditingController _body = TextEditingController();
  Foo? nullableField = Foo();
  static final Bar staticField = Bar();
  final ArticleApi _noInitializer;
}
final Baz topLevelFinal = Baz();
var topLevelVar = Qux();
`;

/** Names that appear ONLY as constructor callees — never legal captures. */
const RHS_ONLY_TYPES = ['TextEditingController', 'Foo', 'Bar', 'Baz', 'Qux'];

/** Every name actually declared in CODE. */
const DECLARED = [
  '_title',
  '_body',
  'nullableField',
  'staticField',
  '_noInitializer',
  'topLevelFinal',
  'topLevelVar',
];

describe('Dart field/variable declarations with constructor initializers', () => {
  let parser: Parser | null = null;
  let unavailable: string | null = null;

  beforeAll(async () => {
    // NB: loadLanguage() resolves to void, so the `if (!(await loadDartOrSkip()))`
    // idiom used elsewhere in this suite is always truthy-false and skips the
    // whole test body. createParserForLanguage returns the Parser, so a genuine
    // load failure is distinguishable from a successful load.
    try {
      parser = await createParserForLanguage(SupportedLanguages.Dart);
    } catch (error) {
      unavailable = error instanceof Error ? error.message : String(error);
    }
  });

  function capturedNames(): { property: string[]; variable: string[] } {
    if (!parser) throw new Error('parser unavailable');
    const tree = parser.parse(CODE);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query = new (Parser as any).Query(
      (tree as any).language ?? parser.getLanguage(),
      DART_QUERIES,
    );
    const property: string[] = [];
    const variable: string[] = [];
    for (const match of query.matches(tree.rootNode)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const name = match.captures.find((c: any) => c.name === 'name');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const def = match.captures.find((c: any) => c.name.startsWith('definition.'));
      if (!name || !def) continue;
      if (def.name === 'definition.property') property.push(name.node.text);
      if (def.name === 'definition.variable') variable.push(name.node.text);
    }
    return { property: [...new Set(property)], variable: [...new Set(variable)] };
  }

  it('does not mint a phantom named after the initializer type', (ctx) => {
    if (!parser) return ctx.skip(`dart grammar unavailable: ${unavailable}`);
    const { property, variable } = capturedNames();
    const all = [...property, ...variable];
    expect(all.length, 'query produced no captures at all').toBeGreaterThan(0);
    for (const type of RHS_ONLY_TYPES) {
      expect(all, `phantom captured for constructor callee "${type}"`).not.toContain(type);
    }
  });

  it('still captures every declared field and top-level variable', (ctx) => {
    if (!parser) return ctx.skip(`dart grammar unavailable: ${unavailable}`);
    const { property, variable } = capturedNames();
    const all = [...property, ...variable];
    for (const declared of DECLARED) {
      expect(all, `lost real declaration "${declared}"`).toContain(declared);
    }
  });

  it('classifies class members as property and top-level names as variable', (ctx) => {
    if (!parser) return ctx.skip(`dart grammar unavailable: ${unavailable}`);
    const { property, variable } = capturedNames();
    expect(property).toEqual(
      expect.arrayContaining(['_title', '_body', 'nullableField', 'staticField', '_noInitializer']),
    );
    expect(variable).toEqual(expect.arrayContaining(['topLevelFinal', 'topLevelVar']));
  });
});
