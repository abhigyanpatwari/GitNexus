/**
 * Swift fixtures for the `import X` narrowing tests: the T1 layouts and
 * matrix (`swift-import-fanout.test.ts`), the size fixture
 * (`swift-import-fanout-size.test.ts`), and the soundness properties that run
 * over all of them (`swift-import-soundness.test.ts`).
 */

import { getRelationships, type PipelineResult } from './helpers.js';

export const SWIFT_IMPORT_REASON = 'swift-scope: import';

/** Persisted `import X` targets per importer, sorted. */
export function swiftImportTargets(result: PipelineResult): Map<string, string[]> {
  const bySource = new Map<string, string[]>();
  for (const edge of getRelationships(result, 'IMPORTS')) {
    if (edge.rel.reason !== SWIFT_IMPORT_REASON) continue;
    const targets = bySource.get(edge.sourceFilePath) ?? [];
    targets.push(edge.targetFilePath);
    bySource.set(edge.sourceFilePath, targets);
  }
  for (const targets of bySource.values()) targets.sort();
  return bySource;
}

export const MODULES = 3;
export const FILES_PER_MODULE = 8;
export const IMPORTERS = 12;

/** Every importer imports all modules and spells exactly one type of each. */
export function typeFor(module: number, importer: number): string {
  return `Model${module}_${importer % FILES_PER_MODULE}`;
}

export function fanoutFixture(layout: { modulePath: (m: string) => string; manifest?: string }) {
  const files: Record<string, string> = {};
  if (layout.manifest !== undefined) files['Package.swift'] = layout.manifest;
  for (let m = 0; m < MODULES; m++) {
    for (let f = 0; f < FILES_PER_MODULE; f++) {
      files[`${layout.modulePath(`Mod${m}`)}/Model${m}_${f}.swift`] = [
        `public struct Model${m}_${f} {`,
        '    public let id: Int',
        '    public init(id: Int) { self.id = id }',
        '    public func describe() -> String { return "model" }',
        '}',
        '',
      ].join('\n');
    }
  }
  for (let i = 0; i < IMPORTERS; i++) {
    const [a, b, c] = [0, 1, 2].map((m) => typeFor(m, i));
    files[`${layout.modulePath('App')}/View${i}.swift`] = [
      'import Mod0',
      'import Mod1',
      'import Mod2',
      '',
      `struct View${i} {`,
      `    func render(_ a: ${a}, _ b: ${b}, _ c: ${c}) -> Int {`,
      '        _ = a.describe()',
      '        _ = b.describe()',
      '        _ = c.describe()',
      '        let x = a.id',
      '        let y = b.id',
      '        let z = c.id',
      '        return x + y + z',
      '    }',
      '}',
      '',
    ].join('\n');
  }
  return files;
}

export const FANOUT_LAYOUTS = [
  {
    name: 'directory-named modules (no manifest)',
    prefix: 'swift-fanout-dirs',
    modulePath: (m: string) => m,
    manifest: undefined,
    // One membership edge per file (recorded on upstream/main).
    membership: 36,
  },
  {
    name: 'Package.swift targets',
    prefix: 'swift-fanout-spm',
    modulePath: (m: string) => `Sources/${m}`,
    manifest: [
      '// swift-tools-version:5.7',
      'import PackageDescription',
      '',
      'let package = Package(',
      '    name: "Fanout",',
      '    targets: [',
      '        .target(name: "Mod0"),',
      '        .target(name: "Mod1"),',
      '        .target(name: "Mod2"),',
      '        .target(name: "App", dependencies: ["Mod0", "Mod1", "Mod2"]),',
      '    ]',
      ')',
      '',
    ].join('\n'),
    membership: 36,
  },
] as const;

