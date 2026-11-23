/**
 * Fault class of caller input that reaches LocalBackend through tools/call:
 * a `read_file` path, a tool name, and a `repo` on a tool without a schema.
 *
 * read_file runs real filesystem calls on a temp checkout, so each error code
 * comes from the operating system, not from a mock. The registry is mocked and
 * GITNEXUS_HOME points at a temp directory, so nothing touches ~/.gitnexus.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

const { lbugMocks } = vi.hoisted(() => ({
  lbugMocks: {
    initLbug: vi.fn().mockResolvedValue(undefined),
    executeQuery: vi.fn().mockResolvedValue([]),
    executeParameterized: vi.fn().mockResolvedValue([]),
    ensureVectorExtension: vi.fn().mockResolvedValue(true),
    closeLbug: vi.fn().mockResolvedValue(undefined),
    isLbugReady: vi.fn().mockReturnValue(true),
  },
}));

vi.mock('../../src/core/lbug/pool-adapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/lbug/pool-adapter.js')>();
  return { ...actual, ...lbugMocks };
});

vi.mock('../../src/storage/repo-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/repo-manager.js')>();
  return { ...actual, listRegisteredRepos: vi.fn().mockResolvedValue([]) };
});

vi.mock('../../src/core/git-staleness.js', () => ({
  checkStaleness: vi.fn().mockReturnValue({ isStale: false, commitsBehind: 0 }),
  checkStalenessAsync: vi.fn().mockResolvedValue({ isStale: false, commitsBehind: 0 }),
  checkCwdMatch: vi.fn().mockResolvedValue({ match: 'none' }),
}));

import { LocalBackend } from '../../src/mcp/local/local-backend.js';
import { createMCPServer } from '../../src/mcp/server.js';
import { listRegisteredRepos } from '../../src/storage/repo-manager.js';

const KEY = 'io.github.abhigyanpatwari.gitnexus/fault';
const NAME = 'fault-input-repo';

let root: string;
let home: string;
let backend: LocalBackend;
/** False where the OS refuses to create symlinks, as Windows may without privileges. */
let symlinks = true;

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'gnx-fault-input-home-'));
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'gnx-fault-input-'));
  const storage = path.join(root, '.gitnexus');
  await fs.mkdir(path.join(storage, 'lbug'), { recursive: true });
  await fs.writeFile(
    path.join(storage, 'gitnexus.json'),
    JSON.stringify({ contentRetention: 'full', indexedAt: '2024-06-01T12:00:00Z' }),
  );
  await fs.mkdir(path.join(root, 'src'));
  await fs.writeFile(path.join(root, 'src', 'auth.ts'), 'export {};\n');
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root });
  git('init', '-q');
  git('add', 'src');
  git('commit', '-q', '-m', 'init');
  await fs.writeFile(path.join(root, 'locked.txt'), 'secret\n');
  await fs.chmod(path.join(root, 'locked.txt'), 0o000);
  await fs.mkdir(path.join(root, 'locked-dir'));
  await fs.writeFile(path.join(root, 'locked-dir', 'file.txt'), 'secret\n');
  await fs.chmod(path.join(root, 'locked-dir'), 0o000);
  try {
    await fs.symlink('loop-b', path.join(root, 'loop-a'));
    await fs.symlink('loop-a', path.join(root, 'loop-b'));
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    symlinks = false;
  }
  vi.mocked(listRegisteredRepos).mockResolvedValue([
    {
      name: NAME,
      path: root,
      storagePath: storage,
      indexedAt: '2024-06-01T12:00:00Z',
      lastCommit: 'abc123',
    } as Awaited<ReturnType<typeof listRegisteredRepos>>[number],
  ]);
});

