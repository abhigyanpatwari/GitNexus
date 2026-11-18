import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import {
  synthesizeLombokAccessorCaptures,
  synthesizeLombokAccessors,
} from '../../src/core/ingestion/languages/java/lombok-synthesizer.js';
import { captureJavaSpringDiClassFact } from '../../src/core/ingestion/languages/java/spring-di.js';

function treeOf(source: string): Parser.Tree {
  const parser = new Parser();
  parser.setLanguage(Java);
  return parser.parse(source);
}

function synthesized(source: string) {
  const tree = treeOf(source);
  const owners = new Map<number, string>();
  for (const node of tree.rootNode.descendantsOfType('class_declaration')) {
    owners.set(node.id, `Class:Example.java:${node.childForFieldName('name')!.text}`);
  }
  return {
    graph: synthesizeLombokAccessors(tree, 'Example.java', owners),
    captures: synthesizeLombokAccessorCaptures(tree.rootNode),
  };
}

function constructorSites(source: string) {
  const tree = treeOf(source);
  const node = tree.rootNode
    .descendantsOfType('class_declaration')
    .find((candidate) => candidate.childForFieldName('name')?.text === 'Consumer')!;
  return (
    captureJavaSpringDiClassFact(node, 'Consumer.java')?.injectionSites.filter(
      (site) => site.kind === 'constructor',
    ) ?? []
  );
}

