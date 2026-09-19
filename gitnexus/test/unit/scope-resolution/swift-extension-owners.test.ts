/**
 * `populateWorkspaceOwners` for Swift must stamp extension members onto a
 * unique owner in the same SPM target, skip nested locals, and fail closed
 * when `Bar` and `Foo.Bar` both exist.
 */
import { describe, it, expect } from 'vitest';
import { extractParsedFile } from '../../../src/core/ingestion/scope-extractor-bridge.js';
import { swiftScopeResolver } from '../../../src/core/ingestion/languages/swift/scope-resolver.js';
import { isLanguageAvailable } from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';

const swiftAvailable = isLanguageAvailable(SupportedLanguages.Swift);

function parseSwift(source: string, filePath: string) {
  const parsed = extractParsedFile(swiftScopeResolver.languageProvider, source, filePath, () => {});
  if (parsed === undefined) throw new Error('scope extraction failed');
  swiftScopeResolver.populateOwners(parsed);
  return parsed;
}

function stamp(
  files: Parameters<NonNullable<typeof swiftScopeResolver.populateWorkspaceOwners>>[0],
  resolutionConfig?: unknown,
) {
  swiftScopeResolver.populateWorkspaceOwners?.(files, {
    fileContents: new Map(),
    resolutionConfig,
  });
}

describe.skipIf(!swiftAvailable)('populateSwiftExtensionOwners', () => {
  it('stamps protocol-extension methods onto the unique protocol', () => {
    const parsed = parseSwift(
      `
protocol ScenarioSupport {}
struct Store {}
extension ScenarioSupport {
    func makeStore() -> Store { Store() }
}
`,
      'Support.swift',
    );
    const protocol = parsed.localDefs.find((d) => d.qualifiedName === 'ScenarioSupport');
    const method = parsed.localDefs.find(
      (d) => d.qualifiedName?.split('.').at(-1) === 'makeStore' && d.type === 'Method',
    );
    expect(protocol).toBeDefined();
    expect(method?.ownerId).toBeUndefined();
    stamp([parsed]);
    expect(method?.ownerId).toBe(protocol?.nodeId);
  });

  it('does not stamp a nested local onto the enclosing type', () => {
    const parsed = parseSwift(
      `
class Host {
    func helper(_ a: Int) -> Int { a }
    func run(_ x: Int) -> Int {
        func helper(_ v: Int, _ w: Int) -> Int { v + w }
        return helper(x, x)
    }
}
`,
      'Host.swift',
    );
    stamp([parsed]);
    const twoArg = parsed.localDefs.filter(
      (d) => d.type === 'Method' && d.qualifiedName?.endsWith('helper') && d.parameterCount === 2,
    );
    expect(twoArg).toHaveLength(1);
    expect(twoArg[0]?.ownerId).toBeUndefined();
  });

  it('stamps extension Foo.Bar members onto Foo.Bar when no top-level Bar exists', () => {
    const parsed = parseSwift(
      `
enum Foo {
    struct Bar {}
}
extension Foo.Bar {
    func added() {}
}
`,
      'Nested.swift',
    );
    stamp([parsed]);
    const added = parsed.localDefs.find((d) => d.qualifiedName?.split('.').at(-1) === 'added');
    const bar = parsed.localDefs.find(
      (d) => d.qualifiedName === 'Foo.Bar' || d.qualifiedName === 'Bar',
    );
    expect(added?.ownerId).toBeDefined();
    expect(added?.ownerId).toBe(bar?.nodeId);
  });

  it('fails closed when top-level Bar and nested Foo.Bar both exist', () => {
    const parsed = parseSwift(
      `
struct Bar {}
enum Foo {
    struct Bar {}
}
extension Foo.Bar {
    func added() {}
}
`,
      'Collide.swift',
    );
    stamp([parsed]);
    const added = parsed.localDefs.find((d) => d.qualifiedName?.split('.').at(-1) === 'added');
    expect(added).toBeDefined();
    expect(added?.ownerId).toBeUndefined();
  });

  it('stamps extension members when the extension also declares a nested type', () => {
    const parsed = parseSwift(
      `
struct Foo {}
extension Foo {
    struct Helper {}
    func added() {}
}
`,
      'NestedInExt.swift',
    );
    stamp([parsed]);
    const added = parsed.localDefs.find((d) => d.qualifiedName?.split('.').at(-1) === 'added');
    const foo = parsed.localDefs.find(
      (d) => d.qualifiedName === 'Foo' && (d.type === 'Struct' || d.type === 'Class'),
    );
    expect(added).toBeDefined();
    expect(foo).toBeDefined();
    expect(added?.ownerId).toBe(foo?.nodeId);
  });

  it('does not let one target’s Foo own another target’s extension', () => {
    const app = parseSwift(
      `
protocol Foo {}
extension Foo {
    func added() {}
}
`,
      'Sources/App/A.swift',
    );
    const lib = parseSwift(
      `
protocol Foo {}
`,
      'Sources/Lib/B.swift',
    );
    stamp([app, lib], {
      targets: new Map([
        ['App', 'Sources/App'],
        ['Lib', 'Sources/Lib'],
      ]),
    });
    const added = app.localDefs.find((d) => d.qualifiedName?.split('.').at(-1) === 'added');
    const appFoo = app.localDefs.find((d) => d.qualifiedName === 'Foo');
    expect(added).toBeDefined();
    expect(appFoo).toBeDefined();
    expect(added?.ownerId).toBe(appFoo?.nodeId);
    const libFoo = lib.localDefs.find((d) => d.qualifiedName === 'Foo');
    expect(added?.ownerId).not.toBe(libFoo?.nodeId);
  });

  it('stamps a one-line extension whose synthetic class shares the Class start line', () => {
    const parsed = parseSwift(
      `
struct Foo {}
extension Foo { func added() {} }
`,
      'OneLine.swift',
    );
    const added = parsed.localDefs.find((d) => d.qualifiedName?.split('.').at(-1) === 'added');
    const foo = parsed.localDefs.find(
      (d) => d.qualifiedName === 'Foo' && (d.type === 'Struct' || d.type === 'Class'),
    );
    expect(added).toBeDefined();
    expect(foo).toBeDefined();
    expect(added?.ownerId).toBeUndefined();
    stamp([parsed]);
    expect(added?.ownerId).toBe(foo?.nodeId);
  });

  it('stamps a cross-file extension onto the real type, not the synthetic class', () => {
    const typeFile = parseSwift('struct Foo {}', 'Foo.swift');
    const extFile = parseSwift('extension Foo { func added() {} }', 'Foo+Added.swift');
    const added = extFile.localDefs.find((d) => d.qualifiedName?.split('.').at(-1) === 'added');
    const foo = typeFile.localDefs.find(
      (d) => d.qualifiedName === 'Foo' && (d.type === 'Struct' || d.type === 'Class'),
    );
    expect(added).toBeDefined();
    expect(foo).toBeDefined();
    expect(added?.ownerId).toBeUndefined();
    stamp([typeFile, extFile]);
    expect(added?.ownerId).toBe(foo?.nodeId);
  });
});
