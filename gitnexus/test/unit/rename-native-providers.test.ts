import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SupportedLanguages } from 'gitnexus-shared';
import { createRenameFixtureHelpers } from '../helpers/rename-provider-fixture.js';
import { SCOPE_RESOLVERS } from '../../src/core/ingestion/scope-resolution/pipeline/registry.js';
import { renameSymbol } from '../../src/mcp/local/rename/rename-plan.js';

const { fixture, expectRename } = createRenameFixtureHelpers();

describe('native provider rename through the production parsing pipeline', () => {
  it('refuses a reserved C++ identifier in the global namespace before preview or apply', async () => {
    const content = 'int target() { return 1; }\nint caller() { return target(); }\n';
    const { root, nodes, symbol } = await fixture({ 'model.cpp': content });
    for (const dry_run of [true, false]) {
      const result = await renameSymbol(root, symbol, { new_name: '_value', dry_run }, nodes);
      expect(result).toMatchObject({
        status: 'error',
        code: 'invalid_name',
        applied: false,
        total_edits: 0,
      });
      expect(await fs.readFile(path.join(root, 'model.cpp'), 'utf8')).toBe(content);
    }
  }, 60000);

  it('allows a leading underscore for a C++ class member', async () => {
    await expectRename(
      {
        'model.cpp':
          'struct Model {\nint target() { return 1; }\n};\nint caller(Model &model) { return model.target(); }\n',
      },
      {
        'model.cpp':
          'struct Model {\nint _value() { return 1; }\n};\nint caller(Model &model) { return model._value(); }\n',
      },
      'target',
      'Method',
      '_value',
    );
  }, 60000);

  it('refuses a leading underscore for a C++ type declared in the global namespace', async () => {
    const content = 'struct Target {};\nvoid caller(Target value) {}\n';
    const { root, nodes, symbol } = await fixture({ 'model.cpp': content }, 'Target', 'Struct');
    for (const dry_run of [true, false]) {
      const result = await renameSymbol(root, symbol, { new_name: '_value', dry_run }, nodes);
      expect(result).toMatchObject({
        status: 'error',
        code: 'invalid_name',
        applied: false,
        total_edits: 0,
      });
      expect(await fs.readFile(path.join(root, 'model.cpp'), 'utf8')).toBe(content);
    }
  }, 60000);

  it('refuses a reserved C++ type name when its constructor is selected', async () => {
    const content = 'struct Target {\n Target() {}\n};\nTarget caller() { return Target(); }\n';
    const { root, nodes, symbol } = await fixture({ 'model.cpp': content }, 'Target', 'Method');
    for (const dry_run of [true, false]) {
      const result = await renameSymbol(root, symbol, { new_name: '_value', dry_run }, nodes);
      expect(result).toMatchObject({
        status: 'error',
        code: 'invalid_name',
        applied: false,
        total_edits: 0,
      });
      expect(await fs.readFile(path.join(root, 'model.cpp'), 'utf8')).toBe(content);
    }
  }, 60000);

  it.each(['await', 'yield'])(
    'refuses Dart contextual identifier %s inside an async body',
    async (new_name) => {
      const content = 'int target() => 1;\nFuture<int> caller() async { return target(); }\n';
      const { root, nodes, symbol } = await fixture({ 'model.dart': content });
      for (const dry_run of [true, false]) {
        const result = await renameSymbol(root, symbol, { new_name, dry_run }, nodes);
        expect(result).toMatchObject({
          status: 'error',
          code: 'invalid_name',
          applied: false,
          total_edits: 0,
        });
        expect(await fs.readFile(path.join(root, 'model.dart'), 'utf8')).toBe(content);
      }
    },
    60000,
  );

  it.each(['yield'])(
    'allows Dart contextual identifier %s in a synchronous body',
    async (newName) => {
      await expectRename(
        { 'model.dart': 'int target() => 1;\nint caller() { return target(); }\n' },
        { 'model.dart': `int ${newName}() => 1;\nint caller() { return ${newName}(); }\n` },
        'target',
        'Function',
        newName,
      );
    },
    60000,
  );

  it.each(['local', 'target'])(
    'records Rust alias identity even with equal spelling: %s',
    async (alias) => {
      const resolver = SCOPE_RESOLVERS.get(SupportedLanguages.Rust)!;
      const source = await resolver.languageProvider.rename!.parseSource({
        filePath: 'model.rs',
        content: `use source::target as ${alias};`,
        languageProvider: resolver.languageProvider,
        scopeResolver: resolver,
      });
      expect(source.parsed.parsedImports).toMatchObject([
        { kind: 'alias', alias, localName: alias, importedName: 'target' },
      ]);
    },
  );

  it.each([
    [
      'model.c',
      'int target(void) { return 1; }\nint caller(void) { int (*value)(void) = target; return target(); }\n// target\n',
    ],
    [
      'model.cpp',
      'int target() { return 1; }\nint caller() { auto value = target; return target(); }\n// target\n',
    ],
    ['model.rs', 'fn target() {}\nfn caller() { let value = target; target(); }\n// target\n'],
    [
      'model.go',
      'package model\nfunc target() {}\nfunc caller() { value := target; value(); target() }\n// target\n',
    ],
    [
      'model.zig',
      'fn target() void {}\nfn caller() void { const value = target; value(); target(); }\n// target\n',
    ],
  ])(
    'previews and applies function calls and bare values in %s',
    async (file, content) => {
      await expectRename(
        { [file]: content },
        { [file]: content.replaceAll('target', 'renamed').replace('// renamed', '// target') },
      );
    },
    60000,
  );

  it.each([
    [SupportedLanguages.C, 'int'],
    [SupportedLanguages.C, 'restrict'],
    [SupportedLanguages.CPlusPlus, 'class'],
    [SupportedLanguages.CPlusPlus, 'co_await'],
    [SupportedLanguages.CPlusPlus, '_Atomic'],
    [SupportedLanguages.CPlusPlus, 'internal__name'],
    [SupportedLanguages.Rust, 'fn'],
    [SupportedLanguages.Go, 'func'],
    [SupportedLanguages.Zig, 'comptime'],
  ])('rejects reserved replacement names in %s: %s', (language, name) => {
    const provider = SCOPE_RESOLVERS.get(language)!.languageProvider.rename;
    expect(provider).toBeDefined();
    expect(provider!.validateName!(name)).toMatchObject({ code: 'invalid_name' });
  });

  it('accepts restrict as a C++ type identifier', async () => {
    await expectRename(
      { 'model.cpp': 'struct Target {};\nvoid caller(struct Target value) {}\n' },
      { 'model.cpp': 'struct restrict {};\nvoid caller(struct restrict value) {}\n' },
      'Target',
      'Struct',
      'restrict',
    );
  }, 60000);

  it('preserves Go type-parameter bindings when renaming an outer type', async () => {
    await expectRename(
      {
        'model.go':
          'package model\ntype Target struct {}\ntype Container[Target any] struct { Item Target }\nfunc identity[Target any](value Target) Target { return value }\nfunc concrete(value Target) Target { return value }\n',
      },
      {
        'model.go':
          'package model\ntype Renamed struct {}\ntype Container[Target any] struct { Item Target }\nfunc identity[Target any](value Target) Target { return value }\nfunc concrete(value Renamed) Renamed { return value }\n',
      },
      'Target',
      'Struct',
      'Renamed',
    );
  }, 60000);

  it('blocks a Go type rename captured by a generic type parameter', async () => {
    const content =
      'package model\ntype Target struct {}\nfunc identity[Element any](value Target, item Element) Target { return value }\n';
    const { root, nodes, symbol } = await fixture({ 'model.go': content }, 'Target', 'Struct');
    for (const dry_run of [true, false]) {
      expect(
        await renameSymbol(root, symbol, { new_name: 'Element', dry_run }, nodes),
      ).toMatchObject({
        status: 'error',
        code: 'name_collision',
        planning_status: 'blocked',
        applied: false,
        total_edits: 0,
      });
      expect(await fs.readFile(path.join(root, 'model.go'), 'utf8')).toBe(content);
    }
  }, 60000);

  it.each([
    [
      'model.c',
      'struct Target { int value; };\nint call(struct Target* p) { return p->value; }\n',
      'Struct',
    ],
    ['model.cpp', 'class Target {};\nvoid call(Target& p) {}\n', 'Class'],
    ['model.rs', 'struct Target {}\nfn call(p: Target) {}\n', 'Struct'],
    ['model.go', 'package p\ntype Target struct {}\nfunc call(p Target) {}\n', 'Struct'],
    ['model.zig', 'const Target = struct { value: u8 };\nfn call(p: Target) void {}\n', 'Struct'],
  ])(
    'renames type annotations in %s',
    async (file, content, kind) => {
      await expectRename(
        { [file]: content },
        { [file]: content.replaceAll('Target', 'Renamed') },
        'Target',
        kind,
        'Renamed',
      );
    },
    60000,
  );

  it.each([
    [
      'model.c',
      'struct Target { int target; };\nint call(struct Target* p) { return p->target; }\n',
      'Property',
    ],
    [
      'model.cpp',
      'class Target { public: int target() { return 1; } };\nint call(Target& p) { return p.target(); }\n',
      'Method',
    ],
    [
      'model.rs',
      'struct Target {}\nimpl Target { fn target(&self) {} }\nfn call(p: Target) { p.target(); }\n',
      'Function',
    ],
    [
      'model.go',
      'package p\ntype Target struct {}\nfunc (p Target) target() {}\nfunc call(p Target) { p.target() }\n',
      'Method',
    ],
    [
      'model.zig',
      'const Target = struct { pub fn target(self: Target) void {} };\nfn call(p: Target) void { p.target(); }\n',
      'Method',
    ],
  ])(
    'renames members on proven receivers in %s',
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

  it.each(['local', 'target'])(
    'keeps Rust imported aliases stable: %s',
    async (alias) => {
      const files = {
        'lib.rs': `mod source;\nuse source::target as ${alias};\nfn call() { ${alias}(); }\n`,
        'source.rs': 'pub fn target() {}\n',
      };
      await expectRename(
        files,
        {
          ...files,
          'source.rs': 'pub fn renamed() {}\n',
          'lib.rs': files['lib.rs'].replace('source::target', 'source::renamed'),
        },
        'target',
        'Function',
        'renamed',
        'source.rs',
      );
    },
    60000,
  );

  it('keeps Zig imported aliases stable', async () => {
    const files = {
      'model.zig': 'const local = @import("source.zig").target;\nfn call() void { local(); }\n',
      'source.zig': 'pub fn target() void {}\n',
    };
    await expectRename(
      files,
      {
        ...files,
        'source.zig': 'pub fn renamed() void {}\n',
        'model.zig': files['model.zig'].replace('.target', '.renamed'),
      },
      'target',
      'Function',
      'renamed',
      'source.zig',
    );
  }, 60000);

  it.each([
    ['model.rs', 'fn r#target() {}\nfn call() { r#target(); target(); }\n'],
    ['model.zig', 'fn @"target"() void {}\nfn call() void { @"target"(); target(); }\n'],
  ])(
    'treats escaped and plain spellings as one identity in %s',
    async (file, content) => {
      await expectRename(
        { [file]: content },
        {
          [file]: content
            .replaceAll('r#target', 'renamed')
            .replaceAll('@"target"', 'renamed')
            .replaceAll('target', 'renamed'),
        },
        file.endsWith('.rs') ? 'r#target' : '@"target"',
      );
    },
    60000,
  );

  it.each([
    [
      'model.go',
      'package p\ntype Work interface { target() }\ntype Worker struct {}\nfunc (p Worker) target() {}\nfunc call(p Work, q Worker) { p.target(); q.target() }\n',
      'Method',
    ],
    [
      'model.rs',
      'trait Work { fn target(&self); }\nstruct Worker {}\nimpl Work for Worker { fn target(&self) {} }\nfn call(p: &dyn Work, q: Worker) { p.target(); q.target(); }\n',
      'Function',
    ],
  ])(
    'renames proven interface method families in %s',
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

  it('renames C prototypes and their definition across a header', async () => {
    const files = {
      'model.h': 'int target(void);\n',
      'model.c':
        '#include "model.h"\nint target(void) { return 1; }\nint call(void) { return target(); }\n',
    };
    await expectRename(
      files,
      Object.fromEntries(
        Object.entries(files).map(([file, content]) => [
          file,
          content.replaceAll('target', 'renamed'),
        ]),
      ),
      'target',
      'Function',
      'renamed',
      'model.c',
    );
  }, 60000);

  it('renames C++ classes together with constructors and destructors', async () => {
    const content =
      'class Target {\npublic:\n Target() {}\n ~Target() {}\n};\nvoid call() { Target value; }\n';
    await expectRename(
      { 'model.cpp': content },
      { 'model.cpp': content.replaceAll('Target', 'Renamed') },
      'Target',
      'Class',
      'Renamed',
    );
  }, 60000);

  it('renames C++ class families with out-of-line constructors and destructors', async () => {
    const files = {
      'model.h': 'class Target { public: Target(); ~Target(); };\n',
      'model.cpp': '#include "model.h"\nTarget::Target() {}\nTarget::~Target() {}\n',
    };
    await expectRename(
      files,
      Object.fromEntries(
        Object.entries(files).map(([file, content]) => [
          file,
          content.replaceAll('Target', 'Renamed'),
        ]),
      ),
      'Target',
      'Class',
      'Renamed',
      'model.h',
    );
  }, 60000);

  it('renames a selected C++ overload without changing other signatures', async () => {
    const content =
      'int target(int value) { return value; }\ndouble target(double value) { return value; }\nint call() { return target(1); }\ndouble other() { return target(1.5); }\n';
    await expectRename(
      { 'model.cpp': content },
      {
        'model.cpp': content
          .replace('int target(', 'int renamed(')
          .replace('target(1)', 'renamed(1)'),
      },
    );
  }, 60000);

  it('keeps same-named methods on unrelated C++ owners unchanged', async () => {
    const content =
      'struct A { int target() { return 1; } };\nstruct B { int target() { return 2; } };\nint call(A& a, B& b) { return a.target() + b.target(); }\n';
    await expectRename(
      { 'model.cpp': content },
      {
        'model.cpp': content
          .replace('int target()', 'int renamed()')
          .replace('a.target()', 'a.renamed()'),
      },
      'target',
      'Method',
    );
  }, 60000);

  it('renames C++ header declarations and their out-of-line definitions', async () => {
    const files = {
      'model.h': 'struct Target { int target(); };\n',
      'model.cpp':
        '#include "model.h"\nint Target::target() { return 1; }\nint call(Target& p) { return p.target(); }\n',
    };
    await expectRename(
      files,
      Object.fromEntries(
        Object.entries(files).map(([file, content]) => [
          file,
          content.replaceAll('target', 'renamed'),
        ]),
      ),
      'target',
      'Method',
      'renamed',
      'model.h',
    );
  }, 60000);

  it.each([
    [
      'model.c',
      'int target(void) { return 1; }\nint other(int target) { return target; }\nint call(void) { return target(); }\n',
    ],
    [
      'model.cpp',
      'int target() { return 1; }\nint other(int target) { return target; }\nint call() { return target(); }\n',
    ],
    [
      'model.rs',
      'fn target() {}\nfn other(target: i32) { let value = target; }\nfn call() { target(); }\n',
    ],
    [
      'model.go',
      'package p\nfunc target() {}\nfunc other(target int) int { return target }\nfunc call() { target() }\n',
    ],
    [
      'model.zig',
      'fn target() void {}\nfn other(target: u8) u8 { return target; }\nfn call() void { target(); }\n',
    ],
  ])(
    'preserves shadowing parameters in %s',
    async (file, content) => {
      await expectRename(
        { [file]: content },
        {
          [file]: content
            .replace('target(', 'renamed(')
            .replace('return target();', 'return renamed();')
            .replace('{ target(); }', '{ renamed(); }')
            .replace('{ target() }', '{ renamed() }'),
        },
      );
    },
    60000,
  );

  it.each([
    [
      'model.c',
      'int target(void) { return 1; }\nint call(void) { int renamed = 0; return target(); }\n',
    ],
    ['model.cpp', 'int target() { return 1; }\nint call() { int renamed = 0; return target(); }\n'],
    ['model.rs', 'fn target() {}\nfn call() { let renamed = 1; target(); }\n'],
    ['model.go', 'package p\nfunc target() {}\nfunc call() { renamed := 1; target() }\n'],
    ['model.zig', 'fn target() void {}\nfn call() void { const renamed = 1; target(); }\n'],
  ])(
    'blocks a capture at an edited use in %s',
    async (file, content) => {
      const { root, nodes, symbol } = await fixture({ [file]: content });
      for (const dry_run of [true, false]) {
        const result = await renameSymbol(root, symbol, { new_name: 'renamed', dry_run }, nodes);
        expect(result, JSON.stringify(result)).toMatchObject({
          status: 'error',
          code: 'name_collision',
          planning_status: 'blocked',
          application_status: 'not_started',
          applied: false,
          total_edits: 0,
        });
        expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(content);
      }
    },
    60000,
  );

  it('allows a C call before a later local declaration of the proposed name', async () => {
    await expectRename(
      {
        'model.c':
          'int target(void) { return 1; }\nint caller(void) { int result = target(); int renamed = 0; return result + renamed; }\n',
      },
      {
        'model.c':
          'int renamed(void) { return 1; }\nint caller(void) { int result = renamed(); int renamed = 0; return result + renamed; }\n',
      },
    );
  }, 60000);

  it('rejects a C capture inside the local declaration initializer', async () => {
    const content =
      'int target(void) { return 1; }\nint caller(void) { int renamed = target(); return renamed; }\n';
    const { root, nodes, symbol } = await fixture({ 'model.c': content });
    for (const dry_run of [true, false]) {
      expect(
        await renameSymbol(root, symbol, { new_name: 'renamed', dry_run }, nodes),
      ).toMatchObject({
        status: 'error',
        code: 'name_collision',
        applied: false,
        total_edits: 0,
      });
      expect(await fs.readFile(path.join(root, 'model.c'), 'utf8')).toBe(content);
    }
  }, 60000);

  it.each([
    [
      'model.c',
      '#define alias target\nint target(void) { return 1; }\nint call(void) { return alias(); }\n',
      'Function',
      'unsupported_occurrence',
      'unsupported',
    ],
    [
      'model.cpp',
      '#define alias target\nint target() { return 1; }\nint call() { return alias(); }\n',
      'Function',
      'unsupported_occurrence',
      'unsupported',
    ],
    [
      'model.rs',
      'fn target() {}\nfn call() { arbitrary_macro!(target); }\n',
      'Function',
      'incomplete_semantics',
      'blocked',
    ],
    [
      'model.zig',
      'const Target = struct { pub fn target(self: Target) void {} };\nfn call(p: Target) void { @field(p, "target")(); }\n',
      'Method',
      'unsupported_occurrence',
      'unsupported',
    ],
  ])(
    'blocks names hidden in unresolved expansion or reflection in %s',
    async (file, content, kind, code, planning_status) => {
      const { root, nodes, symbol } = await fixture({ [file]: content }, 'target', kind);
      for (const dry_run of [true, false]) {
        const result = await renameSymbol(root, symbol, { new_name: 'renamed', dry_run }, nodes);
        expect(result, JSON.stringify(result)).toMatchObject({
          status: 'error',
          code,
          planning_status,
          application_status: 'not_started',
          applied: false,
          total_edits: 0,
        });
        expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(content);
      }
    },
    60000,
  );
});

async function expectBoundaryRefusal(
  files: Record<string, string>,
  name: string,
  kind: string,
  newName: string,
  targetFile: string,
) {
  const { root, nodes, symbol } = await fixture(files, name, kind, targetFile);
  for (const dry_run of [true, false]) {
    const result = await renameSymbol(root, symbol, { new_name: newName, dry_run }, nodes);
    expect(result, `${name} -> ${newName} dry_run=${dry_run}`).toMatchObject({
      status: 'error',
      code: 'unsupported_boundary',
      planning_status: 'unsupported',
      applied: false,
      total_edits: 0,
    });
    for (const [file, content] of Object.entries(files))
      expect(await fs.readFile(path.join(root, file), 'utf8')).toBe(content);
  }
}

describe('names shared with indexed sources of an interoperating language', () => {
  const header = { 'api.h': 'int target(int value);\n' };
  const definition = '#include "api.h"\nint target(int value) { return value; }\n';
  it.each([
    [
      'Rust declares it in an extern block',
      'ffi.rs',
      'extern "C" {\n    fn target(value: i32) -> i32;\n}\npub fn call() -> i32 { unsafe { target(1) } }\n',
    ],
    [
      'Go calls it through cgo',
      'main.go',
      'package main\n\n/*\n#include "api.h"\n*/\nimport "C"\n\nfunc call() int { return int(C.target(1)) }\n',
    ],
    [
      'Zig calls it through @cImport',
      'main.zig',
      'const c = @cImport({\n    @cInclude("api.h");\n});\npub fn call() c_int { return c.target(1); }\n',
    ],
    [
      'Swift calls it through a bridging header',
      'App.swift',
      'func call() -> Int32 { return target(1) }\n',
    ],
  ])(
    'refuses a C function that %s',
    async (_description, consumer, content) => {
      await expectBoundaryRefusal(
        { ...header, 'api.c': definition, [consumer]: content },
        'target',
        'Function',
        'renamed',
        'api.c',
      );
    },
    60_000,
  );

  it('renames a C function beside consumer sources that only mention it in comments and strings', async () => {
    const consumers = {
      'other.rs': '// target renamed\npub fn note() -> &\'static str { "target renamed" }\n',
      'other.go':
        'package main\n\n// target renamed\nfunc note() string { return "target renamed" }\n',
      'other.zig': '// target renamed\npub fn note() []const u8 { return "target renamed"; }\n',
      'Other.swift': '// target renamed\nfunc note() -> String { return "target renamed" }\n',
    };
    await expectRename(
      { ...header, 'api.c': definition, ...consumers },
      {
        'api.h': 'int renamed(int value);\n',
        'api.c': definition.replaceAll('target', 'renamed'),
        ...consumers,
      },
      'target',
      'Function',
      'renamed',
      'api.c',
    );
  }, 60_000);

  it('renames a C function beside an Objective-C selector that only shares its first piece', async () => {
    // A selector base name bridges to Swift only; C and C++ never spell a function that way.
    const selectors =
      '@interface Other\n- (void)target:(int)value with:(int)other;\n@end\n' +
      'void use(Other *other) { [other target:1 with:2]; }\n';
    await expectRename(
      { ...header, 'api.c': definition, 'Other.m': selectors },
      {
        'api.h': 'int renamed(int value);\n',
        'api.c': definition.replaceAll('target', 'renamed'),
        'Other.m': selectors,
      },
      'target',
      'Function',
      'renamed',
      'api.c',
    );
  }, 60_000);

  it('refuses a C function when a Swift source spells the name as an unrelated local', async () => {
    // The inventory compares names, as it does for C++ and Objective-C sources.
    await expectBoundaryRefusal(
      {
        ...header,
        'api.c': definition,
        'App.swift': 'func call() -> Int { let target = 1; return target }\n',
      },
      'target',
      'Function',
      'renamed',
      'api.c',
    );
  }, 60_000);

  const lib = 'int use(void) { return target(1); }\n';
  it.each([
    ['Rust', 'lib.rs', '#[no_mangle]\npub extern "C" fn target(value: i32) -> i32 { value }\n'],
    ['Zig', 'lib.zig', 'export fn target(value: c_int) c_int { return value; }\n'],
    [
      'Go',
      'lib.go',
      'package main\n\nimport "C"\n\n//export target\nfunc target(value C.int) C.int { return value }\n\nfunc main() {}\n',
    ],
  ])(
    'refuses a %s function exported to an indexed C caller',
    async (_language, file, content) => {
      await expectBoundaryRefusal(
        { [file]: content, 'caller.c': `int target(int value);\n${lib}` },
        'target',
        'Function',
        'renamed',
        file,
      );
    },
    60_000,
  );

  it('refuses an Objective-C selector that an indexed Swift caller names', async () => {
    await expectBoundaryRefusal(
      {
        'Foo.h': '@interface Foo\n- (int)target;\n@end\n',
        'Foo.m': '#import "Foo.h"\n@implementation Foo\n- (int)target { return 1; }\n@end\n',
        'App.swift': 'func run(foo: Foo) -> Int32 { return foo.target() }\n',
      },
      'target',
      'Method',
      'renamed',
      'Foo.h',
    );
  }, 60_000);

  it.each([
    [
      'its first piece as the base name',
      'fetch:with:',
      'load:using:',
      '- (int)fetch:(int)key with:(int)value;',
      'foo.fetch(1, with: 2)',
    ],
    [
      'the base name before a With clause',
      'fetchWithKey:',
      'loadUsingKey:',
      '- (int)fetchWithKey:(int)key;',
      'foo.fetch(key: 1)',
    ],
  ])(
    'refuses a multipart Objective-C selector that an indexed Swift caller names by %s',
    async (_description, selector, newName, declaration, call) => {
      await expectBoundaryRefusal(
        {
          'Foo.h': `@interface Foo\n${declaration}\n@end\n`,
          'App.swift': `func run(foo: Foo) -> Int32 { return ${call} }\n`,
        },
        selector,
        'Method',
        newName,
        'Foo.h',
      );
    },
    60_000,
  );

  it('renames an Objective-C selector beside Swift sources that only mention it in comments and strings', async () => {
    const swift = '// target renamed\nlet note = "target renamed"\n';
    const declaration = (name: string) => `@interface Foo\n- (int)${name};\n@end\n`;
    const implementation = (name: string) =>
      `#import "Foo.h"\n@implementation Foo\n- (int)${name} { return 1; }\n@end\n`;
    await expectRename(
      { 'Foo.h': declaration('target'), 'Foo.m': implementation('target'), 'Other.swift': swift },
      {
        'Foo.h': declaration('renamed'),
        'Foo.m': implementation('renamed'),
        'Other.swift': swift,
      },
      'target',
      'Method',
      'renamed',
      'Foo.h',
    );
  }, 60_000);

  it('refuses a Swift method that an indexed Objective-C caller names', async () => {
    await expectBoundaryRefusal(
      {
        'Greeter.swift': '@objc class Greeter {\n    @objc func target() {}\n}\n',
        'caller.m': '#import "Greeter-Swift.h"\nvoid use(Greeter *greeter) { [greeter target]; }\n',
      },
      'target',
      'Function',
      'renamed',
      'Greeter.swift',
    );
  }, 60_000);

  it.each([
    [
      'its two-piece selector',
      '@objc func target(_ name: String, loudly: Bool) {}',
      '[greeter target:@"x" loudly:YES]',
    ],
    ['its one-piece selector', '@objc func target(_ name: String) {}', '[greeter target:@"x"]'],
    [
      'a With clause of the first piece',
      '@objc func target(name: String) {}',
      '[greeter targetWithName:@"x"]',
    ],
    [
      'a With clause before a later piece',
      '@objc func target(name: String, loudly: Bool) {}',
      '[greeter targetWithName:@"x" loudly:YES]',
    ],
  ])(
    'refuses a Swift method taking arguments that an indexed Objective-C caller names by %s',
    async (_description, declaration, call) => {
      await expectBoundaryRefusal(
        {
          'Greeter.swift': `@objc class Greeter {\n    ${declaration}\n}\n`,
          'caller.m': `#import "Greeter-Swift.h"\nvoid use(Greeter *greeter) { ${call}; }\n`,
        },
        'target',
        'Function',
        'renamed',
        'Greeter.swift',
      );
    },
    60_000,
  );

  it('refuses a Swift property that an indexed Objective-C caller writes through its setter selector', async () => {
    await expectBoundaryRefusal(
      {
        'Greeter.swift': '@objc class Greeter {\n    @objc var target: Int = 0\n}\n',
        'caller.m':
          '#import "Greeter-Swift.h"\nvoid use(Greeter *greeter) { [greeter setTarget:1]; }\n',
      },
      'target',
      'Property',
      'renamed',
      'Greeter.swift',
    );
  }, 60_000);

  it('renames a Swift method beside Objective-C selectors that share only a later piece or a prefix', async () => {
    const caller =
      '@interface Other\n- (void)notify:(int)count target:(int)flag;\n- (void)targetedWith:(int)flag;\n@end\n' +
      'void use(Other *other) { [other notify:1 target:2]; [other targetedWith:3]; }\n';
    const swift = (name: string) =>
      `class Greeter {\n    func ${name}(_ value: Int, loudly: Bool) {}\n}\n` +
      `func run(greeter: Greeter) { greeter.${name}(1, loudly: true) }\n`;
    await expectRename(
      { 'Greeter.swift': swift('target'), 'Other.m': caller },
      { 'Greeter.swift': swift('renamed'), 'Other.m': caller },
      'target',
      'Function',
      'renamed',
      'Greeter.swift',
    );
  }, 60_000);

  it.each([
    ['an NS_SWIFT_NAME argument', '- (int)fetchData NS_SWIFT_NAME(target());'],
    ['a swift_name attribute string', '- (int)fetchData __attribute__((swift_name("target()")));'],
  ])(
    'refuses a Swift method that an indexed Objective-C header names to Swift through %s',
    async (_description, declaration) => {
      await expectBoundaryRefusal(
        {
          'Foo.h': `@interface Foo\n${declaration}\n@end\n`,
          'Impl.swift': 'class Impl {\n    func target() -> Int32 { return 1 }\n}\n',
        },
        'target',
        'Function',
        'renamed',
        'Impl.swift',
      );
    },
    60_000,
  );

  it('refuses a Swift initializer that an indexed Objective-C caller constructs with initWith', async () => {
    await expectBoundaryRefusal(
      {
        'Greeter.swift': '@objc class Greeter {\n    @objc init(name: String) {}\n}\n',
        'caller.m':
          '#import "Greeter-Swift.h"\nvoid use(void) { Greeter *greeter = [[Greeter alloc] initWithName:@"x"]; }\n',
      },
      'init',
      'Constructor',
      'make',
      'Greeter.swift',
    );
  }, 60_000);

  it.each([
    [
      'one label',
      '- (instancetype)initWithName:(int)name;',
      'initWithName:',
      'initWithTitle:',
      'Foo(name: 1)',
    ],
    [
      'several labels',
      '- (instancetype)initWithName:(int)name age:(int)age;',
      'initWithName:age:',
      'initWithTitle:age:',
      'Foo(name: 1, age: 2)',
    ],
    [
      'an acronym label',
      '- (instancetype)initWithURL:(int)url;',
      'initWithURL:',
      'initWithLink:',
      'Foo(url: 1)',
    ],
  ])(
    'refuses an Objective-C initWith selector that an indexed Swift caller constructs with %s',
    async (_description, declaration, selector, newName, call) => {
      await expectBoundaryRefusal(
        {
          'Foo.h': `@interface Foo\n${declaration}\n@end\n`,
          'App.swift': `func make() -> Foo { return ${call} }\n`,
        },
        selector,
        'Method',
        newName,
        'Foo.h',
      );
    },
    60_000,
  );

  it.each([
    [
      'a nullary selector',
      '- (int)target NS_REFINED_FOR_SWIFT;',
      'target',
      'renamed',
      'f.__target()',
    ],
    [
      'a multipart selector',
      '- (int)target:(int)key with:(int)value NS_REFINED_FOR_SWIFT;',
      'target:with:',
      'renamed:using:',
      'f.__target(1, with: 2)',
    ],
  ])(
    'refuses an Objective-C %s refined for Swift that an indexed Swift caller spells with a double underscore',
    async (_description, declaration, selector, newName, call) => {
      await expectBoundaryRefusal(
        {
          'Foo.h': `@interface Foo\n${declaration}\n@end\n`,
          'App.swift': `func run(f: Foo) -> Int32 { return ${call} }\n`,
        },
        selector,
        'Method',
        newName,
        'Foo.h',
      );
    },
    60_000,
  );

  it('refuses an Objective-C selector that another declaration spells in an NS_SWIFT_NAME argument', async () => {
    await expectBoundaryRefusal(
      {
        'Foo.h': '@interface Foo\n- (int)target;\n- (int)other NS_SWIFT_NAME(target());\n@end\n',
        'Foo.m':
          '#import "Foo.h"\n@implementation Foo\n- (int)target { return 1; }\n- (int)other { return 2; }\n@end\n',
      },
      'target',
      'Method',
      'renamed',
      'Foo.h',
    );
  }, 60_000);

  it('renames an Objective-C selector whose Swift spelling an explicit NS_SWIFT_NAME keeps independent', async () => {
    const header = (name: string) =>
      `@interface Foo\n- (int)${name} NS_SWIFT_NAME(retrieve());\n@end\n`;
    const implementation = (name: string) =>
      `#import "Foo.h"\n@implementation Foo\n- (int)${name} { return 1; }\n@end\n`;
    const swift = 'func run(f: Foo) -> Int32 { return f.retrieve() }\n';
    await expectRename(
      { 'Foo.h': header('target'), 'Foo.m': implementation('target'), 'App.swift': swift },
      { 'Foo.h': header('renamed'), 'Foo.m': implementation('renamed'), 'App.swift': swift },
      'target',
      'Method',
      'renamed',
      'Foo.h',
    );
  }, 60_000);

  it('renames an Objective-C selector refined for Swift when no indexed Swift source spells it', async () => {
    const header = (name: string) => `@interface Foo\n- (int)${name} NS_REFINED_FOR_SWIFT;\n@end\n`;
    const implementation = (name: string) =>
      `#import "Foo.h"\n@implementation Foo\n- (int)${name} { return 1; }\n@end\n`;
    const swift = 'func run(f: Foo) -> Int32 { return f.other() }\n';
    await expectRename(
      { 'Foo.h': header('target'), 'Foo.m': implementation('target'), 'App.swift': swift },
      { 'Foo.h': header('renamed'), 'Foo.m': implementation('renamed'), 'App.swift': swift },
      'target',
      'Method',
      'renamed',
      'Foo.h',
    );
  }, 60_000);
});
