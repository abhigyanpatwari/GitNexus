import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ParsedFile } from 'gitnexus-shared';
import { emitSwiftScopeCaptures } from '../../../../src/core/ingestion/languages/swift/captures.js';
import {
  collectSwiftCaptureSideChannel,
  readSwiftNameFacts,
  recordSwiftNameFacts,
  SWIFT_PLAIN_MACROS,
  SWIFT_TOP_LEVEL_DECLARATIONS,
  SWIFT_TOP_LEVEL_PLAIN,
  SWIFT_TOP_LEVEL_UNKNOWN,
  type SwiftNameFacts,
} from '../../../../src/core/ingestion/languages/swift/name-facts.js';
import {
  swiftOnDemandImportTargets,
  swiftReaches,
} from '../../../../src/core/ingestion/languages/swift/on-demand-imports.js';
import type { ScopeResolutionIndexes } from '../../../../src/core/ingestion/model/scope-resolution-indexes.js';
import type { SyntaxNode } from '../../../../src/core/ingestion/utils/ast-helpers.js';
import { extractParsedFile } from '../../../../src/core/ingestion/scope-extractor-bridge.js';
import { getProvider } from '../../../../src/core/ingestion/languages/index.js';
import { getSwiftParser } from '../../../../src/core/ingestion/languages/swift/query.js';
import { assertCloneable } from '../../../../src/core/ingestion/workers/clone-safety.js';
import { isLanguageAvailable } from '../../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../../src/config/supported-languages.js';

const swiftAvailable = isLanguageAvailable(SupportedLanguages.Swift);

function factsOf(source: string, filePath = 'Mod/File.swift'): SwiftNameFacts {
  emitSwiftScopeCaptures(source, filePath);
  const payload = collectSwiftCaptureSideChannel(filePath);
  const facts = readSwiftNameFacts({ captureSideChannel: payload } as ParsedFile);
  if (facts === undefined) throw new Error('no facts');
  return facts;
}
function declares(source: string): NonNullable<SwiftNameFacts['declares']> {
  const declared = factsOf(source).declares;
  if (declared === undefined) throw new Error('declarations unknown');
  return declared;
}
const list = (names: ReadonlySet<string>) => [...names].sort();

describe.skipIf(!swiftAvailable)('Swift declared names, by how another file reaches them', () => {
  it.each([
    ['struct', 'public struct Model {}', 'Model'],
    ['class', 'public final class Model {}', 'Model'],
    ['enum', 'public enum Model {}', 'Model'],
    ['actor', 'public actor Model {}', 'Model'],
    ['protocol', 'public protocol Model {}', 'Model'],
    ['typealias', 'public typealias Model = String', 'Model'],
    [
      'macro',
      '@freestanding(expression) public macro model(_ v: Int) -> Int = #externalMacro(module: "M", type: "S")',
      'model',
    ],
    [
      'precedence group',
      'precedencegroup ModelPrecedence { associativity: left }',
      'ModelPrecedence',
    ],
    ['function', 'public func model() {}', 'model'],
    ['let', 'public let model = 1', 'model'],
    ['var list', 'var model = 1, other = 2', 'model'],
    ['tuple pattern', 'public let (first, model) = (1, 2)', 'model'],
  ])('lists a top-level %s by its name', (_kind, source, name) => {
    expect(list(declares(source).top)).toContain(name);
  });

  it('lists custom operators, declared or defined anywhere', () => {
    expect(
      list(
        declares(
          'infix operator <+>: AdditionPrecedence\n' +
            'public func <+>(a: Int, b: Int) -> Int { a }\n' +
            'struct V { static func <*>(a: V, b: V) -> V { a } }\n' +
            'extension Int { static prefix func !!(a: Int) -> Int { a } }\n',
        ).ops,
      ),
    ).toEqual(['!!', '<*>', '<+>']);
  });

  it('lists extension members, statics included, not the extended type', () => {
    const facts = declares(
      'extension String {\n' +
        '    public var shout: String { self }\n' +
        '    public static let empty = ""\n' +
        '    public func trimmed() -> String { self }\n' +
        '    public struct Box {}\n' +
        '}\n',
    );
    expect(list(facts.ext)).toEqual(['Box', 'empty', 'shout', 'trimmed']);
    expect(list(facts.top)).toEqual([]);
    expect(list(facts.extTypes)).toEqual([]);
  });

  it.each([
    ['a conformance', 'extension Model: Equatable {}'],
    ['a conformance with members', 'extension Model: Codable {\n    func f() {}\n}'],
    ['an initializer', 'extension Model {\n    init(x: Int) {}\n}'],
    ['a subscript', 'extension Model {\n    subscript(i: Int) -> Int { 0 }\n}'],
    [
      'a standard-operator overload',
      'extension Model {\n    static func == (a: Model, b: Model) -> Bool { true }\n}',
    ],
    ['nothing', 'extension Model {}'],
    ['a qualified extended type', 'extension Outer.Model {\n    init(x: Int) {}\n}'],
  ])('lists the extended type of an extension with %s', (_what, source) => {
    expect(list(declares(source).extTypes)).toEqual(['Model']);
  });

  it('lists statics and enum cases of type bodies, nested types included, not instance members', () => {
    const facts = declares(
      'public struct Theme {\n' +
        '    public var id = 0\n' +
        '    public func render() {}\n' +
        '    public static let dark = Theme()\n' +
        '    static func make() -> Theme { Theme() }\n' +
        '    public enum Kind { case none, large }\n' +
        '}\n' +
        'class Box { class func make2() {}; final class var count: Int { 0 } }\n',
    );
    expect(list(facts.statics)).toEqual(['count', 'dark', 'large', 'make', 'make2', 'none']);
    expect(list(facts.top)).toEqual(['Box', 'Theme']);
    expect(list(facts.ext)).toEqual([]);
  });

  it('declares nothing for a file without declarations', () => {
    const facts = declares('// Only a comment.\nimport Foundation\n');
    expect(Object.values(facts).every((names) => names.size === 0)).toBe(true);
  });
});

