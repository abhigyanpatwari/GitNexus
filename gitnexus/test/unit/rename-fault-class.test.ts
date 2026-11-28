import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RenameFailure, SupportedLanguages, type GraphNode } from 'gitnexus-shared';
import { SCOPE_RESOLVERS } from '../../src/core/ingestion/scope-resolution/pipeline/registry.js';
import { createFaultScope, markFault } from '../../src/core/fault-class.js';
import {
  executeRenamePlan,
  renameFailureFault,
  renameSymbol,
  type RenamePlan,
} from '../../src/mcp/local/rename/rename-plan.js';
import { readRenameSourceVersion } from '../../src/mcp/local/rename/preview-plans.js';

describe('rename failure fault class', () => {
  it('a stale graph is a server fault: the index no longer matches the checkout', () => {
    expect(renameFailureFault(new RenameFailure('stale_graph', 'Re-analyze first.'))).toBe(
      'server',
    );
  });

  // The request or the working copy: the caller can correct it.
  it.each([
    'invalid_argument',
    'invalid_plan',
    'invalid_name',
    'name_collision',
    'source_changed',
    'duplicate_file',
    'ambiguous_reference',
    'unsupported_occurrence',
    'unsupported_reference',
  ])('a %s rename failure is a client fault', (code) => {
    expect(renameFailureFault(new RenameFailure(code, code))).toBe('client');
  });

  // The planner, a provider, the index or a server budget.
  it.each([
    'invalid_edit',
    'overlapping_edits',
    'no_locations',
    'missing_snapshot',
    'incomplete_semantics',
    'plan_too_large',
    'a_code_this_server_does_not_know',
  ])('a %s rename failure is a server fault', (code) => {
    expect(renameFailureFault(new RenameFailure(code, code))).toBe('server');
  });

  it('any other error keeps its class, and an unclassified one is a server fault', () => {
    expect(renameFailureFault(markFault(new Error('x'), 'client'))).toBe('client');
    expect(renameFailureFault(new Error('EIO'))).toBe('server');
  });
});

