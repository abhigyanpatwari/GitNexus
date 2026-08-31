/**
 * Java route-path constant resolution (#2391 Java binding).
 *
 * Fixtures sampled from REAL Winning Health WiNEX-Outpatient source shapes
 * (lesson from the vendor-alias PR #2883 review: hand-written textbook
 * fixtures missed the dominant real-world spelling — 1198 constant-ref
 * routes vs 2 literals in the real repo).
 *
 * Value shapes covered, spelled with the Spring annotations this branch
 * actually recognises (`@PostMapping` & co., bare or fully qualified):
 *  - `@PostMapping(ApiPathConstants.DIAGNOSIS_SAVE_V1)` — qualified ref, the
 *    dominant real-world spelling (1063 occurrences in the source corpus)
 *  - `@PostMapping(value = ApiPathConstants.X)` / `(path = X)` — named
 *    argument, 414+ occurrences
 *  - `@PostMapping(API_CIS_GET_TREATMENT_ORDER_V1)` — static-imported bare
 *    name, 79 files
 *  - `public static final String API = OTHER + "suffix"` — composed constant
 *  - interface constants (implicitly static final)
 *  - escaped characters survive folding identically to the literal path
 *  - same-package simple-name collision floors to skip across Maven modules
 *  - FQN-qualified annotation value (4 occurrences)
 *  - unresolvable references floor to skip (never a phantom path)
 *
 * NOT covered, deliberately: the vendor alias `@WinPostMapping`. The corpus is
 * dominated by it, but Spring alias recognition is an EXACT-NAME map
 * (`spring-shared.ts`) on this base — there is no `*Mapping`-suffix rule, #2883
 * is still open — so `@PostMapping(...)` extracts zero routes here no matter
 * how the constant folds. A fixture written in that spelling would be dead
 * (one was, and CodeQL flagged it). Constant folding and alias recognition are
 * independent: when #2883 lands, every shape below works unchanged for aliases.
 */

import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import {
  expandJavaWildcardStaticImports,
  extractJavaModuleConstants,
  foldJavaOperands,
  isJavaConstantFile,
  parseJavaConstOperands,
  resolveJavaConstant,
  resolveJavaImport,
  type RepoConstants,
} from '../../src/core/ingestion/route-extractors/java-const-resolver.js';
import { javaProvider } from '../../src/core/ingestion/languages/java.js';
import { unquoteSpringLiteral } from '../../src/core/ingestion/route-extractors/spring-shared.js';

const parser = new Parser();
parser.setLanguage(Java);

function parse(src: string): Parser.Tree {
  return parser.parse(src);
}

/** Build a RepoConstants map from virtual files: { 'a/b/C.java': source }. */
function repoOf(files: Record<string, string>): RepoConstants {
  const map = new Map();
  for (const [key, src] of Object.entries(files)) {
    map.set(key, extractJavaModuleConstants(parse(src)));
  }
  return map;
}

// ─── Real WiNEX shapes ────────────────────────────────────────────────────

const CONSTANTS_FILE = `package com.winning.opt.diagnosis.api.constants;

import static com.winning.opt.common.constants.api.ApiPath.API_CIS_V1;

public class ApiPathConstants {

    private ApiPathConstants() {
    }

    public static final String DIAGNOSIS_SAVE_V1 = "/api/v1/app_record_cis_outpatient_diagnosis/encounter_diagnosis/add";

    public static final String DIAGNOSIS_SAVE_V2 = "/api/v2/app_record_cis_outpatient_diagnosis/encounter_diagnosis/add";

    public static final String API_CIS_SAVE_SUMMARY = API_CIS_V1 + "summary/save";
}`;

const COMMON_API_FILE = `package com.winning.opt.common.constants.api;

public class ApiPath {

    public static final String API_CIS_V1 = "/api/v1/cis/";
}`;

const CONTROLLER_FILE = `package com.winning.opt.diagnosis.controller;

import com.winning.opt.diagnosis.api.constants.ApiPathConstants;

public class DiagnosisController {

    @PostMapping(ApiPathConstants.DIAGNOSIS_SAVE_V1)
    public String save() { return "{}"; }

    @PostMapping(value = ApiPathConstants.DIAGNOSIS_SAVE_V2)
    public String saveV2() { return "{}"; }

    @PostMapping(path = ApiPathConstants.API_CIS_SAVE_SUMMARY)
    public String saveSummary() { return "{}"; }
}`;

const STATIC_IMPORT_CONTROLLER = `package com.winning.opt.cis.controller;

import static com.winning.opt.diagnosis.api.constants.ApiPathConstants.DIAGNOSIS_SAVE_V1;

public class CisController {

    @PostMapping(DIAGNOSIS_SAVE_V1)
    public String save() { return "{}"; }
}`;

