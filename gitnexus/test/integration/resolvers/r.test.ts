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