describe.skipIf(!swiftAvailable)('Swift used names', () => {
  const USES = `import Foundation
import DTO
import struct Shared.Token

@Wrapped var setting: Setting
let banner = "hello \\(Greeting.text)"

func render(_ model: Model, list: [Item], array: Array<Element>) -> Output {
    let shared = Registry.shared
    let nested: Outer.Inner? = nil
    apply(.primary)
    switch model.state {
    case .ready: return Output()
    default: return Output()
    }
}
struct V {
    @Environment(\\.theme) var theme
}
let v = 1 <+> 2
`;
  const uses = () => factsOf(USES).uses!;

  it('records every identifier outside imports', () => {
    for (const name of ['Model', 'Item', 'Array', 'Element', 'Wrapped', 'Setting', 'Greeting'])
      expect(uses().ids).toContain(name);
    for (const name of ['Foundation', 'DTO', 'Shared', 'Token'])
      expect(uses().ids).not.toContain(name);
  });

  it('records names in member position as identifiers: after a dot, in a key path, inside a qualified type', () => {
    for (const name of ['shared', 'state', 'text', 'theme', 'Inner', 'primary', 'ready'])
      expect(uses().ids).toContain(name);
  });

  it('records implicit members separately', () => {
    expect(list(uses().implicit)).toEqual(['primary', 'ready']);
  });

  it('records operator tokens', () => {
    expect(list(uses().ops)).toEqual(expect.arrayContaining(['<+>', '=']));
  });

  it('records no uses for a file without imports', () => {
    expect(factsOf('let x: Model = Model()\n').uses).toBeUndefined();
  });

  it('records uses for a file that imports only SDK modules', () => {
    expect(factsOf('import Foundation\n\nlet x: Model = Model()\n').uses?.ids).toContain('Model');
  });
});