describe('Lombok Value accessor identity', () => {
  it('uses the same getter-only plan for graph and scope synthesis, including trailing arrays', () => {
    const result = synthesized(`import lombok.Value;
@Value class Consumer {
  boolean active;
  Boolean boxed;
  String[] first, second[];
  String trailing[];
  static String shared;
  String $internal;
}`);
    expect(result.graph.symbols.map((symbol) => [symbol.name, symbol.returnType]).sort()).toEqual([
      ['getBoxed', 'Boolean'],
      ['getFirst', 'String[]'],
      ['getSecond', 'String[][]'],
      ['getTrailing', 'String[]'],
      ['isActive', 'boolean'],
    ]);
    const scopeNames = result.captures
      .map((capture) => capture['@declaration.name']?.text)
      .filter((name) => name !== undefined)
      .sort();
    expect(scopeNames).toEqual(result.graph.symbols.map((symbol) => symbol.name).sort());
  });

  it('preserves field suppression, explicit methods and unsupported Accessors', () => {
    const result = synthesized(`import lombok.Value;
import lombok.Getter;
import lombok.AccessLevel;
@Value class Consumer {
  @Getter(AccessLevel.NONE) String hidden;
  String explicit;
  @lombok.experimental.Accessors(fluent=true) String fluent;
  String getExplicit() { return explicit; }
}`);
    expect(result.graph.symbols).toEqual([]);
    expect(result.captures).toEqual([]);
  });

  it.each([
    '@Value class Consumer { String value; }',
    'import org.springframework.beans.factory.annotation.Value; @Value("x") class Consumer { String value; }',
    'import lombok.*; @interface Value {} @Value class Consumer { String value; }',
    'import lombok.*; import org.springframework.beans.factory.annotation.*; @Value class Consumer { String value; }',
    'import lombok.*; import io.micronaut.context.annotation.*; @Value class Consumer { String value; }',
    'import lombok.*; import static custom.Tags.Value; @Value class Consumer { String value; }',
    'import lombok.*; enum Holder { ; @interface Value {} @Value static class Consumer { String value; } }',
    'import lombok.Value; class Outer { @interface Value {} @Value class Consumer { String value; } }',
    'import lombok.*; @interface Outer { @interface Value {} @Value class Consumer { String value; } }',
    '@custom.Value class Consumer { String value; }',
  ])('refuses an unproven or non-Lombok Value annotation: %s', (source) => {
    expect(synthesized(source).graph.symbols).toEqual([]);
  });

  it.each([
    'import lombok.*; import custom.*; @Value class Consumer { String value; }',
    'import lombok.*; import java.util.*; @Value class Consumer { String value; }',
    'import lombok.*; import static custom.Tags.*; @Value class Consumer { String value; }',
    'import lombok.*; enum Holder { ; @Value static class Consumer { String value; } }',
  ])('proves Lombok Value through lombok.* beside an unrelated wildcard: %s', (source) => {
    expect(synthesized(source).graph.symbols.map((symbol) => symbol.name)).toEqual(['getValue']);
  });

  it('keeps every Data accessor with java.util.* beside lombok.*', () => {
    const result = synthesized(`import lombok.*;
import java.util.*;
@Data class Consumer { private String name; private List<String> tags; }
class Other { String getName() { return null; } }`);
    expect(result.graph.symbols.map((symbol) => `${symbol.ownerId}.${symbol.name}`).sort()).toEqual(
      [
        'Class:Example.java:Consumer.getName',
        'Class:Example.java:Consumer.getTags',
        'Class:Example.java:Consumer.setName',
        'Class:Example.java:Consumer.setTags',
      ],
    );
  });

  it('keeps JPA entity accessors with javax.persistence.* beside lombok.*', () => {
    const result = synthesized(`import javax.persistence.*;
import lombok.*;
@Entity @Getter @Setter class Consumer { private String email; }
class Other { String getEmail() { return null; } }`);
    expect(result.graph.symbols.map((symbol) => `${symbol.ownerId}.${symbol.name}`).sort()).toEqual(
      ['Class:Example.java:Consumer.getEmail', 'Class:Example.java:Consumer.setEmail'],
    );
  });

  it('makes FieldDefaults(makeFinal = true) fields final for Data setters, honoring NonFinal', () => {
    const result = synthesized(`import lombok.Data;
import lombok.experimental.FieldDefaults;
import lombok.experimental.NonFinal;
@Data @FieldDefaults(makeFinal = true, level = lombok.AccessLevel.PRIVATE) class Consumer {
  String fixed;
  @NonFinal String mutable;
}
@Data @FieldDefaults(makeFinal = false) class Open { String name; }`);
    expect(result.graph.symbols.map((symbol) => `${symbol.ownerId}.${symbol.name}`).sort()).toEqual(
      [
        'Class:Example.java:Consumer.getFixed',
        'Class:Example.java:Consumer.getMutable',
        'Class:Example.java:Consumer.setMutable',
        'Class:Example.java:Open.getName',
        'Class:Example.java:Open.setName',
      ],
    );
  });

  it('emits no setter when FieldDefaults options cannot be read', () => {
    const result = synthesized(`import lombok.Data;
import lombok.experimental.FieldDefaults;
@Data @FieldDefaults(makeFinal = Flags.FINAL) class Consumer { String name; }`);
    expect(result.graph.symbols.map((symbol) => symbol.name)).toEqual(['getName']);
  });

  it('honors Value default-final fields and a proven NonFinal override for explicit setters', () => {
    const result = synthesized(`@lombok.Value class Consumer {
  @lombok.Setter String fixed;
  @lombok.Setter @lombok.experimental.NonFinal String mutable;
}`);
    expect(result.graph.symbols.map((symbol) => symbol.name).sort()).toEqual([
      'getFixed',
      'getMutable',
      'setMutable',
    ]);
  });
});