describe('sources that change under a rename plan', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'rename-fault-'));
    await fs.writeFile(path.join(root, 'a.ts'), 'close()');
    await fs.mkdir(path.join(root, 'lib'));
    await fs.writeFile(path.join(root, 'lib', 'b.ts'), 'close()');
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  /** Edits a.ts; lib/b.ts is a source the plan read but does not edit. */
  const plan = (): RenamePlan => ({
    symbol: { name: 'close', filePath: 'a.ts', startLine: 1 },
    new_name: 'finish',
    coverage: {
      name: 'gitnexus-semantic',
      scope: 'indexed-repository',
      languages: ['typescript'],
      limitations: [],
      source_file_count: 2,
    },
    snapshots: new Map([
      [path.join(root, 'a.ts'), 'close()'],
      [path.join(root, 'lib', 'b.ts'), 'close()'],
    ]),
    edits: [{ file_path: 'a.ts', start: 0, length: 5, old_text: 'close', new_text: 'finish' }],
  });

  const applied = async (evidence = new Map(), edits?: RenamePlan['edits']) => {
    const scope = createFaultScope();
    const result = await scope.run(() =>
      executeRenamePlan(root, { ...plan(), ...(edits ? { edits } : {}) }, false, evidence),
    );
    return { result, fault: scope.fault() };
  };

  it.each([
    [
      'invalid_edit',
      [{ file_path: 'a.ts', start: 0, length: 5, old_text: 'other', new_text: 'finish' }],
    ],
    [
      'overlapping_edits',
      [
        { file_path: 'a.ts', start: 0, length: 5, old_text: 'close', new_text: 'finish' },
        { file_path: 'a.ts', start: 1, length: 4, old_text: 'lose', new_text: 'ight' },
      ],
    ],
  ] as const)(
    'a planned edit set the planner got wrong (%s) is a server fault',
    async (code, edits) => {
      const { result, fault } = await applied(new Map(), [...edits]);
      expect(result).toMatchObject({ status: 'error', code });
      expect(fault).toBe('server');
    },
  );

  it('a source deleted between its path check and its read before writing is a client fault', async () => {
    const edited = path.join(root, 'a.ts');
    const realpath = fs.realpath.bind(fs);
    let checks = 0;
    // The first check validates the plan; the second is the recheck before writing.
    vi.spyOn(fs, 'realpath').mockImplementation(async (...args: Parameters<typeof fs.realpath>) => {
      const resolved = await realpath(...args);
      if (args[0] === edited && ++checks === 2) await fs.rm(edited);
      return resolved;
    });
    try {
      const { result, fault } = await applied();
      expect(result).toMatchObject({ status: 'error', application_status: 'failed' });
      expect(result.error).toMatch(/^ENOENT: /);
      expect(fault).toBe('client');
    } finally {
      vi.restoreAllMocks();
    }
  });

  // Each code injected where it is born, whatever this platform's filesystem
  // would report for the same change.
  const failRealpathOf = (file: string, code: string) => {
    const realpath = fs.realpath.bind(fs);
    return vi
      .spyOn(fs, 'realpath')
      .mockImplementation(async (...args: Parameters<typeof fs.realpath>) =>
        args[0] === file
          ? Promise.reject(Object.assign(new Error(`${code}: injected, realpath`), { code }))
          : realpath(...args),
      );
  };

  it.each(['ENOENT', 'ENOTDIR'])(
    'an edited source whose path fails with %s while the root is a directory is a client fault',
    async (code) => {
      failRealpathOf(path.join(root, 'a.ts'), code);
      try {
        const { result, fault } = await applied();
        expect(result.error).toMatch(new RegExp(`^${code}: `));
        expect(fault).toBe('client');
      } finally {
        vi.restoreAllMocks();
      }
    },
  );

  // What Windows reports when the root itself was replaced by a file.
  it('an edited source whose path fails with ENOENT while the root is a file is a server fault', async () => {
    await fs.rm(root, { recursive: true });
    await fs.writeFile(root, 'x');
    failRealpathOf(path.join(root, 'a.ts'), 'ENOENT');
    try {
      const { result, fault } = await applied();
      expect(result.error).toMatch(/^ENOENT: /);
      expect(fault).toBe('server');
    } finally {
      vi.restoreAllMocks();
    }
  });

  // The rest use the real filesystem. Windows reports ENOENT for a path through
  // a file, where POSIX systems report ENOTDIR; the class must not depend on which.
  const throughAFile = process.platform === 'win32' ? 'ENOENT' : 'ENOTDIR';

  it.each([
    ['an edited source was deleted', () => fs.rm(path.join(root, 'a.ts'))],
    ['an unedited source was deleted', () => fs.rm(path.join(root, 'lib', 'b.ts'))],
    [
      "an unedited source's directory became a file",
      async () => {
        await fs.rm(path.join(root, 'lib'), { recursive: true });
        await fs.writeFile(path.join(root, 'lib'), 'x');
      },
    ],
  ])('%s: a client fault, with the response unchanged', async (_label, change) => {
    await change();
    const { result, fault } = await applied();
    expect(result).toMatchObject({ status: 'error', code: 'rename_failed' });
    expect(result.error).toMatch(new RegExp(`^(ENOENT|${throughAFile}): `));
    expect(fault).toBe('client');
  });

  it('a deleted semantic-evidence file is a client fault', async () => {
    const file = path.join(root, 'c.ts');
    await fs.writeFile(file, 'export {};');
    const evidence = new Map([[file, await readRenameSourceVersion(file)]]);
    await fs.rm(file);
    const { result, fault } = await applied(evidence);
    expect(result).toMatchObject({ status: 'error', code: 'rename_failed' });
    expect(fault).toBe('client');
  });

  it('a source that cannot be read for another reason is a server fault', async () => {
    await fs.rm(path.join(root, 'lib', 'b.ts'));
    await fs.mkdir(path.join(root, 'lib', 'b.ts'));
    const { result, fault } = await applied();
    expect(result.error).toMatch(/^EISDIR: /);
    expect(fault).toBe('server');
  });

  // The root and the sources are resolved concurrently, so either read can fail
  // first; the class must not depend on which one did.
  it('a repository root that is gone is a server fault, whichever read fails first', async () => {
    for (let run = 0; run < 30; run++) {
      if (run > 0) {
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'rename-fault-'));
        await fs.writeFile(path.join(root, 'a.ts'), 'close()');
      }
      await fs.rm(root, { recursive: true });
      const { result, fault } = await applied();
      expect(result.error).toMatch(/^ENOENT: /);
      expect(fault, `run ${run}`).toBe('server');
    }
  });

  it('a repository root replaced by a file is a server fault', async () => {
    await fs.rm(root, { recursive: true });
    await fs.writeFile(root, 'x');
    const { result, fault } = await applied();
    expect(result.error).toMatch(new RegExp(`^${throughAFile}: `));
    expect(fault).toBe('server');
  });
});