describe.skipIf(!swiftAvailable)('Swift name facts payload', () => {
  it('answers only for the file captured last', () => {
    emitSwiftScopeCaptures('struct A {}\n', 'Mod/A.swift');
    expect(collectSwiftCaptureSideChannel('Mod/B.swift')).toBeUndefined();
    expect(collectSwiftCaptureSideChannel('Mod/A.swift')).toBeDefined();
  });

  it('survives a structured clone and a JSON round trip', () => {
    emitSwiftScopeCaptures('import DTO\n\nstruct A { let m: Model }\n', 'Mod/A.swift');
    const payload = assertCloneable(collectSwiftCaptureSideChannel('Mod/A.swift'));
    const roundTrip = JSON.parse(JSON.stringify(structuredClone(payload)));
    const facts = readSwiftNameFacts({ captureSideChannel: roundTrip } as ParsedFile);
    expect(facts?.declares?.top.has('A')).toBe(true);
    expect(facts?.uses?.ids.has('Model')).toBe(true);
  });

  it('trusts no malformed facts', () => {
    for (const captureSideChannel of [
      undefined,
      null,
      'swift',
      { kind: 'java', nameFacts: { version: 5, declares: {} } },
      { kind: 'swift', nameFacts: { version: 4, declares: {} } },
      { kind: 'swift', nameFacts: { version: 5 } },
      { kind: 'swift', nameFacts: { version: 5, declares: { top: [1] } } },
      { kind: 'swift', nameFacts: { version: 5, declares: { aliasOf: [1] } } },
      {
        kind: 'swift',
        nameFacts: { version: 5, declares: {}, uses: { ids: ['a'], implicit: [3] } },
      },
      { kind: 'swift', nameFacts: { version: 5, declares: {}, uses: { implicit: [] } } },
    ])
      expect(readSwiftNameFacts({ captureSideChannel } as ParsedFile)).toBeUndefined();
  });
});

describe.skipIf(!swiftAvailable)('swiftReaches', () => {
  const importer = (source: string) => factsOf(`import Mod\n\n${source}`, 'App/U.swift').uses!;
  it.each([
    ['a top-level name it spells', 'public struct Model {}', 'let m: Model? = nil', true],
    [
      'an extension member it calls',
      'extension String { var shout: String { self } }',
      'let s = "a".shout',
      true,
    ],
    [
      'an extension member it writes bare, through an implicit self',
      'extension UIViewController { func showAlert() {} }',
      'final class Home: UIViewController { func load() { showAlert() } }',
      true,
    ],
    [
      'an extension member it never writes',
      'extension String { var shout: String { self } }',
      'let quiet = 1',
      false,
    ],
    [
      'a static it writes as an implicit member',
      'struct T { static let dark = T() }',
      'paint(.dark)',
      true,
    ],
    [
      'a static it reaches only through the type',
      'struct T { static let dark = T() }',
      'let d = Other.dark',
      false,
    ],
    [
      'an instance member of a type it never spells',
      'struct T { var id = 0 }',
      'let i = x.id',
      false,
    ],
    [
      'a custom operator it uses',
      'public func <+>(a: Int, b: Int) -> Int { a }',
      'let v = 1 <+> 2',
      true,
    ],
    [
      'the type of a conformance it spells',
      'extension Model: Equatable {}',
      'let m: Model? = nil',
      true,
    ],
    ['nothing at all', '// nothing\n', 'let m: Model? = nil', false],
  ])('%s: %s', (_what, target, use, expected) => {
    expect(swiftReaches(importer(use), declares(target))).toBe(expected);
  });
});

/**
 * Every form the facts model, one row each, on the side it belongs to. A form
 * missing from the facts would drop the edge to a file the importer uses, and
 * for several of them (enum cases, implicit statics, operators) no other edge
 * records the dependency.
 */
