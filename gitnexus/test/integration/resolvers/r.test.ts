/**
 * R: function definitions (<- and = assignment), S4/R5/R6 classes,
 *    library/require imports, source() includes, pkg::func namespaced calls,
 *    roxygen2 doc parsing, cross-package resolution, heritage
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES,
  getRelationships,
  getNodesByLabel,
  getNodesByLabelFull,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';

describe('R function definitions and calls', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'r-packages'), () => {});
  }, 60000);

  // --- Function detection ---

  it('detects functions defined with <- assignment', () => {
    const functions = getNodesByLabel(result, 'Function');
    expect(functions).toContain('AddOutlierStatuses');
    expect(functions).toContain('CleanData');
  });

  it('detects functions defined with = assignment', () => {
    const functions = getNodesByLabel(result, 'Function');
    expect(functions).toContain('HelperFunc');
  });

  it('detects functions defined with <<- super-assignment', () => {
    const functions = getNodesByLabel(result, 'Function');
    expect(functions).toContain('SuperAssignFunc');
  });

  it('detects functions with dot-separated names', () => {
    const functions = getNodesByLabel(result, 'Function');
    expect(functions).toContain('my.helper.func');
  });

  // --- Class detection ---

  it('detects S4 class defined with setClass', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('DataModel');
  });

  it('detects R5 class defined with setRefClass', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('DataProcessor');
  });

  it('detects R6 class defined with R6::R6Class', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('ResultSet');
  });

  it('detects R6 class defined with bare R6Class() call', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('BareR6');
  });

  // --- Import resolution ---

  it('resolves source() to IMPORTS edge', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const sourceEdge = imports.find(
      (e) => e.sourceFilePath.includes('run_analysis.R') && e.targetFilePath.includes('utils.R'),
    );
    expect(sourceEdge).toBeDefined();
  });

  it('resolves library() to IMPORTS edges for all package files', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const libEdges = imports.filter(
      (e) => e.sourceFilePath.includes('run_analysis.R') && e.targetFilePath.includes('pkgB/'),
    );
    expect(libEdges.length).toBeGreaterThanOrEqual(1);
    expect(libEdges.some((e) => e.targetFilePath.includes('clean_data.R'))).toBe(true);
  });

  it('resolves require() to IMPORTS edges for package files', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const requireEdges = imports.filter(
      (e) => e.sourceFilePath.includes('run_analysis.R') && e.targetFilePath.includes('pkgA/R/'),
    );
    // require("pkgA") should resolve to at least one file in pkgA/R/
    expect(requireEdges.length).toBeGreaterThanOrEqual(1);
  });

  // --- Cross-package resolution ---

  it('resolves cross-package pkgB::CleanData call', () => {
    const calls = getRelationships(result, 'CALLS');
    const crossPkg = calls.find(
      (e) => e.target === 'CleanData' && e.targetFilePath.includes('clean_data.R'),
    );
    expect(crossPkg).toBeDefined();
  });

  // --- Call resolution ---

  it('resolves source()-imported function calls', () => {
    const calls = getRelationships(result, 'CALLS');
    const helperCall = calls.find(
      (e) => e.sourceFilePath.includes('run_analysis.R') && e.target === 'HelperFunc',
    );
    expect(helperCall).toBeDefined();
  });

  // --- R6 method detection ---

  it('detects R6 methods inside public = list(...)', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('initialize');
    expect(methods).toContain('count');
  });

  it('detects R5 methods inside setRefClass(... methods = list(...))', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('process');
  });

  it('emits HAS_METHOD edges from R6 class to its methods', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const r6Methods = hasMethod.filter((e) => e.source === 'ResultSet');
    expect(r6Methods.length).toBeGreaterThanOrEqual(2);
    expect(r6Methods.some((e) => e.target === 'initialize')).toBe(true);
    expect(r6Methods.some((e) => e.target === 'count')).toBe(true);
  });

  it('emits HAS_METHOD edge from R5 class to its methods', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const r5Methods = hasMethod.filter((e) => e.source === 'DataProcessor');
    expect(r5Methods.some((e) => e.target === 'process')).toBe(true);
  });

  // --- R6 private methods and fields ---

  it('detects R6 private methods inside private = list(...)', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('compute');
  });

  it('emits HAS_METHOD edge from R6 class to private method', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const privateMethod = hasMethod.find(
      (e) => e.source === 'AdvancedR6' && e.target === 'compute',
    );
    expect(privateMethod).toBeDefined();
  });

  it('detects R6 private fields with correct visibility', () => {
    const properties = getNodesByLabelFull(result, 'Property');
    const secretKey = properties.find(
      (p) => p.name === 'secret_key' && p.properties.filePath.includes('r6_advanced.R'),
    );
    expect(secretKey).toBeDefined();
    expect(secretKey!.properties.visibility).toBe('private');
  });

  // --- R6 active bindings ---

  it('detects R6 active bindings as methods', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('display_name');
  });

  it('emits HAS_METHOD edge from R6 class to active binding', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const activeBinding = hasMethod.find(
      (e) => e.source === 'AdvancedR6' && e.target === 'display_name',
    );
    expect(activeBinding).toBeDefined();
  });

  it('detects methods inside bare R6Class() call', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const bareMethod = hasMethod.find((e) => e.source === 'BareR6' && e.target === 'get_value');
    expect(bareMethod).toBeDefined();
  });

  // --- R6 field type inference ---

  it('infers R6 field types from default values', () => {
    const properties = getNodesByLabelFull(result, 'Property');

    const nameField = properties.find(
      (p) => p.name === 'name' && p.properties.filePath.includes('r6_advanced.R'),
    );
    expect(nameField).toBeDefined();
    expect(nameField!.properties.declaredType).toBe('character');

    const countField = properties.find(
      (p) => p.name === 'active_count' && p.properties.filePath.includes('r6_advanced.R'),
    );
    expect(countField).toBeDefined();
    expect(countField!.properties.declaredType).toBe('integer');

    const flagField = properties.find(
      (p) => p.name === 'internal_flag' && p.properties.filePath.includes('r6_advanced.R'),
    );
    expect(flagField).toBeDefined();
    expect(flagField!.properties.declaredType).toBe('logical');
  });

  it('resolves rs$count() call to ResultSet.count method', () => {
    const calls = getRelationships(result, 'CALLS');
    const countCall = calls.find(
      (e) =>
        e.sourceFilePath.includes('run_analysis.R') &&
        e.target === 'count' &&
        e.targetFilePath.includes('models.R'),
    );
    expect(countCall).toBeDefined();
  });

  // --- S4 setGeneric / setMethod detection ---

  it('detects S4 setGeneric as a function definition', () => {
    const functions = getNodesByLabel(result, 'Function');
    expect(functions).toContain('validate');
  });

  it('detects S4 setMethod as a method definition', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('validate');
  });

  it('emits HAS_METHOD edge from S4 class to setMethod implementation', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const s4Methods = hasMethod.filter((e) => e.source === 'DataModel');
    expect(s4Methods.some((e) => e.target === 'validate')).toBe(true);
  });

  // --- R6 inherit= heritage ---

  it('emits EXTENDS edge from R6 Child class via inherit= (namespace call)', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    const childEdge = extends_.find((e) => e.source === 'Child' && e.target === 'Parent');
    expect(childEdge).toBeDefined();
  });

  it('detects S4 classes from multi-parent setClass with contains=c()', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('MultiChild');
    expect(classes).toContain('BaseA');
    expect(classes).toContain('BaseB');
  });

  it('emits EXTENDS edges from S4 multi-parent setClass with contains=c()', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    const toBaseA = extends_.find((e) => e.source === 'MultiChild' && e.target === 'BaseA');
    const toBaseB = extends_.find((e) => e.source === 'MultiChild' && e.target === 'BaseB');
    expect(toBaseA).toBeDefined();
    expect(toBaseB).toBeDefined();
  });

  it('emits EXTENDS edge from S4 class with single-parent contains=', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    const edge = extends_.find((e) => e.source === 'DataModel' && e.target === 'VIRTUAL');
    expect(edge).toBeDefined();
  });

  it('emits EXTENDS edge from R6 class defined with bare R6Class() via inherit=', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    const bareEdge = extends_.find((e) => e.source === 'BareR6' && e.target === 'Parent');
    expect(bareEdge).toBeDefined();
  });

  it('applies NAMESPACE exports per package instead of as a repo-wide name set', () => {
    const functions = getNodesByLabelFull(result, 'Function').filter(
      (n) => n.name === 'PackageScoped',
    );
    const pkgAFunction = functions.find((n) =>
      n.properties.filePath.includes('pkgA/R/export_scope.R'),
    );
    const pkgBFunction = functions.find((n) =>
      n.properties.filePath.includes('pkgB/R/export_scope.R'),
    );

    expect(pkgAFunction).toBeDefined();
    expect(pkgBFunction).toBeDefined();
    expect(pkgAFunction?.properties.isExported).toBe(true);
    expect(pkgBFunction?.properties.isExported).toBe(false);
  });

  it('applies exportPattern and S3method directives from NAMESPACE', () => {
    const functions = getNodesByLabelFull(result, 'Function');
    const patternScoped = functions.find(
      (n) =>
        n.name === 'PatternScoped' &&
        n.properties.filePath.includes('pkgB/R/export_namespace_variants.R'),
    );
    const s3Method = functions.find(
      (n) =>
        n.name === 'print.FancyWidget' &&
        n.properties.filePath.includes('pkgB/R/export_namespace_variants.R'),
    );

    expect(patternScoped?.properties.isExported).toBe(true);
    expect(s3Method?.properties.isExported).toBe(true);
  });

  it('applies exportClasses() and exportMethods() directives from NAMESPACE', () => {
    const classes = getNodesByLabelFull(result, 'Class');
    const exportedClass = classes.find(
      (n) =>
        n.name === 'ExportedS4Class' && n.properties.filePath.includes('pkgB/R/s4_export_test.R'),
    );
    expect(exportedClass).toBeDefined();
    expect(exportedClass!.properties.isExported).toBe(true);

    const functions = getNodesByLabelFull(result, 'Function');
    const exportedMethod = functions.find(
      (n) =>
        n.name === 'exportedMethod' && n.properties.filePath.includes('pkgB/R/s4_export_test.R'),
    );
    expect(exportedMethod).toBeDefined();
    expect(exportedMethod!.properties.isExported).toBe(true);
  });

  it('defaults all functions to exported when no NAMESPACE file exists', () => {
    const functions = getNodesByLabelFull(result, 'Function');
    const roxygenFunc = functions.find(
      (n) =>
        n.name === 'RoxygenExported' && n.properties.filePath.includes('pkgC/R/default_export.R'),
    );
    const noTagFunc = functions.find(
      (n) => n.name === 'NoExportTag' && n.properties.filePath.includes('pkgC/R/default_export.R'),
    );

    expect(roxygenFunc).toBeDefined();
    expect(noTagFunc).toBeDefined();
    // Without NAMESPACE, rExportChecker defaults to true for all functions
    expect(roxygenFunc!.properties.isExported).toBe(true);
    expect(noTagFunc!.properties.isExported).toBe(true);
  });

  it('populates field metadata on R Property nodes', () => {
    const properties = getNodesByLabelFull(result, 'Property');

    const slotName = properties.find(
      (p) => p.name === 'name' && p.properties.filePath.includes('pkgA/R/models.R'),
    );
    expect(slotName).toBeDefined();
    expect(slotName!.properties.visibility).toBe('public');
    expect(slotName!.properties.declaredType).toBe('character');

    const dataField = properties.find(
      (p) => p.name === 'data' && p.properties.filePath.includes('pkgA/R/models.R'),
    );
    expect(dataField).toBeDefined();
    expect(dataField!.properties.visibility).toBe('public');
    expect(dataField!.properties.declaredType).toBe('data.frame');

    const itemsField = properties.find(
      (p) => p.name === 'items' && p.properties.filePath.includes('pkgA/R/models.R'),
    );
    expect(itemsField).toBeDefined();
    expect(itemsField!.properties.visibility).toBe('public');
  });

  // --- Negative tests ---

  it('does not index .Rprofile or .Renviron files', () => {
    const allNodes: string[] = [];
    result.graph.forEachNode((n) => {
      if (
        n.properties.filePath?.includes('.Rprofile') ||
        n.properties.filePath?.includes('.Renviron')
      ) {
        allNodes.push(n.properties.name);
      }
    });
    expect(allNodes).toHaveLength(0);
  });
});

/**
 * R caller attribution (R caller-attribution fix, kaybenleroll/GitNexus#5).
 *
 * Every call site's CALLS source must be the callable that lexically contains it
 * (named function, nested named function, R6/R5 method) or, when no named
 * callable encloses it, the File node; a call inside a class body but outside
 * any method (an R6 field default, an S4 `setClass(validity = function..)`
 * body) is sourced from the enclosing Class node by design.
 *
 * These tests landed before the fix (as `it.fails`) and pass as ordinary tests
 * with it; each attribution case has a plain characterisation twin (the target
 * edge exists from ANY source).
 * One assertion per `it`. Process / Community / STEP_IN_PROCESS / MEMBER_OF /
 * CALLS totals are NOT asserted: they are expected to change with the fix.
 */
