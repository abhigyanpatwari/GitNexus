import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ParsedFile } from 'gitnexus-shared';
import { createKnowledgeGraph } from '../../../../src/core/graph/graph.js';
import { createSemanticModel } from '../../../../src/core/ingestion/model/semantic-model.js';
import { runScopeResolution } from '../../../../src/core/ingestion/scope-resolution/pipeline/run.js';
import { javaScopeResolver } from '../../../../src/core/ingestion/languages/java/scope-resolver.js';
import type { JavaCaptureSideChannel } from '../../../../src/core/ingestion/languages/java/capture-side-channel.js';

const declarations = {
  'models/User.java': 'package models; public class User {}',
  'models/Order.java': 'package models; public class Order {}',
  'models/Audited.java': 'package models; public @interface Audited {}',
  'models/Problem.java': 'package models; public class Problem extends Exception {}',
};
type Sources = Record<string, string>;
function resolve(
  sources: Sources,
  main: string,
  options: {
    readonly preExtracted?: ReadonlyMap<string, ParsedFile>;
    readonly scopeIndexStorePath?: string;
  } = {},
) {
  const graph = createKnowledgeGraph();
  let parsedFiles: readonly ParsedFile[] = [];
  runScopeResolution(
    {
      graph,
      files: Object.entries(sources).map(([path, content]) => ({ path, content })),
      model: createSemanticModel(),
      preExtractedParsedFiles: options.preExtracted,
      scopeIndexStorePath: options.scopeIndexStorePath,
      onResolved: (result) => {
        parsedFiles = result.parsedFiles;
      },
    },
    javaScopeResolver,
  );
  return {
    targets: [...graph.iterRelationships()]
      .filter((edge) => edge.type === 'IMPORTS' && edge.sourceId === `File:${main}`)
      .map((edge) => edge.targetId.replace('File:', ''))
      .sort(),
    parsedFiles,
  };
}
function run(source: string, extra: Sources = {}, main = 'Main.java') {
  return resolve({ ...declarations, ...extra, [main]: source }, main);
}
/** A warm run: facts come from the cache and no source text is retained. */
function rerun(source: string, cached: readonly ParsedFile[]) {
  const blank = Object.fromEntries(
    Object.keys({ ...declarations, 'Main.java': source }).map((path) => [path, '']),
  );
  return resolve(blank, 'Main.java', {
    preExtracted: new Map(cached.map((parsed) => [parsed.filePath, parsed])),
  });
}
const importing = (body: string) => `import models.*; class Main { ${body} }`;