const INTERFACE_CONSTANTS_FILE = `package com.winning.opt.labtest.api.constants;

public interface LabApiPath {
    String LAB_QUERY_V1 = "/api/v1/labtest/query";
}`;

describe('extractJavaModuleConstants', () => {
  it('collects static final String literals with class-qualified aliases', () => {
    const mc = extractJavaModuleConstants(parse(CONSTANTS_FILE));
    expect(mc.literals.get('DIAGNOSIS_SAVE_V1')).toBe(
      '/api/v1/app_record_cis_outpatient_diagnosis/encounter_diagnosis/add',
    );
    expect(mc.literals.get('ApiPathConstants.DIAGNOSIS_SAVE_V1')).toBe(
      '/api/v1/app_record_cis_outpatient_diagnosis/encounter_diagnosis/add',
    );
  });

  it('records composed constants as operand expressions', () => {
    const mc = extractJavaModuleConstants(parse(CONSTANTS_FILE));
    const expr = mc.exprs.get('API_CIS_SAVE_SUMMARY');
    expect(expr).toEqual([
      { kind: 'ref', name: 'API_CIS_V1' },
      { kind: 'literal', value: 'summary/save' },
    ]);
  });

  it('records class and static imports', () => {
    const mc = extractJavaModuleConstants(parse(CONTROLLER_FILE));
    expect(mc.imports.get('ApiPathConstants')).toEqual({
      module: 'com.winning.opt.diagnosis.api.constants.ApiPathConstants',
      originalName: 'ApiPathConstants',
    });
    const mcStatic = extractJavaModuleConstants(parse(STATIC_IMPORT_CONTROLLER));
    expect(mcStatic.imports.get('DIAGNOSIS_SAVE_V1')).toEqual({
      module: 'com.winning.opt.diagnosis.api.constants.ApiPathConstants',
      originalName: 'DIAGNOSIS_SAVE_V1',
    });
  });

  it('collects interface constants (implicitly static final)', () => {
    const mc = extractJavaModuleConstants(parse(INTERFACE_CONSTANTS_FILE));
    expect(mc.literals.get('LAB_QUERY_V1')).toBe('/api/v1/labtest/query');
  });

  it('ignores non-static or non-String fields', () => {
    const src = `package p;
public class C {
    public static final int COUNT = 5;
    public String instance = "x";
    static final String PRIVATE_OK = "/ok";
}`;
    const mc = extractJavaModuleConstants(parse(src));
    expect(mc.literals.has('COUNT')).toBe(false);
    expect(mc.literals.has('instance')).toBe(false);
    expect(mc.literals.get('PRIVATE_OK')).toBe('/ok');
  });
});

describe('resolveJavaImport', () => {
  const keys = new Set([
    'winning-opt-diagnosis/src/main/java/com/winning/opt/diagnosis/api/constants/ApiPathConstants.java',
    'winning-opt-common/src/main/java/com/winning/opt/common/constants/api/ApiPath.java',
  ]);

  it('resolves a package import to the unique path-suffix file', () => {
    const hit = resolveJavaImport(
      'winning-opt-diagnosis/src/main/java/com/winning/opt/diagnosis/controller/DiagnosisController.java',
      'com.winning.opt.diagnosis.api.constants.ApiPathConstants',
      keys,
    );
    expect(hit).toBe(
      'winning-opt-diagnosis/src/main/java/com/winning/opt/diagnosis/api/constants/ApiPathConstants.java',
    );
  });

  it('resolves a static import (class.member → class file)', () => {
    const hit = resolveJavaImport(
      'winning-opt-cis/src/main/java/com/winning/opt/cis/controller/CisController.java',
      'com.winning.opt.diagnosis.api.constants.ApiPathConstants',
      keys,
    );
    expect(hit).toBe(
      'winning-opt-diagnosis/src/main/java/com/winning/opt/diagnosis/api/constants/ApiPathConstants.java',
    );
  });

  it('returns null when the class does not exist in the repo map', () => {
    const hit = resolveJavaImport('a/A.java', 'com.example.notthere.NoConst', keys);
    expect(hit).toBeNull();
  });
});

