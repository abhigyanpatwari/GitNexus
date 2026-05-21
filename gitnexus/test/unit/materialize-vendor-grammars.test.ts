import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const GITNEXUS_ROOT = path.resolve(import.meta.dirname, '../..');
const SCRIPT = path.join(GITNEXUS_ROOT, 'scripts', 'materialize-vendor-grammars.cjs');
const VENDORED_GRAMMARS = ['tree-sitter-dart', 'tree-sitter-proto', 'tree-sitter-swift'] as const;

function makeFixture(grammars: readonly string[] = VENDORED_GRAMMARS): {
  tmp: string;
  cleanup: () => void;
} {
  const tmp = fs.mkdtempSync(path.join(GITNEXUS_ROOT, '.tmp-materialize-'));
  for (const name of grammars) {
    fs.cpSync(path.join(GITNEXUS_ROOT, 'vendor', name), path.join(tmp, 'vendor', name), {
      recursive: true,
    });
  }
  fs.mkdirSync(path.join(tmp, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, 'package.json'),
    JSON.stringify({ name: 'gitnexus-test-fixture', version: '0.0.0' }),
  );
  fs.copyFileSync(SCRIPT, path.join(tmp, 'scripts', 'materialize-vendor-grammars.cjs'));
  return {
    tmp,
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

function runMaterialize(tmp: string, env: NodeJS.ProcessEnv = {}): void {
  execFileSync(process.execPath, [path.join(tmp, 'scripts', 'materialize-vendor-grammars.cjs')], {
    cwd: tmp,
    stdio: 'pipe',
    env: { ...process.env, ...env },
  });
}

describe('materialize-vendor-grammars.cjs', () => {
  it('copies every vendored grammar into node_modules as a real directory (#1728)', () => {
    const { tmp, cleanup } = makeFixture();
    try {
      runMaterialize(tmp);
      for (const name of VENDORED_GRAMMARS) {
        const dest = path.join(tmp, 'node_modules', name);
        expect(fs.existsSync(dest)).toBe(true);
        const stat = fs.lstatSync(dest);
        expect(stat.isSymbolicLink()).toBe(false);
        expect(stat.isDirectory()).toBe(true);
        expect(fs.existsSync(path.join(dest, 'package.json'))).toBe(true);
      }
    } finally {
      cleanup();
    }
  });

  it('honors GITNEXUS_SKIP_OPTIONAL_GRAMMARS=1 and creates no node_modules entries', () => {
    const { tmp, cleanup } = makeFixture();
    try {
      runMaterialize(tmp, { GITNEXUS_SKIP_OPTIONAL_GRAMMARS: '1' });
      for (const name of VENDORED_GRAMMARS) {
        expect(fs.existsSync(path.join(tmp, 'node_modules', name))).toBe(false);
      }
    } finally {
      cleanup();
    }
  });

  it('does not create node_modules or build outputs under vendor/ (#836)', () => {
    const { tmp, cleanup } = makeFixture();
    try {
      runMaterialize(tmp);
      for (const name of VENDORED_GRAMMARS) {
        expect(fs.existsSync(path.join(tmp, 'vendor', name, 'node_modules'))).toBe(false);
        expect(fs.existsSync(path.join(tmp, 'vendor', name, 'build'))).toBe(false);
      }
    } finally {
      cleanup();
    }
  });

  it('is idempotent across re-runs (clean overwrite of destination)', () => {
    const { tmp, cleanup } = makeFixture();
    try {
      runMaterialize(tmp);
      const sentinel = path.join(tmp, 'node_modules', 'tree-sitter-dart', '.stale-marker');
      fs.writeFileSync(sentinel, 'should be removed on next materialize');
      expect(fs.existsSync(sentinel)).toBe(true);
      runMaterialize(tmp);
      expect(fs.existsSync(sentinel)).toBe(false);
      expect(
        fs.existsSync(path.join(tmp, 'node_modules', 'tree-sitter-dart', 'package.json')),
      ).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('warns and continues when a vendor grammar directory is missing', () => {
    const { tmp, cleanup } = makeFixture(['tree-sitter-dart', 'tree-sitter-proto']);
    try {
      runMaterialize(tmp);
      expect(fs.existsSync(path.join(tmp, 'node_modules', 'tree-sitter-dart'))).toBe(true);
      expect(fs.existsSync(path.join(tmp, 'node_modules', 'tree-sitter-proto'))).toBe(true);
      expect(fs.existsSync(path.join(tmp, 'node_modules', 'tree-sitter-swift'))).toBe(false);
    } finally {
      cleanup();
    }
  });

  // POSIX-only: Windows file-permission semantics do not enforce read
  // restriction via chmod the way POSIX does, so these fail-soft tests rely on
  // chmod 0o000 on the vendor source to deterministically force cpSync to
  // throw. We sabotage the *source* (not a path the script itself touches)
  // because the script wipes any pre-existing partial dir at the top of its
  // loop. The behavior verified is platform-agnostic; only the trigger is.
  const skipOnWin = process.platform === 'win32' ? it.skip : it;

  skipOnWin('fails soft: one grammar copy failure does not abort the others (#1728)', () => {
    const { tmp, cleanup } = makeFixture();
    // Make the proto vendor source unreadable so cpSync(src, partial) throws.
    // The other vendor dirs remain readable and must still materialize.
    const protoSrc = path.join(tmp, 'vendor', 'tree-sitter-proto');
    fs.chmodSync(protoSrc, 0o000);

    try {
      runMaterialize(tmp);

      // dart and swift must still be materialized as real directories
      for (const name of ['tree-sitter-dart', 'tree-sitter-swift']) {
        const dest = path.join(tmp, 'node_modules', name);
        const stat = fs.lstatSync(dest);
        expect(stat.isDirectory()).toBe(true);
        expect(fs.existsSync(path.join(dest, 'package.json'))).toBe(true);
      }
      // proto must NOT have been materialized — sabotage worked
      expect(fs.existsSync(path.join(tmp, 'node_modules', 'tree-sitter-proto'))).toBe(false);
    } finally {
      // Restore permission so cleanup can remove the fixture tree
      try {
        fs.chmodSync(protoSrc, 0o755);
      } catch {
        // If restore fails the cleanup below will surface a clearer error
      }
      cleanup();
    }
  });

  skipOnWin('preserves an existing materialized grammar when partial copy fails (#1728)', () => {
    // The atomicity guard: when cpSync(src, partial) fails (or any subsequent
    // step before rename(partial, dest) completes), the previously-materialized
    // dest directory must remain intact.
    const { tmp, cleanup } = makeFixture(['tree-sitter-dart']);
    const dartSrc = path.join(tmp, 'vendor', 'tree-sitter-dart');
    try {
      // First materialize cleanly so dart has a working dest.
      runMaterialize(tmp);
      const dartDest = path.join(tmp, 'node_modules', 'tree-sitter-dart');
      const sentinel = path.join(dartDest, '.survivor');
      fs.writeFileSync(sentinel, 'preserved');

      // Sabotage the vendor source so the next cpSync throws BEFORE
      // rename(dest, backup) executes. dest must remain untouched.
      fs.chmodSync(dartSrc, 0o000);
      try {
        runMaterialize(tmp);
      } finally {
        fs.chmodSync(dartSrc, 0o755);
      }

      // Original dart materialization must survive — sentinel still present.
      expect(fs.existsSync(sentinel)).toBe(true);
    } finally {
      try {
        fs.chmodSync(dartSrc, 0o755);
      } catch {
        // Best effort — cleanup will surface clearer error if path is gone
      }
      cleanup();
    }
  });

  it('vendored package manifests carry no install script or runtime dependencies (#836)', () => {
    for (const name of VENDORED_GRAMMARS) {
      const manifest = JSON.parse(
        fs.readFileSync(path.join(GITNEXUS_ROOT, 'vendor', name, 'package.json'), 'utf8'),
      ) as { scripts?: Record<string, unknown>; dependencies?: Record<string, unknown> };
      expect(manifest.scripts?.install).toBeUndefined();
      expect(manifest.dependencies).toBeUndefined();
    }
  });
});

describe('gitnexus package manifest hygiene', () => {
  it('does not declare vendored grammars as file: optionalDependencies (#1728)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(GITNEXUS_ROOT, 'package.json'), 'utf8')) as {
      optionalDependencies?: Record<string, string>;
    };
    const optional = pkg.optionalDependencies ?? {};
    for (const name of VENDORED_GRAMMARS) {
      expect(optional[name]).toBeUndefined();
    }
  });

  it('does not link vendored grammars in package-lock.json', () => {
    const lock = JSON.parse(
      fs.readFileSync(path.join(GITNEXUS_ROOT, 'package-lock.json'), 'utf8'),
    ) as { packages?: Record<string, { link?: boolean; resolved?: string }> };
    const packages = lock.packages ?? {};
    for (const name of VENDORED_GRAMMARS) {
      // Strong assertion: removing the `file:` optionalDependency should make
      // the entry disappear entirely from the lockfile. A weaker
      // `expect(entry.link).not.toBe(true)` would silently pass when the entry
      // is absent — vacuously true even if a future regression reintroduced a
      // linked entry.
      expect(packages[`node_modules/${name}`]).toBeUndefined();
    }
  });
});