export const NAMES_FIXTURE: Record<string, string> = {
  'Mod0/Model.swift': 'public struct Model0 {\n    public let id: Int\n}\n',
  // Reached by calling the member, not by spelling the extended type.
  'Mod0/Model+Ext.swift': 'extension Model0 {\n    func ext() {}\n}\n',
  // A conformance is used through values of the type: reached by spelling it.
  'Mod0/Model+Eq.swift': 'extension Model0: Equatable {}\n',
  'Mod0/Other.swift': 'public struct Other0 {}\n',
  'Mod0/Config.swift': 'let sharedConfig = 1\n\nfunc makeModel() -> Int {\n    return 1\n}\n',
  'Mod0/Notes.swift': '// Nothing is declared here.\n',
  'Mod1/Thing.swift': 'public struct Thing1 {}\n',
  'App/UsesModel.swift': 'import Mod0\nimport Mod1\n\nfunc show(_ m: Model0) {}\n',
  'App/CallsExt.swift': 'import Mod0\n\nfunc call(_ m: Model0) {\n    m.ext()\n}\n',
  'App/UsesConfig.swift':
    'import Mod0\n\nfunc configured() -> Int {\n    return sharedConfig + makeModel()\n}\n',
  // An explicit `import struct` keeps its edge whatever the file spells.
  'App/Explicit.swift':
    'import struct Mod0.Other0\nimport Mod0\n\nfunc configured() -> Int {\n    return makeModel()\n}\n',
};

export const UNKNOWN_FIXTURE: Record<string, string> = {
  'Err/Good.swift': 'public struct Good {}\n',
  // A parse error can hide declarations: the file is kept for every importer.
  'Err/Broken.swift': 'public struct Hidden {}\nstruct Bad {\n    func f(\n}\n',
  'Err/Unused.swift': 'public struct Unused {}\n',
  'App/E.swift': 'import Err\n\nlet g: Good? = nil\n',
  // `@_exported import` is a re-export: never narrowed.
  'App/Reexport.swift': '@_exported import Err\n',
};

export const NEGATIVES_FIXTURE: Record<string, string> = {
  'Neg/Holder.swift': 'public enum Holder {}\n',
  'Neg/Holder+Members.swift':
    'extension Holder {\n    public static func build() {}\n    public enum Kind { case alpha }\n}\n',
  'App/SpellsHolder.swift': 'import Neg\n\nlet h: Holder? = nil\n',
  'App/OtherCase.swift': 'import Neg\n\nfunc use(_ k: Kind2) { if case .beta = k {} }\n',
  'App/SameCase.swift': 'import Neg\n\nfunc use(_ k: Kind2) { if case .alpha = k {} }\n',
};

