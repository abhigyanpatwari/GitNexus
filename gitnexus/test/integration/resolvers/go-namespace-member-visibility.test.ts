/**
 * Go — namespace-qualified references honour the export rule, through the REAL
 * pipeline (tree-sitter extraction + import resolution + every resolution pass).
 *
 * Go exports an identifier only when it begins with an uppercase letter, so
 * `api.target()` from another package is a compile error whatever import
 * spelling introduced `api`. The shared namespace lookups used to treat every
 * module-scope declaration of the target package as a public member and minted
 * a confident `import-resolved` edge to it anyway; `ScopeResolver
 * .isNamespaceMemberVisible` now refuses the unexported ones. These cases pin
 * both directions: the invalid qualified references get NO edge, and every
 * legitimate way of reaching a declaration keeps its edge.
 *
 * (`api.target()` does not compile in real Go. Such edges arise only in invalid
 * code, which is exactly why a rename that unexports `api.Target` must not have
 * its re-resolution certified by one — see `rename-go-reresolution.test.ts`.)
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getRelationships, writeFixtureRepo, type PipelineResult } from './helpers.js';
import { runPipelineFromRepo } from '../../../src/core/ingestion/pipeline.js';

const API = 'example.com/nsvis/api';

describe('Go namespace-qualified member visibility (real pipeline)', () => {
  let result: PipelineResult;

  const targetsOf = (type: 'CALLS' | 'ACCESSES', source: string): string[] =>
    getRelationships(result, type)
      .filter((edge) => edge.source === source)
      .map((edge) => edge.target)
      .sort();

  beforeAll(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-go-nsvis-'));
    writeFixtureRepo(dir, {
      'go.mod': 'module example.com/nsvis\n\ngo 1.21\n',
      'api/api.go': [
        'package api',
        '',
        'func target() int { return 1 }',
        '',
        'func Target() int { return 2 }',
        '',
        'type thing struct{}',
        '',
        'type Thing struct{}',
        '',
        'var hidden = 1',
        '',
        'var Shown = 2',
        '',
        'func helper() *Thing { return &Thing{} }',
        '',
        'func Maker() *Thing { return &Thing{} }',
        '',
        'func (t *Thing) Pub() {}',
        '',
        'func SameFile() int { return target() }',
        '',
      ].join('\n'),
      // Same package, other file: unexported names are visible UNQUALIFIED.
      'api/sibling.go': ['package api', '', 'func SiblingUse() int { return target() }', ''].join(
        '\n',
      ),
      // External test package of the same directory: a different package.
      'api/api_test.go': [
        'package api_test',
        '',
        `import "${API}"`,
        '',
        'func TestExtUpper() int { return api.Target() }',
        '',
        'func TestExtLower() int { return api.target() }',
        '',
      ].join('\n'),
      'main/main.go': [
        'package main',
        '',
        'import (',
        `\t"${API}"`,
        `\tshim "${API}"`,
        ')',
        '',
        'func CallLower() int { return api.target() }',
        '',
        'func CallUpper() int { return api.Target() }',
        '',
        'func AliasLower() int { return shim.target() }',
        '',
        'func AliasUpper() int { return shim.Target() }',
        '',
        'func MakeLower() { _ = api.thing{} }',
        '',
        'func MakeUpper() { _ = api.Thing{} }',
        '',
        'func ReadLower() int { return api.hidden }',
        '',
        'func ReadUpper() int { return api.Shown }',
        '',
        'func ChainLower() { api.helper().Pub() }',
        '',
        'func ChainUpper() { api.Maker().Pub() }',
        '',
      ].join('\n'),
      // A dot import brings only the EXPORTED names into scope.
      'dot/dot.go': [
        'package dot',
        '',
        `import . "${API}"`,
        '',
        'func DotUpper() int { return Target() }',
        '',
        'func DotLower() int { return target() }',
        '',
      ].join('\n'),
    });
    result = await runPipelineFromRepo(dir, () => {});
  }, 60000);

  it('resolves an exported function through the package qualifier at import-resolved confidence', () => {
    const edges = getRelationships(result, 'CALLS').filter((edge) => edge.source === 'CallUpper');
    expect(edges.map((edge) => edge.target)).toEqual(['Target']);
    expect(edges[0]!.rel.reason).toBe('import-resolved');
  });

  it('gives an unexported function reached through the package qualifier no edge at all', () => {
    expect(targetsOf('CALLS', 'CallLower')).toEqual([]);
  });

  it('keeps the exported/unexported split under an import alias', () => {
    expect(targetsOf('CALLS', 'AliasUpper')).toEqual(['Target']);
    expect(targetsOf('CALLS', 'AliasLower')).toEqual([]);
  });

  it('keeps the exported/unexported split in an external test package of the same directory', () => {
    expect(targetsOf('CALLS', 'TestExtUpper')).toEqual(['Target']);
    expect(targetsOf('CALLS', 'TestExtLower')).toEqual([]);
  });

  it('keeps the exported/unexported split for a qualified composite literal', () => {
    expect(targetsOf('CALLS', 'MakeUpper')).toEqual(['Thing']);
    expect(targetsOf('CALLS', 'MakeLower')).toEqual([]);
  });

  it('keeps the exported/unexported split for a qualified package-variable read', () => {
    expect(targetsOf('ACCESSES', 'ReadUpper')).toEqual(['Shown']);
    expect(targetsOf('ACCESSES', 'ReadLower')).toEqual([]);
  });

  it('does not type a method chain from an unexported function reached through the qualifier', () => {
    expect(targetsOf('CALLS', 'ChainUpper')).toContain('Maker');
    expect(targetsOf('CALLS', 'ChainLower')).toEqual([]);
  });

  it('still resolves unexported names UNQUALIFIED inside their own package, across files', () => {
    expect(targetsOf('CALLS', 'SameFile')).toEqual(['target']);
    expect(targetsOf('CALLS', 'SiblingUse')).toEqual(['target']);
  });

  it('resolves only the exported name through a dot import', () => {
    expect(targetsOf('CALLS', 'DotUpper')).toEqual(['Target']);
    expect(targetsOf('CALLS', 'DotLower')).toEqual([]);
  });
});