describe('resolveJavaConstant end-to-end (real repo shapes)', () => {
  const repo = repoOf({
    'winning-opt-diagnosis/src/main/java/com/winning/opt/diagnosis/api/constants/ApiPathConstants.java':
      CONSTANTS_FILE,
    'winning-opt-common/src/main/java/com/winning/opt/common/constants/api/ApiPath.java':
      COMMON_API_FILE,
  });
  const controllerKey =
    'winning-opt-diagnosis/src/main/java/com/winning/opt/diagnosis/controller/DiagnosisController.java';

  it('resolves qualified refs via the class import chain', () => {
    // The controller imports ApiPathConstants; the ref name is qualified.
    // Hand-rolled two-step: import resolves the class, qualified alias carries the field.
    const mc = extractJavaModuleConstants(parse(CONTROLLER_FILE));
    const targetFile = resolveJavaImport(
      controllerKey,
      mc.imports.get('ApiPathConstants')!.module,
      new Set(repo.keys()),
    );
    expect(targetFile).toBeTruthy();
    const value = resolveJavaConstant(targetFile!, 'ApiPathConstants.DIAGNOSIS_SAVE_V1', repo);
    expect(value).toBe('/api/v1/app_record_cis_outpatient_diagnosis/encounter_diagnosis/add');
  });

  it('folds composed constants across files (static import + concat)', () => {
    const mc = extractJavaModuleConstants(parse(CONSTANTS_FILE));
    const targetFile = resolveJavaImport(
      'winning-opt-diagnosis/src/main/java/com/winning/opt/diagnosis/api/constants/ApiPathConstants.java',
      mc.imports.get('API_CIS_V1')!.module,
      new Set(repo.keys()),
    );
    expect(targetFile).toBe(
      'winning-opt-common/src/main/java/com/winning/opt/common/constants/api/ApiPath.java',
    );
    const value = resolveJavaConstant(
      'winning-opt-diagnosis/src/main/java/com/winning/opt/diagnosis/api/constants/ApiPathConstants.java',
      'API_CIS_SAVE_SUMMARY',
      repo,
    );
    expect(value).toBe('/api/v1/cis/summary/save');
  });

  it('floors to null on unresolvable names (skip, never guess)', () => {
    expect(resolveJavaConstant(controllerKey, 'NOT_A_THING', repo)).toBeNull();
  });
});

describe('parseJavaConstOperands', () => {
  it('parses a bare identifier ref', () => {
    const tree = parse(`package p; public class C { static final String X = Y; }`);
    let valueNode: Parser.SyntaxNode | null = null;
    const walk = (n: Parser.SyntaxNode): void => {
      if (n.type === 'variable_declarator') {
        const v = n.childForFieldName('value');
        if (v) valueNode = v;
      }
      for (const c of n.children ?? []) walk(c);
    };
    walk(tree.rootNode);
    expect(parseJavaConstOperands(valueNode)).toEqual([{ kind: 'ref', name: 'Y' }]);
  });

  it('parses left-associative + chains', () => {
    const tree = parse(`package p; public class C { static final String X = A + "/b" + C; }`);
    let valueNode: Parser.SyntaxNode | null = null;
    const walk = (n: Parser.SyntaxNode): void => {
      if (n.type === 'variable_declarator') {
        const v = n.childForFieldName('value');
        if (v) valueNode = v;
      }
      for (const c of n.children ?? []) walk(c);
    };
    walk(tree.rootNode);
    expect(parseJavaConstOperands(valueNode)).toEqual([
      { kind: 'ref', name: 'A' },
      { kind: 'literal', value: '/b' },
      { kind: 'ref', name: 'C' },
    ]);
  });

  it('returns null for calls and non-string shapes', () => {
    const tree = parse(
      `package p; public class C { static final String X = String.format("%s", a); }`,
    );
    let valueNode: Parser.SyntaxNode | null = null;
    const walk = (n: Parser.SyntaxNode): void => {
      if (n.type === 'variable_declarator') {
        const v = n.childForFieldName('value');
        if (v) valueNode = v;
      }
      for (const c of n.children ?? []) walk(c);
    };
    walk(tree.rootNode);
    expect(parseJavaConstOperands(valueNode)).toBeNull();
  });
});

