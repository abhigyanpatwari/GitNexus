/**
 * Python taint model (#2204) over real Python CFG and import capture output.
 */

import Python from 'tree-sitter-python';
import type { ParsedImport } from 'gitnexus-shared';
import { describe, expect, it } from 'vitest';
import { createPythonCfgVisitor } from '../../../src/core/ingestion/cfg/visitors/python.js';
import { emitPythonScopeCaptures } from '../../../src/core/ingestion/languages/python/captures.js';
import { interpretPythonImport } from '../../../src/core/ingestion/languages/python/interpret.js';
import { PYTHON_TAINT_MODEL } from '../../../src/core/ingestion/taint/python-model.js';
import type { SourceSinkSanitizerSpec } from '../../../src/core/ingestion/taint/source-sink-config.js';
import { hasTaintSafeSites } from '../../../src/core/ingestion/taint/site-safety.js';
import {
  buildTaintImportIndex,
  matchFunctionSites,
  type FunctionSiteMatches,
  type MatchedSinkCall,
  type MatchedSource,
} from '../../../src/core/ingestion/taint/match.js';
import { makeCfgHarness } from '../../helpers/cfg-harness.js';

const harness = makeCfgHarness(Python, createPythonCfgVisitor(), 'fixture.py');

function importsFor(src: string): ParsedImport[] {
  return emitPythonScopeCaptures(src, 'fixture.py')
    .filter((m) => m['@import.statement'] !== undefined)
    .map((m) => interpretPythonImport(m))
    .filter((p): p is ParsedImport => p !== null);
}

function matchesOf(
  code: string,
  fnIndex = 0,
  spec: SourceSinkSanitizerSpec = PYTHON_TAINT_MODEL,
): FunctionSiteMatches {
  const cfg = harness.cfgOf(code, fnIndex);
  expect(hasTaintSafeSites(cfg)).toBe(true);
  return matchFunctionSites(cfg, spec, buildTaintImportIndex(importsFor(code)));
}

const allSinks = (m: FunctionSiteMatches): MatchedSinkCall[] =>
  m.statements.flatMap((s) => [...s.sinks]);
const allSources = (m: FunctionSiteMatches): MatchedSource[] =>
  m.statements.flatMap((s) => [...s.sources]);

describe('Python taint model (#2204)', () => {
  it('matches Flask/FastAPI-style request member reads as remote-input sources', () => {
    const m = matchesOf(`
def f(request, req, other):
    a = request.args
    b = req.json
    c = other.args
`);
    expect(allSources(m).map((s) => s.entry.kind)).toEqual(['remote-input', 'remote-input']);
    expect(m.hasSource).toBe(true);
  });

  it('resolves named stdlib imports for command sinks', () => {
    const m = matchesOf(`
from os import system

def f(request):
    system(request.args)
`);
    const sinks = allSinks(m);
    expect(sinks).toHaveLength(1);
    expect(sinks[0].entry.kind).toBe('command-injection');
    expect(sinks[0].entry.name).toBe('system');
    expect(allSources(m)).toHaveLength(1);
  });

  it('resolves namespace stdlib imports for subprocess sinks', () => {
    const m = matchesOf(`
import subprocess as sp

def f(request):
    sp.run(request.args)
`);
    expect(allSinks(m).map((s) => s.entry.name)).toEqual(['run']);
  });

  it('does not dedupe named imports from a same-tail module path', () => {
    const spec: SourceSinkSanitizerSpec = {
      sources: [],
      sinks: [{ name: 'read_string', kind: 'path-traversal', args: [0], module: 'pkg.Files' }],
      sanitizers: [],
    };
    const m = matchesOf(
      `
from pkg.Files import Files

def f(p):
    Files.read_string(p)
`,
      0,
      spec,
    );
    expect(allSinks(m)).toHaveLength(0);
  });

  it('does not guess positional sink slots for keyword arguments', () => {
    const m = matchesOf(`
import subprocess as sp

def f(request):
    sp.run(shell=request.args, args="safe")
`);
    expect(allSinks(m)).toHaveLength(0);
    expect(allSources(m)).toHaveLength(1);
  });

  it('matches global code and path sinks at argument position zero', () => {
    const m = matchesOf(`
def f(request):
    eval(request.args)
    exec(request.form)
    open(request.path_params)
`);
    const sinks = allSinks(m);
    expect(sinks.map((s) => s.entry.kind)).toEqual([
      'code-injection',
      'code-injection',
      'path-traversal',
    ]);
    expect(sinks.map((s) => [...s.argPositions])).toEqual([[0], [0], [0]]);
    expect(allSources(m)).toHaveLength(3);
  });

  it('matches conventional database calls at argument position zero', () => {
    const m = matchesOf(`
def f(request, cursor, db):
    cursor.execute(request.args)
    db.query(request.form)
    cursor.executemany(request.json)
    cursor.executescript(request.data)
`);
    const sinks = allSinks(m);
    expect(sinks.map((s) => s.entry.name)).toEqual([
      'execute',
      'query',
      'executemany',
      'executescript',
    ]);
    expect(sinks.map((s) => [...s.argPositions])).toEqual([[0], [0], [0], [0]]);
    expect(allSources(m)).toHaveLength(4);
  });

  it('does not match a locally shadowed stdlib sink name', () => {
    const m = matchesOf(`
from os import system

def f(request):
    def system(value):
        return value
    system(request.args)
`);
    expect(allSinks(m)).toHaveLength(0);
    expect(allSources(m)).toHaveLength(1);
  });

  it('does not let methods in a nested class shadow an enclosing import', () => {
    const m = matchesOf(`
from os import system

def f(request):
    class Helpers:
        def system(self, value):
            return value
    system(request.args)
`);
    expect(allSinks(m)).toHaveLength(1);
    expect(allSources(m)).toHaveLength(1);
  });

  it('treats a nested class declaration as a local sink-name binding', () => {
    const m = matchesOf(`
def f(request):
    class open:
        pass
    open(request.args)
`);
    expect(allSinks(m)).toHaveLength(0);
    expect(allSources(m)).toHaveLength(1);
  });
});