describe('R caller attribution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'r-call-attribution'), () => {});
  }, 60000);

  /** Sorted unique CALLS targets of the source named `sourceName` in the file ending `fileSuffix`. */
  const callsFrom = (sourceName: string, fileSuffix: string): string[] =>
    [
      ...new Set(
        getRelationships(result, 'CALLS')
          .filter((e) => e.source === sourceName && e.sourceFilePath.endsWith(fileSuffix))
          .map((e) => e.target),
      ),
    ].sort();

  /** Sorted `Label:name` of every CALLS source in the file ending `fileSuffix` that targets `target`. */
  const sourceKeys = (fileSuffix: string, target: string): string[] =>
    getRelationships(result, 'CALLS')
      .filter((e) => e.sourceFilePath.endsWith(fileSuffix) && e.target === target)
      .map((e) => `${e.sourceLabel}:${e.source}`)
      .sort();

  /** Targets from `expected` that NO source in the file calls (twin: the edge exists from any source). */
  const missingTargets = (fileSuffix: string, expected: string[]): string[] => {
    const present = new Set(
      getRelationships(result, 'CALLS')
        .filter((e) => e.sourceFilePath.endsWith(fileSuffix))
        .map((e) => e.target),
    );
    return expected.filter((t) => !present.has(t));
  };

  const countNodes = (label: string): number => {
    let n = 0;
    result.graph.forEachNode((node) => {
      if (node.label === label) n++;
    });
    return n;
  };
  const countRels = (type: string): number => {
    let n = 0;
    for (const rel of result.graph.iterRelationships()) if (rel.type === type) n++;
    return n;
  };

  // ─── named_forms.R ────────────────────────────────────────────────────────
  describe('named_forms.R', () => {
    const F = 'R/named_forms.R';
    const own: Array<[string, string]> = [
      ['arrow_fn', 'leaf_b'],
      ['equals_fn', 'leaf_c'],
      ['super_fn', 'leaf_d'],
      ['lambda_fn', 'leaf_e'],
      ['dotted.name.fn', 'leaf_f'],
      ['`backtick name fn`', 'leaf_g'],
      ['pair_one', 'leaf_h'],
      ['pair_two', 'leaf_i'],
      ['cond_fn', 'leaf_j'],
      ['default_arg_fn', 'leaf_k'],
    ];

    it('the decoy first function still has its own edge', () => {
      expect(callsFrom('decoy_named', F)).toContain('leaf_a');
    });

    it('the decoy first function has ONLY its own edge', () => {
      expect(callsFrom('decoy_named', F)).toEqual(['leaf_a']);
    });

    for (const [fn, leaf] of own) {
      it(`${fn} is the sole source of ${leaf}`, () => {
        expect(callsFrom(fn, F)).toEqual([leaf]);
      });
    }

    it('twin: every named-form target has an edge from some source', () => {
      expect(
        missingTargets(F, ['leaf_a', ...own.map(([, leaf]) => leaf), 'leaf_l', 'leaf_x']),
      ).toEqual([]);
    });

    it('the obj$member_fn body call is sourced from the File node', () => {
      expect(sourceKeys(F, 'leaf_l')).toEqual(['File:named_forms.R']);
    });

    it('the module-level `res <- leaf_x(1)` call is sourced from the File node', () => {
      expect(sourceKeys(F, 'leaf_x')).toEqual(['File:named_forms.R']);
    });
  });

  // ─── nesting.R ────────────────────────────────────────────────────────────
  describe('nesting.R', () => {
    const F = 'R/nesting.R';

    it('the decoy first function has exactly its own edge', () => {
      expect(callsFrom('decoy_nesting', F)).toEqual(['leaf_m']);
    });

    it('outer calls exactly inner and its lambda / FUN= / tryCatch leaves', () => {
      expect(callsFrom('outer', F)).toEqual(['inner', 'leaf_o', 'leaf_p', 'leaf_q', 'leaf_r']);
    });

    it('inner calls exactly its own leaf', () => {
      expect(callsFrom('inner', F)).toEqual(['leaf_n']);
    });

    it('there is no inner -> inner self-loop', () => {
      expect(callsFrom('inner', F).includes('inner')).toBe(false);
    });

    for (const [what, leaf] of [
      ['the lapply lambda', 'leaf_o'],
      ['the FUN = function argument', 'leaf_p'],
      ['the tryCatch expression', 'leaf_q'],
      ['the tryCatch error = function handler', 'leaf_r'],
    ]) {
      it(`${what} call to ${leaf} is sourced from outer`, () => {
        expect(sourceKeys(F, leaf)).toEqual(['Function:outer']);
      });
    }

    it('level1 calls exactly level2 and leaf_u', () => {
      expect(callsFrom('level1', F)).toEqual(['leaf_u', 'level2']);
    });

    it('level2 calls exactly level3 and leaf_t', () => {
      expect(callsFrom('level2', F)).toEqual(['leaf_t', 'level3']);
    });

    it('level3 calls exactly leaf_s', () => {
      expect(callsFrom('level3', F)).toEqual(['leaf_s']);
    });

    it('twin: every nested-function target has an edge from some source', () => {
      expect(
        missingTargets(F, [
          'inner',
          'leaf_n',
          'leaf_o',
          'leaf_p',
          'leaf_q',
          'leaf_r',
          'level2',
          'level3',
          'leaf_s',
          'leaf_t',
          'leaf_u',
        ]),
      ).toEqual([]);
    });
  });

  // ─── r6_methods.R ─────────────────────────────────────────────────────────
  describe('r6_methods.R', () => {
    const F = 'R/r6_methods.R';
    const perMethod: Array<[string, string[]]> = [
      ['first', ['leaf_y']],
      ['run', ['helper', 'leaf_aa']],
      ['relay', ['peer']],
      ['peer', ['leaf_ab']],
      ['hidden', ['leaf_ac']],
      ['shown', ['leaf_ad']],
      ['helper', ['leaf_z']],
      ['bump', ['leaf_ae']],
      ['reset', ['leaf_af']],
    ];

    it('the decoy first function has exactly its own edge', () => {
      expect(callsFrom('decoy_r6', F)).toEqual(['leaf_v']);
    });

    for (const [method, targets] of perMethod) {
      it(`${method} calls exactly ${targets.join(', ')}`, () => {
        expect(callsFrom(method, F)).toEqual(targets);
      });
    }

    it('twin: every R6 / R5 target has an edge from some source', () => {
      expect(
        missingTargets(F, [
          'leaf_y',
          'helper',
          'leaf_aa',
          'peer',
          'leaf_ab',
          'leaf_ac',
          'leaf_ad',
          'leaf_z',
          'leaf_ae',
          'leaf_af',
          'leaf_w',
        ]),
      ).toEqual([]);
    });

    it('self$peer() resolves to the peer method from some Method in the class', () => {
      expect(sourceKeys(F, 'peer').map((k) => k.split(':')[0])).toEqual(['Method']);
    });

    it('self$peer() is sourced from the method containing it, not the first method', () => {
      expect(sourceKeys(F, 'peer')).toEqual(['Method:relay']);
    });

    it('the public field default `cache = leaf_w()` is sourced from the Class node', () => {
      expect(sourceKeys(F, 'leaf_w')).toEqual(['Class:Widget']);
    });
  });

  // ─── s4.R ─────────────────────────────────────────────────────────────────
  describe('s4.R', () => {
    const F = 'R/s4.R';

    it('the decoy first function has ONLY its own edge (S4 negative)', () => {
      expect(callsFrom('decoy_s4', F)).toEqual(['leaf_ag']);
    });

    it('the setMethod body call is not sourced from a named function', () => {
      // Negative only: the File-source outcome is a documented limitation, not locked.
      expect(sourceKeys(F, 'leaf_ah').filter((k) => !k.startsWith('File:'))).toEqual([]);
    });

    it('twin: the setMethod body call has an edge from some source', () => {
      expect(missingTargets(F, ['leaf_ag', 'leaf_ah'])).toEqual([]);
    });

    it('the setClass(validity = function..) body call is sourced from the Class node', () => {
      expect(sourceKeys(F, 'leaf_ai')).toEqual(['Class:P']);
    });
  });

  // ─── scripts/top_level.R ──────────────────────────────────────────────────
  describe('scripts/top_level.R (no functions)', () => {
    const F = 'scripts/top_level.R';

    it('sources its first top-level call from the File node', () => {
      expect(sourceKeys(F, 'leaf_aj')).toEqual(['File:top_level.R']);
    });

    it('sources its second top-level call from the File node', () => {
      expect(sourceKeys(F, 'leaf_ak')).toEqual(['File:top_level.R']);
    });
  });

  // ─── Invariance (named types; step-0 literals measured at HEAD) ───────────
  describe('graph structure is unchanged by attribution', () => {
    for (const [label, count] of [
      ['Function', 58],
      ['Method', 10],
      ['Class', 4],
      ['Property', 1],
      ['File', 6],
    ] as const) {
      it(`has ${count} ${label} nodes`, () => {
        expect(countNodes(label)).toBe(count);
      });
    }

    for (const [type, count] of [
      ['DEFINES', 73],
      ['CONTAINS', 6],
      ['HAS_METHOD', 10],
      ['HAS_PROPERTY', 1],
      ['IMPORTS', 0],
      ['EXTENDS', 0],
    ] as const) {
      it(`has ${count} ${type} relationships`, () => {
        expect(countRels(type)).toBe(count);
      });
    }
  });
});