// ── Ingestion extractor level: constant-referencing annotation values ──
// (regression for the review finding where the route loop's `!valueNode`
// guard dropped every @value_expr match before the operand branch ran)
describe('extractSpringRoutes constant value', () => {
  it('emits routePathExpr + operands for @Mapping(CONSTS.X)', async () => {
    const { extractSpringRoutes } =
      await import('../../src/core/ingestion/route-extractors/spring.js');
    const tree = parser.parse(`
package com.winning.opt.demo;
public class DemoController {
  @org.springframework.web.bind.annotation.PostMapping(ApiPathConstants.DIAGNOSIS_SAVE_V1)
  public String save() { return "ok"; }
}`);
    const routes = extractSpringRoutes(tree, 'DemoController.java', 0);
    expect(routes.length).toBe(1);
    expect(routes[0].httpMethod).toBe('POST');
    expect(routes[0].routePathExpr).toBe('ApiPathConstants.DIAGNOSIS_SAVE_V1');
    expect(routes[0].routePathOperands && routes[0].routePathOperands.length > 0).toBeTruthy();
    expect(routes[0].routePath).toBe('');
  });

  it('keeps literal routes unchanged', async () => {
    const { extractSpringRoutes } =
      await import('../../src/core/ingestion/route-extractors/spring.js');
    const tree = parser.parse(`
package com.winning.opt.demo;
public class DemoController {
  @org.springframework.web.bind.annotation.PostMapping("/literal/path")
  public String save() { return "ok"; }
}`);
    const routes = extractSpringRoutes(tree, 'DemoController.java', 0);
    expect(routes.length).toBe(1);
    expect(routes[0].routePath).toBe('/literal/path');
    expect(routes[0].routePathExpr).toBe(undefined);
  });
});

describe('qualified-ref recursion cycle guard (maintainer point 5)', () => {
  it('self-import: qualified self-reference terminates with null, not a stack overflow', () => {
    const repo = repoOf({
      'src/main/java/com/example/SelfConsts.java': `package com.example;
import com.example.SelfConsts;
public class SelfConsts {
  public static final String X = SelfConsts.X + "/x";
}`,
    });
    // In-file expr records the qualified ref `SelfConsts.X`; resolving it
    // re-enters the same file via the (self) import head — must hit the depth
    // cap, not the V8 stack.
    expect(
      resolveJavaConstant('src/main/java/com/example/SelfConsts.java', 'SelfConsts.X', repo),
    ).toBeNull();
  });

  it('mutual imports: A.X -> B.Y -> A.X terminates with null', () => {
    const repo = repoOf({
      'src/main/java/com/example/AConsts.java': `package com.example;
import com.example.BConsts;
public class AConsts {
  public static final String X = BConsts.Y;
}`,
      'src/main/java/com/example/BConsts.java': `package com.example;
import com.example.AConsts;
public class BConsts {
  public static final String Y = AConsts.X;
}`,
    });
    expect(
      resolveJavaConstant('src/main/java/com/example/AConsts.java', 'AConsts.X', repo),
    ).toBeNull();
  });
});

// ─── Review round 2 regressions (#2980) ───────────────────────────────────

describe('F4: class nested in an interface is NOT implicitly final', () => {
  const SRC = `package p;
public interface Api {
  String BASE = "/api";
  class Holder {
    String mutable = "/mutable";
    static final String OK = "/ok";
  }
  interface Inner {
    String IMPLICIT = "/implicit";
    class Deep {
      String alsoMutable = "/also";
    }
  }
}`;

  it('harvests the interface own fields and explicit static final nested fields', () => {
    const mc = extractJavaModuleConstants(parse(SRC));
    expect(mc.literals.get('BASE')).toBe('/api');
    expect(mc.literals.get('OK')).toBe('/ok');
    expect(mc.literals.get('Holder.OK')).toBe('/ok');
  });

  it('does NOT harvest mutable fields of a class nested in an interface', () => {
    const mc = extractJavaModuleConstants(parse(SRC));
    expect(mc.literals.has('mutable')).toBe(false);
    expect(mc.literals.has('alsoMutable')).toBe(false);
    expect(mc.literals.has('Holder.mutable')).toBe(false);
    expect(mc.exprs.has('mutable')).toBe(false);
  });

  it('still harvests a class directly nested in an interface (own implicit semantics recomputed at each boundary)', () => {
    const mc = extractJavaModuleConstants(parse(SRC));
    expect(mc.literals.get('IMPLICIT')).toBe('/implicit');
    expect(mc.literals.get('Inner.IMPLICIT')).toBe('/implicit');
  });
});

describe('F5: same-name shadowing across nested types drops the stale entry', () => {
  const SRC = `package p;
public class Outer {
  public static final String PATH = "/v1";
  static class Inner {
    // shadows Outer.PATH with a non-foldable initializer
    public static final String PATH = compute();
    static String compute() { return "/v2"; }
  }
}`;

  it('a non-foldable shadow must drop the outer literal, not keep it (skip floor)', () => {
    const mc = extractJavaModuleConstants(parse(SRC));
    expect(mc.literals.has('PATH')).toBe(false);
    expect(mc.exprs.has('PATH')).toBe(false);
  });

  it('qualified aliases survive per class (Outer.PATH resolvable, Inner.PATH not)', () => {
    const mc = extractJavaModuleConstants(parse(SRC));
    expect(mc.literals.get('Outer.PATH')).toBe('/v1');
    expect(mc.literals.has('Inner.PATH')).toBe(false);
  });

  it('a foldable shadow REPLACES the outer value (last binding wins in source order)', () => {
    const src = `package p;
public class Outer {
  public static final String PATH = "/v1";
  static class Inner {
    public static final String PATH = "/v2";
  }
}`;
    const mc = extractJavaModuleConstants(parse(src));
    expect(mc.literals.get('PATH')).toBe('/v2');
    expect(mc.literals.get('Outer.PATH')).toBe('/v1');
    expect(mc.literals.get('Inner.PATH')).toBe('/v2');
  });
});

