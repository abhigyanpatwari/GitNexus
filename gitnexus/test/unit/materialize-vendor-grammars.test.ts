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

  // POSIX-only: Windows file-permission semantics do not enforce write
  // restriction via chmod the way POSIX does, so these fail-soft tests rely on
  // chmod 0o555 (read+execute, no write) to deterministically force cpSync to
  // throw. The behavior they verify is platform-agnostic; only the trigger is.
  const skipOnWin = process.platform === 'win32' ? it.skip : it;

  skipOnWin('fails soft: one grammar copy failure does not abort the others (#1728)', () => {
    const { tmp, cleanup } = makeFixture();
    try {
      // Pre-create the proto destination as a read-only directory so cpSync
      // into its sibling .materialize-tmp path fails when it cannot write into
      // node_modules/. We make node_modules/tree-sitter-proto.materialize-tmp
      // a chmod 0o555 directory — cpSync will recurse into it and EACCES on
      // the first file write.
      fs.mkdirSync(path.join(tmp, 'node_modules'), { recursive: true });
      const protoPartial = path.join(tmp, 'node_modules', 'tree-sitter-proto.materialize-tmp');
      fs.mkdirSync(protoPartial);
      fs.chmodSync(protoPartial, 0o555);

      try {
        runMaterialize(tmp);
      } finally {
        fs.chmodSync(protoPartial, 0o755);
      }

      // dart and swift must still be materialized as real directories
      for (const name of ['tree-sitter-dart', 'tree-sitter-swift']) {
        const dest = path.join(tmp, 'node_modules', name);
        const stat = fs.lstatSync(dest);
        expect(stat.isDirectory()).toBe(true);
        expect(fs.existsSync(path.join(dest, 'package.json'))).toBe(true);
      }
    } finally {
      cleanup();
    }
  });

  skipOnWin('preserves an existing materialized grammar when partial copy fails (#1728)', () => {
    // The torn-state guard: rmSync(dest) must not run before cpSync(src,
    // partial) succeeds. If the partial copy fails, the previously-materialized
    // dest directory must remain intact.
    const { tmp, cleanup } = makeFixture(['tree-sitter-dart']);
    try {
      runMaterialize(tmp);
      const dartDest = path.join(tmp, 'node_modules', 'tree-sitter-dart');
      const sentinel = path.join(dartDest, '.survivor');
      fs.writeFileSync(sentinel, 'preserved');

      // Force the next cpSync to throw by pre-creating partial as a read-only dir.
      const partial = `${dartDest}.materialize-tmp`;
      fs.mkdirSync(partial);
      fs.chmodSync(partial, 0o555);

      try {
        runMaterialize(tmp);
      } finally {
        fs.chmodSync(partial, 0o755);
      }

      // Original dart materialization must survive — sentinel still present.
      expect(fs.existsSync(sentinel)).toBe(true);
    } finally {
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
