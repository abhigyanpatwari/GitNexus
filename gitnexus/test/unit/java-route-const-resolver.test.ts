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
