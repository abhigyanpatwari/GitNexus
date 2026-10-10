import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { prepareTreeSitterBundle } = require('../../scripts/prepare-tree-sitter-bundle.cjs');
const roots: string[] = [];

const directVersions: Record<string, string> = {
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
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('native parser bundle preparation', () => {
  it('admits the tested runtime for direct and transitive peers without changing binaries', () => {
    const root = fixture();
    const native = path.join(root, 'node_modules/tree-sitter-cpp/parser.node');
    writeFileSync(native, Buffer.from([0, 1, 128, 255]));
    const original = readFileSync(native);
    expect(prepareTreeSitterBundle(root)).toHaveLength(8);
    expect(
      read(path.join(root, 'node_modules/tree-sitter-cpp/package.json')).peerDependencies[
        'tree-sitter'
      ],
    ).toBe('^0.21.1 || 0.25.1');
    expect(
      read(
        path.join(
          root,
          'node_modules/tree-sitter-typescript/node_modules/tree-sitter-javascript/package.json',
        ),
      ).peerDependencies['tree-sitter'],
    ).toBe('^0.21.1 || 0.25.1');
    expect(
      read(path.join(root, 'node_modules/tree-sitter-javascript/package.json')).peerDependencies[
        'tree-sitter'
      ],
    ).toBe('^0.25.0');
    expect(prepareTreeSitterBundle(root)).toHaveLength(8);
    expect(readFileSync(native)).toEqual(original);
    expect(read(path.join(root, 'package.json')).dependencies).toEqual(directVersions);
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