/**
 * R native pipe (`|>`) chains: baseline characterisation at the landed
 * caller-attribution fix. Every assertion here passes without any pipe-specific
 * production support; the tests lock the current behaviour before NAMESPACE /
 * importFrom resolution work touches the resolver.
 * The fixture is synthetic (`r-native-pipes/`, three packages); one function per
 * scenario so each assertion is an exact `source -> targets` set.
 * magrittr `%>%` is deliberately NOT covered (no support claimed either way).
 * Two tests pin known-wrong name-only results for `pkg::fn` stages (fork #7).
 */
describe('R native pipe chains', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'r-native-pipes'), () => {});
  }, 60000);

  const callEdges = (sourceName: string, fileSuffix: string) =>
    getRelationships(result, 'CALLS').filter(
      (e) => e.source === sourceName && e.sourceFilePath.endsWith(fileSuffix),
    );

  /** Sorted unique CALLS targets of the source named `sourceName` in the file ending `fileSuffix`. */
  const callsFrom = (sourceName: string, fileSuffix: string): string[] =>
    [...new Set(callEdges(sourceName, fileSuffix).map((e) => e.target))].sort();

  /** Sorted `Label:name` of every CALLS source in the file ending `fileSuffix` that targets `target`. */
  const sourceKeys = (fileSuffix: string, target: string): string[] =>
    getRelationships(result, 'CALLS')
      .filter((e) => e.sourceFilePath.endsWith(fileSuffix) && e.target === target)
      .map((e) => `${e.sourceLabel}:${e.source}`)
      .sort();

  const A = 'pkgmain/R/a.R';
  const B = 'pkgmain/R/b.R';

  // ─── module-level chain ─────────────────────────────────────────────────
  describe('module-level chain', () => {
    it('sources every stage of a top-level chain from the File node', () => {
      expect(callsFrom('a.R', A)).toEqual(['stage_one', 'stage_two']);
    });

    it('labels the top-level chain source as File for stage_one', () => {
      expect(sourceKeys(A, 'stage_one').filter((k) => k.startsWith('File:'))).toEqual(['File:a.R']);
    });

    it('labels the top-level chain source as File for stage_two', () => {
      expect(sourceKeys(A, 'stage_two').filter((k) => k.startsWith('File:'))).toEqual(['File:a.R']);
    });

    it('resolves the top-level stages as local calls at 0.85', () => {
      expect(
        callEdges('a.R', A)
          .map((e) => `${e.target}:${e.rel.reason}:${e.rel.confidence}`)
          .sort(),
      ).toEqual(['stage_one:local-call:0.85', 'stage_two:local-call:0.85']);
    });
  });

  // ─── multi-line chain ───────────────────────────────────────────────────
  describe('multi-line chain with a builtin stage', () => {
    it('resolves every user-defined stage of a five-stage chain', () => {
      expect(callsFrom('multiline_user', A)).toEqual(['stage_one', 'stage_three', 'stage_two']);
    });

    it('emits no edge for the builtin-named paste stage', () => {
      expect(callsFrom('multiline_user', A).includes('paste')).toBe(false);
    });

    it('emits no CALLS edge to a paste target anywhere', () => {
      expect(getRelationships(result, 'CALLS').filter((e) => e.target === 'paste')).toEqual([]);
    });
  });

  // ─── placeholder ────────────────────────────────────────────────────────
  describe('placeholder argument', () => {
    it('resolves only the stage that takes the placeholder', () => {
      expect(callsFrom('placeholder_user', A)).toEqual(['stage_three']);
    });

    it('emits no CALLS edge to the placeholder `_`', () => {
      expect(getRelationships(result, 'CALLS').filter((e) => e.target === '_')).toEqual([]);
    });
  });

  // ─── lambda stage ───────────────────────────────────────────────────────
  describe('lambda stage', () => {
    it('sources the lambda body call from the enclosing function', () => {
      expect(callsFrom('lambda_user', A)).toEqual(['uniq_helper']);
    });

    it('resolves the lambda body call as a 0.85 local call', () => {
      expect(callEdges('lambda_user', A).map((e) => `${e.rel.reason}:${e.rel.confidence}`)).toEqual(
        ['local-call:0.85'],
      );
    });
  });

  // ─── attribution across functions ───────────────────────────────────────
  describe('two pipe functions in one package', () => {
    it('gives the decoy first function only its own pipe edge', () => {
      expect(callsFrom('decoy_first', 'pkgmain/R/decoy_first.R')).toEqual(['uniq_helper']);
    });

    it('does not source later pipes from the decoy first function', () => {
      expect(
        sourceKeys('pkgmain/R/decoy_first.R', 'stage_one').concat(
          sourceKeys('pkgmain/R/decoy_first.R', 'stage_three'),
        ),
      ).toEqual([]);
    });

    it('keeps a plain call and a lambda-stage call in separate sources', () => {
      expect(sourceKeys(A, 'uniq_helper')).toEqual(['Function:lambda_user', 'Function:plain_user']);
    });
  });

  // ─── R6 method chain ────────────────────────────────────────────────────
  describe('R6 method chain', () => {
    it('sources the chain from the Method and calls exactly the stage and self$post', () => {
      expect(callsFrom('run', A)).toEqual(['post', 'stage_one']);
    });

    it('targets a Method for the self$post stage', () => {
      expect(callEdges('run', A).find((e) => e.target === 'post')?.targetLabel).toBe('Method');
    });

    it('targets a Function for the stage_one stage', () => {
      expect(callEdges('run', A).find((e) => e.target === 'stage_one')?.targetLabel).toBe(
        'Function',
      );
    });

    it('labels the chain source as Method:run', () => {
      expect(sourceKeys(A, 'post')).toEqual(['Method:run']);
    });
  });

  // ─── member stages ──────────────────────────────────────────────────────
  describe('member stage on a typed object', () => {
    it('resolves obj$score() and the following stage', () => {
      expect(callsFrom('typed_user', B)).toEqual(['score', 'stage_one']);
    });

    it('targets a Method for the typed member stage', () => {
      expect(callEdges('typed_user', B).find((e) => e.target === 'score')?.targetLabel).toBe(
        'Method',
      );
    });
  });

  describe('member stage on an untyped object', () => {
    it('emits no edge for the untyped member stage and resolves the next stage', () => {
      expect(callsFrom('member_user', A)).toEqual(['stage_one']);
    });
  });

  // ─── namespaced stages ──────────────────────────────────────────────────
  describe('namespaced stage with a unique name in another package', () => {
    it('resolves pkgother::ext_fn() and the following stage', () => {
      expect(callsFrom('ns_user', A)).toEqual(['ext_fn', 'stage_one']);
    });

    it('resolves the namespaced stage into the other package', () => {
      expect(callEdges('ns_user', A).find((e) => e.target === 'ext_fn')?.targetFilePath).toBe(
        'pkgother/R/e.R',
      );
    });

    it('resolves it by the 0.5 global-name-fallback (the qualifier is unused)', () => {
      expect(
        callEdges('ns_user', A)
          .filter((e) => e.target === 'ext_fn')
          .map((e) => `${e.rel.reason}:${e.rel.confidence}`),
      ).toEqual(['global-name-fallback:0.5']);
    });
  });

  describe('namespaced stage whose name is also defined in the calling file', () => {
    it('documents current name-only behaviour (fork #7)', () => {
      // `pkgother::amb_stage()` is qualified, yet the edge goes to the LOCAL definition
      // (0.85 local-call): the qualifier is discarded. A false edge; fork #7 should flip this.
      expect(
        callEdges('ns_amb_user', A).map((e) => `${e.target}:${e.targetFilePath}:${e.rel.reason}`),
      ).toEqual(['amb_stage:pkgmain/R/a.R:local-call']);
    });
  });

  describe('namespaced stages whose name is defined in two other packages', () => {
    it('documents current name-only behaviour (fork #7)', () => {
      // `pkgother::amb_only() |> pkgthird::amb_only()`: ambiguous by name alone, so no edge
      // even though each qualifier names exactly one definition. Fork #7 should flip this.
      expect(callsFrom('ns_amb2_user', B)).toEqual([]);
    });
  });

  // ─── backticked stage ───────────────────────────────────────────────────
  describe('backticked stage with no definition', () => {
    it('emits no edge for it and still resolves the following stage', () => {
      expect(callsFrom('bt_user', B)).toEqual(['stage_two']);
    });
  });

  // ─── O1: nested function sharing a name with a later top-level function ─
  describe('nested function sharing a name with a top-level function (plan O1)', () => {
    const N = 'pkgmain/R/nested.R';
    const targetStartLine = (fn: string): number | undefined => {
      const edge = callEdges(fn, N).find((e) => e.target === 'nest_fn');
      return edge ? result.graph.getNode(edge.rel.targetId)?.properties.startLine : undefined;
    };

    it('resolves a pipe stage to the same-named nested function from the enclosing function', () => {
      expect(callsFrom('nested_outer', N)).toEqual(['nest_fn', 'stage_two']);
    });

    it('resolves the same name from another function to the top-level definition', () => {
      expect(callsFrom('nested_caller', N)).toEqual(['nest_fn']);
    });

    it('binds the enclosing function to the nested definition, not the top-level one', () => {
      expect(targetStartLine('nested_outer') ?? Infinity).toBeLessThan(
        targetStartLine('nested_caller') ?? -Infinity,
      );
    });
  });
});