describe('Java AST-bound package on-demand dependencies (JLS 6.5, 7.5.2)', () => {
  it.each([
    ['field type', 'User value;'],
    ['same-spelling value and type', 'User User;'],
    ['parameter type', 'void use(User value) {}'],
    ['generic argument', 'java.util.List<User> values;'],
    ['cast', 'Object use(Object value) { return (User) value; }'],
    ['instanceof', 'boolean use(Object value) { return value instanceof User; }'],
    ['class literal', 'Class<?> type = User.class;'],
    ['static receiver', 'void use() { User.run(); }'],
    ['method reference receiver', 'Object ref = User::new;'],
    ['array type', 'User[] values;'],
    ['generic bound', '<T extends User> void use(T value) {}'],
    ['parameter annotation outside parameter scope', 'void use(@Mark(User.FLAG) Object User) {}'],
    ['method annotation outside type-parameter scope', '@Mark(User.FLAG) <User> void use() {}'],
    [
      'local type outside its scope',
      'void a() { class User {} User local; } void b(User value) {}',
    ],
    ['value outside its block', 'void use() { { int User = 1; } User.run(); }'],
    ['value before its declaration', 'void use() { User.run(); int User = 1; }'],
    [
      'value outside its loop',
      'void use() { for (int User = 0; User < 1; User++) {} User.run(); }',
    ],
    [
      'value outside the local-class constructor that declares it',
      'void use() { class L { L() { Object User = null; } } User.run(); }',
    ],
    [
      'value outside the local-class method whose varargs parameter declares it',
      'void use() { class L { void f(Object... User) {} } User.run(); }',
    ],
    [
      'value outside the nested annotation type whose constant declares it',
      '@interface Config { int User = 1; } void use() { User.run(); }',
    ],
    [
      'type outside the nested class that declares it',
      'static class Holder { class User {} } User value;',
    ],
    [
      'constructor reference beside a same-named variable',
      'Object use(Object User) { return (java.util.function.Supplier<Object>) User::new; }',
    ],
  ])('retains a %s dependency', (_label, body) => {
    expect(run(importing(body)).targets).toEqual(['models/User.java']);
  });
  it('retains annotation and throws-only types', () => {
    expect(run(importing('@Audited void use() throws Problem {}')).targets).toEqual([
      'models/Audited.java',
      'models/Problem.java',
    ]);
  });
  it.each([
    ['comment and string', 'String value = "User Order"; /* User Order */'],
    ['field name', 'int User;'],
    ['method name', 'void User() {} void use() { User(); }'],
    ['qualified type', 'models.User value;'],
    ['qualified member', 'void use(Object value) { value.User(); }'],
    ['nested type', 'class User {} User value;'],
    ['local type', 'void use() { class User {} User value; }'],
    ['method type parameter', '<User> void use(User value) {}'],
    ['parameter obscures expression qualifier', 'void use(Object User) { User.toString(); }'],
    ['local obscures expression qualifier', 'void use() { Object User = null; User.toString(); }'],
    ['lambda parameter', 'Object value = (User) -> User.toString();'],
    [
      'field obscures a qualifier in a nested class',
      'Object User; class Inner { void use() { User.toString(); } }',
    ],
    [
      'catch parameter',
      'void use() { try { use(); } catch (Exception User) { User.toString(); } }',
    ],
    ['loop variable', 'void use(Object[] all) { for (Object User : all) { User.toString(); } }'],
    ['constructor parameter', 'Main(Object User) { User.toString(); }'],
    ['enum constant', 'enum Kind { User; Object use() { return User.name(); } }'],
  ])('does not import a %s spelling', (_label, body) => {
    expect(run(importing(body)).targets).toEqual([]);
  });
  it('class type parameters shadow wildcard types', () => {
    expect(run('import models.*; class Main<User> { User value; }').targets).toEqual([]);
  });
  it('annotated type parameters still shadow wildcard types', () => {
    expect(
      run('import models.*; class Main<@Audited User> { User value; }', {
        'models/Audited.java':
          'package models; @java.lang.annotation.Target(java.lang.annotation.ElementType.TYPE_PARAMETER) public @interface Audited {}',
      }).targets,
    ).toEqual(['models/Audited.java']);
  });
  it('explicit imports shadow wildcard types, including an unused explicit import', () => {
    expect(
      run('import models.*; import other.User; import models.Order; class Main { User value; }', {
        'other/User.java': 'package other; public class User {}',
      }).targets,
    ).toEqual(['models/Order.java', 'other/User.java']);
  });
  it('a same-package type in the importing directory shadows a wildcard type', () => {
    expect(
      run(
        'package app; import models.*; class Main { User value; }',
        { 'app/User.java': 'package app; public class User {}' },
        'app/Main.java',
      ).targets,
    ).toEqual([]);
  });
  it.each([
    ['another directory', 'Main.java', 'elsewhere/User.java'],
    ['the test source set', 'src/main/java/app/Main.java', 'src/test/java/app/User.java'],
    [
      'another build module',
      'modA/src/main/java/app/Main.java',
      'modB/src/main/java/app/User.java',
    ],
  ])(
    'a same-package namesake in %s does not prove the wildcard type unused',
    (_label, main, namesake) => {
      expect(
        run(
          'package app; import models.*; class Main { User value; }',
          { [namesake]: 'package app; public class User {}' },
          main,
        ).targets,
      ).toEqual(['models/User.java']);
    },
  );
  it('a default-package namesake in another directory keeps the wildcard dependency', () => {
    expect(
      run(
        'import models.*; class Main { User value; }',
        { 'samples/User.java': 'class User {}' },
        'tools/Main.java',
      ).targets,
    ).toEqual(['models/User.java']);
  });
  it('an unresolved explicit import still shadows a wildcard type', () => {
    expect(
      run('import models.*; import external.User; class Main { User value; }').targets,
    ).toEqual([]);
  });
  it('large same-package scopes remain precise beyond the sibling-injection cap', () => {
    const extra = Object.fromEntries(
      Array.from({ length: 205 }, (_, i) => [
        `app/Sibling${i}.java`,
        `package app; public class Sibling${i} {}`,
      ]),
    );
    extra['app/User.java'] = 'package app; public class User {}';
    expect(
      run(
        'package app; import models.*; class Main { User value; Order order; }',
        extra,
        'app/Main.java',
      ).targets,
    ).toEqual(['models/Order.java']);
  });
  it('retains both candidates for an ambiguous wildcard type', () => {
    expect(
      run('import models.*; import other.*; class Main { User value; }', {
        'other/User.java': 'package other; public class User {}',
      }).targets,
    ).toEqual(['models/User.java', 'other/User.java']);
  });
  it('retains the concrete owner of an inherited static wildcard', () => {
    expect(
      run('import static utility.Child.*; class Main { void use() { run(); } }', {
        'utility/Base.java': 'package utility; public class Base { public static void run() {} }',
        'utility/Child.java': 'package utility; public class Child extends Base {}',
      }).targets,
    ).toEqual(['utility/Child.java']);
  });
  it('retains the static owner alongside a selected package wildcard type', () => {
    expect(
      run('import models.*; import static utility.Tools.*; class Main { User value; }', {
        'utility/Tools.java': 'package utility; public class Tools { public static void run() {} }',
      }).targets,
    ).toEqual(['models/User.java', 'utility/Tools.java']);
  });
  it.each([
    ['Unicode escape', String.raw`\u0055ser`],
    ['repeated u', String.raw`Us\uuuu0065r`],
    ['escaped ignorable', String.raw`Us\u200cer`],
    ['U+200C', 'Us\u200cer'],
    ['U+200B', 'Us\u200ber'],
    ['U+0000', 'Us\u0000er'],
    ['U+007F', 'Us\u007fer'],
    ['U+009F', 'Us\u009fer'],
  ])('retains dependencies when parser bindings cannot represent %s', (_label, name) => {
    expect(run(importing(`${name} value;`)).targets).toContain('models/User.java');
  });
  it.each([String.raw`// \u000a User value;`, String.raw`/* \u002a\u002f User value; // */`])(
    'retains code exposed by Unicode translation inside a comment: %s',
    (body) => {
      const result = run(`import models.*; class Main {\n${body}\n}`);
      expect(result.targets).toContain('models/User.java');
      const parsed = result.parsedFiles.find((file) => file.filePath === 'Main.java');
      expect((parsed?.captureSideChannel as JavaCaptureSideChannel).importUses?.complete).toBe(
        false,
      );
    },
  );
  it('reuses JSON-serialized AST facts with no retained source', () => {
    const source = importing('User value; String unrelated = "Order";');
    const cold = run(source);
    const cached = structuredClone(cold.parsedFiles).map((parsed) => ({
      ...parsed,
      captureSideChannel: JSON.parse(JSON.stringify(parsed.captureSideChannel)),
    }));
    expect(rerun(source, cached).targets).toEqual(cold.targets);
    expect(cold.targets).toEqual(['models/User.java']);
  });
  it.each([
    ['no AST use facts', undefined],
    ['facts in the superseded per-use shape', { version: 1, complete: true, uses: [] }],
    ['facts whose names are not strings', { version: 2, complete: true, names: [7] }],
    ['facts with no name list', { version: 2, complete: true }],
  ])('cache entries with %s retain all wildcard dependencies', (_label, importUses) => {
    const source = importing('User value;');
    const cached = structuredClone(run(source).parsedFiles).map((parsed) => ({
      ...parsed,
      captureSideChannel: { ...(parsed.captureSideChannel as JavaCaptureSideChannel), importUses },
    }));
    expect(rerun(source, cached).targets).toEqual(Object.keys(declarations).sort());
  });
  it.each([
    ['incomplete', { version: 2, complete: false, names: [] }],
    ['superseded', { version: 1, complete: true, uses: [] }],
    ['malformed', { version: 2, complete: true, names: [7] }],
  ])('retains an otherwise unused target whose cached facts are %s', (_label, importUses) => {
    const source = importing('Order value;');
    const cached = structuredClone(run(source).parsedFiles);
    const target = cached.find((parsed) => parsed.filePath === 'models/User.java');
    if (target === undefined) throw new Error('Missing parsed User fixture');
    const preExtracted = new Map(cached.map((parsed) => [parsed.filePath, parsed]));
    preExtracted.set(target.filePath, {
      ...target,
      captureSideChannel: { ...(target.captureSideChannel as JavaCaptureSideChannel), importUses },
    });
    expect(rerun(source, [...preExtracted.values()]).targets).toEqual([
      'models/Order.java',
      'models/User.java',
    ]);
  });
  it('stores each unbound name once and no declared, bound or method name', () => {
    const { parsedFiles } = run(
      importing('User a; User b; Order use(Object local) { local.toString(); return helper(a); }'),
    );
    const parsed = parsedFiles.find((file) => file.filePath === 'Main.java');
    expect(
      [...((parsed?.captureSideChannel as JavaCaptureSideChannel).importUses?.names ?? [])].sort(),
    ).toEqual(['Order', 'Object', 'User'].sort());
  });
  it.each([
    ['a marker annotation', '@Audited package app; import models.*;', ['models/Audited.java']],
    [
      'an annotation argument',
      '@SuppressWarnings(User.FLAG) package app; import models.*;',
      ['models/User.java'],
    ],
  ])('retains a type used by %s on the package declaration', (_label, source, expected) => {
    expect(run(source, {}, 'app/package-info.java').targets).toEqual(expected);
  });
  it("binds a class header outside the scope of the class's own member types", () => {
    expect(
      run('import models.*; class Main extends User { static class User {} }').targets,
    ).toEqual(['models/User.java']);
  });
  it('resolves a file whose one expression has thousands of operands', () => {
    const operands = Array.from({ length: 3000 }, (_, i) => `User.F${i}`).join(' + ');
    expect(run(importing(`int sum() { return ${operands}; }`)).targets).toEqual([
      'models/User.java',
    ]);
  });
  it('narrows when the scope tree is sealed to disk before emission', async () => {
    const store = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-scope-index-'));
    vi.stubEnv('GITNEXUS_DISK_SCOPE_INDEX', '1');
    try {
      const source = importing('User value;');
      expect(
        resolve({ ...declarations, 'Main.java': source }, 'Main.java', {
          scopeIndexStorePath: store,
        }).targets,
      ).toEqual(['models/User.java']);
    } finally {
      vi.unstubAllEnvs();
      await fs.rm(store, { recursive: true, force: true });
    }
  });
});
