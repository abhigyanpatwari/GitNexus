/**
 * `populateRQualifiedCalls` attributes a local package's top-level definitions to the files of
 * that package. A package known only from a `<name>/R/` directory owns the files under it, but
 * never a file a discovered package owns, whatever that directory is called.
 */
import { describe, expect, it } from 'vitest';
import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import type { RPackageConfig } from '../../../../src/core/ingestion/languages/r/package-config.js';
import { rQualifiedDefinitionCount } from '../../../../src/core/ingestion/languages/r/namespace-imports.js';
import {
  populateRQualifiedCalls,
  resolveRQualifiedFreeCall,
} from '../../../../src/core/ingestion/languages/r/qualified-call.js';

const callSite = {
  kind: 'call',
  name: 'helper',
  rawQualifiedName: 'foo::helper',
  atRange: { startLine: 3, startCol: 2, endLine: 3, endCol: 16 },
};

function definition(filePath: string): SymbolDefinition {
  return { nodeId: `Function:${filePath}:helper`, filePath, type: 'Function' } as SymbolDefinition;
}

/** A file whose Module scope binds `helper` as a local top-level function. */
function definingFile(filePath: string): ParsedFile {
  const def = definition(filePath);
  return {
    filePath,
    moduleScope: 'module',
    scopes: [{ id: 'module', bindings: new Map([['helper', [{ origin: 'local', def }]]]) }],
    referenceSites: [],
  } as unknown as ParsedFile;
}

function callerFile(filePath: string): ParsedFile {
  return {
    filePath,
    moduleScope: 'module',
    scopes: [{ id: 'module', bindings: new Map() }],
    referenceSites: [callSite],
  } as unknown as ParsedFile;
}

describe('populateRQualifiedCalls: <name>/R/ ownership', () => {
  it('binds `foo::helper` to the undiscovered foo/R/ package, not to a discovered package in a directory named foo', () => {
    // Discovery found `Package: bar` in pkgs/foo; x/foo/R/ has no DESCRIPTION, so `foo` is a
    // package only through its directory name.
    const cfg: RPackageConfig = {
      packages: new Map([['bar', 'pkgs/foo']]),
      namespaceInfoByPackageDir: new Map(),
      truncated: false,
    };
    const parsedFiles = [
      definingFile('pkgs/foo/R/a.R'),
      definingFile('x/foo/R/b.R'),
      callerFile('scripts/use.R'),
    ];
    populateRQualifiedCalls(parsedFiles, { resolutionConfig: cfg });

    const caller = parsedFiles[2];
    expect(caller.referenceSites).toHaveLength(1); // not dropped as a duplicate definition
    expect(resolveRQualifiedFreeCall(callSite, caller)?.filePath).toBe('x/foo/R/b.R');
  });
});

describe('populateRQualifiedCalls: module state', () => {
  const config = (): RPackageConfig => ({
    packages: new Map([['foo', 'pkgs/foo']]),
    namespaceInfoByPackageDir: new Map(),
    truncated: false,
  });

  it.each([
    ['an empty context', {}],
    ['a context whose resolutionConfig is undefined', { resolutionConfig: undefined }],
    ['a context whose resolutionConfig is null', { resolutionConfig: null }],
  ])('runs without a package config (%s)', (_name, ctx) => {
    const parsedFiles = [definingFile('pkgs/foo/R/a.R'), callerFile('scripts/use.R')];
    expect(() => populateRQualifiedCalls(parsedFiles, ctx)).not.toThrow();
    // No config, so nothing proves `foo` external: the site stays and nothing is recorded.
    expect(parsedFiles[1].referenceSites).toHaveLength(1);
  });

  it('forgets the previous run: a run with no qualified call records no definition count', () => {
    const cfg = config();
    populateRQualifiedCalls([definingFile('pkgs/foo/R/a.R'), callerFile('scripts/use.R')], {
      resolutionConfig: cfg,
    });
    expect(rQualifiedDefinitionCount(cfg, 'foo', 'helper')).toBe(1);

    populateRQualifiedCalls([definingFile('pkgs/foo/R/a.R')], { resolutionConfig: cfg });
    expect(rQualifiedDefinitionCount(cfg, 'foo', 'helper')).toBeUndefined();
  });

  it('forgets the previous run precise targets: a later run does not resolve its site', () => {
    const cfg = config();
    const first = [definingFile('pkgs/foo/R/a.R'), callerFile('scripts/use.R')];
    populateRQualifiedCalls(first, { resolutionConfig: cfg });
    expect(resolveRQualifiedFreeCall(callSite, first[1])?.filePath).toBe('pkgs/foo/R/a.R');

    const second = [callerFile('scripts/use.R')];
    populateRQualifiedCalls(second, { resolutionConfig: cfg });
    expect(resolveRQualifiedFreeCall(callSite, second[0])).toBeUndefined();
  });
});
