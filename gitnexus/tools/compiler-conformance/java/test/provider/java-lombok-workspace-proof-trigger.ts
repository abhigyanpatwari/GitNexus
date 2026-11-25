import { compareCodeUnits } from '../../../compare.mjs';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type Parser from 'tree-sitter';
import type { ParsedFile } from 'gitnexus-shared';
import { javaProvider } from '../../../../../src/core/ingestion/languages/java.js';
import { extractParsedFile } from '../../../../../src/core/ingestion/scope-extractor-bridge.js';
import { populateClassOwnedMembers } from '../../../../../src/core/ingestion/scope-resolution/scope/walkers.js';
import { reconcileJavaLombokWorkspaceProof } from '../../../../../src/core/ingestion/languages/java/lombok-workspace-proof.js';
import { clearJavaClassAnnotationFacts } from '../../../../../src/core/ingestion/languages/java/capture-side-channel.js';
import { clearJavaPackageFacts } from '../../../../../src/core/ingestion/languages/java/package-facts.js';
import { getJavaParser } from '../../../../../src/core/ingestion/languages/java/query.js';

function reconcile(files: Record<string, string>) {
  clearJavaClassAnnotationFacts();
  clearJavaPackageFacts();
  const trees = new Map<string, Parser.Tree>();
  const before = new Map<string, ParsedFile>();
  for (const [filePath, source] of Object.entries(files)) {
    const tree = getJavaParser().parse(source);
    trees.set(filePath, tree);
    const parsed = extractParsedFile(javaProvider, source, filePath, undefined, tree);
    if (parsed === undefined) throw new Error(`Missing Java extraction: ${filePath}`);
    const captureSideChannel = javaProvider.collectCaptureSideChannel?.(filePath);
    const snapshot = { ...parsed, captureSideChannel };
    populateClassOwnedMembers(snapshot);
    before.set(filePath, snapshot);
  }
  const after = [...before.values()];
  reconcileJavaLombokWorkspaceProof(after, {
    fileContents: new Map(Object.entries(files)),
    treeCache: trees,
  });
  return { before, after: new Map(after.map((parsed) => [parsed.filePath, parsed])) };
}

const getters = (parsed: ParsedFile | undefined) =>
  parsed?.localDefs
    .filter((def) => def.type === 'Method' && def.isSynthetic && !def.isDeleted)
    .map((def) => def.qualifiedName) ?? [];

describe('Java Lombok workspace proof recapture triggers', () => {
  it('does not replace an unchanged file for an unrelated external base and an already-known own-file annotation', () => {
    const result = reconcile({
      'Main.java': `package p;
@lombok.Value class Model { Repo repo; }
@interface AllArgsConstructor {}
@AllArgsConstructor class Custom { Repo repo; }
class Resource implements java.lang.AutoCloseable {
  public void close() {}
}
class Repo {}
`,
    });
    assert.ok(getters(result.before.get('Main.java')).includes('Model.getRepo'));
    assert.equal(result.after.get('Main.java'), result.before.get('Main.java'));
  });

  it('still replaces a file for a foreign same-package annotation shadow', () => {
    const result = reconcile({
      'Model.java': 'package p; import lombok.*; @Value class Model { Repo repo; } class Repo {}',
      'Value.java': 'package p; public @interface Value {}',
    });
    assert.ok(getters(result.before.get('Model.java')).includes('Model.getRepo'));
    assert.notEqual(result.after.get('Model.java'), result.before.get('Model.java'));
    assert.ok(!getters(result.after.get('Model.java')).includes('Model.getRepo'));
  });

  it('still replaces a file for a foreign same-package type-root shadow', () => {
    const result = reconcile({
      'Model.java': 'package p; @lombok.Value class Model { Repo repo; } class Repo {}',
      'lombok.java': 'package p; public class lombok { public @interface Value {} }',
    });
    assert.ok(getters(result.before.get('Model.java')).includes('Model.getRepo'));
    assert.ok(!getters(result.after.get('Model.java')).includes('Model.getRepo'));
  });

  for (const example of [
    ['marker', '@Getter', '\n'],
    ['normal', '@Getter()', '\n'],
    ['CRLF marker', '@Getter', '\r\n'],
    ['CRLF normal', '@Getter()', '\r\n'],
    ['same-line marker', '@Getter', ' '],
    ['same-line normal', '@Getter()', ' '],
  ] as const) {
    it(`retains inherited-shadow correction for ${example[0]} annotations with non-ASCII text`, () => {
      const [_label, annotation, newline] = example;

      const source = [
        '/* café 😀 */ package p; import lombok.*;',
        'class Base { public @interface Getter {} }',
        `class Model extends Base { ${annotation} Repo repo; }`,
        'class Repo {}',
      ].join(newline);
      const result = reconcile({ 'Main.java': source });
      assert.ok(getters(result.before.get('Main.java')).includes('Model.getRepo'));
      assert.notEqual(result.after.get('Main.java'), result.before.get('Main.java'));
      assert.ok(!getters(result.after.get('Main.java')).includes('Model.getRepo'));
    });
  }

  it('retains the original conservative trigger when an anonymous type fact is not mapped to a scope', () => {
    // `Holder.Inner` is read literally and names a workspace type the base
    // lookup misses, so its member types stay undecided.
    const result = reconcile({
      'Main.java': `package p;
@lombok.Value class Model { Repo repo; }
class Resource extends Holder.Inner {}
class Holder { static class Inner {} Object value = new Object() {}; }
class Repo {}
`,
    });
    assert.notEqual(result.after.get('Main.java'), result.before.get('Main.java'));
    assert.ok(getters(result.after.get('Main.java')).includes('Model.getRepo'));
  });
});