afterAll(async () => {
  await fs.chmod(path.join(root, 'locked.txt'), 0o600).catch(() => {});
  await fs.chmod(path.join(root, 'locked-dir'), 0o700).catch(() => {});
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function callTool(name: string, args: Record<string, unknown>) {
  vi.stubEnv('GITNEXUS_HOME', home);
  backend ??= new LocalBackend();
  const server = createMCPServer(backend);
  const client = new Client({ name: 'fault-input-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const response = CallToolResultSchema.parse(await client.callTool({ name, arguments: args }));
    const text = response.content.find((item) => item.type === 'text')?.text ?? '';
    return {
      text,
      ...('isError' in response ? { isError: response.isError } : {}),
      meta: response._meta,
    };
  } finally {
    await client.close();
    await server.close();
  }
}

/**
 * A path error as read_file reports it: ENOENT is a soft "File not found"
 * result, any other code an isError response that names it. Both are the
 * caller's.
 */
function expectClientPathError(response: Awaited<ReturnType<typeof callTool>>, code: string) {
  if (code === 'ENOENT') {
    expect(response).not.toHaveProperty('isError');
    expect(response.text).toContain('File not found: ');
  } else {
    expect(response.isError).toBe(true);
    expect(response.text.startsWith(`Error [${code}]: `)).toBe(true);
  }
  expect(response.meta?.[KEY]).toBe('client');
}

describe('read_file path errors', () => {
  // Each code where the operating system raises it, injected so the result does
  // not depend on which code this platform picks for a given path.
  it.each([
    ['realpath', 'ENOENT'],
    ['realpath', 'ENOTDIR'],
    ['realpath', 'ENAMETOOLONG'],
    ['realpath', 'ELOOP'],
    ['realpath', 'EINVAL'],
    ['readFile', 'EISDIR'],
  ] as const)('%s failing with %s is a client fault', async (method, code) => {
    const original = fs[method] as (...args: unknown[]) => Promise<unknown>;
    const spy = vi
      .spyOn(fs, method)
      .mockImplementation((async (target: unknown, ...rest: unknown[]) =>
        String(target).endsWith(path.join('src', 'auth.ts'))
          ? Promise.reject(Object.assign(new Error(`${code}: injected, ${method}`), { code }))
          : original(target, ...rest)) as never);
    try {
      expectClientPathError(await callTool('read_file', { repo: NAME, path: 'src/auth.ts' }), code);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  // The same paths on the real filesystem. Windows reports ENOENT for a path
  // through a file and for an over-long name, where POSIX systems report
  // ENOTDIR and ENAMETOOLONG; the class is the caller's either way.
  const onWindows = (posixCode: string) => (process.platform === 'win32' ? 'ENOENT' : posixCode);
  it.for([
    ['a directory', 'src', 'EISDIR'],
    ['a path through a file', 'src/auth.ts/x', onWindows('ENOTDIR')],
    ['a NUL byte', 'src/a\u0000b', 'ERR_INVALID_ARG_VALUE'],
    ['an over-long name', 'x'.repeat(300), onWindows('ENAMETOOLONG')],
    ['a symlink loop', 'loop-a', 'ELOOP'],
  ])('%s on the real filesystem is a client fault', async ([, filePath, code], ctx) => {
    if (code === 'ELOOP' && !symlinks) ctx.skip();
    expectClientPathError(await callTool('read_file', { repo: NAME, path: filePath }), code);
  });

  it.skipIf(process.getuid?.() === 0 || process.platform === 'win32')(
    'a file the server may not read is a server fault',
    async () => {
      const response = await callTool('read_file', { repo: NAME, path: 'locked.txt' });
      expect(response.isError).toBe(true);
      expect(response.text.startsWith('Error [EACCES]: ')).toBe(true);
      expect(response.meta?.[KEY]).toBe('server');
    },
  );

  it.skipIf(process.getuid?.() === 0 || process.platform === 'win32')(
    'a path through a directory the server may not search is a server fault',
    async () => {
      const response = await callTool('read_file', { repo: NAME, path: 'locked-dir/file.txt' });
      expect(response.isError).toBe(true);
      expect(response.text.startsWith('Error [EACCES]: ')).toBe(true);
      expect(response.meta?.[KEY]).toBe('server');
    },
  );

  // Runs as root too, where permission bits cannot produce the error.
  it('an I/O error while resolving the path is a server fault', async () => {
    const realpath = fs.realpath;
    const spy = vi
      .spyOn(fs, 'realpath')
      .mockImplementation(async (target, ...rest) =>
        String(target).endsWith(path.join('src', 'auth.ts'))
          ? Promise.reject(Object.assign(new Error('EIO: i/o error, realpath'), { code: 'EIO' }))
          : realpath(target, ...rest),
      );
    try {
      const response = await callTool('read_file', { repo: NAME, path: 'src/auth.ts' });
      expect(response).toMatchObject({
        isError: true,
        text: 'Error [EIO]: EIO: i/o error, realpath',
      });
      expect(response.meta?.[KEY]).toBe('server');
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('a missing file stays a soft client fault and a real file reads', async () => {
    const missing = await callTool('read_file', { repo: NAME, path: 'nope.txt' });
    expect(missing).not.toHaveProperty('isError');
    expect(missing.text).toContain('File not found: nope.txt');
    expect(missing.meta?.[KEY]).toBe('client');

    const found = await callTool('read_file', { repo: NAME, path: 'src/auth.ts' });
    expect(found).not.toHaveProperty('isError');
    expect(found.meta).toBeUndefined();
  });

  it.each([
    ['read_file', { path: 'src/auth.ts' }],
    ['grep', { pattern: 'export' }],
  ])('%s on a registered checkout that is gone is a server fault', async (tool, args) => {
    const moved = `${root}.moved`;
    await fs.rename(root, moved);
    try {
      const response = await callTool(tool, { repo: NAME, ...args });
      expect(JSON.parse(response.text.split('\n\n---')[0])).toMatchObject({
        code: 'source-unavailable',
        reason: 'checkout-missing',
      });
      expect(response.meta?.[KEY]).toBe('server');
    } finally {
      await fs.rename(moved, root);
    }
  });

  // The checkout passed the availability check but goes before the path resolves.
  it.each([
    ['gone', 'ENOENT', undefined],
    ['replaced by a file', 'ENOTDIR', { isDirectory: () => false }],
  ] as const)(
    'a checkout %s while the path resolves is a server fault',
    async (_label, code, rootStat) => {
      const realpath = fs.realpath;
      const stat = fs.stat;
      let rootStats = 0;
      vi.spyOn(fs, 'realpath').mockImplementation(async (target, ...rest) =>
        String(target).endsWith(path.join('src', 'auth.ts'))
          ? Promise.reject(Object.assign(new Error(`${code}: injected, realpath`), { code }))
          : realpath(target, ...rest),
      );
      vi.spyOn(fs, 'stat').mockImplementation(async (target, ...rest) => {
        if (target !== root || rootStats++ === 0) return stat(target, ...rest);
        if (rootStat) return rootStat as never;
        throw Object.assign(new Error('ENOENT: injected, stat'), { code: 'ENOENT' });
      });
      try {
        const response = await callTool('read_file', { repo: NAME, path: 'src/auth.ts' });
        if (code === 'ENOENT') expect(response.text).toContain('File not found: src/auth.ts');
        else expect(response.text.startsWith('Error [ENOTDIR]: ')).toBe(true);
        expect(rootStats).toBe(2);
        expect(response.meta?.[KEY]).toBe('server');
      } finally {
        vi.restoreAllMocks();
      }
    },
  );
});

describe('tool names and repo on tools without a schema', () => {
  it.each([5, true, {}])('overview with repo %j is a client fault', async (repo) => {
    const response = await callTool('overview', { repo });
    expect(response).toMatchObject({
      isError: true,
      text: 'Error: Parameter "repo" must be an indexed repository name or path.',
    });
    expect(response.meta?.[KEY]).toBe('client');
  });

  it.each([
    ['nosuch', { repo: 5 }],
    ['Query', { repo: 5 }],
    ['constructor', {}],
    ['toString', {}],
    ['__proto__', {}],
    ['hasOwnProperty', { repo: NAME }],
  ])('unknown tool %s is a client fault', async (name, args) => {
    const response = await callTool(name, args);
    expect(response).toMatchObject({ isError: true, text: `Error: Unknown tool: ${name}` });
    expect(response.meta?.[KEY]).toBe('client');
  });

  it('every advertised tool and legacy alias still dispatches', async () => {
    const { GITNEXUS_TOOLS, REFRESH_INDEX_TOOL } = await import('../../src/mcp/tools.js');
    vi.stubEnv('GITNEXUS_HOME', home);
    backend ??= new LocalBackend();
    const names = [
      ...GITNEXUS_TOOLS.map((tool) => tool.name),
      REFRESH_INDEX_TOOL.name,
      'search',
      'explore',
      'overview',
    ];
    for (const name of names) {
      const outcome = await backend.callTool(name, { repo: NAME, dry_run: true }).catch((e) => e);
      expect(String((outcome as Error)?.message ?? ''), name).not.toMatch(/^Unknown (group )?tool/);
    }
  });
});

describe('detect_changes git failures', () => {
  const softError = (text: string) => JSON.parse(text.split('\n\n---')[0]).error as string;

  it("a git that rejects the caller's base_ref is a client fault", async () => {
    const response = await callTool('detect_changes', {
      repo: NAME,
      scope: 'compare',
      base_ref: 'no-such-ref',
    });
    expect(response).not.toHaveProperty('isError');
    expect(softError(response.text)).toMatch(/^Git diff failed: /);
    expect(response.meta?.[KEY]).toBe('client');
  });

  it('a missing git executable is a server fault', async () => {
    const emptyPath = await fs.mkdtemp(path.join(os.tmpdir(), 'gnx-no-git-'));
    try {
      vi.stubEnv('PATH', emptyPath);
      const response = await callTool('detect_changes', {
        repo: NAME,
        scope: 'compare',
        base_ref: 'HEAD',
      });
      expect(softError(response.text)).toMatch(/^Git diff failed: .*ENOENT/);
      expect(response.meta?.[KEY]).toBe('server');
    } finally {
      await fs.rm(emptyPath, { recursive: true, force: true });
    }
  });

  it('a git failure with no caller ref is a server fault', async () => {
    vi.stubEnv('GIT_DIR', path.join(root, 'no-such-git-dir'));
    const response = await callTool('detect_changes', { repo: NAME, scope: 'unstaged' });
    expect(softError(response.text)).toMatch(/^Git diff failed: /);
    expect(response.meta?.[KEY]).toBe('server');
  });

  it('a resolvable base_ref whose diff fails (a broken repository) is a server fault', async () => {
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    const tree = git('rev-parse', 'HEAD^{tree}');
    const objectPath = path.join(root, '.git', 'objects', tree.slice(0, 2), tree.slice(2));
    const saved = await fs.readFile(objectPath);
    await fs.rm(objectPath, { force: true });
    try {
      const response = await callTool('detect_changes', {
        repo: NAME,
        scope: 'compare',
        base_ref: 'HEAD',
      });
      expect(softError(response.text)).toMatch(/^Git diff failed: /);
      expect(response.meta?.[KEY]).toBe('server');
    } finally {
      await fs.writeFile(objectPath, saved, { mode: 0o444 });
    }
  });

  it('a git that cannot resolve the registered repository for a worktree is a server fault', async () => {
    const emptyPath = await fs.mkdtemp(path.join(os.tmpdir(), 'gnx-no-git-'));
    try {
      vi.stubEnv('PATH', emptyPath);
      const response = await callTool('detect_changes', {
        repo: NAME,
        scope: 'staged',
        worktree: root,
      });
      expect(softError(response.text)).toContain('Is git available?');
      expect(response.meta?.[KEY]).toBe('server');
    } finally {
      await fs.rm(emptyPath, { recursive: true, force: true });
    }
  });
});

describe('PDG index schema', () => {
  it('an index older than the PDG query is a server fault', async () => {
    const { resolvePdgBlockAnchor } = await import('../../src/mcp/local/pdg-impact.js');
    const { createFaultScope } = await import('../../src/core/fault-class.js');
    const scope = createFaultScope();
    const result = await scope.run(() =>
      resolvePdgBlockAnchor(
        '/unused',
        { id: 'Function:a.ts:f', filePath: 'a.ts' },
        vi.fn(async () => {
          throw new Error('Binder exception: Cannot find property ownerId for owner.');
        }) as never,
      ),
    );
    expect(result).toMatchObject({ error: 'The PDG index schema predates executable ownership.' });
    expect(scope.fault()).toBe('server');
  });
});
