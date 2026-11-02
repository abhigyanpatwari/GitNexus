import { describe, it, expect } from 'vitest';
import { javaScopeResolver } from '../../src/core/ingestion/languages/java/scope-resolver.js';
import { runScopeResolution } from '../../src/core/ingestion/scope-resolution/pipeline/run.js';
import { parseFilesWithWorkers } from '../helpers/worker-parse.js';

describe('Java imported return types through worker parsing', () => {
  it.each([
    { reverse: false, returns: 'same spelling' },
    { reverse: true, returns: 'same spelling' },
    { reverse: false, returns: 'different spelling' },
    { reverse: true, returns: 'different spelling' },
    { reverse: false, returns: 'same class' },
    { reverse: true, returns: 'same class' },
  ])(
    'compares transitive return identities ($returns, reverse=$reverse)',
    async ({ reverse, returns }) => {
      const otherType = returns === 'different spelling' ? 'OtherNode' : 'Node';
      const shared = returns === 'same class';
      const files = [
        {
          path: 'a/Node.java',
          content: 'package a; public class Node { public void visitA() {} }',
        },
        {
          path: 'a/TreeA.java',
          content: 'package a; public class TreeA { public Node next() { return new Node(); } }',
        },
        {
          path: `b/${otherType}.java`,
          content: `package b; public class ${otherType} { public void visitB() {} }`,
        },
        {
          path: 'b/TreeB.java',
          content: `package b; ${shared ? 'import a.Node;' : ''} public class TreeB { public ${otherType} next() { return new ${otherType}(); } }`,
        },
        {
          path: 'mid/Mid.java',
          content:
            'package mid; import a.TreeA; import b.TreeB; public class Mid { public TreeA makeA() { return new TreeA(); } }',
        },
        {
          path: 'app/App.java',
          content:
            'package app; import mid.Mid; public class App { public void run() { Mid mid = new Mid(); var a = mid.makeA(); var n = a.next(); n.visitA(); n.visitB(); } }',
        },
      ];
      // No same-package competitor in the positive case: both producers return a.Node.
      if (shared) files.splice(2, 1);
      if (reverse) files.reverse();
      javaScopeResolver.loadResolutionConfig?.('');
      const { graph, model, data } = await parseFilesWithWorkers(files);
      runScopeResolution(
        {
          graph,
          model,
          files,
          preExtractedParsedFiles: new Map(data.parsedFiles.map((file) => [file.filePath, file])),
          onResolved: ({ parsedFiles }) => {
            const app = parsedFiles.find((file) => file.filePath === 'app/App.java');
            const next = app?.scopes
              .find((scope) => scope.id === app.moduleScope)
              ?.typeBindings.get('next');
            if (shared) expect(next?.rawName).toBe('Node');
            else expect(next).toBeUndefined();
          },
        },
        javaScopeResolver,
      );
      const targets = [...graph.iterRelationshipsByType('CALLS')]
        .filter((edge) => edge.sourceId === 'Method:app/App.java:App.run#0')
        .map((edge) => edge.targetId);
      expect(targets).not.toContain(`Method:b/${otherType}.java:${otherType}.visitB#0`);
      if (shared) expect(targets).toContain('Method:a/Node.java:Node.visitA#0');
    },
  );

  it.each([
    { reverse: false, cycle: false },
    { reverse: true, cycle: false },
    { reverse: false, cycle: true },
    { reverse: true, cycle: true },
  ])(
    'resolves a 12-file factory chain (reverse=$reverse, cycle=$cycle)',
    async ({ reverse, cycle }) => {
      const count = 12;
      const files = Array.from({ length: count }, (_, i) => ({
        path: `p${i}/C${i}.java`,
        content: `package p${i};
${i + 1 < count ? `import p${i + 1}.C${i + 1};` : cycle ? 'import p0.C0;' : ''}
public class C${i} {
${i + 1 < count ? `public C${i + 1} next${i}() { return new C${i + 1}(); }` : 'public void finish() {}'}
}`,
      }));
      files.push({
        path: 'app/App.java',
        content: `package app; import p0.C0; public class App { public void run() {
C0 value0 = new C0();
${Array.from({ length: count - 1 }, (_, i) => `var value${i + 1} = value${i}.next${i}();`).join('\n')}
value${count - 1}.finish();
} }`,
      });
      if (reverse) files.reverse();
      javaScopeResolver.loadResolutionConfig?.('');
      const { graph, model, data } = await parseFilesWithWorkers(files);
      runScopeResolution(
        {
          graph,
          model,
          files,
          preExtractedParsedFiles: new Map(data.parsedFiles.map((file) => [file.filePath, file])),
        },
        javaScopeResolver,
      );
      const targets = [...graph.iterRelationshipsByType('CALLS')]
        .filter((edge) => edge.sourceId === 'Method:app/App.java:App.run#0')
        .map((edge) => edge.targetId);
      expect(targets).toEqual(
        expect.arrayContaining(
          Array.from(
            { length: count },
            (_, i) => `Method:p${i}/C${i}.java:C${i}.${i + 1 < count ? `next${i}` : 'finish'}#0`,
          ),
        ),
      );
    },
  );

  it.each([
    { order: 'forward', override: false },
    { order: 'reverse', override: false },
    { order: 'forward', override: true },
    { order: 'reverse', override: true },
  ])(
    'resolves inherited return calls ($order, override=$override)',
    async ({ order, override }) => {
      const files = [
        {
          path: 'p0/Foo.java',
          content: 'package p0; public class Foo { public void fooMethod() {} }',
        },
        {
          path: 'p0/Base.java',
          content:
            'package p0; public class Base { public Foo baseMethod() { return new Foo(); } }',
        },
        {
          path: 'p1/ChildFoo.java',
          content:
            'package p1; import p0.Foo; public class ChildFoo extends Foo { public void childOnly() {} }',
        },
        {
          path: 'p1/C1.java',
          content: `package p1; import p0.Base; public class C1 extends Base {
${override ? 'public ChildFoo baseMethod() { return new ChildFoo(); }' : ''}
}`,
        },
        {
          path: 'p2/App.java',
          content: `package p2; import p1.C1; public class App { public void run() {
C1 c = new C1(); var r = c.baseMethod(); r.${override ? 'childOnly' : 'fooMethod'}();
} }`,
        },
      ];
      if (order === 'reverse') files.reverse();
      javaScopeResolver.loadResolutionConfig?.('');
      const { graph, model, data } = await parseFilesWithWorkers(files);
      runScopeResolution(
        {
          graph,
          model,
          files,
          preExtractedParsedFiles: new Map(data.parsedFiles.map((file) => [file.filePath, file])),
        },
        javaScopeResolver,
      );
      const target = override
        ? 'Method:p1/ChildFoo.java:ChildFoo.childOnly#0'
        : 'Method:p0/Foo.java:Foo.fooMethod#0';
      expect([...graph.iterRelationshipsByType('CALLS')]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sourceId: 'Method:p2/App.java:App.run#0', targetId: target }),
        ]),
      );
    },
  );
});
