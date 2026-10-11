import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SupportedLanguages } from 'gitnexus-shared';
import { createRenameFixtureHelpers } from '../helpers/rename-provider-fixture.js';
import { SCOPE_RESOLVERS } from '../../src/core/ingestion/scope-resolution/pipeline/registry.js';
import { renameSymbol } from '../../src/mcp/local/rename/rename-plan.js';

const { fixture, expectRename } = createRenameFixtureHelpers();

describe('native provider rename through the production parsing pipeline', () => {
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
  ])('rejects reserved replacement names in %s', (language, name) => {
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
