import { compareCodeUnits } from '../compare.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

function write(root, file, contents) {
  const filename = path.join(root, file);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, contents);
}

export function generateLargePackages(root, corpus) {
  const dirs = [];
  function finish(dir, checks, diagnostics) {
    write(dir, 'resolution.json', JSON.stringify({ diagnostics, largePackage: checks }));
    dirs.push(dir);
  }
  for (const count of [205, 505]) {
    for (const variant of ['imported', 'list-shadow', 'root-shadow', 'import-shadow']) {
      const dir = path.join(root, 'large-' + count + '-' + variant);
      const element = variant === 'root-shadow' ? 'models.User' : 'User';
      write(dir, 'models/User.java', 'package models; public class User { public void save() {} }');
      write(
        dir,
        'models/Other.java',
        'package models; public class Other { public void save() {} }',
      );
      write(dir, 'app/Base.java', 'package app; public class Base {}');
      if (variant === 'list-shadow')
        write(dir, 'app/List.java', 'package app; public class List<T> {}');
      if (variant.endsWith('root-shadow') || variant === 'import-shadow')
        write(
          dir,
          'app/models.java',
          'package app; public class models { public static class User { public void save() {} } }',
        );
      for (let i = 0; i < count; i++) {
        const wildcard = i % 2 === 0;
        write(
          dir,
          `app/K${i}.java`,
          `package app;
${wildcard ? 'import java.util.*;' : ''}
${element === 'User' ? 'import models.User;' : ''}
public class K${i}${i % 4 < 2 ? ' extends Base' : ''} {
  ${wildcard ? 'List' : 'java.util.List'}<${element}> items;
  models.User one;
  void viaLambda() { items.forEach(u -> u.save()); }
  void viaLoop() { for (var u : items) u.save(); }
  void viaField() { one.save(); }
}
`,
        );
      }
      const rejected = Math.ceil(count / 2);
      const diagnostics =
        variant === 'list-shadow'
          ? {
              'compiler.err.cant.resolve.location.args': rejected,
              'compiler.err.foreach.not.applicable.to.type': rejected,
            }
          : {};
      finish(dir, { count, methods: ['viaLambda', 'viaLoop', 'viaField'] }, diagnostics);
    }
  }
  for (const variant of ['demand', 'raw', 'shadow']) {
    const count = 205;
    const dir = path.join(root, 'large-205-qualified-' + variant);
    write(dir, 'p/Base.java', 'package p; public class Base {}');
    write(dir, 'p/User.java', 'package p; public class User { public void save() {} }');
    write(dir, 'p/Other.java', 'package p; public class Other { public void save() {} }');
    if (variant === 'shadow') write(dir, 'p/List.java', 'package p; public class List<T> {}');
    for (let i = 0; i < count; i++) {
      write(
        dir,
        `p/K${i}.java`,
        `package p;
${variant === 'raw' ? '' : 'import java.util.*;'}
class K${i} extends Base {
  ${variant === 'raw' ? 'java.util.List' : 'List'}<User> items;
  void runEach() { items.forEach(u -> u.save()); }
  void runFor() { for (var u : items) u.save(); }
}`,
      );
    }
    finish(
      dir,
      { count, methods: ['runEach', 'runFor'] },
      variant === 'shadow'
        ? {
            'compiler.err.cant.resolve.location.args': count,
            'compiler.err.foreach.not.applicable.to.type': count,
          }
        : {},
    );
  }
  const dir = path.join(root, 'large-inherited-field-siblings');
  fs.cpSync(path.join(corpus, 'inherited-field-siblings'), dir, { recursive: true });
  for (let i = 0; i < 501; i++) write(dir, `src/app/F${i}.java`, `package app; class F${i} {}`);
  dirs.push(dir);
  return dirs;
}

export function checkLargePackage(graph, ref, { count, methods }) {
  const sources = [...ref.methods].filter(([, m]) => methods.includes(m.name));
  assert.equal(sources.length, count * methods.length, 'Compiler caller count');
  const positions = new Set(sources.map(([pos]) => pos));
  const expected = ref.calls
    .filter((c) => c.name === 'save' && positions.has(c.from))
    .map((c) => c.from + ' -> ' + c.to)
    .sort(compareCodeUnits);
  const pos = (n) =>
    n.properties.filePath + '#' + (n.properties.startLine + 1) + ':' + n.properties.startColumn;
  const callers = [...graph.iterNodes()].filter(
    (n) => n.label === 'Method' && methods.includes(n.properties.name),
  );
  assert.deepEqual(
    callers.map(pos).sort(compareCodeUnits),
    [...positions].sort(compareCodeUnits),
    'Published callers',
  );
  const ids = new Set(callers.map((n) => n.id));
  const actual = [...graph.iterRelationshipsByType('CALLS')]
    .flatMap((edge) => {
      if (!ids.has(edge.sourceId)) return [];
      const target = graph.getNode(edge.targetId);
      return target.properties.name === 'save'
        ? [pos(graph.getNode(edge.sourceId)) + ' -> ' + pos(target)]
        : [];
    })
    .sort(compareCodeUnits);
  assert.deepEqual(actual, expected, 'Element and field targets across the whole package');
  return callers.length;
}
