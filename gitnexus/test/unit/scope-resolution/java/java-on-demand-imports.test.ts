import { describe, expect, it } from 'vitest';
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
function run(source: string, extra: Record<string, string> = {}, cached?: readonly ParsedFile[]) {
  const graph = createKnowledgeGraph();
  const files = Object.entries({ ...declarations, ...extra, 'Main.java': source }).map(
    ([path, content]) => ({ path, content: cached ? '' : content }),
  );
  let parsedFiles: readonly ParsedFile[] = [];
  runScopeResolution(
    {
      graph,
      files,
      model: createSemanticModel(),
      preExtractedParsedFiles: cached
        ? new Map(cached.map((parsed) => [parsed.filePath, parsed]))
        : undefined,
      onResolved: (result) => {
        parsedFiles = result.parsedFiles;
      },
    },
    javaScopeResolver,
  );
  return {
    targets: [...graph.iterRelationships()]
      .filter((edge) => edge.type === 'IMPORTS' && edge.sourceId === 'File:Main.java')
      .map((edge) => edge.targetId.replace('File:', ''))
      .sort(),
    parsedFiles,
  };
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
  it('same-package types shadow wildcard types even in another directory', () => {
    expect(
      run('package app; import models.*; class Main { User value; }', {
        'elsewhere/User.java': 'package app; public class User {}',
      }).targets,
    ).not.toContain('models/User.java');
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
    extra['elsewhere/User.java'] = 'package app; public class User {}';
    expect(
      run('package app; import models.*; class Main { User value; Order order; }', extra).targets,
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
    expect(run(source, {}, cached).targets).toEqual(cold.targets);
    expect(cold.targets).toEqual(['models/User.java']);
  });
  it('old cache entries without AST use facts retain all wildcard dependencies', () => {
    const source = importing('User value;');
    const cold = run(source);
    const cached = structuredClone(cold.parsedFiles).map((parsed) =>
      parsed.filePath === 'Main.java'
        ? {
            ...parsed,
            captureSideChannel: {
              ...(parsed.captureSideChannel as JavaCaptureSideChannel),
              importUses: undefined,
            },
          }
        : parsed,
    );
    expect(run(source, {}, cached).targets).toEqual(Object.keys(declarations).sort());
  });
});
