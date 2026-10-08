/**
 * R package discovery must not depend on the order in which the filesystem lists
 * directory entries (ext4 hash order, APFS, NTFS and overlayfs all differ).
 *
 * `readdir` is intercepted so a real temporary tree is listed in ascending,
 * descending and seeded-shuffled order; the discovery result has to be the same
 * for every order. A one-order test could pass by accident on a filesystem that
 * happens to list entries sorted.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fsReal from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  hidesUndiscoveredPackage,
  loadRPackageConfig,
  type RPackageConfig,
} from '../../src/core/ingestion/languages/r/package-config.js';

type Order = 'asc' | 'desc' | number;
const box = vi.hoisted(() => ({ order: 'asc' as 'asc' | 'desc' | number }));

/** Reproducible Fisher-Yates (LCG seeded), so a failing order can be replayed. */
function reorder<T extends { name: string }>(entries: readonly T[], order: Order): T[] {
  const out = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  if (order === 'asc') return out;
  if (order === 'desc') return out.reverse();
  let s = order;
  const rand = (): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const base = (actual as unknown as { default: typeof actual }).default ?? actual;
  const readdir = (async (...args: Parameters<typeof actual.readdir>) => {
    const entries = await (base.readdir as (...a: unknown[]) => Promise<unknown>)(...args);
    return Array.isArray(entries) && entries.every((e) => typeof e === 'object' && e !== null)
      ? reorder(entries as { name: string }[], box.order)
      : entries;
  }) as typeof actual.readdir;
  return { ...actual, readdir, default: { ...base, readdir } };
});

const ORDERS: readonly Order[] = ['asc', 'desc', 1, 2, 3, 4, 5];

let tmp: string;
let counter = 0;

async function write(root: string, rel: string, content: string): Promise<void> {
  const full = path.join(root, rel);
  await fsReal.mkdir(path.dirname(full), { recursive: true });
  await fsReal.writeFile(full, content);
}

const desc = (name: string): string => `Package: ${name}\nVersion: 1.0\n`;

async function newRepo(): Promise<string> {
  const root = path.join(tmp, `repo${counter++}`);
  await fsReal.mkdir(root, { recursive: true });
  return root;
}

/** Everything observable about a config, including Map iteration order. */
function snapshot(cfg: RPackageConfig): unknown {
  return {
    packages: [...cfg.packages],
    namespaces: [...cfg.namespaceInfoByPackageDir.keys()],
    truncated: cfg.truncated,
  };
}

async function discover(root: string, order: Order): Promise<RPackageConfig> {
  box.order = order;
  return loadRPackageConfig(root);
}

describe('R package discovery is independent of readdir order', () => {
  beforeAll(async () => {
    tmp = await fsReal.mkdtemp(path.join(os.tmpdir(), 'gn-r-order-'));
  });
  afterAll(async () => {
    box.order = 'asc';
    await fsReal.rm(tmp, { recursive: true, force: true });
  });
  beforeEach(() => {
    box.order = 'asc';
  });

  it('same-depth duplicate package names resolve to the path that sorts first', async () => {
    const root = await newRepo();
    for (const dir of ['mm', 'zz', 'aa']) await write(root, `${dir}/DESCRIPTION`, desc('dup'));
    for (const order of ORDERS) {
      const cfg = await discover(root, order);
      expect(cfg.packages.get('dup'), `order ${String(order)}`).toBe('aa');
      expect(cfg.packages.size).toBe(1);
    }
  });

  it('the shallowest duplicate wins even when a deeper one sorts earlier', async () => {
    const root = await newRepo();
    await write(root, 'aaa/nested/DESCRIPTION', desc('dup'));
    await write(root, 'zzz/DESCRIPTION', desc('dup'));
    for (const order of ORDERS) {
      const cfg = await discover(root, order);
      expect(cfg.packages.get('dup'), `order ${String(order)}`).toBe('zzz');
    }
  });

  it('same-depth duplicates compare as whole paths, not segment by segment', async () => {
    const root = await newRepo();
    // '-' (U+002D) sorts before '/' (U+002F), so as whole strings 'a-b/x' < 'a/x',
    // although the directory 'a' itself sorts before 'a-b'.
    await write(root, 'a/x/DESCRIPTION', desc('dup'));
    await write(root, 'a-b/x/DESCRIPTION', desc('dup'));
    for (const order of ORDERS) {
      const cfg = await discover(root, order);
      expect(cfg.packages.get('dup'), `order ${String(order)}`).toBe('a-b/x');
    }
  });

  it('a root-level package beats a nested package of the same name', async () => {
    const root = await newRepo();
    await write(root, 'DESCRIPTION', desc('dup'));
    await write(root, 'inst/copy/DESCRIPTION', desc('dup'));
    for (const order of ORDERS) {
      expect((await discover(root, order)).packages.get('dup'), `order ${String(order)}`).toBe('');
    }
  });

  it('packages and NAMESPACE entries come back in the same order for every listing order', async () => {
    const root = await newRepo();
    for (const name of ['delta', 'alpha', 'charlie', 'bravo']) {
      await write(root, `pkgs/${name}/DESCRIPTION`, desc(name));
      await write(root, `pkgs/${name}/NAMESPACE`, `export(${name}_fn)\n`);
    }
    const reference = snapshot(await discover(root, 'asc'));
    expect((reference as { packages: [string, string][] }).packages.map(([n]) => n)).toEqual([
      'alpha',
      'bravo',
      'charlie',
      'delta',
    ]);
    for (const order of ORDERS) expect(snapshot(await discover(root, order))).toEqual(reference);
  });

  it('the 200-directory cap keeps the same packages and the same truncated flag', async () => {
    const root = await newRepo();
    // 250 sibling directories (root counts as the first scanned one): whichever 199 the
    // walk reads first decide what is discovered. d010 is read, d240 is not.
    for (let i = 0; i < 250; i++) {
      const dir = `d${String(i).padStart(3, '0')}`;
      await fsReal.mkdir(path.join(root, dir), { recursive: true });
    }
    await write(root, 'd010/DESCRIPTION', desc('early'));
    await write(root, 'd240/DESCRIPTION', desc('late'));
    const reference = await discover(root, 'asc');
    expect([...reference.packages.keys()]).toEqual(['early']);
    expect(reference.truncated).toBe(true);
    for (const order of ORDERS)
      expect(snapshot(await discover(root, order))).toEqual(snapshot(reference));
  });

  it('the hidden-package scan answers the same for every listing order', async () => {
    const root = await newRepo();
    await write(root, 'a/b/c/known/DESCRIPTION', desc('known'));
    await write(root, 'a/b/c/z/deep/DESCRIPTION', desc('unknown'));
    await write(root, 'q/none/file.txt', 'x');
    const clean = await newRepo();
    await write(clean, 'a/b/c/known/DESCRIPTION', desc('known'));
    await write(clean, 'q/none/file.txt', 'x');
    for (const order of ORDERS) {
      box.order = order;
      const known = new Set(['known']);
      expect(await hidesUndiscoveredPackage([root], known), `hidden, ${String(order)}`).toBe(true);
      expect(await hidesUndiscoveredPackage([clean], known), `clean, ${String(order)}`).toBe(false);
      // Budget exhaustion is a count of directories, not of an order.
      expect(await hidesUndiscoveredPackage([clean], known, 2), `budget, ${String(order)}`).toBe(
        true,
      );
    }
  });
});
