import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import { collectJavaLombokConstructors } from '../../src/core/ingestion/languages/java/lombok-constructors.js';
import { captureJavaSpringDiClassFact } from '../../src/core/ingestion/languages/java/spring-di.js';

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
  it.each([
    ['p.User', 'User', 'import p.User;'],
    ['p.User[]', 'User[]', 'import p.User;'],
    ['java.util.List<p.User>', 'List<p.User>', 'import java.util.List;'],
    ['p.Outer.User', 'Outer.User', 'import p.Outer;'],
  ])(
    'refuses a generated %s signature duplicated by imported %s, keeping only the written injected constructor',
    (fieldType, parameterType, imported) => {
      const source = `${imported}
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Autowired;
@Service @lombok.AllArgsConstructor class Consumer {
  ${fieldType} user;
  @Autowired Consumer(${parameterType} user) {}
}`;
      expect(hasSignatureConflict(source)).toBe(true);
      expect(
        sites(source).map((site) => ({
          implicitConstructor: site.implicitConstructor,
          dependencies: site.dependencies,
        })),
      ).toEqual([
        {
          implicitConstructor: false,
          dependencies: [{ name: 'user', rawType: parameterType, annotations: [] }],
        },
      ]);
    },
  );

  it('preserves a distinct explicitly injected constructor despite a same-simple-name generated type', () => {
    const source = `import b.User;
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Autowired;
@Service @lombok.AllArgsConstructor class Consumer {
  a.User user;
  @Autowired Consumer(User user) {}
}`;
    expect(hasSignatureConflict(source)).toBe(false);
    const constructors = sites(source);
    expect(constructors).toHaveLength(1);
    expect(constructors[0].implicitConstructor).toBe(false);
    expect(constructors[0].dependencies).toEqual([
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
    expect(hasSignatureConflict(source)).toBe(false);
    const constructors = sites(source);
    expect(constructors).toHaveLength(1);
    expect(constructors[0].dependencies).toEqual([
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
    expect(hasSignatureConflict(source)).toBe(true);
    expect(sites(source).map((site) => site.dependencies)).toEqual([
      [{ name: 'user', rawType: 'User', annotations: [] }],
    ]);
  });

  // The imported head is the whole leading Java identifier, never its ASCII
  // prefix: `Straße` must not expand through an import of `q.Stra`.
  it.each([
    ['import q.Straße;', 'Straße', 'q.Straße', true],
    ['import q.Street;', 'Street', 'q.Street', true],
    ['import q.Stra;', 'Straße', 'q.Straße', false],
    ['import q.Str;', 'Street', 'q.Street', false],
  ])(
    'with %s, compares a generated %s against a written %s by import identity (clash: %s)',
    (imported, fieldType, parameterType, clash) => {
      const source = `${imported}
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Autowired;
@Service @lombok.AllArgsConstructor class Consumer {
  ${fieldType} road;
  @Autowired Consumer(${parameterType} road) {}
}`;
      expect(hasSignatureConflict(source)).toBe(clash);
    },
  );
});
