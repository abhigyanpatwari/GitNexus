import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/core/logger.js', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
  },
}));

import type { ParsedFile, SymbolDefinition } from 'gitnexus-shared';
import { logger } from '../../../../src/core/logger.js';
import { populateGoWorkspaceOwners } from '../../../../src/core/ingestion/languages/go/method-owners.js';

/**
 * #2837. A Go file whose package clause cannot be resolved is dropped from
 * method-owner resolution entirely — its methods can never attach to a struct
 * declared in a sibling file. That used to be a bare `continue` with no trace,
 * the same false-safe silence #2813 was filed about.
 *
 * The warning is bounded on purpose: one line per analyze, naming at most five
 * paths, never one line per file.
 */
describe('populateGoWorkspaceOwners no-package-clause reporting (#2837)', () => {
  beforeEach(() => {
    vi.mocked(logger.warn).mockClear();
  });

  it('says nothing when every file has a package clause', () => {
    populateGoWorkspaceOwners([parsed('a/svc.go')], {
      fileContents: new Map([['a/svc.go', 'package a\n']]),
    });
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });

  it('emits exactly one warning naming the file it dropped', () => {
    populateGoWorkspaceOwners([parsed('a/svc.go'), parsed('a/broken.go')], {
      fileContents: new Map([
        ['a/svc.go', 'package a\n'],
        ['a/broken.go', 'func Orphan() {}\n'],
      ]),
    });
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
    const [payload] = vi.mocked(logger.warn).mock.calls[0] as [
      { skippedFiles: number; sample: string[] },
    ];
    expect(payload.skippedFiles).toBe(1);
    expect(payload.sample).toEqual(['a/broken.go']);
  });

  // A file whose header comment happens to contain a `package` line used to be
  // bucketed under THAT name, silently isolating it. It must now resolve to its
  // real package and therefore produce no warning at all.
  it('does not warn for a file whose comment mentions another package', () => {
    populateGoWorkspaceOwners([parsed('a/svc.go')], {
      fileContents: new Map([
        ['a/svc.go', '/*\npackage legacy_notes kept for history\n*/\npackage a\n'],
      ]),
    });
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });

  it('caps the sample at five paths while reporting the true total', () => {
    const files = Array.from({ length: 9 }, (_, i) => parsed(`a/f${i}.go`));
    const contents = new Map(files.map((f) => [f.filePath, 'not go source\n']));
    populateGoWorkspaceOwners(files, { fileContents: contents });
    expect(vi.mocked(logger.warn)).toHaveBeenCalledTimes(1);
    const [payload] = vi.mocked(logger.warn).mock.calls[0] as [
      { skippedFiles: number; sample: string[] },
    ];
    expect(payload.skippedFiles).toBe(9);
    expect(payload.sample).toHaveLength(5);
  });
});

function parsed(filePath: string): ParsedFile {
  const localDef: SymbolDefinition = {
    nodeId: `def:${filePath}`,
    filePath,
    type: 'Function',
    qualifiedName: 'Noop',
  };
  return {
    filePath,
    moduleScope: `module:${filePath}`,
    scopes: [],
    parsedImports: [],
    localDefs: [localDef],
    referenceSites: [],
  };
}
