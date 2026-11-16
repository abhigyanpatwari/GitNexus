import { describe, expect, it } from 'vitest';
import { makeScopeId, type ParsedFile } from 'gitnexus-shared';
import { emitJavaScopeCaptures } from '../../../../src/core/ingestion/languages/java/captures.js';
import { getJavaOverloadFacts } from '../../../../src/core/ingestion/languages/java/overload-argument-facts.js';
import { javaProvider } from '../../../../src/core/ingestion/languages/java.js';
import { extract } from '../../../../src/core/ingestion/scope-extractor.js';

const file = 'Identity.java';
function parse(source: string) {
  return extract(emitJavaScopeCaptures(source, file), file, javaProvider);
}
function refs(parsed: ParsedFile, name: string) {
  return parsed.scopes.flatMap((scope) => {
    const ref = scope.typeBindings.get(name);
    return ref === undefined ? [] : [ref];
  });
}

describe('Java contextual types retain the producer declaration environment', () => {
  it('canonicalizes an imported element before entering a nested same-named class', () => {
    const parsed = parse(`import java.util.List; import a.User;
class Outer {
  List<User> users;
  void direct() { users.forEach(x -> x.save()); }
  class Inner {
    static class User { void save() {} }
    void callback() { users.forEach(x -> x.save()); }
    void loop() { for (var x : users) x.save(); }
  }
}`);
    const outer = getJavaOverloadFacts(file)!.types.find((type) => type.simpleName === 'Outer')!;
    expect(refs(parsed, 'x')).toHaveLength(3);
    for (const ref of refs(parsed, 'x')) {
      expect(ref.declaredSpelling).toBe('a.User');
      expect(ref.declaredAtScope).toBe(
        makeScopeId({ filePath: file, range: outer.range, kind: 'Class' }),
      );
    }
  });

  it('anchors a known current-file element on its own Class scope', () => {
    const parsed = parse(`import java.util.List;
class User { void save() {} }
class Outer {
  List<User> users;
  class Inner {
    static class User { void save() {} }
    void callback() { users.forEach(x -> x.save()); }
  }
}`);
    const user = getJavaOverloadFacts(file)!.types.find((type) => type.simpleName === 'User')!;
    const [ref] = refs(parsed, 'x');
    expect(ref?.rawName).toBe('User');
    expect(ref?.declaredAtScope).toBe(
      makeScopeId({ filePath: file, range: user.range, kind: 'Class' }),
    );
  });

  it('keeps nested generic and array evidence without inventing raw java-root provenance', () => {
    const parsed = parse(`import java.util.List;
class User { void save() {} }
class Outer {
  List<List<User[]>> groups;
  void run() { groups.forEach(list -> list.forEach(array -> { for (var item : array) item.save(); })); }
}`);
    const user = getJavaOverloadFacts(file)!.types.find((type) => type.simpleName === 'User')!;
    const userScope = makeScopeId({ filePath: file, range: user.range, kind: 'Class' });
    expect(refs(parsed, 'list')[0]?.declaredSpelling).toBe('java.util.List<User[]>');
    expect(refs(parsed, 'array')[0]?.rawName).toBe('User[]');
    expect(refs(parsed, 'array')[0]?.declaredAtScope).toBe(userScope);
    expect(refs(parsed, 'item')[0]?.rawName).toBe('User');
    expect(refs(parsed, 'item')[0]?.declaredAtScope).toBe(userScope);
    for (const name of ['list', 'array', 'item']) {
      expect(refs(parsed, name)[0]?.source).toBe('parameter-annotation');
    }
  });

  it('retains raw java-root validation at the original container declaration', () => {
    const parsed = parse(`class User { void save() {} }
class Outer {
  java.util.List<java.util.List<User[]>> groups;
  void run() { groups.forEach(list -> list.forEach(array -> { for (var item : array) item.save(); })); }
}`);
    const outer = getJavaOverloadFacts(file)!.types.find((type) => type.simpleName === 'Outer')!;
    const outerScope = makeScopeId({ filePath: file, range: outer.range, kind: 'Class' });
    for (const name of ['list', 'array', 'item']) {
      expect(refs(parsed, name)[0]?.source).toBe('receiver-propagated');
      expect(refs(parsed, name)[0]?.declaredAtScope).toBe(outerScope);
    }
  });

  it('declines an unresolved producer argument that a later local type could reinterpret', () => {
    const parsed = parse(`import java.util.List;
class Outer {
  List<User> users;
  void run() { class User { void save() {} } users.forEach(x -> x.save()); }
}`);
    expect(refs(parsed, 'x')).toEqual([]);
    expect(parsed.scopes.some((scope) => scope.lexicalNames?.has('x'))).toBe(true);
  });
});
