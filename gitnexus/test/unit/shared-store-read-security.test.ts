import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { resolveGraphPath } from '../../src/storage/shared-store.js';
import { INDEX_METADATA_FILE } from '../../src/storage/storage-constants.js';

const directories: string[] = [];
const first = `lbug.generation.${'a'.repeat(32)}`;
const second = `lbug.generation.${'b'.repeat(32)}`;

function fixture() {
  const slot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gn-graph-read-')));
  directories.push(slot);
  const metadata = path.join(slot, INDEX_METADATA_FILE);
  fs.writeFileSync(metadata, JSON.stringify({ graphPath: first }));
  fs.writeFileSync(path.join(slot, first), 'first graph');
  fs.writeFileSync(path.join(slot, second), 'second graph');
  return { slot, metadata };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('fs');
  vi.resetModules();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

it('keeps warm metadata reads to one stat without opening or parsing the file', () => {
  const { slot, metadata } = fixture();
  expect(resolveGraphPath(slot)).toBe(path.join(slot, first));
  const open = vi.spyOn(fs, 'openSync');
  const read = vi.spyOn(fs, 'readFileSync');
  const parse = vi.spyOn(JSON, 'parse');
  const stat = vi.spyOn(fs, 'lstatSync');
  expect(resolveGraphPath(slot)).toBe(path.join(slot, first));
  expect(open).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  expect(parse).not.toHaveBeenCalled();
  expect(stat.mock.calls.filter(([file]) => file === metadata)).toHaveLength(1);
});

it('reads the opened metadata snapshot and invalidates it after pathname replacement', () => {
  const { slot, metadata } = fixture();
  const replacement = path.join(slot, 'replacement.json');
  fs.writeFileSync(replacement, JSON.stringify({ graphPath: second }));
  // Model a pathname swap while keeping both real files available: Windows
  // refuses rename-over-open, but descriptor reads must remain pinned there too.
  let replaced = false;
  const open = fs.openSync.bind(fs);
  const stat = fs.lstatSync.bind(fs);
  vi.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) =>
    open(replaced && file === metadata ? replacement : file, flags, mode),
  );
  vi.spyOn(fs, 'lstatSync').mockImplementation((file, options) =>
    stat(replaced && file === metadata ? replacement : file, options),
  );
  const read = fs.readFileSync.bind(fs);
  const spy = vi.spyOn(fs, 'readFileSync').mockImplementation((...args) => {
    replaced = true;
    if (args[0] === metadata) args[0] = replacement;
    return read(...args);
  });
  expect(resolveGraphPath(slot)).toBe(path.join(slot, first));
  expect(resolveGraphPath(slot)).toBe(path.join(slot, second));
  expect(spy).toHaveBeenCalledTimes(2);
  expect(spy.mock.calls.every(([file]) => typeof file === 'number')).toBe(true);
});

it('preserves a relative storage path while validating its generation', () => {
  const { slot } = fixture();
  const relative = path.relative(process.cwd(), slot);
  expect(resolveGraphPath(relative, { graphPath: first })).toBe(path.join(relative, first));
});

it.skipIf(process.platform === 'win32').each([false, true])(
  'rejects symlinked metadata with a warm cache of %s',
  (warm) => {
    const { slot, metadata } = fixture();
    const outside = fixture();
    if (warm) expect(resolveGraphPath(slot)).toBe(path.join(slot, first));
    fs.unlinkSync(metadata);
    fs.symlinkSync(outside.metadata, metadata);
    const read = vi.spyOn(fs, 'readFileSync');
    expect(resolveGraphPath(slot)).toBe(path.join(slot, 'lbug'));
    expect(read).not.toHaveBeenCalled();
  },
);

it.skipIf(process.platform === 'win32')(
  'rejects a metadata symlink when O_NOFOLLOW is unavailable and closes the descriptor',
  async () => {
    const { slot, metadata } = fixture();
    const outside = fixture();
    vi.doMock('fs', async (original) => {
      const actual = await original<typeof import('fs')>();
      return {
        ...actual,
        default: { ...fs, constants: { ...fs.constants, O_NOFOLLOW: undefined } },
      };
    });
    const open = fs.openSync.bind(fs);
    vi.spyOn(fs, 'openSync').mockImplementation((file, flags, mode) => {
      if (file === metadata) {
        fs.unlinkSync(metadata);
        fs.symlinkSync(outside.metadata, metadata);
      }
      return open(file, flags, mode);
    });
    const close = vi.spyOn(fs, 'closeSync');
    const read = vi.spyOn(fs, 'readFileSync');
    vi.resetModules();
    const { resolveGraphPath: resolveWithoutNoFollow } =
      await import('../../src/storage/shared-store.js');
    expect(resolveWithoutNoFollow(slot)).toBe(path.join(slot, 'lbug'));
    expect(read).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  },
);

it.each(['../outside', '/outside/lbug', '..\\outside', `../${first}`])(
  'rejects an escaping graph pointer %s without accessing it',
  (graphPath) => {
    const { slot } = fixture();
    const stat = vi.spyOn(fs, 'lstatSync');
    expect(resolveGraphPath(slot, { graphPath })).toBe(path.join(slot, 'lbug'));
    expect(stat).not.toHaveBeenCalled();
  },
);