describe('F3: multi-segment FQN annotation values and constant initializers', () => {
  const constValueOf = (src: string): Parser.SyntaxNode => {
    const cls = parse(src).rootNode.descendantsOfType('class_declaration')[0]!;
    const body = cls.childForFieldName('body')!;
    const field = body.children.find((c) => c.type === 'field_declaration')!;
    const decl = field.children.find((c) => c.type === 'variable_declarator')!;
    return decl.childForFieldName('value')!;
  };

  it('parses com.example.ApiPaths.USERS as ONE ref (nested field_access chain flattened)', () => {
    const ops = parseJavaConstOperands(
      constValueOf(`package p;
public class W {
  public static final String X = com.example.ApiPaths.USERS;
}`),
    );
    expect(ops).toEqual([{ kind: 'ref', name: 'com.example.ApiPaths.USERS' }]);
  });

  it('still rejects call/object-side chains: f().X, this.X, arr[0].X', () => {
    expect(
      parseJavaConstOperands(
        constValueOf(`package p;
public class W { public static final String A = f().X; static Object f(){return null;} }`),
      ),
    ).toBeNull();
    expect(
      parseJavaConstOperands(
        constValueOf(`package p;
public class W { public static final String B = this.Y; String Y = "y"; }`),
      ),
    ).toBeNull();
    expect(
      parseJavaConstOperands(
        constValueOf(`package p;
public class W { public static final String C = arr[0].Z; }`),
      ),
    ).toBeNull();
  });

  it('resolves an FQN-qualified annotation constant end-to-end (query → operands → fold)', () => {
    const repo = repoOf({
      'src/main/java/com/example/ApiPaths.java': `package com.example;
public class ApiPaths {
  public static final String USERS = "/api/v1/users";
}`,
      'src/main/java/com/example/Ctl.java': `package com.example;
import org.springframework.web.bind.annotation.PostMapping;
public class Ctl {
  @PostMapping(com.example.ApiPaths.USERS)
  public void list() {}
}`,
    });
    // The whole FQN arrives as one ref operand (verified against the real
    // tree-sitter-java parse shape); the resolver must follow it via the
    // longest-prefix import fallback.
    expect(
      resolveJavaConstant('src/main/java/com/example/Ctl.java', 'com.example.ApiPaths.USERS', repo),
    ).toBe('/api/v1/users');
  });
});

describe('escaped characters survive folding (review P1)', () => {
  // tree-sitter-java splits a string_literal AROUND its escape_sequence
  // children, so a string_fragment-only join silently deleted every escape:
  // the standard Spring path-variable constraint `{id:\\d+}` folded to
  // `{id:d+}` and a pure-escape literal folded to ''. Worse, the LITERAL path
  // keeps escapes verbatim, so one Java route had two spellings.
  const cases = [
    ['"/user/{id:\\d+}"', '/user/{id:\\d+}'],
    ['"/a\\tb"', '/a\\tb'],
    ['"/a\\u002Fb"', '/a\\u002Fb'],
    ['"\\t"', '\\t'],
    ['""', ''],
    ['"/plain"', '/plain'],
  ] as const;

  it.each(cases)('keeps %s intact through the constant path', (literal, expected) => {
    const mc = extractJavaModuleConstants(
      parse(`public class C { public static final String X = ${literal}; }`),
    );
    expect(mc.literals.get('X')).toBe(expected);
  });

  it.each(cases)('agrees with the literal path for %s', (literal, expected) => {
    // The constant path and `unquoteSpringLiteral` (what a literal-valued
    // @GetMapping goes through) must produce the SAME string, or the graph
    // carries two irreconcilable spellings of one route.
    expect(unquoteSpringLiteral(literal)).toBe(expected);
  });
});