describe('Lombok constructor inventory for Spring DI', () => {
  it('selects uninitialized final and proven NonNull fields in source/declarator order', () => {
    expect(
      constructorSites(`import lombok.RequiredArgsConstructor;
import lombok.NonNull;
import org.springframework.stereotype.Service;
@Service @RequiredArgsConstructor class Consumer {
  final First first;
  @NonNull Second second;
  final Third initialized = null;
  @NonNull Third initializedNonNull = null;
  static First shared;
  final First $internal = null;
  First plain;
  final First[] array, matrix[];
}`).map((site) => ({ implicit: site.implicitConstructor, dependencies: site.dependencies })),
    ).toEqual([
      {
        implicit: true,
        dependencies: [
          { name: 'first', rawType: 'First', annotations: [] },
          { name: 'second', rawType: 'Second', annotations: [] },
          { name: 'array', rawType: 'First[]', annotations: [] },
          { name: 'matrix', rawType: 'First[][]', annotations: [] },
        ],
      },
    ]);
  });

  it('selects all-args fields while excluding static, dollar and initialized final fields', () => {
    const sites = constructorSites(`import lombok.AllArgsConstructor;
import org.springframework.stereotype.Service;
@Service @AllArgsConstructor class Consumer {
  First first;
  Second second = null;
  final Third fixed = null;
  static Third shared;
  First $internal;
}`);
    expect(sites).toHaveLength(1);
    expect(sites[0].dependencies.map((dependency) => dependency.name)).toEqual(['first', 'second']);
  });

  it.each(['Data', 'Value'])('captures the implied %s constructor', (annotation) => {
    const sites = constructorSites(`import lombok.${annotation};
import org.springframework.stereotype.Service;
@Service @${annotation} class Consumer { final First first; }`);
    expect(sites).toHaveLength(1);
    expect(sites[0].dependencies).toEqual([{ name: 'first', rawType: 'First', annotations: [] }]);
  });

  it.each(['Data', 'Value'])(
    'suppresses the implied %s constructor when source has one',
    (annotation) => {
      const sites = constructorSites(`import lombok.${annotation};
import org.springframework.stereotype.Service;
@Service @${annotation} class Consumer {
  final First first = null;
  Consumer(Second second) {}
}`);
      expect(sites).toHaveLength(1);
      expect(sites[0].dependencies).toEqual([
        { name: 'second', rawType: 'Second', annotations: [] },
      ]);
    },
  );

  it('does not treat a single-static-import Value as Lombok when generating a constructor', () => {
    expect(
      constructorSites(`import lombok.*;
import static custom.Tags.Value;
import org.springframework.stereotype.Service;
@Service @Value class Consumer { First first; }`),
    ).toEqual([]);
  });

  it('excludes an initialized FieldDefaults(makeFinal = true) field from an all-args constructor', () => {
    const sites = constructorSites(`import lombok.AccessLevel;
import lombok.AllArgsConstructor;
import lombok.experimental.FieldDefaults;
import org.springframework.stereotype.Service;
@Service @AllArgsConstructor @FieldDefaults(makeFinal = true, level = AccessLevel.PRIVATE)
class Consumer { Helper helper; Audit audit = new Audit(); }`);
    expect(sites.map((site) => site.dependencies)).toEqual([
      [{ name: 'helper', rawType: 'Helper', annotations: [] }],
    ]);
  });

  it('selects FieldDefaults(makeFinal = true) fields for a required-args constructor, honoring NonFinal', () => {
    const sites = constructorSites(`import lombok.RequiredArgsConstructor;
import lombok.experimental.FieldDefaults;
import lombok.experimental.NonFinal;
import org.springframework.stereotype.Service;
@Service @RequiredArgsConstructor @FieldDefaults(makeFinal = true)
class Consumer { Clock clock; @NonFinal Audit audit; }`);
    expect(sites.map((site) => site.dependencies)).toEqual([
      [{ name: 'clock', rawType: 'Clock', annotations: [] }],
    ]);
  });

  it.each([
    '@lombok.experimental.FieldDefaults(makeFinal = Flags.FINAL)',
    '@lombok.experimental.FieldDefaults(makeFinal = true, unknownOption = 1)',
  ])('refuses a generated constructor when FieldDefaults options are unreadable: %s', (options) => {
    expect(
      constructorSites(`import org.springframework.stereotype.Service;
@Service @lombok.RequiredArgsConstructor ${options} class Consumer { Clock clock; }`),
    ).toEqual([]);
  });

  it('keeps an explicit sole constructor beside a class-level Builder', () => {
    const sites = constructorSites(`import lombok.Builder;
import org.springframework.stereotype.Service;
@Service @Builder class Consumer {
  private final Other other = null;
  Consumer(Repo repo) {}
}`);
    expect(
      sites.map((site) => ({
        implicit: site.implicitConstructor,
        dependencies: site.dependencies,
      })),
    ).toEqual([
      { implicit: true, dependencies: [{ name: 'repo', rawType: 'Repo', annotations: [] }] },
    ]);
  });

  it('models the Builder all-args constructor, which replaces the Data constructor', () => {
    const sites = constructorSites(`import lombok.Builder;
import lombok.Data;
import org.springframework.stereotype.Service;
@Service @Builder(toBuilder = true) @Data class Consumer {
  Repo repo;
  final Other fixed = null;
}`);
    expect(sites.map((site) => site.dependencies)).toEqual([
      [{ name: 'repo', rawType: 'Repo', annotations: [] }],
    ]);
  });

  it.each([
    ['@other.Default', '', '', true],
    ['@Default', 'import other.Default;', '', true],
    ['@Default', '', '@interface Default {}', true],
    ['@Builder.Default', 'import other.Builder;', '', true],
    ['@Builder.Default', 'import lombok.Builder;', 'class Builder { @interface Default {} }', true],
    ['@Builder /* owner */ . Default', 'import lombok.Builder;', '', false],
    ['@Default', 'import lombok.Builder.Default;', '', false],
    ['@Default', 'import lombok.Builder.*;', '', false],
    ['@Default', 'import static lombok.Builder.Default;', '', false],
    ['@Default', 'import static lombok.Builder.*;', '', false],
  ])('resolves %s from %s with member %s', (annotation, imports, member, ordinaryField) => {
    const sites = constructorSites(`${imports}
import org.springframework.stereotype.Service;
@Service @lombok.Builder class Consumer {
  ${member}
  ${annotation} final Other fixed = null;
  Repo repo;
}`);
    expect(sites.map((site) => site.dependencies.map((dependency) => dependency.name))).toEqual(
      ordinaryField ? [['repo']] : [],
    );
  });

  it.each([
    [
      'XArgs constructors beside Builder',
      '@lombok.Builder @lombok.NoArgsConstructor @lombok.AllArgsConstructor',
      'Repo repo;',
    ],
    [
      'a Builder.Default field',
      '@lombok.Builder',
      '@lombok.Builder.Default final Repo repo = null;',
    ],
    ['SuperBuilder', '@lombok.experimental.SuperBuilder', 'Repo repo;'],
  ])('does not infer a sole generated constructor for %s', (_label, annotations, members) => {
    expect(
      constructorSites(`import org.springframework.stereotype.Service;
@Service ${annotations} class Consumer { ${members} }`),
    ).toEqual([]);
  });

  it('uses Value default finality when selecting initialized fields', () => {
    const sites = constructorSites(`import org.springframework.stereotype.Service;
@Service @lombok.Value class Consumer {
  First first;
  Second initialized = null;
  @lombok.experimental.NonFinal Third mutable = null;
}`);
    expect(sites[0].dependencies.map((dependency) => dependency.name)).toEqual([
      'first',
      'mutable',
    ]);
  });

  it.each([
    '@lombok.RequiredArgsConstructor',
    '@lombok.AllArgsConstructor',
    '@lombok.RequiredArgsConstructor(staticName="of")',
    '@lombok.AllArgsConstructor(onConstructor_=@Deprecated)',
    '@lombok.RequiredArgsConstructor @lombok.NoArgsConstructor(force=true)',
    '@lombok.RequiredArgsConstructor @lombok.AllArgsConstructor',
  ])(
    'does not treat a source constructor as sole when generation adds or may add one: %s',
    (annotations) => {
      expect(
        constructorSites(`import org.springframework.stereotype.Service;
@Service ${annotations} class Consumer {
  final First first;
  Consumer(Second second) { first = null; }
}`),
      ).toEqual([]);
    },
  );

  it.each([
    '@RequiredArgsConstructor',
    '@custom.RequiredArgsConstructor',
    '@lombok.RequiredArgsConstructor(staticName="of")',
    '@lombok.AllArgsConstructor(onConstructor_=@Deprecated)',
    '@lombok.RequiredArgsConstructor @lombok.AllArgsConstructor',
  ])('refuses unproven, unsupported or ambiguous generated constructors: %s', (annotations) => {
    expect(
      constructorSites(`import org.springframework.stereotype.Service;
@Service ${annotations} class Consumer { final First first; }`),
    ).toEqual([]);
  });

  it('does not invent constructor parameter Qualifier or property Value facts', () => {
    const sites = constructorSites(`import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.beans.factory.annotation.Value;
@Service @RequiredArgsConstructor class Consumer {
  @Qualifier("first") final First first;
  @Value("property") final Second property;
  final Third safe;
}`);
    expect(sites).toHaveLength(1);
    expect(sites[0].dependencies).toEqual([{ name: 'safe', rawType: 'Third', annotations: [] }]);
  });

  it('preserves explicitly annotated constructor injection even with another generated constructor', () => {
    const sites = constructorSites(`import lombok.AllArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
@Service @AllArgsConstructor class Consumer {
  First first;
  @Autowired Consumer(@Qualifier("chosen") Second second) {}
}`);
    expect(sites).toHaveLength(1);
    expect(sites[0].implicitConstructor).toBe(false);
    expect(sites[0].dependencies[0].annotations[0].name).toBe('Qualifier');
  });

  it('keeps ambiguous Spring wildcard field annotations from becoming unqualified bean dependencies', () => {
    const sites = constructorSites(`import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.*;
import java.util.*;
@Service @lombok.RequiredArgsConstructor class Consumer {
  @Qualifier("first") final First first;
  @Value("property") final Second property;
  final Third safe;
}`);
    expect(sites[0].dependencies).toEqual([{ name: 'safe', rawType: 'Third', annotations: [] }]);
  });

  it('does not treat a known custom field Value annotation as Spring property injection', () => {
    const sites = constructorSites(`import org.springframework.stereotype.Service;
import custom.Value;
@Service @lombok.RequiredArgsConstructor class Consumer {
  @Value final First first;
}`);
    expect(sites[0].dependencies).toEqual([{ name: 'first', rawType: 'First', annotations: [] }]);
  });

  it.each([
    ['Autowired', 'org.springframework.beans.factory.annotation.Autowired'],
    ['Inject', 'jakarta.inject.Inject'],
  ])(
    'keeps the written @%s constructor when a generated constructor has the same signature, and refuses the generated one',
    (annotation, annotationImport) => {
      const sites = constructorSites(`import org.springframework.stereotype.Service;
import ${annotationImport};
@Service @lombok.AllArgsConstructor class Consumer {
  First first;
  @${annotation} Consumer(First chosen) {}
}`);
      expect(
        sites.map((site) => ({
          memberName: site.memberName,
          implicitConstructor: site.implicitConstructor,
          annotations: site.annotations.map((fact) => fact.name),
          dependencies: site.dependencies.map((dependency) => dependency.name),
        })),
      ).toEqual([
        {
          memberName: 'Consumer',
          implicitConstructor: false,
          annotations: [annotation],
          dependencies: ['chosen'],
        },
      ]);
    },
  );

  it('keeps only the written injected constructor when one of two generated constructors clashes with it', () => {
    const sites = constructorSites(`import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Autowired;
@Service @lombok.RequiredArgsConstructor @lombok.AllArgsConstructor class Consumer {
  final First first;
  Second second;
  @Autowired Consumer(First chosen) { this.first = chosen; }
}`);
    expect(sites.map((site) => site.dependencies.map((dependency) => dependency.name))).toEqual([
      ['chosen'],
    ]);
  });

  it('does not make an unannotated written constructor an implicit injection site under a signature clash', () => {
    const sites = constructorSites(`import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Autowired;
@Service @lombok.AllArgsConstructor class Consumer {
  First first;
  @Autowired Consumer(First chosen) {}
  Consumer(Second other) {}
}`);
    expect(sites.map((site) => site.dependencies.map((dependency) => dependency.name))).toEqual([
      ['chosen'],
    ]);
  });

  it('refuses both the generated and the implicit constructor when the clashing written constructor is not annotated', () => {
    expect(
      constructorSites(`import org.springframework.stereotype.Service;
@Service @lombok.AllArgsConstructor class Consumer {
  First first;
  Consumer(First chosen) {}
}`),
    ).toEqual([]);
  });
});