describe('Java Lombok workspace proof inherited member types', () => {
  for (const example of [
    [
      'extends RuntimeException',
      'class Ex extends RuntimeException { @Getter private final String code = "x"; }',
      'Ex.getCode',
    ],
    [
      'implements a qualified library interface',
      'class Ex implements java.io.Serializable { @Getter private String code; }',
      'Ex.getCode',
    ],
  ] as const) {
    it(`keeps a field accessor when the base ${example[0]} is outside the workspace`, () => {
      const [_label, model, accessor] = example;

      const result = reconcile({ 'Ex.java': `package p; import lombok.*; ${model}` });
      assert.deepEqual(getters(result.after.get('Ex.java')), [accessor]);
    });
  }

  it('keeps a field-level AccessLevel.NONE when the base is outside the workspace', () => {
    const result = reconcile({
      'Dto.java': `package p; import lombok.*;
@Data class Dto implements java.io.Serializable {
  @Setter(AccessLevel.NONE) private String id;
  private String name;
}`,
    });
    assert.deepEqual(getters(result.after.get('Dto.java')).sort(), [
      'Dto.getId',
      'Dto.getName',
      'Dto.setName',
    ]);
  });

  for (const example of [
    ['Setter', 'getId'],
    ['Getter', 'setId'],
  ] as const) {
    it(`keeps the independent Data accessor when @${example[0]}(NONE) is uncertain`, () => {
      const [annotation, accessor] = example;

      const result = reconcile({
        'Dto.java': `package p; import lombok.*;
@Data class Dto extends Holder.Inner {
  @${annotation}(AccessLevel.NONE) private String id;
  private String name;
}`,
        'Holder.java': 'package p; public class Holder { public static class Inner {} }',
      });
      assert.deepEqual(
        getters(result.after.get('Dto.java')).sort(),
        [`Dto.${accessor}`, 'Dto.getName', 'Dto.setName'].sort(compareCodeUnits),
      );
    });
  }

  it('still vetoes a definite inherited workspace member type', () => {
    const result = reconcile({
      'GModel.java':
        'package p; import lombok.*; class GModel extends GBase { @Getter String name; }',
      'GBase.java': 'package p; public class GBase { public @interface Getter {} }',
    });
    assert.deepEqual(getters(result.before.get('GModel.java')), ['GModel.getName']);
    assert.deepEqual(getters(result.after.get('GModel.java')), []);
  });

  it('proves inherited annotation names separately for each anonymous class during recapture', () => {
    const result = reconcile({
      'p/Plain.java': 'package p; class Plain {}',
      'p/Hidden.java': 'package p; class Hidden { public @interface Getter {} }',
      'p/Value.java': 'package p; public @interface Value {}',
      'p/Host.java': `package p; import lombok.*;
class Host {
  void run() {
    new Plain() { void run() { @Getter class Cell { String text; } } };
    new Hidden() { void run() { @Getter class ShadowCell { String text; } } };
  }
  @Value class Trigger { String mark; }
}`,
    });
    assert.deepEqual(getters(result.before.get('p/Host.java')).sort(), [
      'Cell.getText',
      'ShadowCell.getText',
      'Trigger.getMark',
    ]);
    assert.deepEqual(getters(result.after.get('p/Host.java')), ['Cell.getText']);
  });

  it('does not inherit a private member type', () => {
    const result = reconcile({
      'Model.java':
        'package p; import lombok.Getter; class Model extends Base { @Getter String name; }',
      'Base.java': 'package p; public class Base { private @interface Getter {} }',
    });
    assert.deepEqual(getters(result.after.get('Model.java')), ['Model.getName']);
  });

  it('inherits a package-private member type only inside its package', () => {
    const result = reconcile({
      'p/PkgBase.java': 'package p; public class PkgBase { @interface Getter {} }',
      'p/Same.java':
        'package p; import lombok.Getter; class Same extends PkgBase { @Getter String name; }',
      'q/Other.java':
        'package q; import lombok.Getter; class Other extends p.PkgBase { @Getter String name; }',
    });
    assert.deepEqual(getters(result.after.get('p/Same.java')), []);
    assert.deepEqual(getters(result.after.get('q/Other.java')), ['Other.getName']);
  });
});