describe('a non-foldable rebind drops the static import too (review P1)', () => {
  it('returns null rather than the shadowed imported value', () => {
    const repo = repoOf({
      'src/main/java/com/x/Base.java': `package com.x;
public class Base { public static final String PATH = "/WRONG-imported"; }`,
      'src/main/java/com/y/C.java': `package com.y;
import static com.x.Base.PATH;
public class C { public static final String PATH = compute(); }`,
    });
    // A local `static final` shadows a static import of the same simple name
    // inside that class (JLS 6.4.1), so the only correct answer is
    // "unresolvable". Leaving the import alive made the fold fall through to
    // it and return the imported literal — a wrong path where the skip floor
    // is owed (#2393's Python defect, reproduced for Java).
    expect(repo.get('src/main/java/com/y/C.java')!.imports.has('PATH')).toBe(false);
    expect(
      foldJavaOperands('src/main/java/com/y/C.java', [{ kind: 'ref', name: 'PATH' }], repo),
    ).toBeNull();
  });

  it('the drop is file-scoped: a sibling class floors to skip, never to a wrong value', () => {
    // These maps are file-level by design (nested types flatten into one
    // namespace), so dropping the import costs a sibling class that
    // legitimately uses it. javac would answer `/imported/b` here; we answer
    // null. Pinned deliberately — the alternative direction is a wrong path.
    const repo = repoOf({
      'src/main/java/com/x/Base.java': `package com.x;
public class Base { public static final String PATH = "/imported"; }`,
      'src/main/java/com/y/Two.java': `package com.y;
import static com.x.Base.PATH;
class A { public static final String PATH = compute(); }
class B { public static final String USE = PATH + "/b"; }`,
    });
    expect(
      foldJavaOperands('src/main/java/com/y/Two.java', [{ kind: 'ref', name: 'B.USE' }], repo),
    ).toBeNull();
  });

  it('a FOLDABLE rebind still wins over the import', () => {
    const repo = repoOf({
      'src/main/java/com/x/Base.java': `package com.x;
public class Base { public static final String PATH = "/imported"; }`,
      'src/main/java/com/y/C.java': `package com.y;
import static com.x.Base.PATH;
public class C { public static final String PATH = "/local"; }`,
    });
    expect(
      foldJavaOperands('src/main/java/com/y/C.java', [{ kind: 'ref', name: 'PATH' }], repo),
    ).toBe('/local');
  });
});

describe('isJavaConstantFile — one gate, both subsystems (review P1)', () => {
  // The ingestion provider and the group extractor's prepareRepo pre-pass used
  // to spell this gate differently. A constant INTERFACE passed the group's and
  // failed ingestion's, so the group published a provider contract while the
  // graph got no Route node — an R4 parity break in the losing direction.
  const shapes = [
    [
      'constant interface (implicitly static final, no import)',
      `package com.x;
public interface ApiPathConstants { String SAVE = "/api/v1/save"; }`,
    ],
    [
      'lowercase interface name',
      `package com.x;
public interface apiPaths { String SAVE = "/api/v1/save"; }`,
    ],
    [
      'reversed modifier order',
      `package com.x;
public class P { public final static String SAVE = "/api/v1/save"; }`,
    ],
    [
      'conventional order',
      `package com.x;
public class P { public static final String SAVE = "/api/v1/save"; }`,
    ],
    [
      'modifiers interleaved',
      `package com.x;
public class P { static public final String SAVE = "/api/v1/save"; }`,
    ],
    [
      'fully-qualified java.lang.String',
      `package com.x;
public class P { public static final java.lang.String SAVE = "/api/v1/save"; }`,
    ],
    [
      'fully-qualified type in an interface',
      `package com.x;
public interface P { java.lang.String SAVE = "/api/v1/save"; }`,
    ],
  ] as const;

  it.each(shapes)('admits %s on BOTH sides', (_name, src) => {
    expect(isJavaConstantFile(src)).toBe(true);
    // The provider hook is what the parse worker actually calls — drive it,
    // not just the regex, so the gate itself is covered and not only the
    // extractor behind it.
    expect(javaProvider.moduleConstantHeuristic?.(src)).toBe(true);
    expect(extractJavaModuleConstants(parse(src)).literals.get('SAVE')).toBe('/api/v1/save');
  });

  it.each([
    [
      'no constant-bearing syntax',
      `package com.x;
public class P { void run() { System.out.println("/not-a-constant"); } }`,
    ],
    [
      'a local String inside a static method',
      `package com.x;
public class P { static void run() { String s = "/local"; } }`,
    ],
    [
      'prose that merely mentions an interface',
      `/** interface EXTENDS (#1951). */
public class A { void f() {} }`,
    ],
  ])('still skips %s', (_name, src) => {
    expect(isJavaConstantFile(src)).toBe(false);
    expect(extractJavaModuleConstants(parse(src)).literals.size).toBe(0);
  });
});

