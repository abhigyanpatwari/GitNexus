import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import { captureJavaSpringDiClassFact } from '../../src/core/ingestion/languages/java/spring-di.js';

function sites(source: string) {
  const parser = new Parser();
  parser.setLanguage(Java);
  const root = parser.parse(source).rootNode;
  const consumer = root
    .descendantsOfType('class_declaration')
    .find((node) => node.childForFieldName('name')?.text === 'Consumer')!;
  return (
    captureJavaSpringDiClassFact(consumer, 'Consumer.java')?.injectionSites.filter(
      (site) => site.kind === 'constructor',
    ) ?? []
  );
}

describe('Lombok qualified constructor signature ownership', () => {
  it.each([
    ['p.User', 'User', 'import p.User;'],
    ['p.User[]', 'User[]', 'import p.User;'],
    ['java.util.List<p.User>', 'List<p.User>', 'import java.util.List;'],
    ['p.Outer.User', 'Outer.User', 'import p.Outer;'],
  ])(
    'refuses a generated %s signature duplicated by imported %s',
    (fieldType, parameterType, imported) => {
      expect(
        sites(`${imported}
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Autowired;
@Service @lombok.AllArgsConstructor class Consumer {
  ${fieldType} user;
  @Autowired Consumer(${parameterType} user) {}
}`),
      ).toEqual([]);
    },
  );

  it('preserves a distinct explicitly injected constructor despite a same-simple-name generated type', () => {
    const constructors = sites(`import b.User;
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Autowired;
@Service @lombok.AllArgsConstructor class Consumer {
  a.User user;
  @Autowired Consumer(User user) {}
}`);
    expect(constructors).toHaveLength(1);
    expect(constructors[0].implicitConstructor).toBe(false);
    expect(constructors[0].dependencies).toEqual([
      { name: 'user', rawType: 'User', annotations: [] },
    ]);
  });

  it('preserves a nested type that shadows an explicitly imported same-named type', () => {
    const constructors = sites(`import p.User;
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Autowired;
@Service @lombok.AllArgsConstructor class Consumer {
  static class User {}
  User user;
  @Autowired Consumer(p.User user) {}
}`);
    expect(constructors).toHaveLength(1);
    expect(constructors[0].dependencies).toEqual([
      { name: 'user', rawType: 'p.User', annotations: [] },
    ]);
  });

  it('does not let constructor-body local types change a parameter signature', () => {
    expect(
      sites(`import p.User;
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Autowired;
@Service @lombok.AllArgsConstructor class Consumer {
  p.User user;
  @Autowired Consumer(User user) { class User {} }
}`),
    ).toEqual([]);
  });
});