export const DROPS_FIXTURE: Record<string, string> = {
  'Drop/Base.swift': 'open class Base {\n    public init() {}\n    public func configure() {}\n}\n',
  'Drop/Sub.swift': 'open class Sub: Base {}\n',
  'Drop/P.swift': 'public protocol P {\n    func req()\n}\n',
  'Drop/PDefault.swift': 'extension P {\n    public func req() {}\n}\n',
  'Drop/Cfg.swift': 'public struct Cfg {\n    public init(x: Int) {}\n}\n',
  'Drop/Setup.swift': 'public func setup(_ c: Cfg) {}\n',
  'Drop/Runner.swift':
    'public struct Runner {\n    public init() {}\n    public func run() {}\n    public var state = 0\n}\n',
  'Drop/Make.swift': 'public func makeRunner() -> Runner { Runner() }\n',
  'Drop/Tok.swift': 'public struct Tok {}\n',
  'Drop/TokEq.swift': 'public func == (a: Tok, b: Tok) -> Bool { true }\n',
  'Drop/StringPlus.swift':
    'extension String {\n    public static func + (a: String, b: Int) -> String { a }\n}\n',
  'Drop/Label.swift': 'public func label() -> String { "" }\n',
  'Drop/StringIndex.swift':
    'extension String {\n    public subscript(i: Int) -> Character { first! }\n}\n',
  'Drop/Vec.swift':
    'public struct Vec {\n    public init() {}\n    public static func + (a: Vec, b: Vec) -> Vec { a }\n}\n',
  'Drop/MakeVec.swift': 'public func makeVec() -> Vec { Vec() }\n',
  'Drop/Svc.swift': 'public struct Svc {\n    public typealias Model = User\n}\n',
  'Drop/User.swift':
    'public struct User {\n    public static let shared = User()\n    public init() {}\n    public func run() {}\n}\n',
  'Core/Money.swift':
    'public struct Money {\n    public static let zero = Money()\n    public init() {}\n    public func run() {}\n}\n',
  'Facade/Cash.swift': 'import Core\n\npublic typealias Cash = Money\n',
  'App/NestedAlias.swift': 'import Drop\n\nfunc use() {\n    Svc.Model.shared.run()\n}\n',
  'App/CrossImportAlias.swift':
    'import Core\nimport Facade\n\nfunc use() {\n    Cash.zero.run()\n}\n',
  'App/Inherited.swift': 'import Drop\n\nfunc use() {\n    Sub().configure()\n}\n',
  'App/InheritedLocal.swift':
    'import Drop\n\nfunc use() {\n    let s = Sub()\n    s.configure()\n}\n',
  'App/InheritedParam.swift': 'import Drop\n\nfunc use(_ s: Sub) {\n    s.configure()\n}\n',
  'App/InheritedInside.swift':
    'import Drop\n\nfinal class Mine: Sub {\n    func use() {\n        configure()\n    }\n}\n',
  'App/UnlabelledSubscript.swift': 'import Drop\n\nfunc use() -> Character {\n    label()[0]\n}\n',
  'App/TypeBodyOp.swift': 'import Drop\n\nfunc use() {\n    _ = makeVec() + makeVec()\n}\n',
  'App/Conforms.swift': 'import Drop\n\nstruct S: P {}\n',
  'App/ImplicitInit.swift': 'import Drop\n\nfunc use() {\n    setup(.init(x: 1))\n}\n',
  'App/Inferred.swift':
    'import Drop\n\nfunc use() {\n    let r = makeRunner()\n    r.run()\n    _ = r.state\n}\n',
  'App/StdOp.swift': 'import Drop\n\nfunc use(_ a: Tok, _ b: Tok) -> Bool {\n    a == b\n}\n',
  'App/LiteralOp.swift': 'import Drop\n\nfunc use() -> Int {\n    ("a" + 1).count\n}\n',
};

/** One declaration per target file, next to an unrelated `struct Keep_k`, and an
 *  importer that reaches only that declaration. Support files the importer
 *  also names are listed in `alsoKept`. */