describe('resolveJavaImport honours the documented skip floor (review P2)', () => {
  it('returns null when the same package+class exists in two modules', () => {
    // A nearest-shared-directory tie-break used to pick one. javac resolves
    // duplicate FQNs by classpath order, so proximity can hand back a
    // src/test fixture copy — a silently wrong literal in a resolver whose
    // contract is skip-or-correct.
    const keys = new Set([
      'svc-order/src/main/java/com/x/ApiPaths.java',
      'svc-user/src/main/java/com/x/ApiPaths.java',
    ]);
    expect(
      resolveJavaImport(
        'svc-order/src/main/java/com/x/web/OrderController.java',
        'com.x.ApiPaths',
        keys,
      ),
    ).toBeNull();
  });

  it('still resolves a unique full-suffix match', () => {
    const keys = new Set([
      'svc-order/src/main/java/com/x/ApiPaths.java',
      'svc-user/src/main/java/com/y/ApiPaths.java',
    ]);
    expect(
      resolveJavaImport(
        'svc-order/src/main/java/com/x/web/OrderController.java',
        'com.x.ApiPaths',
        keys,
      ),
    ).toBe('svc-order/src/main/java/com/x/ApiPaths.java');
  });
});

describe('enum and record constants are collected', () => {
  it.each([
    ['enum', 'public enum E { A, B; public static final String P = "/e"; }', 'E'],
    ['record', 'public record R(int x) { public static final String P = "/r"; }', 'R'],
  ])('harvests a static final String declared in a %s', (_kind, src, owner) => {
    const mc = extractJavaModuleConstants(parse(src));
    expect(mc.literals.get('P')).toBe(src.includes('enum') ? '/e' : '/r');
    expect(mc.literals.get(`${owner}.P`)).toBe(src.includes('enum') ? '/e' : '/r');
  });

  it('does not harvest a non-static field of a record', () => {
    const mc = extractJavaModuleConstants(parse('public record R(int x) { String p = "/r"; }'));
    expect(mc.literals.has('p')).toBe(false);
  });
});

describe('constants composed across files through a qualified ref', () => {
  it('folds `X = BConsts.Y + "/tail"` across the import', () => {
    // Operands found INSIDE an initializer used to go straight to the agnostic
    // fold, which only knows bare names — so a qualified operand missed and
    // floored the whole chain to null, even acyclically.
    const repo = repoOf({
      'src/com/example/AConsts.java': `package com.example;
import com.example.BConsts;
public class AConsts { public static final String X = BConsts.Y + "/tail"; }`,
      'src/com/example/BConsts.java': `package com.example;
public class BConsts { public static final String Y = "/y"; }`,
    });
    expect(resolveJavaConstant('src/com/example/AConsts.java', 'X', repo)).toBe('/y/tail');
    expect(
      foldJavaOperands('src/com/example/AConsts.java', [{ kind: 'ref', name: 'AConsts.X' }], repo),
    ).toBe('/y/tail');
  });

  it('a missing link in the chain still floors to null', () => {
    const repo = repoOf({
      'src/com/example/AConsts.java': `package com.example;
import com.example.BConsts;
public class AConsts { public static final String X = BConsts.MISSING + "/tail"; }`,
      'src/com/example/BConsts.java': `package com.example;
public class BConsts { public static final String Y = "/y"; }`,
    });
    expect(resolveJavaConstant('src/com/example/AConsts.java', 'X', repo)).toBeNull();
  });
});

describe('the fold is bounded in time as well as depth', () => {
  it('folds a 30-level shared-descendant DAG instead of exploring 2^30 paths', () => {
    // `X_k = X_{k+1} + X_{k+1}` re-folds each child once per reference without a
    // memo — O(2^depth). MAX_FOLD_LENGTH cannot save it here because every
    // intermediate value is the EMPTY string, so nothing ever accumulates.
    // Un-memoized this took 2.7 s at 26 levels and 11 s at 28, on the main
    // thread, for one route. The assertion is the explicit timeout below: a
    // regression does not fail this test slowly, it fails it.
    const lines = ['public static final String X30 = "";'];
    for (let i = 29; i >= 0; i--) {
      lines.push(`public static final String X${i} = X${i + 1} + X${i + 1};`);
    }
    const repo = repoOf({ 'C.java': `public class C {\n${lines.join('\n')}\n}` });
    expect(resolveJavaConstant('C.java', 'X0', repo)).toBe('');
  }, 5_000);

  it('still caps a chain that genuinely produces a huge string', () => {
    const lines = ['public static final String X30 = "a";'];
    for (let i = 29; i >= 0; i--) {
      lines.push(`public static final String X${i} = X${i + 1} + X${i + 1};`);
    }
    const repo = repoOf({ 'C.java': `public class C {\n${lines.join('\n')}\n}` });
    expect(resolveJavaConstant('C.java', 'X0', repo)).toBeNull();
  }, 5_000);
});