describe('Java Lombok workspace proof annotation spelling', () => {
  for (const example of [
    ['a comment after @', '@/*c*/Value'],
    ['a line comment after @', '@ // note\nValue'],
  ] as const) {
    it(`finds a same-package annotation shadow behind ${example[0]}`, () => {
      const [_label, annotation] = example;

      const result = reconcile({
        'Model.java': `package p; import lombok.*; ${annotation} class Model { Repo repo; } class Repo {}`,
        'Value.java': 'package p; public @interface Value {}',
      });
      assert.deepEqual(getters(result.before.get('Model.java')), ['Model.getRepo']);
      assert.deepEqual(getters(result.after.get('Model.java')), []);
    });
  }

  it('lets a single-static-import shadow a same-package sibling and lombok.*', () => {
    const result = reconcile({
      'Model.java':
        'package p; import lombok.*; import static custom.Tags.Value; @Value class Model { Repo repo; } class Repo {}',
      'Value.java': 'package p; public @interface Value {}',
    });
    assert.deepEqual(getters(result.before.get('Model.java')), []);
    assert.deepEqual(getters(result.after.get('Model.java')), []);
  });
});

describe('Java Lombok workspace proof single-static-import of an annotation name', () => {
  const model = (owner: string) =>
    `package p; import lombok.*; import static ${owner}.Value; @Value class Model { Repo repo; } class Repo {}`;

  for (const example of [
    ['a static field', 'public final class Constants { public static final String Value = "v"; }'],
    ['an interface constant', 'public interface Constants { String Value = "v"; }'],
    ['a static method', 'public class Constants { public static String Value() { return ""; } }'],
    [
      'a static field beside a private member type',
      'public class Constants { private @interface Value {} public static final String Value = ""; }',
    ],
    [
      'a static field with a workspace base',
      'public class Constants extends Base { public static final String Value = ""; }',
    ],
  ] as const) {
    it(`proves lombok.* when the workspace owner imports ${example[0]}`, () => {
      const [_label, constants] = example;

      const result = reconcile({
        'p/Model.java': model('custom.Constants'),
        'custom/Constants.java': `package custom; ${constants}`,
        'custom/Base.java': 'package custom; public class Base { public static int size; }',
      });
      assert.deepEqual(getters(result.before.get('p/Model.java')), []);
      assert.deepEqual(getters(result.after.get('p/Model.java')), ['Model.getRepo']);
    });
  }

  for (const example of [
    ['a member annotation type', 'public class Constants { public @interface Value {} }'],
    [
      'an interface member type',
      'public interface Constants { @interface Value {} String OTHER = ""; }',
    ],
    [
      'a member type inherited from a workspace base',
      'public class Constants extends Base { public static final String OTHER = ""; }',
    ],
    [
      'a static field and an inner class it may also name',
      'public class Constants { public class Value {} public static final String Value = ""; }',
    ],
    [
      'a static field with a base outside the workspace',
      'public class Constants extends com.acme.Base { public static final String Value = ""; }',
    ],
  ] as const) {
    it(`keeps refusing lombok.* when the workspace owner imports ${example[0]}`, () => {
      const [_label, constants] = example;

      const result = reconcile({
        'p/Model.java': model('custom.Constants'),
        'custom/Constants.java': `package custom; ${constants}`,
        'custom/Base.java': 'package custom; public class Base { public @interface Value {} }',
      });
      assert.deepEqual(getters(result.after.get('p/Model.java')), []);
    });
  }

  it('keeps refusing, without recapture, a static import whose owner is outside the workspace', () => {
    const result = reconcile({ 'p/Model.java': model('com.acme.Constants') });
    assert.deepEqual(getters(result.before.get('p/Model.java')), []);
    assert.equal(result.after.get('p/Model.java'), result.before.get('p/Model.java'));
  });

  it('lets a same-package sibling, not lombok.*, own a name a static import only names as a field', () => {
    const result = reconcile({
      'p/Model.java': model('custom.Constants'),
      'p/Value.java': 'package p; public @interface Value {}',
      'custom/Constants.java':
        'package custom; public class Constants { public static final String Value = ""; }',
    });
    assert.deepEqual(getters(result.after.get('p/Model.java')), []);
  });
});
