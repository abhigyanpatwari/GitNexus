import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { prepareTreeSitterBundle } = require('../../scripts/prepare-tree-sitter-bundle.cjs');
const { TUPLES: tuples } = require('../../scripts/assert-publish-grammar-coverage.cjs');
const roots: string[] = [];
const repairs = [
  ['tree-sitter-cpp', '0.23.4'],
  ['tree-sitter-java', '0.23.5'],
  ['tree-sitter-ruby', '0.23.1'],
  ['tree-sitter-javascript', '0.23.1'],
  ['tree-sitter-typescript', '0.23.2'],
];
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const repairRoot = (root: string) => path.join(root, 'prebuilds/bundled');
const grammarRoot = (root: string, name: string) =>
  path.join(
    root,
    'node_modules',
    name === 'tree-sitter-javascript'
      ? 'tree-sitter-typescript/node_modules/tree-sitter-javascript'
      : name,
  );
const replacement = () => {
  const bytes = Buffer.alloc(96);
  bytes.write('\x7fELF');
  bytes[4] = 2;
  bytes[5] = 1;
  bytes.writeUInt16LE(3, 16);
  bytes.writeUInt16LE(183, 18);
  bytes.write('napi_register_module_v1', 64);
  return bytes;
};

const directVersions: Record<string, string> = {
  '@eagleoutice/tree-sitter-r': '1.1.2',
  'tree-sitter': '0.25.1',
  'tree-sitter-c-sharp': '0.23.5',
  'tree-sitter-cpp': '0.23.4',
  'tree-sitter-go': '0.25.0',
  'tree-sitter-java': '0.23.5',
  'tree-sitter-javascript': '0.25.0',
  'tree-sitter-php': '0.24.2',
  'tree-sitter-python': '0.25.0',
  'tree-sitter-ruby': '0.23.1',
  'tree-sitter-rust': '0.24.0',
  'tree-sitter-typescript': '0.23.2',
};
const peers: Record<string, string> = {
  '@eagleoutice/tree-sitter-r': '^0.21.0',
  'tree-sitter-cpp': '^0.21.1',
  'tree-sitter-java': '^0.21.1',
  'tree-sitter-php': '^0.22.4',
  'tree-sitter-ruby': '^0.21.1',
  'tree-sitter-rust': '^0.22.1',
  'tree-sitter-typescript': '^0.21.0',
};
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const write = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
};

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'gitnexus-parser-bundle-'));
  roots.push(root);
  write(path.join(root, 'package.json'), {
    dependencies: directVersions,
    bundleDependencies: Object.keys(directVersions),
  });
  for (const [name, version] of Object.entries(directVersions)) {
    write(path.join(root, 'node_modules', name, 'package.json'), {
      name,
      version,
      peerDependencies: { 'tree-sitter': peers[name] ?? '^0.25.0' },
    });
  }
  write(path.join(root, 'node_modules/tree-sitter-c/package.json'), {
    name: 'tree-sitter-c',
    version: '0.23.6',
    peerDependencies: { 'tree-sitter': '^0.22.1' },
  });
  write(
    path.join(
      root,
      'node_modules/tree-sitter-typescript/node_modules/tree-sitter-javascript/package.json',
    ),
    {
      name: 'tree-sitter-javascript',
      version: '0.23.1',
      peerDependencies: { 'tree-sitter': '^0.21.1' },
    },
  );
  const overlays = repairs.map(([name, version]) => {
    const file = `${name}@${version}/linux-arm64/${name}.node`;
    const bytes = replacement();
    mkdirSync(path.dirname(path.join(repairRoot(root), file)), { recursive: true });
    writeFileSync(path.join(repairRoot(root), file), bytes);
    for (const tuple of tuples) {
      const dir = path.join(grammarRoot(root, name), 'prebuilds', tuple);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, `${name}.node`), `original ${name} ${tuple}`);
    }
    return { name, version, file, sha256: sha256(bytes) };
  });
  write(path.join(repairRoot(root), 'manifest.json'), {
    schemaVersion: 1,
    tuple: 'linux-arm64',
    packages: overlays,
  });
  return root;
}