describe.skipIf(!swiftAvailable)('Swift name facts: forms that reach a declaration', () => {
  const importer = (source: string) => factsOf(`import Mod\n\n${source}`, 'App/U.swift').uses!;

  it.each([
    ['if case', 'if case .alpha(let v) = e { _ = v }', 'alpha'],
    ['guard case', 'guard case .beta = e else { return }', 'beta'],
    ['while case', 'while case .gamma = e {}', 'gamma'],
    ['for case', 'for case .delta in xs {}', 'delta'],
    ['case let', 'switch e { case let .eps(v): _ = v; default: break }', 'eps'],
    [
      'case with an optional pattern',
      'switch e { case .zeta(let w)?: _ = w; default: break }',
      'zeta',
    ],
    ['switch case', 'switch e { case .eta: break; default: break }', 'eta'],
    ['an argument', 'paint(.theta)', 'theta'],
    ['a backticked implicit member', 'paint(.`default`)', 'default'],
    // Keyword-named members: the node after the `.` is not an identifier.
    ['`.true` (a boolean literal)', 'paint(.true)', 'true'],
    ['`.false`', 'paint(.false)', 'false'],
    ['`.nil`', 'paint(.nil)', 'nil'],
    ['`.if`', 'paint(.if)', 'if'],
    ['`.switch`', 'paint(.switch)', 'switch'],
    ['`.self`', 'paint(.self)', 'self'],
    ['`.super`', 'paint(.super)', 'super'],
    ['`.async`', 'paint(.async)', 'async'],
    ['`.repeat(1)` (a value pack expansion)', 'paint(.repeat(1))', 'repeat'],
  ])('records an implicit member written in %s', (_form, statement, name) => {
    const uses = importer(`func f(_ e: E, _ xs: [E]) {\n    ${statement}\n}`);
    expect(uses.implicit).toContain(name);
  });

  it.each([
    ['a backticked enum case', 'enum K { case `default`, none }', 'statics', 'default'],
    ['a backticked static', 'struct K { static let `default` = K() }', 'statics', 'default'],
    ['a backticked function', 'func `guard`() {}', 'top', 'guard'],
    ['a backticked extension member', 'extension K { func `self`() {} }', 'ext', 'self'],
  ])('lists %s without its backticks', (_form, source, category, name) => {
    const declared = declares(source) as unknown as Record<string, ReadonlySet<string>>;
    expect(list(declared[category]!)).toContain(name);
  });

  it('records a backticked identifier without its backticks', () => {
    expect(importer('let v = `guard`()').ids).toContain('guard');
  });

  it.each([
    ['prefix operator ++', '++'],
    ['postfix operator --', '--'],
    ['infix operator <+> : AdditionPrecedence', '<+>'],
    ['extension Int { static prefix func ++(x: inout Int) {} }', '++'],
    ['struct V { static postfix func --(x: inout V) {} }', '--'],
  ])('lists the operator of `%s`', (source, op) => {
    expect(list(declares(source).ops)).toContain(op);
  });

  it.each([
    ['x++', '++'],
    ['x--', '--'],
    ['let r = 1...2', '...'],
    ['let r = 1..<2', '..<'],
    ['let v = 1 <+> 2', '<+>'],
  ])('records the operator token of `%s`', (statement, op) => {
    expect(importer(`func f() {\n    ${statement}\n}`).ops).toContain(op);
  });

  it('records a word that error recovery leaves as a bare error leaf (`consume x`)', () => {
    expect(importer('func f() {\n    let y = consume xval\n}').ids).toContain('xval');
  });

  it.each([
    ['public typealias Bar = Foo', ['Foo']],
    [
      'public typealias Handler = (Mod.Foo, [Kind]) -> Other<Item>?',
      ['Foo', 'Item', 'Kind', 'Mod', 'Other'],
    ],
    ['private typealias Hidden = Foo', []],
  ])('lists the names `%s` stands for', (source, names) => {
    expect(list(declares(source).aliasOf)).toEqual(names);
  });

  it('lists a typealias declared in an extension as an extension member', () => {
    expect(list(declares('extension Foo {\n    public typealias Item = Int\n}').ext)).toEqual([
      'Item',
    ]);
  });

  it.each([['callAsFunction'], ['`callAsFunction`']])(
    'lists the extended type of an extension declaring %s',
    (name) => {
      const facts = declares(`public extension Foo {\n    func ${name}() -> Int { 1 }\n}`);
      expect(list(facts.extTypes)).toEqual(['Foo']);
      expect(swiftReaches(importer('func f() {\n    let t = Foo()\n    _ = t()\n}'), facts)).toBe(
        true,
      );
    },
  );

  it('lists the argument labels of an extension subscript as members', () => {
    expect(
      list(
        declares('extension Collection {\n    subscript(safe i: Int, _ j: Int) -> Int { 0 }\n}')
          .ext,
      ),
    ).toEqual(['safe']);
  });

  it('does not list a standard-operator overload as an operator', () => {
    const facts = declares(
      'extension Model {\n    static func == (a: Model, b: Model) -> Bool { true }\n}',
    );
    expect(list(facts.ops)).toEqual([]);
    expect(list(facts.extTypes)).toEqual(['Model']);
  });

  it.each([
    ['extension [Int]: P {}', 'Array'],
    ['extension [String: Int] {\n    subscript(k: Int) -> Int { 0 }\n}', 'Dictionary'],
    ['extension Int? {\n    init(x: Int) { self = x }\n}', 'Optional'],
  ])('lists the standard type a sugar-spelled extension `%s` extends', (source, type) => {
    expect(list(declares(source).extTypes)).toEqual([type]);
  });

  it.each([
    ['let a: [Int] = []', 'Array'],
    ['let d: [String: Int] = [:]', 'Dictionary'],
    ['let o: Int? = nil', 'Optional'],
    ['let a = [1, 2]', 'Array'],
  ])('records `%s` as spelling %s', (statement, type) => {
    expect(importer(`func f() {\n    ${statement}\n}`).ids).toContain(type);
  });

  it.each([
    ['an enum case in `if case`', 'public enum E { case alpha }', 'if case .alpha = e {}'],
    [
      'an enum case in `case let`',
      'public enum E { case eps(Int) }',
      'switch e { case let .eps(v): _ = v; default: break }',
    ],
    ['an enum case in `for case`', 'public enum E { case delta }', 'for case .delta in xs {}'],
    [
      'a backticked case written as `.default`',
      'public enum E { case `default` }',
      'paint(.default)',
    ],
    ['a keyword-named case written as `.true`', 'public enum E { case `true` }', 'paint(.true)'],
    [
      'a keyword-named case written as `.repeat(1)`',
      'public enum E { case `repeat`(Int) }',
      'paint(.repeat(1))',
    ],
    [
      'a backticked static written as `.default`',
      'public struct T { public static let `default` = T() }',
      'paint(.default)',
    ],
    [
      'an extension member called bare inside a subclass',
      'extension UIViewController { func showAlert() {} }',
      'class Home: UIViewController { func f() { showAlert() } }',
    ],
    [
      'a protocol-extension member called bare in a conforming type',
      'extension P { func helper() {} }',
      'struct C: P { func f() { helper() } }',
    ],
    [
      'a type nested in an extension, used bare',
      'extension Foo { struct Bar {} }',
      'extension Foo { func f() { _ = Bar() } }',
    ],
    [
      'a `++` operator',
      'prefix operator ++\nextension Int { static prefix func ++(x: inout Int) {} }',
      'func f() { var x = 1; ++x }',
    ],
    [
      'a `--` operator defined in a type',
      'struct V { static postfix func --(x: inout V) {} }',
      'func f(_ v: inout V) { v-- }',
    ],
    [
      'an array extension subscript',
      'extension [Int] {\n    subscript(safe i: Int) -> Int? { nil }\n}',
      'func f(_ xs: [Int]) { _ = xs[safe: 0] }',
    ],
    [
      'a labelled subscript of a protocol extension, through a value',
      'extension Collection {\n    public subscript(safe i: Index) -> Element? { nil }\n}',
      'func f() { _ = items()[safe: 3] }',
    ],
    ['a dictionary conformance', 'extension [String: Int]: P {}', 'func f(_ d: [String: Int]) {}'],
    [
      'an optional extension',
      'extension Int? {\n    init(text: String) { self = nil }\n}',
      'func f(_ o: Int?) {}',
    ],
  ])('reaches %s', (_form, target, use) => {
    expect(swiftReaches(importer(`func g(_ e: E, _ xs: [E]) {}\n${use}`), declares(target))).toBe(
      true,
    );
  });
});

