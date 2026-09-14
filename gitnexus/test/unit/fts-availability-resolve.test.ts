import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { requireFtsResourceOrSkip, resolveFtsExtension } from '../helpers/fts-availability.js';

const tmpRoots: string[] = [];

const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'gn-fts-gate-'));
  tmpRoots.push(root);
  return root;
};

afterEach(() => {
  delete process.env.GITNEXUS_REQUIRE_FTS;
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('resolveFtsExtension (U12 CI gates)', () => {
  it('reports available from a vendored artifact when ~/.lbdb is empty', () => {
    const vendorRoot = makeRoot();
    const emptyHome = join(makeRoot(), 'extension');
    const tuple = `${process.platform}-${process.arch}`;
    const dir = join(vendorRoot, 'lbug-fts', 'prebuilds', tuple);
    mkdirSync(dir, { recursive: true });
    const artifact = join(dir, 'libfts.lbug_extension');
    writeFileSync(artifact, 'placeholder');

    const resolved = resolveFtsExtension({ vendorRoot, homeExtensionRoot: emptyHome });
    expect(resolved).toBe(artifact);

    process.env.GITNEXUS_REQUIRE_FTS = '1';
    expect(() =>
      requireFtsResourceOrSkip({ skip: () => undefined }, resolved, 'installed FTS extension'),
    ).not.toThrow();
  });

  it('still throws under GITNEXUS_REQUIRE_FTS=1 when nothing resolves', () => {
    const vendorRoot = makeRoot();
    const emptyHome = join(makeRoot(), 'extension');
    const resolved = resolveFtsExtension({ vendorRoot, homeExtensionRoot: emptyHome });
    expect(resolved).toBeNull();

    process.env.GITNEXUS_REQUIRE_FTS = '1';
    expect(() =>
      requireFtsResourceOrSkip({ skip: () => undefined }, resolved, 'installed FTS extension'),
    ).toThrow(/GITNEXUS_REQUIRE_FTS=1/);
  });
});