export const MATRIX: readonly {
  readonly kind: string;
  readonly declaration: string;
  readonly use: string;
  readonly alsoKept?: readonly string[];
}[] = [
  {
    kind: 'typealias',
    declaration: 'public typealias UserID = String',
    use: 'func f(_ x: UserID) {}',
  },
  {
    kind: 'macro',
    declaration:
      '@freestanding(expression) public macro stringify(_ v: Int) -> Int = #externalMacro(module: "M", type: "S")',
    use: 'let v = #stringify(1)',
  },
  {
    kind: 'custom operator',
    declaration:
      'infix operator <+>: AdditionPrecedence\npublic func <+>(a: Int, b: Int) -> Int { a + b }',
    use: 'let v = 1 <+> 2',
  },
  { kind: 'tuple let', declaration: 'public let (tupA, tupB) = (1, 2)', use: 'let v = tupB' },
  {
    kind: 'SDK-type extension member',
    declaration: 'extension String {\n    public var shout: String { self }\n}',
    use: 'let v = "a".shout',
  },
  {
    kind: 'extension static used as an implicit member',
    declaration: 'extension Style {\n    public static let primary = Style()\n}',
    use: 'func use() { apply(.primary) }',
    alsoKept: ['Take.swift'],
  },
  {
    kind: 'enum case used as an implicit member',
    declaration: 'public enum Size {\n    case large\n}',
    use: 'func use() { take(.large) }',
    alsoKept: ['Take.swift'],
  },
  {
    kind: 'nested-type extension',
    declaration: 'extension Holder.Util {\n    public func extra() {}\n}',
    use: 'func use() { makeUtil().extra() }',
    alsoKept: ['Take.swift'],
  },
  {
    kind: 'key path to an environment value',
    declaration: 'extension EnvironmentValues {\n    public var theme: Int { get { 0 } set {} }\n}',
    use: 'struct V {\n    @Environment(\\.theme) var theme\n}',
  },
  {
    kind: 'static member of a type used as an implicit member',
    declaration: 'public struct Theme {\n    public static let dark = Theme()\n}',
    use: 'func use() { paint(.dark) }',
    alsoKept: ['Take.swift'],
  },
  { kind: 'enum', declaration: 'public enum Mode {}', use: 'let m: Mode? = nil' },
  { kind: 'protocol', declaration: 'public protocol Proto {}', use: 'struct S: Proto {}' },
  { kind: 'actor', declaration: 'public actor Act {}', use: 'let a: Act? = nil' },
  {
    kind: 'top-level function',
    declaration: 'public func helper() {}',
    use: 'func use() { helper() }',
  },
  {
    kind: 'top-level var',
    declaration: 'public var counter = 0',
    use: 'func use() { counter += 1 }',
  },
  {
    kind: 'extension initializer of an SDK type',
    declaration:
      'extension URL {\n    public init(path: String, base: Int) { self.init(string: path)! }\n}',
    use: 'let u = URL(path: "a", base: 1)',
  },
  {
    kind: 'enum case matched by `if case`',
    declaration: 'public enum Signal {\n    case ready\n}',
    use: 'func use() { if case .ready = current() {} }',
    alsoKept: ['Take.swift'],
  },
  {
    kind: 'enum case bound by `case let`',
    declaration: 'public enum Payload {\n    case data(Int)\n}',
    use: 'func use() {\n    switch payload() {\n    case let .data(v): _ = v\n    default: break\n    }\n}',
    alsoKept: ['Take.swift'],
  },
  {
    kind: 'enum case matched by `for case`',
    declaration: 'public enum Step {\n    case go\n}',
    use: 'func use() { for case .go in steps() {} }',
    alsoKept: ['Take.swift'],
  },
  {
    kind: 'backticked static used as `.default`',
    declaration: 'public struct Preset {\n    public static let `default` = Preset()\n}',
    use: 'func use() { setPreset(.default) }',
    alsoKept: ['Take.swift'],
  },
  {
    kind: 'extension member called through an implicit self in a subclass',
    declaration: 'extension Screen {\n    public func showAlert() {}\n}',
    use: 'final class Home: Screen {\n    func load() { showAlert() }\n}',
    alsoKept: ['Take.swift'],
  },
  {
    kind: 'protocol-extension member called in a conforming type',
    declaration: 'extension Greeter {\n    public func greet() {}\n}',
    use: 'struct Hi: Greeter {\n    func f() { greet() }\n}',
    alsoKept: ['Take.swift'],
  },
  {
    kind: 'type nested in an extension, used bare',
    declaration: 'extension Box {\n    public struct Inner { public init() {} }\n}',
    use: 'extension Box {\n    static func make() -> Inner { Inner() }\n}',
    alsoKept: ['Take.swift'],
  },
  {
    kind: '`++` operator',
    declaration:
      'prefix operator ++\nextension Int {\n    public static prefix func ++(x: inout Int) { x += 1 }\n}',
    use: 'func use() {\n    var n = 0\n    ++n\n}',
  },
  {
    kind: 'array extension subscript',
    declaration: 'extension [Int] {\n    public subscript(at i: Int) -> Int? { nil }\n}',
    use: 'func use(_ xs: [Int]) { _ = xs[at: 0] }',
  },
  {
    kind: 'labelled subscript of a protocol extension, through a value',
    declaration:
      'extension Collection {\n    public subscript(safe i: Index) -> Element? { indices.contains(i) ? self[i] : nil }\n}',
    use: 'func use() { _ = steps()[safe: 0] }',
    alsoKept: ['Take.swift'],
  },
  {
    kind: 'alias of a struct, used as `Alias.shared`',
    declaration: 'public typealias BarShared = Aliased',
    use: 'func use() { BarShared.shared.run() }',
    alsoKept: ['Aliased.swift'],
  },
  {
    kind: 'alias of a struct, used as `Alias()`',
    declaration: 'public typealias BarMake = Aliased',
    use: 'func use() {\n    let b = BarMake()\n    b.run()\n}',
    alsoKept: ['Aliased.swift'],
  },
  {
    kind: 'alias of a struct, extended',
    declaration: 'public typealias BarExt = Aliased',
    use: 'extension BarExt {\n    func refresh() { run() }\n}',
    alsoKept: ['Aliased.swift'],
  },
  {
    kind: 'alias of an enum, used as `Alias.case`',
    declaration: 'public typealias KindAlias = AliasedKind',
    use: 'func use() { _ = KindAlias.alpha }',
    alsoKept: ['AliasedKind.swift'],
  },
];