describe.skipIf(!swiftAvailable)('Swift name facts: forms they do not model are unknown', () => {
  const unknownReason = (source: string) => {
    emitSwiftScopeCaptures(source, 'Mod/File.swift');
    const payload = collectSwiftCaptureSideChannel('Mod/File.swift');
    return payload?.nameFacts.declares === null ? payload.nameFacts.unknown : undefined;
  };
  const unknown = (source: string) => factsOf(source).declares === undefined;

  it.each([
    ['a parse error at the top level', 'struct A {}\n)\nstruct C {}', 'parse-error'],
    ['a parse error in a type body', 'struct A {\n    )\n    static let x = 1\n}', 'parse-error'],
    [
      'a parse error in a nested type body',
      'struct A {\n    struct B {\n        )\n    }\n}',
      'parse-error',
    ],
    ['a parse error in an extension body', 'extension A {\n    )\n}', 'parse-error'],
    ['an unclosed type body', 'struct A {\n    static let x = 1\n', 'parse-error'],
    [
      'an unclosed protocol body that hides what follows',
      'public protocol P { func f()\npublic struct Next {}\nfunc helper() {}\n',
      'parse-error',
    ],
    [
      'a parse error in a declaration header',
      'public func f(a: Int {\n}\npublic struct After {}\n',
      'parse-error',
    ],
    [
      'an unterminated string that swallows the rest of the file',
      'func f() { let s = "abc }\npublic struct After {}\n',
      'unterminated-to-eof',
    ],
    [
      'an unterminated raw string',
      'public let a = 1\nlet r = #"abc\npublic struct After {}\n',
      'parse-error',
    ],
    [
      'an unterminated multi-line string',
      'public let a = 1\nlet m = """\nabc\npublic struct After {}\n',
      'unterminated-to-eof',
    ],
    [
      'an error holding a declaration',
      'func f() {\n    ?items.forEach { item in\n        let a = item.value(for: key, default: 0)\n        let b = [a, 1]\n    }\n}\n',
      'error-hides-declaration',
    ],
    ['a freestanding macro that may declare anything', '#mk()', 'unknown-node'],
    ['an extension of a type it cannot name', 'extension (Int, Int) {}', 'unnamed-extended-type'],
    // The grammar does not take a macro in a body: a parse error.
    [
      'a freestanding macro in an extension body',
      'extension Foo {\n    #declareThings\n}',
      'parse-error',
    ],
    ['a top-level initializer (only after a misparse)', 'init() {}', 'unknown-node'],
    // A diagnostic in a body is a grammar gap: it parses as an error.
    [
      'a `#warning` in a type body',
      'public struct A {\n    #warning("x")\n    static let a = 1\n}',
      'parse-error',
    ],
  ])('marks the declarations of %s unknown', (_form, source, reason) => {
    expect(unknownReason(source)).toBe(reason);
  });

  it.each([
    ['a string', 'public let tail = "hello"\n', ['f', 'tail']],
    ['a raw string', 'public let tail = #"a"b"#\n', ['f', 'tail']],
    ['a multi-line string', 'public let tail = """\n    text\n    """\n', ['f', 'tail']],
  ])(
    'keeps the declarations known when %s ends the file beside an unrelated parse error',
    (_form, last, names) => {
      // The error is inside a function body; the complete literal that ends
      // the file is not an unterminated one.
      expect(list(declares(`func f() {\n    let x = (\n}\n${last}`).top)).toEqual(names);
    },
  );

  it('keeps the declarations known after a parse error inside a function body', () => {
    // An error inside a function body hides no declaration another file can
    // name: the declarations around it are still read.
    expect(list(declares('func f() {\n    let x = (\n}\nstruct After {}\n').top)).toEqual([
      'After',
      'f',
    ]);
  });

  it('still records the uses of a file whose declarations are unknown', () => {
    const facts = factsOf('import Mod\n\n#mk(Model())\n');
    expect(facts.declares).toBeUndefined();
    expect(facts.uses?.ids).toContain('Model');
  });

  it('classifies every top-level node the grammar allows', () => {
    const nodeTypes = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, '../../../../vendor/tree-sitter-swift/src/node-types.json'),
        'utf8',
      ),
    ) as { type: string; children?: { types: { type: string }[] } }[];
    const sourceFile = nodeTypes.find((node) => node.type === 'source_file');
    const allowed = sourceFile?.children?.types.map((child) => child.type) ?? [];
    expect(allowed.length).toBeGreaterThan(0);
    const unclassified = allowed.filter(
      (type) =>
        !SWIFT_TOP_LEVEL_DECLARATIONS.has(type) &&
        !SWIFT_TOP_LEVEL_PLAIN.has(type) &&
        !SWIFT_TOP_LEVEL_UNKNOWN.has(type),
    );
    expect(unclassified).toEqual([]);
    // A freestanding macro is unknown unless named in SWIFT_PLAIN_MACROS.
    expect(SWIFT_TOP_LEVEL_UNKNOWN.has('macro_invocation')).toBe(true);
    expect([...SWIFT_PLAIN_MACROS].sort()).toEqual(['Preview', '_sourceLocation']);
  });

  it.each([
    ['#Preview { V() }'],
    ['#Preview("named") { V() }'],
    ['#_sourceLocation(file: "a.swift", line: 1)'],
    ['#warning("later")'],
    ['#error("never")'],
  ])('keeps the declarations known beside `%s`', (macro) => {
    expect(list(declares(`${macro}\npublic struct A {}\n`).top)).toEqual(['A']);
  });

  it('keeps the declarations known beside comments and directives in every position', () => {
    const facts = declares(
      [
        '// MARK: - Types',
        '/// A model.',
        '/* block */',
        '#if DEBUG',
        'public struct A {',
        '    // a comment',
        '    /// a doc comment',
        '    /* a block */',
        '    // MARK: Statics',
        '    #if DEBUG',
        '    static let debug = 1',
        '    #endif',
        '}',
        '#endif',
        'extension String {',
        '    // a comment',
        '    /// a doc comment',
        '    /* a block */',
        '    #if os(iOS)',
        '    var shout: String { self }',
        '    #endif',
        '}',
        '',
      ].join('\n'),
    );
    expect(list(facts.top)).toEqual(['A']);
    expect(list(facts.statics)).toEqual(['debug']);
    expect(list(facts.ext)).toEqual(['shout']);
  });

  it('keeps the declarations of top-level statements known (main.swift)', () => {
    expect(unknown('import Foundation\nlet app = App()\napp.run()\nif ready { start() }\n')).toBe(
      false,
    );
  });

  it('marks the declarations unknown and records no uses when gathering throws', () => {
    const throwing = new Proxy({} as SyntaxNode, {
      get: () => {
        throw new Error('boom');
      },
    });
    recordSwiftNameFacts('Mod/Broken.swift', throwing);
    const facts = readSwiftNameFacts({
      captureSideChannel: collectSwiftCaptureSideChannel('Mod/Broken.swift'),
    } as ParsedFile);
    expect(facts).toBeDefined();
    expect(facts?.declares).toBeUndefined();
    expect(facts?.uses).toBeUndefined();
    expect(collectSwiftCaptureSideChannel('Mod/Broken.swift')?.nameFacts.unknown).toBe('failure');
  });

  it('reads uses without parent or sibling lookups, whose cost grows with depth', () => {
    // Every node the walk reaches comes from its cursor; count the lookups a
    // depth-proportional read would make on them.
    let reads = 0;
    const bound = (target: object, value: unknown) =>
      typeof value === 'function' ? value.bind(target) : value;
    const node = (raw: SyntaxNode): SyntaxNode =>
      new Proxy(raw, {
        get(target, key) {
          if (key === 'parent' || key === 'nextSibling' || key === 'previousSibling') reads++;
          return bound(target, Reflect.get(target, key, target));
        },
      });
    const cursorOf = (raw: object): object =>
      new Proxy(raw, {
        get(target, key) {
          const value = Reflect.get(target, key, target);
          return key === 'currentNode' ? node(value as SyntaxNode) : bound(target, value);
        },
      });
    const source =
      'import M\nlet x = ' +
      '('.repeat(200) +
      '[' +
      '.a, .true, .repeat(1), '.repeat(50) +
      ']' +
      ')'.repeat(200);
    const root = getSwiftParser().parse(source).rootNode as unknown as SyntaxNode;
    const counted = new Proxy(root, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        return key === 'walk' ? () => cursorOf(target.walk()) : bound(target, value);
      },
    });
    recordSwiftNameFacts('Mod/Deep.swift', counted);
    const facts = readSwiftNameFacts({
      captureSideChannel: collectSwiftCaptureSideChannel('Mod/Deep.swift'),
    } as ParsedFile);
    expect([...(facts?.uses?.implicit ?? [])].sort()).toEqual(['a', 'repeat', 'true']);
    expect(reads).toBe(0);
  });

  it('gathers a 20,000-deep nest of types without overflowing the stack', () => {
    const depth = 20000;
    const source =
      'import M\n' + 'struct S {'.repeat(depth) + ' static let deep = 1 ' + '}'.repeat(depth);
    expect(list(declares(source).statics)).toEqual(['deep']);
    expect(factsOf(source).uses?.ids).toContain('deep');
    const warnings: string[] = [];
    const parsed = extractParsedFile(
      getProvider(SupportedLanguages.Swift),
      source,
      'Mod/Deep.swift',
      (message) => warnings.push(message),
    );
    expect(warnings).toEqual([]);
    expect(parsed).toBeDefined();
  });
});