describe('rename failures a language provider causes', () => {
  let root: string;
  const file = 'model.ts';
  const source = 'function target() {}\ntarget();\n';
  const nodes = [
    { id: `File:${file}`, label: 'File', properties: { name: file, filePath: file } },
    {
      id: `Function:${file}:target`,
      label: 'Function',
      properties: { name: 'target', filePath: file, startLine: 0, endLine: 0 },
    },
  ] as GraphNode[];
  const symbol = {
    uid: `Function:${file}:target`,
    name: 'target',
    kind: 'Function',
    filePath: file,
    startLine: 1,
  };
  const provider = SCOPE_RESOLVERS.get(SupportedLanguages.TypeScript)?.languageProvider.rename;
  if (!provider) throw new Error('The TypeScript rename provider is not registered.');
  type Rewrite = NonNullable<typeof provider.rewrite>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'rename-provider-fault-'));
    await fs.writeFile(path.join(root, file), source);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  const previewWith = async (rewrite: Rewrite) => {
    vi.spyOn(provider, 'rewrite').mockImplementation(rewrite);
    const scope = createFaultScope();
    const result = await scope.run(() =>
      renameSymbol(root, symbol, { new_name: 'renamed', dry_run: true }, nodes),
    );
    return { result, fault: scope.fault() };
  };

  it.each<[string, Rewrite, RegExp]>([
    [
      'a span whose text the source does not hold',
      ({ occurrence }) =>
        occurrence.spans.map((span) => ({ ...span, oldText: 'nothing', newText: 'renamed' })),
      /^The provider returned an invalid source span in model\.ts\.$/,
    ],
    [
      'overlapping rewrites',
      ({ occurrence, source: renamed }) =>
        occurrence.spans.flatMap(({ start, length }) => [
          {
            start,
            length,
            oldText: renamed.content.slice(start, start + length),
            newText: 'renamed',
          },
          {
            start: start + 1,
            length: 2,
            oldText: renamed.content.slice(start + 1, start + 3),
            newText: 'x',
          },
        ]),
      /^Provider source rewrites overlap\.$/,
    ],
  ])('a provider that returns %s is a server fault', async (_label, rewrite, error) => {
    const { result, fault } = await previewWith(rewrite);
    expect(result).toMatchObject({ status: 'error', code: 'unsupported_occurrence' });
    expect(result.error).toMatch(error);
    expect(fault).toBe('server');
  });

  it('a provider that cannot prove a reference is a client fault', async () => {
    vi.spyOn(provider, 'validateName').mockImplementation(() => {
      throw new RenameFailure('unsupported_reference', 'Provider cannot prove this reference.');
    });
    const scope = createFaultScope();
    const result = await scope.run(() =>
      renameSymbol(root, symbol, { new_name: 'renamed', dry_run: true }, nodes),
    );
    expect(result).toMatchObject({ status: 'error', code: 'unsupported_reference' });
    expect(scope.fault()).toBe('client');
  });

  it('a provider that declines an occurrence is a client fault', async () => {
    const { result, fault } = await previewWith(() => ({
      code: 'unsupported_occurrence',
      message: 'Dynamic dispatch may refer to the selected declaration.',
      status: 'unsupported',
    }));
    expect(result).toMatchObject({
      status: 'error',
      code: 'unsupported_occurrence',
      error: 'Dynamic dispatch may refer to the selected declaration.',
    });
    expect(fault).toBe('client');
  });
});
