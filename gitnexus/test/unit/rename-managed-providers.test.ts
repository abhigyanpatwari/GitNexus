import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SupportedLanguages } from 'gitnexus-shared';
import { createRenameFixtureHelpers } from '../helpers/rename-provider-fixture.js';
import { SCOPE_RESOLVERS } from '../../src/core/ingestion/scope-resolution/pipeline/registry.js';
import { renameSymbol } from '../../src/mcp/local/rename/rename-plan.js';

const { fixture, expectRename } = createRenameFixtureHelpers();

describe('managed provider rename through the production parsing pipeline', () => {
  it('preserves C# named argument labels that share a method name', async () => {
    const content =
      'class Model { static void target() {} static void other(int target) {} static void caller() { target(); other(target: 1); } }\n';
    await expectRename(
      { 'model.cs': content },
      { 'model.cs': content.replaceAll('target()', 'renamed()') },
      'target',
      'Method',
    );
  }, 60_000);

  it('keeps independent Dart static methods out of inherited rename families', async () => {
    const content =
      'class Base { static void target() {} }\nclass Child extends Base { static void target() {} }\nvoid use() { Base.target(); Child.target(); }\n';
    await expectRename(
      { 'model.dart': content },
      { 'model.dart': content.replace('target', 'renamed').replace('Base.target', 'Base.renamed') },
      'target',
      'Method',
    );
  }, 60_000);

  it.each([
    ['Class', 'public class Writer { public Writer() {} }\n'],
    ['Constructor', 'public class Writer { public Writer() {} }\n'],
    ['Interface', 'public interface Writer {}\n'],
    ['Enum', 'public enum Writer { VALUE }\n'],
    ['Record', 'public record Writer() {}\n'],
    ['Annotation', 'public @interface Writer {}\n'],
  ])(
    'refuses a public top-level Java %s rename requiring a file move',
    async (kind, content) => {
      const { root, nodes, symbol } = await fixture({ 'Writer.java': content }, 'Writer', kind);
      for (const dry_run of [true, false]) {
        const result = await renameSymbol(root, symbol, { new_name: 'Reader', dry_run }, nodes);
        expect(result, JSON.stringify(result)).toMatchObject({
          status: 'error',
          code: 'unsupported_occurrence',
          planning_status: 'unsupported',
          application_status: 'not_started',
          applied: false,
          total_edits: 0,
        });
        expect(result.error).toContain('file move');
        expect(await fs.readFile(path.join(root, 'Writer.java'), 'utf8')).toBe(content);
        expect(await fs.readdir(root)).not.toContain('Reader.java');
      }
    },
    60_000,
  );

  it.each([
    ['Class', 'class Writer { Writer() {} }\n'],
    ['Constructor', 'class Writer { Writer() {} }\n'],
    ['Class', 'public class Outer { public static class Writer { public Writer() {} } }\n'],
    ['Constructor', 'public class Outer { public static class Writer { public Writer() {} } }\n'],
    ['Annotation', '@interface Writer {}\n'],
    ['Annotation', 'public class Outer { public @interface Writer {} }\n'],
  ])(
    'renames a package-private or nested Java %s without requiring a file move (case %#)',
    async (kind, content) => {
      await expectRename(
        { 'Outer.java': content },
        { 'Outer.java': content.replaceAll('Writer', 'Reader') },
        'Writer',
        kind,
        'Reader',
      );
    },
    60_000,
  );

  it('allows a Java public type rename that matches the existing file name', async () => {
    await expectRename(
      { 'Reader.java': 'public class Writer { public Writer() {} }\n' },
      { 'Reader.java': 'public class Reader { public Reader() {} }\n' },
      'Writer',
      'Class',
      'Reader',
    );
  }, 60_000);

  it.each([
    [
      'Constructor',
      'class Outer { static class Writer { Writer() {} } }\nclass Other { static class Writer { Writer() {} } }\n',
    ],
    ['Annotation', 'class Outer { @interface Writer {} }\nclass Other { @interface Writer {} }\n'],
  ])(
    'refuses collapsed same-name nested Java %s graph identities',
    async (kind, content) => {
      const { root, nodes, symbol } = await fixture({ 'Outer.java': content }, 'Writer', kind);
      for (const dry_run of [true, false]) {
        const result = await renameSymbol(root, symbol, { new_name: 'Reader', dry_run }, nodes);
        expect(result, JSON.stringify(result)).toMatchObject({
          status: 'error',
          code: 'stale_graph',
          planning_status: 'blocked',
          application_status: 'not_started',
          applied: false,
          total_edits: 0,
        });
        expect(await fs.readFile(path.join(root, 'Outer.java'), 'utf8')).toBe(content);
      }
    },
    60_000,
  );

  it('renames a C# class and its destructor without changing another class', async () => {
    const content =
      'class Writer { public Writer() {} ~Writer() {} }\nclass Other { ~Other() {} Writer Create() { return new Writer(); } }\n';
    await expectRename(
      { 'model.cs': content },
      { 'model.cs': content.replaceAll('Writer', 'Renamed') },
      'Writer',
      'Class',
      'Renamed',
    );
  }, 60_000);
  it.each([
    [
      'model.java',
      'class Model { static int target() { return 1; } static int caller() { return target(); } }\n// target\n',
      'Method',
    ],
    [
      'model.kt',
      'fun target() {}\nfun caller() { val value = ::target; target() }\n// target\n',
      'Function',
    ],
    [
      'model.cs',
      'class Model { static void target() {} static void caller() { System.Action value = target; target(); } }\n// target\n',
      'Method',
    ],
    [
      'model.swift',
      'func target() {}\nfunc caller() { let value = target; target() }\n// target\n',
      'Function',
    ],
    [
      'model.dart',
      'void target() {}\nvoid caller() { var value = target; target(); }\n// target\n',
      'Function',
    ],
  ])(
    'previews and applies calls and bare values in %s',
    async (file, content, kind) => {
      await expectRename(
        { [file]: content },
        { [file]: content.replaceAll('target', 'renamed').replace('// renamed', '// target') },
        'target',
        kind,
      );
    },
    60000,
  );

  it.each([
    [
      'model.java',
      'class Model { static int target() { return 1; } int caller(int target) { return target; } int use() { return target(); } }\n',
      'Method',
    ],
    [
      'model.kt',
      'fun target() {}\nfun caller(target: Int): Int { return target }\nfun use() { target() }\n',
      'Function',
    ],
    [
      'model.cs',
      'class Model { static int target() { return 1; } int caller(int target) { return target; } int use() { return target(); } }\n',
      'Method',
    ],
    [
      'model.swift',
      'func target() {}\nfunc caller(target: Int) -> Int { return target }\nfunc use() { target() }\n',
      'Function',
    ],
    [
      'model.dart',
      'int target() { return 1; }\nint caller(int target) { return target; }\nint use() { return target(); }\n',
      'Function',
    ],
  ])(
    'preserves shadow parameters in %s',
    async (file, content, kind) => {
      await expectRename(
        { [file]: content },
        { [file]: content.replaceAll('target()', 'renamed()') },
        'target',
        kind,
      );
    },
    60000,
  );

  it.each([
    [
      'model.java',
      'class Target { Target() {} }\nclass User { Target value; Target make() { return new Target(); } }\n',
    ],
    ['model.kt', 'class Target\nfun use(value: Target): Target { return Target() }\n'],
    [
      'model.cs',
      'class Target { Target() {} }\nclass User { Target value; Target make() { return new Target(); } }\n',
    ],
    ['model.swift', 'class Target {}\nfunc use(value: Target) -> Target { return Target() }\n'],
    ['model.dart', 'class Target { Target(); }\nTarget use(Target value) { return Target(); }\n'],
  ])(
    'renames type uses and named constructors in %s',
    async (file, content) => {
      await expectRename(
        { [file]: content },
        { [file]: content.replaceAll('Target', 'Renamed') },
        'Target',
        'Class',
        'Renamed',
      );
    },
    60000,
  );

  it.each([
    [
      'model.java',
      'class Model { void target() {} void caller(Model value) { value.target(); } }\nclass Other { void target() {} void caller(Other value) { value.target(); } }\n',
      'Method',
    ],
    [
      'model.kt',
      'class Model {\nfun target() {}\nfun caller(value: Model) { value.target() }\n}\nclass Other {\nfun target() {}\n}\n',
      'Method',
    ],
    [
      'model.cs',
      'class Model { void target() {} void caller(Model value) { value.target(); } }\nclass Other { void target() {} void caller(Other value) { value.target(); } }\n',
      'Method',
    ],
    [
      'model.swift',
      'class Model { func target() {}\nfunc caller(value: Model) { value.target() } }\nclass Other { func target() {} }\n',
      'Function',
    ],
    [
      'model.dart',
      'class Model { void target() {} void caller(Model value) { value.target(); } }\nclass Other { void target() {} }\n',
      'Method',
    ],
  ])(
    'preserves unrelated owners in %s',
    async (file, content, kind) => {
      const boundary = content.indexOf('class Other');
      await expectRename(
        { [file]: content },
        {
          [file]:
            content.slice(0, boundary).replaceAll('target', 'renamed') + content.slice(boundary),
        },
        'target',
        kind,
      );
    },
    60000,
  );

  it.each([
    [
      SupportedLanguages.Kotlin,
      'model.kt',
      'fun `target`() {}\nfun caller() { target() }',
      '`target`',
    ],
    [
      SupportedLanguages.CSharp,
      'model.cs',
      'class Model { void @target() {} void caller() { target(); } }',
      '@target',
    ],
    [
      SupportedLanguages.Swift,
      'model.swift',
      'func `target`() {}\nfunc caller() { target() }',
      '`target`',
    ],
  ])(
    'inventories canonical escaped identifiers in %s',
    async (language, filePath, content, spelling) => {
      const resolver = SCOPE_RESOLVERS.get(language)!;
      const source = await resolver.languageProvider.rename!.parseSource({
        filePath,
        content,
        languageProvider: resolver.languageProvider,
        scopeResolver: resolver,
      });
      const occurrence = source.occurrences.find((entry) => entry.node?.text === spelling)!;
      expect(occurrence.name).toBe('target');
      expect(occurrence.spans).toEqual([
        { start: content.indexOf(spelling), length: spelling.length },
      ]);
    },
  );

  it.each([
    [
      'model.kt',
      'package demo\nfun target() {}\n',
      'caller.kt',
      'package app\nimport demo.target as local\nfun use() { local() }\n',
      'Function',
    ],
    [
      'model.cs',
      'namespace Demo { public class Target {} }\n',
      'caller.cs',
      'using Local = Demo.Target;\nclass User { Local value; }\n',
      'Class',
    ],
    [
      'model.dart',
      'void target() {}\n',
      'caller.dart',
      "import 'model.dart' as lib;\nvoid use() { lib.target(); }\n",
      'Function',
    ],
  ])(
    'renames imported identity while preserving aliases in %s',
    async (file, content, callerFile, caller, kind) => {
      const name = kind === 'Class' ? 'Target' : 'target';
      await expectRename(
        { [file]: content, [callerFile]: caller },
        {
          [file]: content.replaceAll(name, 'renamed'),
          [callerFile]: caller.replaceAll(name, 'renamed'),
        },
        name,
        kind,
        'renamed',
        file,
      );
    },
    60000,
  );

  it.each([
    [
      'model.kt',
      'fun `target`() {}\nfun caller() { target() }\n',
      '`target`',
      'Function',
      'fun `renamed`() {}\nfun caller() { renamed() }\n',
    ],
    [
      'model.cs',
      'class Model { void @target() {} void caller() { target(); } }\n',
      '@target',
      'Method',
      'class Model { void @renamed() {} void caller() { renamed(); } }\n',
    ],
    [
      'model.swift',
      'func `target`() {}\nfunc caller() { target() }\n',
      '`target`',
      'Function',
      'func `renamed`() {}\nfunc caller() { renamed() }\n',
    ],
  ])(
    'renames escaped declarations and ordinary references in %s',
    async (file, content, name, kind, expected) => {
      await expectRename({ [file]: content }, { [file]: expected }, name, kind);
    },
    60000,
  );

  it.each([
    [
      'model.java',
      'interface Base { void target(); }\nclass Child implements Base { public void target() {} }\n',
      'Method',
    ],
    [
      'model.kt',
      'interface Base {\nfun target()\n}\nclass Child: Base {\noverride fun target() {}\n}\n',
      'Method',
    ],
    [
      'model.cs',
      'interface Base { void target(); }\nclass Child : Base { public void target() {} }\n',
      'Method',
    ],
    [
      'model.swift',
      'protocol Base { func target() }\nclass Child: Base { func target() {} }\n',
      'Function',
    ],
    [
      'model.dart',
      'abstract class Base { void target(); }\nclass Child implements Base { void target() {} }\n',
      'Method',
    ],
  ])(
    'renames proven interface declaration families in %s',
    async (file, content, kind) => {
      await expectRename(
        { [file]: content },
        { [file]: content.replaceAll('target', 'renamed') },
        'target',
        kind,
      );
    },
    60000,
  );

  it.each([
    [
      'model.java',
      'class Model { void target() {} void renamed() {} void use() { target(); } }\n',
      'Method',
    ],
    ['model.kt', 'fun target() {}\nfun renamed() {}\nfun use() { target() }\n', 'Function'],
    [
      'model.cs',
      'class Model { void target() {} void renamed() {} void use() { target(); } }\n',
      'Method',
    ],
    ['model.swift', 'func target() {}\nfunc renamed() {}\nfunc use() { target() }\n', 'Function'],
    ['model.dart', 'void target() {}\nvoid renamed() {}\nvoid use() { target(); }\n', 'Function'],
  ])(
    'refuses scope collisions without writing %s',
    async (file, content, kind) => {
      const { root, nodes, symbol } = await fixture({ [file]: content }, 'target', kind);
      const result = await renameSymbol(
        root,
        symbol,
        { new_name: 'renamed', dry_run: false },
        nodes,
      );
      expect(result).toMatchObject({ status: 'error', code: 'name_collision', applied: false });
      expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(content);
    },
    60000,
  );

  it('retains Swift conditional directives and original source offsets', async () => {
    const content =
      'class Model {\n#if DEBUG // 日本語 😀\nfunc target() {}\n#endif\nfunc use() { target() }\n}\n';
    await expectRename(
      { 'model.swift': content },
      { 'model.swift': content.replaceAll('target', 'renamed') },
      'target',
      'Function',
    );
  }, 60000);

  it('fails closed when the Java grammar cannot inventory Unicode escape syntax', async () => {
    const resolver = SCOPE_RESOLVERS.get(SupportedLanguages.Java)!;
    await expect(
      resolver.languageProvider.rename!.parseSource({
        filePath: 'model.java',
        content: 'class Model { void t\\u0061rget() {} }',
        languageProvider: resolver.languageProvider,
        scopeResolver: resolver,
      }),
    ).rejects.toMatchObject({ code: 'parse_error' });
  });

  it.each([
    [
      'model.java',
      'class Model { void target() {} void target(int value) {} void use() { target(); target(1); } }\n',
      'Method',
    ],
    [
      'model.kt',
      'fun target() {}\nfun target(value: Int) {}\nfun use() { target(); target(1) }\n',
      'Function',
    ],
    [
      'model.cs',
      'class Model { void target() {} void target(int value) {} void use() { target(); target(1); } }\n',
      'Method',
    ],
    [
      'model.swift',
      'func target() {}\nfunc target(value: Int) {}\nfunc use() { target(); target(value: 1) }\n',
      'Function',
    ],
  ])(
    'renames overload declaration groups and calls in %s',
    async (file, content, kind) => {
      await expectRename(
        { [file]: content },
        { [file]: content.replaceAll('target', 'renamed') },
        'target',
        kind,
      );
    },
    60000,
  );

  it.each([
    [SupportedLanguages.Java, 'class'],
    [SupportedLanguages.Kotlin, 'fun'],
    [SupportedLanguages.CSharp, 'class'],
    [SupportedLanguages.Swift, 'func'],
    [SupportedLanguages.Dart, 'class'],
  ])('rejects reserved replacement names in %s', (language, name) => {
    const provider = SCOPE_RESOLVERS.get(language)!.languageProvider.rename;
    expect(provider).toBeDefined();
    expect(provider!.validateName!(name)).toMatchObject({ code: 'invalid_name' });
  });
});