describe.skipIf(!swiftAvailable)('Swift name facts: file-private declarations', () => {
  it('does not list private or fileprivate declarations, which no other file can name', () => {
    const facts = declares(
      'private enum Constants { static let a = 1 }\n' +
        'fileprivate func helper() {}\n' +
        'private(set) var counter = 0\n' +
        'public struct Model { private static let hidden = 1; static let shown = 2 }\n' +
        'private extension Foo { func pe() {} }\n' +
        'extension Foo { private func pm() {}; func shared() {} }\n',
    );
    expect(list(facts.top)).toEqual(['Model', 'counter']);
    expect(list(facts.statics)).toEqual(['shown']);
    expect(list(facts.ext)).toEqual(['shared']);
  });
});

describe.skipIf(!swiftAvailable)('swiftOnDemandImportTargets fails open', () => {
  const parsedOf = (filePath: string, source: string | undefined): ParsedFile => {
    if (source !== undefined) emitSwiftScopeCaptures(source, filePath);
    return {
      filePath,
      moduleScope: `scope:${filePath}`,
      captureSideChannel:
        source === undefined ? undefined : collectSwiftCaptureSideChannel(filePath),
    } as unknown as ParsedFile;
  };
  const indexesFor = (targets: readonly string[]) =>
    ({
      imports: {
        forEachTarget: (_scope: string, visit: (file: string, via: { kind: string }) => void) => {
          for (const file of targets) visit(file, { kind: 'namespace' });
        },
      },
    }) as unknown as ScopeResolutionIndexes;

  it('keeps every edge of an importer without facts', () => {
    const importer = parsedOf('App/U.swift', undefined);
    expect(
      swiftOnDemandImportTargets(importer, indexesFor(['Mod/A.swift']), () => undefined),
    ).toBeUndefined();
  });

  it('keeps a target without facts, a target whose declarations are unknown and one whose gathering threw', () => {
    const files = new Map<string, ParsedFile>([
      ['Mod/Used.swift', parsedOf('Mod/Used.swift', 'public struct Used {}\n')],
      ['Mod/Unused.swift', parsedOf('Mod/Unused.swift', 'public struct Unused {}\n')],
      ['Mod/NoFacts.swift', parsedOf('Mod/NoFacts.swift', undefined)],
      [
        'Mod/Broken.swift',
        parsedOf('Mod/Broken.swift', 'struct A { func f( }\nstruct Hidden {}\n'),
      ],
    ]);
    recordSwiftNameFacts(
      'Mod/Threw.swift',
      new Proxy({} as SyntaxNode, {
        get: () => {
          throw new Error('boom');
        },
      }),
    );
    files.set('Mod/Threw.swift', {
      filePath: 'Mod/Threw.swift',
      captureSideChannel: collectSwiftCaptureSideChannel('Mod/Threw.swift'),
    } as unknown as ParsedFile);
    const importer = parsedOf('App/U.swift', 'import Mod\n\nlet u: Used? = nil\n');
    const kept = swiftOnDemandImportTargets(importer, indexesFor([...files.keys()]), (file) =>
      files.get(file),
    );
    expect([...(kept ?? [])].sort()).toEqual([
      'Mod/Broken.swift',
      'Mod/NoFacts.swift',
      'Mod/Threw.swift',
      'Mod/Used.swift',
    ]);
  });

  it('follows one alias hop to the file declaring the aliased type, and no further', () => {
    const files = new Map<string, ParsedFile>([
      ['Mod/Foo.swift', parsedOf('Mod/Foo.swift', 'public struct Foo {}\n')],
      ['Mod/Bar.swift', parsedOf('Mod/Bar.swift', 'public typealias Bar = Foo\n')],
      ['Mod/Baz.swift', parsedOf('Mod/Baz.swift', 'public typealias Baz = Bar\n')],
      ['Mod/Other.swift', parsedOf('Mod/Other.swift', 'public struct Other {}\n')],
    ]);
    const keptFor = (use: string) =>
      [
        ...(swiftOnDemandImportTargets(
          parsedOf('App/U.swift', `import Mod\n\n${use}\n`),
          indexesFor([...files.keys()]),
          (file) => files.get(file),
        ) ?? []),
      ].sort();
    expect(keptFor('let b = Bar()')).toEqual(['Mod/Bar.swift', 'Mod/Foo.swift']);
    // A chain of aliases is followed one hop only: a documented drop.
    expect(keptFor('let b = Baz()')).toEqual(['Mod/Bar.swift', 'Mod/Baz.swift']);
  });
});
