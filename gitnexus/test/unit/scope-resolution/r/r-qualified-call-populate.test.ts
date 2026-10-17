/**
 * `populateRQualifiedCalls` attributes a local package's top-level definitions to the files of
 * that package. A package known only from a `<name>/R/` directory owns the files under it, but
 * never a file a discovered package owns, whatever that directory is called.
 */
import { describe, expect, it } from 'vitest';
import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import type { RPackageConfig } from '../../../../src/core/ingestion/languages/r/package-config.js';
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
