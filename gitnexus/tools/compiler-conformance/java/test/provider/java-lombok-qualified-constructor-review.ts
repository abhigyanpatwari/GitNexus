import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import { collectJavaLombokConstructors } from '../../../../../src/core/ingestion/languages/java/lombok-constructors.js';
import { captureJavaSpringDiClassFact } from '../../../../../src/core/ingestion/languages/java/spring-di.js';

function consumerOf(source: string): Parser.SyntaxNode {
  const parser = new Parser();
  parser.setLanguage(Java);
  const root = parser.parse(source).rootNode;
  return root
    .descendantsOfType('class_declaration')
    .find((node) => node.childForFieldName('name')?.text === 'Consumer')!;
}

function sites(source: string) {
  return (
    captureJavaSpringDiClassFact(consumerOf(source), 'Consumer.java')?.injectionSites.filter(
      (site) => site.kind === 'constructor',
    ) ?? []
  );
}

function hasSignatureConflict(source: string): boolean {
  return collectJavaLombokConstructors(consumerOf(source)).hasSignatureConflict;
}

describe('Lombok qualified constructor signature ownership', () => {
  for (const example of [
    ['p.User', 'User', 'import p.User;'],
    ['p.User[]', 'User[]', 'import p.User;'],
    ['java.util.List<p.User>', 'List<p.User>', 'import java.util.List;'],
    ['p.Outer.User', 'Outer.User', 'import p.Outer;'],
  ] as const) {
    it(`refuses a generated ${example[0]} signature duplicated by imported ${example[1]}, keeping only the written injected constructor`, () => {
      const [fieldType, parameterType, imported] = example;

      const source = `${imported}
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Autowired;
@Service @lombok.AllArgsConstructor class Consumer {
  ${fieldType} user;
  @Autowired Consumer(${parameterType} user) {}
}`;
      assert.equal(hasSignatureConflict(source), true);
      assert.deepEqual(
        sites(source).map((site) => ({
          implicitConstructor: site.implicitConstructor,
          dependencies: site.dependencies,
        })),
        [
          {
            implicitConstructor: false,
            dependencies: [{ name: 'user', rawType: parameterType, annotations: [] }],
          },
        ],
      );
    });
  }

  it('preserves a distinct explicitly injected constructor despite a same-simple-name generated type', () => {
    const source = `import b.User;
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Autowired;
@Service @lombok.AllArgsConstructor class Consumer {
  a.User user;
  @Autowired Consumer(User user) {}
}`;
    assert.equal(hasSignatureConflict(source), false);
    const constructors = sites(source);
    assert.equal(constructors.length, 1);
    assert.equal(constructors[0].implicitConstructor, false);
    assert.deepEqual(constructors[0].dependencies, [
      { name: 'user', rawType: 'User', annotations: [] },
    ]);
  });

  it('preserves a nested type that shadows an explicitly imported same-named type', () => {
    const source = `import p.User;
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Autowired;
@Service @lombok.AllArgsConstructor class Consumer {
  static class User {}
  User user;
  @Autowired Consumer(p.User user) {}
}`;
    assert.equal(hasSignatureConflict(source), false);
    const constructors = sites(source);
    assert.equal(constructors.length, 1);
    assert.deepEqual(constructors[0].dependencies, [
      { name: 'user', rawType: 'p.User', annotations: [] },
    ]);
  });

  it('does not let constructor-body local types change a parameter signature', () => {
    const source = `import p.User;
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Autowired;
@Service @lombok.AllArgsConstructor class Consumer {
  p.User user;
  @Autowired Consumer(User user) { class User {} }
}`;
    assert.equal(hasSignatureConflict(source), true);
    assert.deepEqual(
      sites(source).map((site) => site.dependencies),
      [[{ name: 'user', rawType: 'User', annotations: [] }]],
    );
  });

  // The imported head is the whole leading Java identifier, never its ASCII
  // prefix: `Straße` must not expand through an import of `q.Stra`.
  for (const example of [
    ['import q.Straße;', 'Straße', 'q.Straße', true],
    ['import q.Street;', 'Street', 'q.Street', true],
    ['import q.Stra;', 'Straße', 'q.Straße', false],
    ['import q.Str;', 'Street', 'q.Street', false],
  ] as const) {
    it(`with ${example[0]}, compares a generated ${example[1]} against a written ${example[2]} by import identity (clash: ${example[3]})`, () => {
      const [imported, fieldType, parameterType, clash] = example;

      const source = `${imported}
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Autowired;
@Service @lombok.AllArgsConstructor class Consumer {
  ${fieldType} road;
  @Autowired Consumer(${parameterType} road) {}
}`;
      assert.equal(hasSignatureConflict(source), clash);
    });
  }
});