/** Support declarations the matrix importers call. */
export const SUPPORT = {
  'Take.swift': [
    'public struct Style { public init() {} }',
    'public enum Holder { public struct Util {} }',
    'public func apply(_ s: Style) {}',
    'public func take(_ s: Size) {}',
    'public func paint(_ t: Theme) {}',
    'public func makeUtil() -> Holder.Util { Holder.Util() }',
    'public func current() -> Signal { .ready }',
    'public func payload() -> Payload { .data(1) }',
    'public func steps() -> [Step] { [] }',
    'public func setPreset(_ p: Preset) {}',
    'open class Screen { public init() {} }',
    'public protocol Greeter {}',
    'public enum Box {}',
    '',
  ].join('\n'),
  'Aliased.swift': [
    'public struct Aliased {',
    '    public static let shared = Aliased()',
    '    public init() {}',
    '    public func run() {}',
    '}',
    '',
  ].join('\n'),
  'AliasedKind.swift': 'public enum AliasedKind {\n    case alpha\n}\n',
};

export function matrixFixture(
  module: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const files: Record<string, string> = {};
  for (const [name, source] of Object.entries(SUPPORT)) files[`${module}/${name}`] = source;
  MATRIX.forEach(({ declaration, use }, k) => {
    files[`${module}/K${k}.swift`] = `public struct Keep${k} {}\n\n${declaration}\n`;
    files[`App/U${k}.swift`] = `import ${module}\n\n${use}\n`;
  });
  for (const [name, source] of Object.entries(extra)) files[name] = source;
  return files;
}

/** Same-named types beside the matrix declarations. */
export const SAME_NAMED_TYPES: Record<string, string> = {
  'Kit/Dup/Util.swift': 'public struct Util {}\n',
  'Kit/Dup/Style.swift': 'struct Style {}\n',
  'Kit/Dup/Holder.swift': 'enum Holder {}\n',
};

export const LOCALS_FILES = 4;
export const LOCALS_IMPORTING = 4;