describe('text blocks keep the skip floor', () => {
  it('does not fold a text-block constant into a path with newlines and indentation', () => {
    // `unquoteSpringLiteral` has a `"""` arm that slices 3/-3, which would hand
    // back the raw block — leading newline and incidental indentation included,
    // both of which Java strips — and nothing downstream normalizes it. The old
    // fragment-join returned '' here, i.e. a skip; keep the skip.
    const src = [
      'public class C {',
      '  public static final String X = """',
      '      /api/v1/tb',
      '      """;',
      '}',
    ].join('\n');
    expect(extractJavaModuleConstants(parse(src)).literals.has('X')).toBe(false);
  });
});

describe('wildcard static imports (`import static a.b.C.*`)', () => {
  const WILDCARD_CONTROLLER = `package com.y;
import static com.x.ApiPaths.*;
public class C {
    @PostMapping(SAVE)
    public void save() {}
}`;

  it('records the class FQN and does not bind the class simple name as a field', () => {
    const mc = extractJavaModuleConstants(parse(WILDCARD_CONTROLLER));
    expect(mc.wildcardImports).toEqual(['com.x.ApiPaths']);
    expect(mc.imports.has('ApiPaths')).toBe(false);
    expect(mc.imports.has('SAVE')).toBe(false);
  });

  it('materializes bare names and does not overwrite an explicit static import', () => {
    const constants = extractJavaModuleConstants(
      parse(`package com.x;
public class ApiPaths {
  public static final String SAVE = "/api/v1/save";
  public static final String OTHER = "/api/v1/other";
}`),
    );
    const controller = extractJavaModuleConstants(
      parse(`package com.y;
import static com.x.ApiPaths.SAVE;
import static com.x.ApiPaths.*;
public class C {}`),
    );
    expect(controller.wildcardImports).toEqual(['com.x.ApiPaths']);
    expect(controller.imports.get('SAVE')).toEqual({
      module: 'com.x.ApiPaths',
      originalName: 'SAVE',
    });
    const repo: RepoConstants = new Map([
      ['src/com/x/ApiPaths.java', constants],
      ['src/com/y/C.java', controller],
    ]);
    expandJavaWildcardStaticImports(controller, 'src/com/y/C.java', repo);
    expect(controller.imports.get('SAVE')).toEqual({
      module: 'com.x.ApiPaths',
      originalName: 'SAVE',
    });
    expect(controller.imports.get('OTHER')).toEqual({
      module: 'com.x.ApiPaths',
      originalName: 'OTHER',
    });
  });

  it('folds a wildcard-imported route constant', () => {
    const repo = repoOf({
      'src/main/java/com/x/ApiPaths.java': `package com.x;
public class ApiPaths { public static final String SAVE = "/api/v1/save"; }`,
      'src/main/java/com/y/C.java': WILDCARD_CONTROLLER,
    });
    expandJavaWildcardStaticImports(
      repo.get('src/main/java/com/y/C.java')!,
      'src/main/java/com/y/C.java',
      repo,
    );
    expect(
      foldJavaOperands('src/main/java/com/y/C.java', [{ kind: 'ref', name: 'SAVE' }], repo),
    ).toBe('/api/v1/save');
  });

  it('unresolved wildcard target stays at the skip floor', () => {
    const mc = extractJavaModuleConstants(parse(WILDCARD_CONTROLLER));
    const repo: RepoConstants = new Map([['src/com/y/C.java', mc]]);
    expandJavaWildcardStaticImports(mc, 'src/com/y/C.java', repo);
    expect(foldJavaOperands('src/com/y/C.java', [{ kind: 'ref', name: 'SAVE' }], repo)).toBeNull();
  });

  it('admits wildcard-only files on the harvest heuristic', () => {
    expect(javaProvider.moduleConstantHeuristic?.(WILDCARD_CONTROLLER)).toBe(true);
  });
});

describe('resolveJavaImport POSIX key compare', () => {
  it('matches a backslash-keyed Windows repo path', () => {
    const keys = new Set(['src\\main\\java\\com\\x\\ApiPath.java']);
    expect(resolveJavaImport('a\\A.java', 'com.x.ApiPath', keys)).toBe(
      'src\\main\\java\\com\\x\\ApiPath.java',
    );
  });
});