describe('R NAMESPACE importFrom() bindings to local packages', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'r-namespace-imports'), () => {});
  }, 60000);

  const callEdges = (sourceName: string, fileSuffix: string) =>
    getRelationships(result, 'CALLS').filter(
      (e) => e.source === sourceName && e.sourceFilePath.endsWith(fileSuffix),
    );

  /** Sorted unique CALLS targets of the source named `sourceName` in the file ending `fileSuffix`. */
  const callsFrom = (sourceName: string, fileSuffix: string): string[] =>
    [...new Set(callEdges(sourceName, fileSuffix).map((e) => e.target))].sort();

  /** `target:targetFile:reason:confidence` of every edge from `sourceName`, sorted. */
  const edgeSummaries = (sourceName: string, fileSuffix: string): string[] =>
    callEdges(sourceName, fileSuffix)
      .map((e) => `${e.target}:${e.targetFilePath}:${e.rel.reason}:${e.rel.confidence}`)
      .sort();

  /** Sorted unique IMPORTS target files of the file `sourceFile` (fixture-root-relative). */
  const importTargets = (sourceFile: string): string[] =>
    [
      ...new Set(
        getRelationships(result, 'IMPORTS')
          .filter((e) => e.sourceFilePath === sourceFile)
          .map((e) => e.targetFilePath),
      ),
    ].sort();

  const USE = 'analytics/R/use.R';

  // Every `R/` file of the caller package, with the import set the synthesised
  // named imports must produce for it (defining provider files only).
  const CALLER_FILES = [
    'analytics/R/decoy_first.R',
    'analytics/R/dotted_use.R',
    'analytics/R/fork7.R',
    'analytics/R/nested_use.R',
    'analytics/R/own.R',
    'analytics/R/r6_use.R',
    'analytics/R/reexport_use.R',
    'analytics/R/second.R',
    'analytics/R/use.R',
    'analytics/R/veto_use.R',
  ];
  const BOUND_TARGET_FILES = [
    'legacyscore/R/l.R', // dup_fn: the later importFrom() (legacyscore) wins
    'scorelib/R/nested.R',
    'scorelib/R/plain.R',
    'scorelib/R/r6.R',
    'scorelib/R/s.R',
  ];

  describe('bare calls to names imported from a local package', () => {
    it('resolves every imported name from the one calling function, and nothing else', () => {
      expect(callsFrom('run_all', USE)).toEqual([
        'dup_fn',
        'hidden_helper',
        'normalise_scores',
        'quoted_fn',
        'rank_scores',
        'tidy_scores',
      ]);
    });

    it('binds a single-line importFrom() name to the provider even though another package defines it', () => {
      // Baseline (before this change): no edge — `tidy_scores` is defined in scorelib AND
      // legacyscore, so the name-only guess is ambiguous and drops it.
      expect(
        callEdges('run_all', USE)
          .filter((e) => e.target === 'tidy_scores')
          .map((e) => `${e.targetFilePath}:${e.rel.reason}:${e.rel.confidence}`),
      ).toEqual(['scorelib/R/s.R:import-resolved:0.85']);
    });

    it('binds names from a multi-line importFrom() and a quoted importFrom() by import, not by name guess', () => {
      // Baseline: 0.5 `global-name-fallback` edges only (the multi-line/quoted forms were unparsed).
      expect(
        ['normalise_scores', 'rank_scores', 'quoted_fn'].map((name) =>
          callEdges('run_all', USE)
            .filter((e) => e.target === name)
            .map((e) => `${name}:${e.targetFilePath}:${e.rel.reason}`),
        ),
      ).toEqual([
        ['normalise_scores:scorelib/R/s.R:import-resolved'],
        ['rank_scores:scorelib/R/s.R:import-resolved'],
        ['quoted_fn:scorelib/R/s.R:import-resolved'],
      ]);
    });

    it('applies the imports to every R file of the caller package, not only the caller of the name', () => {
      expect(edgeSummaries('second_user', 'analytics/R/second.R')).toEqual([
        'tidy_scores:scorelib/R/s.R:import-resolved:0.85',
      ]);
    });

    it('lets the later importFrom() win when two local packages are imported for one name', () => {
      // scorelib is imported first, legacyscore last: R replaces the earlier binding.
      expect(
        callEdges('run_all', USE)
          .filter((e) => e.target === 'dup_fn')
          .map((e) => `${e.targetFilePath}:${e.rel.reason}`),
      ).toEqual(['legacyscore/R/l.R:import-resolved']);
    });

    it('does not bind an imported name that the calling package also defines (own namespace masks)', () => {
      // `own_dup` is defined in analytics/R/own.R AND scorelib: ambiguous, so no edge. An edge to
      // scorelib's `own_dup` would mean the synthesised import outranked R's own-namespace rule.
      expect(callsFrom('run_all', USE)).not.toContain('own_dup');
    });

    it('does not bind a name the provider defines but does not export, and keeps the fallback edge', () => {
      expect(
        callEdges('run_all', USE)
          .filter((e) => e.target === 'hidden_helper')
          .map((e) => `${e.targetFilePath}:${e.rel.reason}:${e.rel.confidence}`),
      ).toEqual(['scorelib/R/internal.R:global-name-fallback:0.5']);
    });

    it('emits no edge for an exported name that no package defines', () => {
      expect(callsFrom('run_all', USE)).not.toContain('no_such_fn');
    });

    it('emits no edge for a call outside the package R/ directory (NAMESPACE does not apply)', () => {
      // `tidy_scores` is ambiguous by name (scorelib + legacyscore); tests/ gets no import.
      expect(callsFrom('test_that_user', 'analytics/tests/testthat/test-x.R')).toEqual([]);
    });
  });

  describe('IMPORTS edges', () => {
    it('gives every caller R file IMPORTS edges to exactly the provider files that define an imported name', () => {
      expect(CALLER_FILES.map((f) => [f, importTargets(f)])).toEqual(
        CALLER_FILES.map((f) => [f, BOUND_TARGET_FILES]),
      );
    });

    it('does not link the provider file of a shadowed, unexported or dotted-only name', () => {
      const all = CALLER_FILES.flatMap((f) => importTargets(f));
      expect(all.filter((t) => /own_dup|dup\.R|internal|dotted/.test(t))).toEqual([]);
    });

    it('never links an external package import to a same-named file in another language', () => {
      const targets = getRelationships(result, 'IMPORTS').map((e) => e.targetFilePath);
      expect(targets.filter((t) => t.startsWith('vendor/'))).toEqual([]);
    });

    it('adds no IMPORTS edge for files outside the package R/ directory', () => {
      const sources = getRelationships(result, 'IMPORTS').map((e) => e.sourceFilePath);
      expect(
        sources.filter((s) => s.startsWith('analytics/scripts/') || s.includes('/tests/')),
      ).toEqual([]);
    });
  });

  describe('dotted names', () => {
    it('leaves a dotted importedName unbound (baseline call edge unchanged)', () => {
      // `normalise.scores` can never bind by import (finalize keys defs by the text after the
      // last `.`); the call keeps the baseline low-confidence edge, not an import-resolved one.
      expect(edgeSummaries('dotted_name_user', 'analytics/R/dotted_use.R')).toEqual([
        'normalise.scores:scorelib/R/dotted.R:scope-resolution: call:0.35',
      ]);
    });

    it('never binds tidy to print.tidy when print.tidy is defined first', () => {
      // finalize would index `print.tidy` under `tidy`; the guard refuses the import instead, so
      // there is no 0.85 edge to the wrong def (baseline: ambiguous, no edge).
      expect(edgeSummaries('print_before_bare_user', 'analytics/R/dotted_use.R')).toEqual([]);
    });

    it('also refuses the mirror layout (bare def first): the guard is order-blind', () => {
      expect(edgeSummaries('bare_before_print_user', 'analytics/R/dotted_use.R')).toEqual([]);
    });

    it('does not fire for an underscore name (plain_fn binds by import)', () => {
      expect(edgeSummaries('underscore_user', 'analytics/R/dotted_use.R')).toEqual([
        'plain_fn:scorelib/R/plain.R:import-resolved:0.85',
      ]);
    });
  });

  describe('R6 members and nested definitions in the provider', () => {
    it('binds the top-level def, not the same-named R6 method defined earlier in the same file', () => {
      // Fails without `namedImportsBindTopLevelOnly` (the wide index would store the method).
      expect(
        callEdges('r6_flag_user', 'analytics/R/r6_use.R').map(
          (e) => `${e.targetLabel}:${e.target}:${e.rel.reason}`,
        ),
      ).toEqual(['Function:score_it:import-resolved']);
    });

    it('does not bind an import to an R6 method when no top-level def carries the name', () => {
      expect(edgeSummaries('r6_method_only_user', 'analytics/R/r6_use.R')).toEqual([
        'describe_run:scorelib/R/r6.R:global-name-fallback:0.5',
      ]);
    });

    it('documents residual O1: a nested function defined before the top-level one still wins the binding', () => {
      // The named branch can only choose FILES; finalize's first-callable rule then picks the
      // nested def. Fixing it needs an `isExported` capture (query change): out of scope here.
      const edges = callEdges('nested_user', 'analytics/R/nested_use.R');
      expect(edges.map((e) => `${e.target}:${e.targetFilePath}:${e.rel.reason}`)).toEqual([
        'nest_fn:scorelib/R/nested.R:import-resolved',
      ]);
      const nestFnLines = getNodesByLabelFull(result, 'Function')
        .filter((n) => n.name === 'nest_fn' && n.properties.filePath === 'scorelib/R/nested.R')
        .map((n) => n.properties.startLine as number);
      const boundLine = result.graph.getNode(edges[0].rel.targetId)?.properties.startLine;
      expect(boundLine).toBe(Math.min(...nestFnLines));
    });
  });

  describe('re-export through a local provider', () => {
    it('keeps the baseline fallback edge to the defining package (no import binding)', () => {
      // scorelib re-exports `reexp_fn` from corelib and defines no top-level def of the name.
      expect(edgeSummaries('reexport_user', 'analytics/R/reexport_use.R')).toEqual([
        'reexp_fn:corelib/R/c.R:global-name-fallback:0.5',
      ]);
    });
  });

  describe('global-name guesses contradicted by the NAMESPACE importFrom() (veto)', () => {
    const VETO = 'analytics/R/veto_use.R';

    it('refuses the guess to a decoy in another local package when the name is imported from an external package', () => {
      // importFrom(dplyr, mutate) + a same-named `mutate` in legacyscore: the unique-name guess
      // (a FALSE 0.5 edge before the veto) is impossible in R, so no edge is published.
      expect(edgeSummaries('mutate_user', VETO)).toEqual([]);
    });

    it('keeps the 0.5 fallback edge to the own-package definition of an externally imported name', () => {
      // importFrom(dplyr, filter) and `filter` defined in analytics/R/own.R: the candidate is the
      // caller's own package, which masks the import. Precise own-package binding is fork #10.
      expect(edgeSummaries('filter_user', VETO)).toEqual([
        'filter:analytics/R/own.R:global-name-fallback:0.5',
      ]);
    });

    it('refuses the guess when the last importFrom() of the name names an external package', () => {
      // importFrom(scorelib, dup_ext) then importFrom(dplyr, dup_ext): the last entry wins, nothing
      // is bound, and the guess to scorelib's exported `dup_ext` is contradicted (no IMPORTS edge
      // either).
      expect(edgeSummaries('dup_ext_user', VETO)).toEqual([]);
      expect(importTargets(VETO)).not.toContain('scorelib/R/dup.R');
    });

    it('keeps the 0.5 fallback edge to a candidate outside every package R/ directory', () => {
      // `scripts_only_fn` lives in analytics/scripts/helper.R, which no NAMESPACE governs.
      expect(edgeSummaries('scripts_only_user', VETO)).toEqual([
        'scripts_only_fn:analytics/scripts/helper.R:global-name-fallback:0.5',
      ]);
    });

    it('does not apply to a caller outside the package R/ directory (tests/testthat keeps the guess)', () => {
      expect(edgeSummaries('test_mutate_user', 'analytics/tests/testthat/test-veto.R')).toEqual([
        'mutate:legacyscore/R/l.R:global-name-fallback:0.5',
      ]);
    });

    it('keeps the re-export fallback edge to the origin package (allowance for a local provider that re-exports)', () => {
      expect(edgeSummaries('reexport_user', 'analytics/R/reexport_use.R')).toEqual([
        'reexp_fn:corelib/R/c.R:global-name-fallback:0.5',
      ]);
    });

    it('records every refusal as fallback-refused and no other kind of veto outcome', () => {
      const refused = (result.resolutionOutcomes ?? []).filter(
        (o) => o.kind === 'fallback-refused',
      );
      expect(refused.map((o) => o.name).sort()).toEqual(['dup_ext', 'mutate', 'mutate']);
    });
  });

  describe('explicitly qualified call to another local package', () => {
    it('documents current name-only behaviour after importFrom() binding (fork #7)', () => {
      // `legacyscore::tidy_scores()` names legacyscore, yet the qualifier is discarded and the
      // synthesised import (scorelib) binds it: a FALSE 0.85 edge (baseline: ambiguous, no edge).
      // Fork #7 should flip this.
      expect(edgeSummaries('qualified_user', 'analytics/R/fork7.R')).toEqual([
        'tidy_scores:scorelib/R/s.R:import-resolved:0.85',
      ]);
    });

    it('documents current name-only behaviour (fork #7): a correct qualified edge is refused by the veto', () => {
      // `legacyscore::mutate()` names the package that really defines `mutate`, but the qualifier
      // is discarded and the NAMESPACE imports `mutate` from dplyr, so the guess is vetoed
      // (baseline before the veto: a correct 0.5 edge to legacyscore). Fork #7 should flip this.
      expect(edgeSummaries('qualified_mutate_user', 'analytics/R/fork7.R')).toEqual([]);
    });
  });
});

