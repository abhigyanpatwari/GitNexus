import { describe, expect, it } from 'vitest';
import { makeScopeId, type ParsedFile, type SymbolDefinition } from 'gitnexus-shared';
import { resolvePythonImportTarget } from '../../../../src/core/ingestion/languages/python/import-target.js';

function parsedFile(localDefs: readonly SymbolDefinition[]): ParsedFile {
  return {
    filePath: 'pkg/__init__.py',
    moduleScope: makeScopeId({
      filePath: 'pkg/__init__.py',
      kind: 'Module',
      range: { startLine: 1, startCol: 0, endLine: 1, endCol: 0 },
    }),
    scopes: [],
    parsedImports: [],
    localDefs,
    referenceSites: [],
  };
}

function definition(qualifiedName?: string): SymbolDefinition {
  return {
    nodeId: `Function:${qualifiedName}`,
    filePath: 'pkg/__init__.py',
    type: 'Function',
    qualifiedName,
  };
}

function resolver(files: readonly ParsedFile[], names: readonly string[]) {
  const context = {
    fromFile: 'app.py',
    allFilePaths: new Set(['pkg/__init__.py', ...names.map((name) => `pkg/${name}.py`)]),
    parsedFiles: files,
  };
  return (name: string) =>
    resolvePythonImportTarget(
      { kind: 'named', targetRaw: 'pkg', localName: name, importedName: name },
      context,
    );
}

describe('Python exported-name lookup scaling', () => {
  // Count definition reads, not file-set probes: only these see the old
  // per-import localDefs.some scan. Colliding submodules make every hit matter.
  it.each([32, 128, 512, 2048])('reads %i definitions once across hits and misses', (count) => {
    let reads = 0;
    const names = Array.from({ length: count }, (_, i) => `name${i}`);
    const defs = names.map((name) => ({
      ...definition(name),
      get qualifiedName() {
        reads++;
        return name;
      },
    }));
    const resolve = resolver([parsedFile(defs)], [...names, 'absent']);
    for (const name of names) expect(resolve(name)).toBe('pkg/__init__.py');
    for (const name of [...names].reverse()) expect(resolve(name)).toBe('pkg/__init__.py');
    for (let i = 0; i < count; i++) expect(resolve('absent')).toBe('pkg/absent.py');
    expect(reads).toBe(count);
  });

  it('keeps early hits cheap and completes the index only when needed', () => {
    let reads = 0;
    const defs = Array.from({ length: 128 }, (_, i) => ({
      ...definition(`name${i}`),
      get qualifiedName() {
        reads++;
        return `name${i}`;
      },
    }));
    const resolve = resolver([parsedFile(defs)], ['name0', 'name127', 'absent']);
    expect(resolve('name0')).toBe('pkg/__init__.py');
    expect(resolve('name0')).toBe('pkg/__init__.py');
    expect(reads).toBe(1);
    expect(resolve('name127')).toBe('pkg/__init__.py');
    expect(resolve('absent')).toBe('pkg/absent.py');
    expect(reads).toBe(128);
  });

  it('does not reuse a previous pass even when its definition array is reused', () => {
    const defs = [definition('old')];
    const file = parsedFile(defs);
    expect(resolver([file], ['old', 'new'])('old')).toBe('pkg/__init__.py');
    defs[0] = definition('new');
    const nextPass = resolver([file], ['old', 'new']);
    expect(nextPass('old')).toBe('pkg/old.py');
    expect(nextPass('new')).toBe('pkg/__init__.py');
  });

  it('preserves qualified suffixes and ignores absent or empty names', () => {
    const resolve = resolver(
      [parsedFile([definition(), definition(''), definition('owner.exported')])],
      ['exported', 'absent'],
    );
    expect(resolve('exported')).toBe('pkg/__init__.py');
    expect(resolve('absent')).toBe('pkg/absent.py');
  });

  it('retains the first parsed file when duplicate paths have different exports', () => {
    const resolve = resolver([parsedFile([]), parsedFile([definition('exported')])], ['exported']);
    expect(resolve('exported')).toBe('pkg/exported.py');
  });
});
