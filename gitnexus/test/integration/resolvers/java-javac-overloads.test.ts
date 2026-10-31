import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURES } from './helpers.js';

const compilerLocale = ['-J-Duser.language=en', '-J-Duser.country=US'];
const javacAvailable =
  spawnSync('javac', [...compilerLocale, '-version'], { encoding: 'utf8' }).status === 0;

describe('javac oracle for Java overload resolution', () => {
  it.runIf(javacAvailable)(
    'confirms enclosing-subclass access and protected receiver restrictions',
    () => {
      const root = mkdtempSync(path.join(tmpdir(), 'gitnexus-javac-protected-'));
      try {
        const sources = path.join(FIXTURES, 'java-protected-overloads');
        execFileSync('javac', [
          ...compilerLocale,
          '-d',
          root,
          path.join(sources, 'a/A.java'),
          path.join(sources, 'b/B.java'),
        ]);
        expect(execFileSync('java', ['-cp', root, 'b.B'], { encoding: 'utf8' }).trim()).toBe(
          'string,object,object,string,string,string,static-string',
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(javacAvailable)(
    'compiles the exact issue fixture and confirms its six target descriptors',
    () => {
      const root = mkdtempSync(path.join(tmpdir(), 'gitnexus-javac-overloads-'));
      try {
        const sources = path.join(FIXTURES, 'java-overload-types/src/main/java/demo');
        execFileSync('javac', [
          ...compilerLocale,
          '-d',
          root,
          ...readdirSync(sources)
            .filter((name) => name.endsWith('.java'))
            .map((name) => path.join(sources, name)),
        ]);
        const bytecode = execFileSync(
          'javap',
          [
            '-classpath',
            root,
            '-c',
            '-p',
            'demo.LookupService',
            'demo.OrderService',
            'demo.BillingService',
          ],
          { encoding: 'utf8' },
        );
        for (const [descriptor, count] of [
          ['find:(Ljava/util/Collection;)Ljava/util/Map;', 3],
          ['find:(Ljava/lang/Long;)Ldemo/Perm;', 1],
          ['resolve:(Ljava/lang/String;)Ldemo/Perm;', 1],
          ['resolve:(Ljava/lang/Long;)Ldemo/Perm;', 1],
          ['count:(Ldemo/Req;)I', 2],
          ['count:(Ljava/lang/Long;Ldemo/Req;)I', 1],
        ] as const) {
          expect(
            bytecode
              .split('\n')
              .filter((line) => line.includes('invoke') && line.includes(descriptor)),
            descriptor,
          ).toHaveLength(count);
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(javacAvailable)(
    'confirms phase ordering, arrays, invariance, target typing and zero-argument specificity',
    () => {
      const root = mkdtempSync(path.join(tmpdir(), 'gitnexus-javac-phases-'));
      try {
        const file = path.join(root, 'Oracle.java');
        writeFileSync(
          file,
          `import java.util.*;
class Oracle {
 static String phase(Integer x) { return "box"; } static String phase(long x) { return "wide"; }
 static String boxed(long x) { return "unbox"; } static String boxed(Number x) { return "reference"; }
 static String variable(String... x) { return "varargs"; } static String variable(Object x) { return "fixed"; }
 static String empty(Object... x) { return "object"; } static String empty(String... x) { return "string"; }
 static String generic(Collection<Number> x) { return "collection"; } static String generic(Object x) { return "object"; }
 static String primitive(List<Long> x) { return "list"; } static String primitive(Object x) { return "object"; }
 static String array(Object[] x) { return "array"; } static String array(Object x) { return "object"; }
 public static void main(String[] args) {
   List<Long> ids = Arrays.asList(1L);
   System.out.println(String.join(",", phase(1), boxed(Integer.valueOf(1)), variable("x"), empty(),
     generic(ids), generic(Arrays.asList(1L)), generic(Collections.singletonList(1L)),
     primitive(Arrays.asList(new long[]{1L})), array(new int[1][1])));
 }
}`,
        );
        execFileSync('javac', [...compilerLocale, '-d', root, file]);
        expect(execFileSync('java', ['-cp', root, 'Oracle'], { encoding: 'utf8' }).trim()).toBe(
          'wide,reference,fixed,string,object,collection,collection,object,array',
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(javacAvailable)(
    'confirms inherited field precedence and enhanced-for variable scope',
    () => {
      const root = mkdtempSync(path.join(tmpdir(), 'gitnexus-javac-lexical-'));
      try {
        const source = path.join(root, 'Lexical.java');
        writeFileSync(
          source,
          `class Lexical {
 static class Base { String value = "base"; }
 static class Outer { Long value = 1L; class Inner extends Base {
   String pick(String value) { return "string"; } String pick(Long value) { return "long"; }
   String byThis() { return pick(this.value); } String byImplicit() { return pick(value); }
 } }
 static class Loop { Long item = 1L;
   String[] source(String value) { return new String[]{"wrong"}; }
   String[] source(Long value) { return new String[]{"right"}; }
   String body(String value) { return "string"; } String body(Long value) { return "long"; }
   String run() { String result = ""; for (String item : source(item)) result += item + ":" + body(item); return result; }
 }
 public static void main(String[] args) {
   Outer.Inner value = new Outer().new Inner();
   System.out.println(value.byThis() + "," + value.byImplicit() + "," + new Loop().run());
 }
}`,
        );
        execFileSync('javac', [...compilerLocale, '-d', root, source]);
        expect(execFileSync('java', ['-cp', root, 'Lexical'], { encoding: 'utf8' }).trim()).toBe(
          'string,string,right:string',
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(javacAvailable).each([
    [
      'null tie',
      'void choose(String x) {} void choose(Integer x) {} void run() { choose(null); }',
      'ambiguous',
    ],
    [
      'crossed parameters',
      'void choose(String x,Object y) {} void choose(Object x,String y) {} void run() { choose("a","b"); }',
      'ambiguous',
    ],
    [
      'poly target tie',
      'void choose(java.util.List<Number> x) {} void choose(java.util.Collection<Integer> x) {} void run() { choose(java.util.Arrays.asList(1)); }',
      'ambiguous',
    ],
    ['widen then box', 'void choose(Long x) {} void run() { choose(1); }', 'incompatible'],
    [
      'static invocation after selection',
      'static void choose(Object x) {} void choose(String x) {} static void run() { choose("x"); }',
      'non-static method choose(String)',
    ],
    [
      'type-qualified invocation after selection',
      'static void choose(Object x) {} void choose(String x) {} static void run() { Invalid.choose("x"); }',
      'non-static method choose(String)',
    ],
  ])('rejects %s', (_name, body, diagnostic) => {
    const root = mkdtempSync(path.join(tmpdir(), 'gitnexus-javac-invalid-'));
    try {
      const source = path.join(root, 'Invalid.java');
      mkdirSync(path.join(root, 'classes'));
      writeFileSync(source, `class Invalid { ${body} }`);
      const compilation = spawnSync(
        'javac',
        [...compilerLocale, '-d', path.join(root, 'classes'), source],
        {
          encoding: 'utf8',
        },
      );
      expect(compilation.status).not.toBe(0);
      expect(compilation.stderr).toContain(diagnostic);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