describe('R importFrom(pkgB, CleanData) in the shared r-packages fixture', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'r-packages'), () => {});
  }, 60000);

  it('binds the pkgB::CleanData call by import instead of the name guess', () => {
    // Baseline: 0.5 `global-name-fallback`. pkgA/NAMESPACE now yields a real import binding.
    expect(
      getRelationships(result, 'CALLS')
        .filter((e) => e.source === 'AddOutlierStatuses' && e.target === 'CleanData')
        .map((e) => `${e.targetFilePath}:${e.rel.reason}:${e.rel.confidence}`),
    ).toEqual(['pkgB/R/clean_data.R:import-resolved:0.85']);
  });

  it('links pkgA R files to the pkgB file that defines the imported name', () => {
    const imports = getRelationships(result, 'IMPORTS').filter(
      (e) => e.sourceFilePath.startsWith('pkgA/R/') && e.targetFilePath === 'pkgB/R/clean_data.R',
    );
    expect(imports.length).toBeGreaterThanOrEqual(1);
  });
});

// Fork #6: a package whose DESCRIPTION/NAMESPACE sit at the repository root
// (pkgDir === '') must get the same NAMESPACE export refinement as a nested one.
describe('R root-level package NAMESPACE export refinement', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'r-root-package'), () => {});
  }, 60000);

  const findFn = (name: string) =>
    getNodesByLabelFull(result, 'Function').find((n) => n.name === name);

  it('keeps an explicit export() public', () => {
    expect(findFn('RootExported')?.properties.isExported).toBe(true);
  });

  it('keeps a symbol matching exportPattern() public', () => {
    expect(findFn('PatternMatched')?.properties.isExported).toBe(true);
  });

  it('keeps an S3method() registration public', () => {
    expect(findFn('print.RootWidget')?.properties.isExported).toBe(true);
  });

  it('marks a symbol absent from NAMESPACE as not exported', () => {
    const helper = findFn('RootHelper');
    expect(helper).toBeDefined();
    expect(helper?.properties.isExported).toBe(false);
  });
});