/** Every module file and importer shares the usual local and member names. */
export function localsFixture(): Record<string, string> {
  const files: Record<string, string> = {};
  for (let m = 0; m < MODULES; m++) {
    for (let f = 0; f < LOCALS_FILES; f++) {
      files[`Mod${m}/Rec${m}_${f}.swift`] = [
        `public struct Rec${m}_${f} {`,
        '    public var id: Int',
        '    public var data: String',
        '    public var value: Int',
        '    public var result: Int',
        '    public func compute(id: Int, data: String) -> Int {',
        '        let value = id + 1',
        '        var result = value',
        '        result += data.count',
        '        return result',
        '    }',
        '}',
        '',
        `func helper${m}_${f}() -> Int {`,
        '    func inner(value: Int) -> Int {',
        '        let result = value',
        '        return result',
        '    }',
        '    return inner(value: 1)',
        '}',
        '',
      ].join('\n');
    }
  }
  for (let i = 0; i < LOCALS_IMPORTING; i++) {
    files[`App/Use${i}.swift`] = [
      'import Mod0',
      'import Mod1',
      'import Mod2',
      '',
      `func use${i}(_ a: Rec0_${i}, _ b: Rec1_${i}, _ c: Rec2_${i}) -> Int {`,
      '    let id = a.id',
      '    let data = b.data',
      '    var value = c.value',
      '    var result = id + value + a.result',
      '    result += data.count',
      '    value = a.compute(id: id, data: data)',
      '    return result + value',
      '}',
      '',
    ].join('\n');
  }
  return files;
}

export const SIZE_TYPES = 40;
export const SIZE_SDK_EXTENSIONS = 50;
/** SDK extension files that also declare a common member name (`name`). */
export const SIZE_COMMON_EXTENSIONS = 5;
export const SIZE_DTO_FILES = 20;
export const SIZE_IMPORTERS = 30;

export function sizeFixture(): Record<string, string> {
  const files: Record<string, string> = {};
  for (let i = 0; i < SIZE_TYPES; i++)
    files[`Core/Type${i}.swift`] = [
      '// MARK: - Model',
      '/// A model type, as a SwiftUI module writes it.',
      `public struct Type${i} {`,
      '    // MARK: Fields',
      '    /* stored */',
      '    public var id = 0',
      '    public var name = ""',
      '    public var title = ""',
      '    public var data: [UInt8] = []',
      '    public var value = 0',
      `    public static let shared = Type${i}()`,
      `    public static let \`default\` = Type${i}()`,
      '    public enum Kind {',
      `        case none, kind${i}`,
      '    }',
      '}',
      '',
      '#Preview {',
      `    Type${i}()`,
      '}',
      '',
    ].join('\n');
  for (let n = 0; n < SIZE_SDK_EXTENSIONS; n++)
    files[`Core/${n % 2 === 0 ? 'String' : 'UIView'}+E${n}.swift`] = [
      `extension ${n % 2 === 0 ? 'String' : 'UIView'} {`,
      `    public func e${n}() -> Int { 0 }`,
      ...(n < SIZE_COMMON_EXTENSIONS ? ['    public var name: String { "" }'] : []),
      '}',
      '',
    ].join('\n');
  files['DTO/DTO.swift'] = 'public enum DTO {\n    public static let version = 1\n}\n';
  for (let d = 0; d < SIZE_DTO_FILES; d++)
    files[`DTO/Model${d}.swift`] = `public struct Model${d} {\n    public var id = 0\n}\n`;
  for (let k = 0; k < SIZE_IMPORTERS; k++) {
    const t = k % SIZE_TYPES;
    files[`App/Spelled${k}.swift`] = [
      'import Core',
      'import DTO',
      '',
      `func spelled${k}(_ t: Type${t}, _ m: Model${k % SIZE_DTO_FILES}) -> Int {`,
      '    let a = t.id + t.value + m.id',
      '    let b = t.name + t.title',
      `    let s = Type${t}.shared.data.count + Type${t}.default.id`,
      `    let e = "x".e${(2 * k) % SIZE_SDK_EXTENSIONS}()`,
      '    let n = "y".name',
      '    let v = DTO.version',
      '    return a + b.count + s + e + n.count + v',
      '}',
      '',
    ].join('\n');
    // The same importer, also writing implicit members that Optional and many
    // SDK types declare too.
    files[`App/Implicit${k}.swift`] = [
      'import Core',
      '',
      `func implicit${k}(_ t: Type${t}?, _ kind: Type${t}.Kind) -> Bool {`,
      '    _ = [Type0](repeating: .default, count: 1)',
      '    return t == .none || kind == .none',
      '}',
      '',
    ].join('\n');
  }
  return files;
}
