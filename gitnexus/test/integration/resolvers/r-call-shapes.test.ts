/**
 * R: the call shapes and definitions that docs/languages/r-provider.md says create no edge or
 * node, pinned end to end on a package-shaped fixture (r-call-shapes).
 *
 * The documented "Limits" are claims that hold only while nothing captures the shape, so each
 * is asserted here against a fixture that contains it, next to positive controls (a plain call
 * and a `library()` import do link). A change that widens the query to one of these shapes, or
 * that stops one linking, fails here instead of changing the graph unnoticed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'path';
import {
  FIXTURES,
  getNodesByLabelFull,
  getRelationships,
  getResolutionOutcomes,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';

beforeAll(() => vi.stubEnv('GITNEXUS_WORKER_READY_TIMEOUT_MS', '60000'));
afterAll(() => vi.unstubAllEnvs());

let result: PipelineResult;
beforeAll(async () => {
  result = await runPipelineFromRepo(path.join(FIXTURES, 'r-call-shapes'), () => {});
}, 60000);

const callsFrom = (source: string) =>
  getRelationships(result, 'CALLS').filter((e) => e.source === source);

describe('R: positive controls of the call-shape fixture', () => {
  it('links a plain call by the unique-name fallback', () => {
    const edge = callsFrom('direct_call');
    expect(edge.map((e) => `${e.targetFilePath}:${e.target}`)).toEqual(['R/helpers.R:helper']);
    expect(edge[0].rel.reason).toBe('global-name-fallback');
    expect(edge[0].rel.confidence).toBe(0.5);
  });

  it('links a call from a script that attaches the package with library()', () => {
    const edge = callsFrom('attached_user');
    expect(edge.map((e) => `${e.targetFilePath}:${e.target}`)).toEqual(['R/helpers.R:helper']);
    expect(edge[0].rel.reason).toBe('import-resolved');
  });

  it('links a call to a function that dispatches (UseMethod), but only to that function', () => {
    expect(callsFrom('use_area').map((e) => e.target)).toEqual(['area']);
  });

  it('has exactly these CALLS edges, so every shape below stayed unlinked', () => {
    const calls = getRelationships(result, 'CALLS')
      .map((e) => `${e.source} -> ${e.target}`)
      .sort();
    expect(calls).toEqual([
      'attached_user -> helper',
      'direct_call -> helper',
      'inherited -> describe_it',
      'shout -> greet',
      'up -> climb_up',
      'use_area -> area',
    ]);
  });
});

describe('R: a function used other than as a callee creates no CALLS edge', () => {
  it.each([
    ['via_lapply', 'lapply(xs, helper)'],
    ['via_map', 'Map(helper, xs, xs)'],
    ['via_do_call', 'do.call("helper", ...)'],
    ['via_match_fun', 'match.fun("helper")(1)'],
    ['via_get', 'get("helper")(1)'],
    ['via_registry', 'handlers[["a"]](1)'],
    ['via_qualified_value', 'lapply(xs, shapes::helper)'],
  ])('%s: %s', (caller) => {
    expect(callsFrom(caller)).toEqual([]);
  });

  it('does not link an infix operator to its definition', () => {
    expect(callsFrom('via_infix')).toEqual([]);
    expect(getRelationships(result, 'CALLS').filter((e) => e.target === '`%+%`')).toEqual([]);
  });

  it('does not read S4 slot access p@name as a call of the function name()', () => {
    expect(callsFrom('via_slot')).toEqual([]);
    expect(getRelationships(result, 'CALLS').filter((e) => e.target === 'name')).toEqual([]);
  });

  it('does not read a call through @ on an R6 instance (p@greet()) as a member call', () => {
    expect(callsFrom('via_slot_call')).toEqual([]);
    const sites = getResolutionOutcomes(result).filter(
      (o) => o.filePath === 'R/uses.R' && o.name === 'greet',
    );
    expect(sites).toEqual([]);
  });

  it('does not link UseMethod() or NextMethod() to a method', () => {
    expect(callsFrom('area')).toEqual([]);
    expect(callsFrom('area.circle')).toEqual([]);
    expect(getRelationships(result, 'CALLS').filter((e) => e.target.startsWith('area.'))).toEqual(
      [],
    );
  });
});

describe('R6: dispatch and heritage', () => {
  it('links self$method() to a method of the same class, at the receiver-call confidence', () => {
    const [edge] = callsFrom('shout');
    expect(edge.targetFilePath).toBe('R/child.R');
    expect(edge.rel.targetId).toMatch(/greet/);
    expect(edge.rel.reason).toBe('global');
    expect(edge.rel.confidence).toBeCloseTo(0.85, 5);
  });

  it('creates no edge for super$method() or private$method()', () => {
    // Child$greet overrides Parent$greet and calls super$greet(); Child$ping calls private$secret().
    expect(callsFrom('greet').filter((e) => e.sourceFilePath === 'R/child.R')).toEqual([]);
    expect(callsFrom('ping')).toEqual([]);
  });

  it('binds an inherited self$method() to the parent method, not to a top-level function of that name', () => {
    // Parent defines a method and a top-level function called describe_it; the call is in Child.
    const edges = getRelationships(result, 'CALLS').filter(
      (e) => e.source === 'inherited' && e.sourceFilePath === 'R/child.R',
    );
    expect(edges.map((e) => e.rel.targetId)).toEqual(['Method:R/parent.R:Parent.describe_it#0']);
    expect(edges[0].targetLabel).toBe('Method');
  });

  it('binds an inherited self$method() to the parent method even when the child file has a top-level function of that name', () => {
    const [edge] = callsFrom('up');
    expect(edge.targetLabel).toBe('Method');
    expect(edge.targetFilePath).toBe('R/parent.R');
    expect(edge.rel.targetId).toBe('Method:R/parent.R:Parent.climb_up#0');
    expect(callsFrom('up')).toHaveLength(1);
  });

  it('links inherit = Parent across files to the Parent class node (positive control)', () => {
    const edges = getRelationships(result, 'EXTENDS').filter((e) => e.source === 'Child');
    expect(edges.map((e) => e.rel.targetId)).toEqual(['Class:R/parent.R:Parent']);
    expect(edges[0].rel.reason).toBe('scope-resolution: inherits');
  });

  it('creates no EXTENDS edge for inherit = pkg::Base, although pkg is a package of the repository', () => {
    expect(getRelationships(result, 'EXTENDS').filter((e) => e.source === 'Remote')).toEqual([]);
    // The base class is there to be linked to, and the call through it gets no edge either.
    expect(getNodesByLabelFull(result, 'Class').map((n) => n.properties.name)).toContain(
      'BasePkgClass',
    );
    expect(callsFrom('again')).toEqual([]);
    // The base is not indexed, so the member cannot be found: the shared pass's closest label.
    expect(
      getResolutionOutcomes(result)
        .filter((o) => o.name === 'base_method')
        .map((o) => (o.kind === 'suppressed' ? o.reason : o.kind)),
    ).toEqual(['member-lookup-ambiguous']);
  });
});

describe('R: definitions the provider does not create', () => {
  const names = (label: string, file: string) =>
    getNodesByLabelFull(result, label)
      .filter((n) => n.properties.filePath === file)
      .map((n) => n.properties.name)
      .sort();

  it('creates a Class for setClass and setRefClass, and none for setClassUnion()', () => {
    expect(names('Class', 'R/s4.R')).toEqual(['Gen', 'PatOne', 'Person']);
  });

  it('creates no Method for setValidity(), setReplaceMethod() or Class$methods(...)', () => {
    expect(names('Method', 'R/s4.R')).toEqual([]);
    expect(names('Function', 'R/s4.R')).toEqual(['rename<-']);
  });
});

describe('R: exports and imports the provider does not read', () => {
  const exported = (name: string) =>
    getNodesByLabelFull(result, 'Function').find((n) => n.name === name)?.properties.isExported;

  it('consults NAMESPACE, not roxygen2 @export tags', () => {
    expect(exported('helper')).toBe(true); // export(helper)
    expect(exported('tagged')).toBe(false); // carries a roxygen2 @export tag, but NAMESPACE lacks it
    expect(exported('untagged')).toBe(false);
  });

  it('does not read exportClassPattern()', () => {
    const cls = getNodesByLabelFull(result, 'Class').find((n) => n.name === 'PatOne');
    expect(cls?.properties.isExported).toBe(false);
  });

  it('still parses .R files under renv/ (the shared scanner has no entry for it)', () => {
    expect(
      getNodesByLabelFull(result, 'Function').some(
        (n) => n.name === 'renv_only' && n.properties.filePath === 'renv/lib.R',
      ),
    ).toBe(true);
  });

  it('reads no import from box::use(), import::from(), loadNamespace(), attachNamespace() or sys.source()', () => {
    const from = (file: string) =>
      getRelationships(result, 'IMPORTS').filter((e) => e.sourceFilePath === file);
    expect(from('scripts/other_imports.R')).toEqual([]);
    // Positive control: library(shapes) in another script does import.
    expect(from('scripts/attach.R').length).toBeGreaterThan(0);
  });
});
