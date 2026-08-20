/**
 * Java route-path constant resolution (#2391 Java binding).
 *
 * Fixtures sampled from REAL Winning Health WiNEX-Outpatient source shapes
 * (lesson from the vendor-alias PR #2883 review: hand-written textbook
 * fixtures missed the dominant real-world spelling — 1198 constant-ref
 * routes vs 2 literals in the real repo).
 *
 * Real shapes covered (counts from the live repo):
 *  - `@WinPostMapping(ApiPathConstants.DIAGNOSIS_SAVE_V1)` — qualified ref,
 *    1063 occurrences
 *  - `@WinPostMapping(value = ApiPathConstants.X)` / `(path = X)` — named
 *    argument, 414+ occurrences
 *  - `@WinPostMapping(API_CIS_GET_TREATMENT_ORDER_V1)` — static-imported bare
 *    name, 79 files
 *  - `public static final String API = OTHER + "suffix"` — composed constant
 *  - interface constants (implicitly static final)
 *  - same-package simple-name collision handled by unique-suffix import
 *    resolution across Maven modules
 *  - FQN-qualified annotation value (4 occurrences)
 *  - unresolvable references floor to skip (never a phantom path)
 */

import { describe, expect, it } from 'vitest';
import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import {
  extractJavaModuleConstants,
  parseJavaConstOperands,
  resolveJavaConstant,
  resolveJavaImport,
  type RepoConstants,
} from '../../src/core/ingestion/route-extractors/java-const-resolver.js';

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

    @WinPostMapping(ApiPathConstants.DIAGNOSIS_SAVE_V1)
    public String save() { return "{}"; }

    @WinPostMapping(value = ApiPathConstants.DIAGNOSIS_SAVE_V2)
    public String saveV2() { return "{}"; }

    @WinPostMapping(path = ApiPathConstants.API_CIS_SAVE_SUMMARY)
    public String saveSummary() { return "{}"; }
}`;

const STATIC_IMPORT_CONTROLLER = `package com.winning.opt.cis.controller;

import static com.winning.opt.diagnosis.api.constants.ApiPathConstants.DIAGNOSIS_SAVE_V1;

public class CisController {

    @WinPostMapping(DIAGNOSIS_SAVE_V1)
    public String save() { return "{}"; }
}`;

const INTERFACE_CONSTANTS_FILE = `package com.winning.opt.labtest.api.constants;

public interface LabApiPath {
    String LAB_QUERY_V1 = "/api/v1/labtest/query";
}`;

const WIN_POST_MAPPING = `package com.winning.opt.annotations;

public @interface WinPostMapping {
    String value() default "";
    String path() default "";
}`;

// Fake minimal annotation so fixtures parse — the alias layer treats any
// *Mapping-suffixed annotation as a route annotation.

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
    assert.strictEqual(routes.length, 1);
    assert.strictEqual(routes[0].httpMethod, 'POST');
    assert.strictEqual(routes[0].routePathExpr, 'ApiPathConstants.DIAGNOSIS_SAVE_V1');
    assert.ok(routes[0].routePathOperands && routes[0].routePathOperands.length > 0);
    assert.strictEqual(routes[0].routePath, '');
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
    assert.strictEqual(routes.length, 1);
    assert.strictEqual(routes[0].routePath, '/literal/path');
    assert.strictEqual(routes[0].routePathExpr, undefined);
  });
});

describe('qualified-ref recursion cycle guard (maintainer point 5)', () => {
  it('self-import: qualified self-reference terminates with null, not a stack overflow', () => {
    const repo = repoOf({
      'src/main/java/com/example/SelfConsts.java': `package com.example;
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