function pnpmFixture() {
  const root = fixture();
  const modules = path.join(root, 'node_modules');
  const relocate = (source: string, name: string, version: string) => {
    const target = path.join(modules, '.pnpm', `${name}@${version}`, 'node_modules', name);
    mkdirSync(path.dirname(target), { recursive: true });
    renameSync(source, target);
    return target;
  };
  const c = relocate(path.join(modules, 'tree-sitter-c'), 'tree-sitter-c', '0.23.6');
  const javascript = relocate(
    path.join(modules, 'tree-sitter-typescript/node_modules/tree-sitter-javascript'),
    'tree-sitter-javascript',
    '0.23.1',
  );
  rmSync(path.join(modules, 'tree-sitter-typescript/node_modules'), { recursive: true });
  for (const [name, version] of Object.entries(directVersions)) {
    const target = relocate(path.join(modules, name), name, version);
    symlinkSync(target, path.join(modules, name), 'junction');
    if (name === 'tree-sitter-cpp') {
      symlinkSync(c, path.join(path.dirname(target), 'tree-sitter-c'), 'junction');
    }
    if (name === 'tree-sitter-typescript') {
      symlinkSync(
        javascript,
        path.join(path.dirname(target), 'tree-sitter-javascript'),
        'junction',
      );
    }
  }
  return { root, c, javascript };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('native parser bundle preparation', () => {
  it('pins audited peers without changing unrelated binaries', () => {
    const root = fixture();
    const native = path.join(root, 'node_modules/tree-sitter-cpp/parser.node');
    writeFileSync(native, Buffer.from([0, 1, 128, 255]));
    const original = readFileSync(native);
    expect(prepareTreeSitterBundle(root)).toHaveLength(9);
    expect(
      read(path.join(root, 'node_modules/tree-sitter-cpp/package.json')).peerDependencies[
        'tree-sitter'
      ],
    ).toBe('0.25.1');
    expect(
      read(path.join(root, 'node_modules/@eagleoutice/tree-sitter-r/package.json'))
        .peerDependencies['tree-sitter'],
    ).toBe('0.25.1');
    expect(
      read(
        path.join(
          root,
          'node_modules/tree-sitter-typescript/node_modules/tree-sitter-javascript/package.json',
        ),
      ).peerDependencies['tree-sitter'],
    ).toBe('0.25.1');
    expect(
      read(path.join(root, 'node_modules/tree-sitter-javascript/package.json')).peerDependencies[
        'tree-sitter'
      ],
    ).toBe('^0.25.0');
    expect(prepareTreeSitterBundle(root)).toHaveLength(9);
    expect(readFileSync(native)).toEqual(original);
    expect(read(path.join(root, 'package.json')).dependencies).toEqual(directVersions);
  });

  it('migrates previously widened peer ranges to the exact runtime', () => {
    const root = fixture();
    const file = path.join(root, 'node_modules/tree-sitter-cpp/package.json');
    const pkg = read(file);
    pkg.peerDependencies['tree-sitter'] = '^0.21.1 || 0.25.1';
    write(file, pkg);
    expect(prepareTreeSitterBundle(root)).toHaveLength(9);
    expect(read(file).peerDependencies['tree-sitter']).toBe('0.25.1');
    expect(prepareTreeSitterBundle(root)).toHaveLength(9);
  });

  it('prepares pnpm symlinks, transitive siblings, and aliased cycles exactly once', () => {
    const { root, c, javascript } = pnpmFixture();
    const aliases = path.join(c, 'node_modules');
    mkdirSync(aliases);
    symlinkSync(c, path.join(aliases, 'tree-sitter-c'), 'junction');
    expect(prepareTreeSitterBundle(root)).toHaveLength(9);
    for (const dir of [c, javascript, path.join(root, 'node_modules/tree-sitter-cpp')]) {
      expect(read(path.join(dir, 'package.json')).peerDependencies['tree-sitter']).toBe('0.25.1');
    }
    expect(
      read(path.join(root, 'node_modules/tree-sitter-javascript/package.json')).peerDependencies[
        'tree-sitter'
      ],
    ).toBe('^0.25.0');
    expect(prepareTreeSitterBundle(root)).toHaveLength(9);
  });

  it('rejects drift behind pnpm symlinks before writing any package', () => {
    const { root, c, javascript } = pnpmFixture();
    const first = path.join(c, 'package.json');
    const before = readFileSync(first, 'utf8');
    const last = path.join(javascript, 'package.json');
    const pkg = read(last);
    pkg.peerDependencies['tree-sitter'] = '^0.26.0';
    write(last, pkg);
    expect(() => prepareTreeSitterBundle(root)).toThrow('Unexpected tree-sitter peer metadata');
    expect(readFileSync(first, 'utf8')).toBe(before);
  });

  it('rejects distinct copies of an audited grammar before writing any package', () => {
    const root = fixture();
    const first = path.join(root, 'node_modules/tree-sitter-c/package.json');
    const before = readFileSync(first, 'utf8');
    write(
      path.join(root, 'node_modules/tree-sitter-cpp/node_modules/tree-sitter-c/package.json'),
      read(first),
    );
    expect(() => prepareTreeSitterBundle(root)).toThrow('dependency layout changed');
    expect(readFileSync(first, 'utf8')).toBe(before);
  });

  it('rejects changed peer metadata before writing any package', () => {
    const root = fixture();
    const first = path.join(root, 'node_modules/tree-sitter-c/package.json');
    const before = readFileSync(first, 'utf8');
    const last = path.join(root, 'node_modules/tree-sitter-typescript/package.json');
    const pkg = read(last);
    pkg.peerDependencies['tree-sitter'] = '^0.26.0';
    write(last, pkg);
    expect(() => prepareTreeSitterBundle(root)).toThrow('Unexpected tree-sitter peer metadata');
    expect(readFileSync(first, 'utf8')).toBe(before);
  });

  it('rejects a missing transitive grammar instead of silently shipping stale peers', () => {
    const root = fixture();
    rmSync(path.join(root, 'node_modules/tree-sitter-typescript/node_modules'), {
      recursive: true,
    });
    expect(() => prepareTreeSitterBundle(root)).toThrow('dependency layout changed');
  });

  it('refuses to rely on root overrides when a grammar is not bundled', () => {
    const root = fixture();
    const file = path.join(root, 'package.json');
    const pkg = read(file);
    pkg.bundleDependencies = ['tree-sitter'];
    write(file, pkg);
    expect(() => prepareTreeSitterBundle(root)).toThrow('must be bundled');
  });

  it('applies the bundling rule to the scoped R grammar', () => {
    const root = fixture();
    const file = path.join(root, 'package.json');
    const pkg = read(file);
    pkg.bundleDependencies = pkg.bundleDependencies.filter(
      (name: string) => name !== '@eagleoutice/tree-sitter-r',
    );
    write(file, pkg);
    expect(() => prepareTreeSitterBundle(root)).toThrow(
      '@eagleoutice/tree-sitter-r must be bundled',
    );
  });

  it('rejects a scoped R grammar whose peer metadata changed', () => {
    const root = fixture();
    const file = path.join(root, 'node_modules/@eagleoutice/tree-sitter-r/package.json');
    const pkg = read(file);
    pkg.peerDependencies['tree-sitter'] = '^0.26.0';
    write(file, pkg);
    expect(() => prepareTreeSitterBundle(root)).toThrow('Unexpected tree-sitter peer metadata');
  });

  it('rejects a runtime upgrade until its compatibility has been revalidated', () => {
    const root = fixture();
    const file = path.join(root, 'package.json');
    const pkg = read(file);
    pkg.dependencies['tree-sitter'] = '0.26.0';
    write(file, pkg);
    expect(() => prepareTreeSitterBundle(root)).toThrow('only validated for runtime 0.25.1');
  });

  it('rejects installed versions that differ from the exact package pins', () => {
    const root = fixture();
    const file = path.join(root, 'node_modules/tree-sitter-go/package.json');
    const pkg = read(file);
    pkg.version = '0.26.0';
    write(file, pkg);
    expect(() => prepareTreeSitterBundle(root)).toThrow('installed version differs');
  });
});

describe('audited Linux ARM64 bundle repairs', () => {
  it('repairs all five identities and preserves every other tuple and the direct JavaScript dependency', () => {
    const root = fixture();
    const direct = path.join(
      root,
      'node_modules/tree-sitter-javascript/prebuilds/linux-arm64/tree-sitter-javascript.node',
    );
    mkdirSync(path.dirname(direct), { recursive: true });
    writeFileSync(direct, 'direct JavaScript 0.25.0');
    prepareTreeSitterBundle(root);
    for (const [name] of repairs) {
      for (const tuple of tuples) {
        const bytes = readFileSync(
          path.join(grammarRoot(root, name), 'prebuilds', tuple, `${name}.node`),
        );
        expect(bytes).toEqual(
          tuple === 'linux-arm64' ? replacement() : Buffer.from(`original ${name} ${tuple}`),
        );
      }
    }
    expect(readFileSync(direct, 'utf8')).toBe('direct JavaScript 0.25.0');
    expect(prepareTreeSitterBundle(root)).toHaveLength(9);
  });

  it.each(['missing', 'corrupt', 'architecture', 'version'])(
    'rejects %s repair input before any manifest or binary writes',
    (failure) => {
      const root = fixture();
      const manifestFile = path.join(repairRoot(root), 'manifest.json');
      const manifest = read(manifestFile);
      const last = manifest.packages.at(-1);
      const file = path.join(repairRoot(root), last.file);
      if (failure === 'missing') rmSync(file);
      if (failure === 'corrupt') writeFileSync(file, 'corrupt binary');
      if (failure === 'architecture') {
        const bytes = replacement();
        bytes.writeUInt16LE(62, 18);
        writeFileSync(file, bytes);
        last.sha256 = sha256(bytes);
      }
      if (failure === 'version') last.version = '99.0.0';
      write(manifestFile, manifest);
      const peer = path.join(root, 'node_modules/tree-sitter-c/package.json');
      const before = readFileSync(peer);
      expect(() => prepareTreeSitterBundle(root)).toThrow();
      expect(readFileSync(peer)).toEqual(before);
      for (const [name] of repairs) {
        expect(
          readFileSync(
            path.join(grammarRoot(root, name), 'prebuilds/linux-arm64', `${name}.node`),
            'utf8',
          ),
        ).toBe(`original ${name} linux-arm64`);
      }
    },
  );

  it('repairs nested JavaScript through linked dependency containers', () => {
    const { root, javascript } = pnpmFixture();
    prepareTreeSitterBundle(root);
    expect(
      readFileSync(path.join(javascript, 'prebuilds/linux-arm64/tree-sitter-javascript.node')),
    ).toEqual(replacement());
  });

  it('removes shadowing local builds only for publication, preserving consumer source-build fallbacks', () => {
    const root = fixture();
    const shadows = repairs.flatMap(([name]) =>
      ['Release', 'Debug'].map((mode) => {
        const file = path.join(grammarRoot(root, name), 'build', mode, 'binding.node');
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, 'source-built fallback');
        return file;
      }),
    );
    prepareTreeSitterBundle(root);
    expect(shadows.every(existsSync)).toBe(true);
    prepareTreeSitterBundle(root, { forPublication: true });
    expect(shadows.some(existsSync)).toBe(false);
  });
});
