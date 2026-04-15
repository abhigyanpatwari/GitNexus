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
