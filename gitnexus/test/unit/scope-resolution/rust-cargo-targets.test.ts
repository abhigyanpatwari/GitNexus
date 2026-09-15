import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cargoTargetRoots,
  loadRustCargoTargets,
  rustFilesShareCargoTarget,
} from '../../../src/core/ingestion/languages/rust/cargo-targets.js';

const PACKAGE = '[package]\nname = "demo"\nversion = "0.1.0"\nedition = "2021"\n';
const temporary: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of temporary.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function fixture(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-cargo-targets-'));
  temporary.push(dir);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  return dir;
}

describe('Cargo manifest target metadata', () => {
  const files = new Set([
    'src/lib.rs',
    'src/main.rs',
    'src/bin/tool.rs',
    'src/bin/other/main.rs',
    'tests/helper.rs',
    'benches/speed.rs',
    'examples/demo/main.rs',
    'custom/entry.rs',
    'build.rs',
  ]);

  it('discovers lib, main, binary, test, bench, example and build-script roots', () => {
    expect(new Set(cargoTargetRoots('Cargo.toml', PACKAGE, files))).toEqual(
      new Set([...files].filter((file) => file !== 'custom/entry.rs')),
    );
  });

  it.each([
    ['autolib', 'src/lib.rs'],
    ['autobins', 'src/bin/tool.rs'],
    ['autotests', 'tests/helper.rs'],
    ['autobenches', 'benches/speed.rs'],
    ['autoexamples', 'examples/demo/main.rs'],
  ])('honors %s = false', (key, absent) => {
    const roots = cargoTargetRoots('Cargo.toml', `${PACKAGE}${key} = false\n`, files);
    expect(roots).toBeDefined();
    expect(roots).not.toContain(absent);
  });

  it('explicit paths override auto-discovered targets of the same name', () => {
    const roots = cargoTargetRoots(
      'Cargo.toml',
      `${PACKAGE}\n[[test]]\nname = 'helper'\npath = 'custom/entry.rs'\n`,
      files,
    );
    expect(roots).toContain('custom/entry.rs');
    expect(roots).not.toContain('tests/helper.rs');
  });

  it('explicit lib paths work with autolib disabled', () => {
    const roots = cargoTargetRoots(
      'Cargo.toml',
      `${PACKAGE}autolib = false\n[lib]\npath = 'custom/entry.rs'\n`,
      files,
    );
    expect(roots).toContain('custom/entry.rs');
    expect(roots).not.toContain('src/lib.rs');
  });

  it.each([
    ['bin', 'tool', ['src/main.rs', 'src/bin/other/main.rs']],
    ['test', 'helper', ['tests/extra.rs']],
    ['bench', 'speed', ['benches/extra.rs']],
    ['example', 'demo', ['examples/extra.rs']],
  ] as const)(
    'Cargo 2015 explicit %s targets only disable discovery of that kind',
    (kind, name, excluded) => {
      const discovered = new Set([
        ...files,
        'tests/extra.rs',
        'benches/extra.rs',
        'examples/extra.rs',
      ]);
      expect(
        new Set(
          cargoTargetRoots(
            'Cargo.toml',
            `[package]\nname="demo"\nbuild=false\n[[${kind}]]\nname="${name}"\n`,
            discovered,
          ),
        ),
      ).toEqual(
        new Set(
          [...discovered].filter(
            (file) =>
              file !== 'build.rs' &&
              file !== 'custom/entry.rs' &&
              !(excluded as readonly string[]).includes(file),
          ),
        ),
      );
    },
  );

  it('retains workspace/package prefixes', () => {
    expect(
      cargoTargetRoots('crates/a/Cargo.toml', PACKAGE, new Set(['crates/a/src/lib.rs'])),
    ).toEqual(['crates/a/src/lib.rs']);
    expect(cargoTargetRoots('Cargo.toml', '[workspace]\nmembers=["crates/a"]\n', files)).toEqual(
      [],
    );
  });

  it.each([
    '[package',
    `${PACKAGE}\n[[test]]\npath="missing.rs"\n`,
    `${PACKAGE}autotests="false"\n`,
  ])('does not manufacture evidence from malformed metadata', (manifest) => {
    expect(cargoTargetRoots('Cargo.toml', manifest, files)).toBeUndefined();
  });
});

describe('Rust module membership', () => {
  it('distinguishes all package targets even though directory prefixes overlap', async () => {
    const paths = [
      'src/lib.rs',
      'src/main.rs',
      'src/bin/tool.rs',
      'tests/helper.rs',
      'benches/helper.rs',
      'examples/helper.rs',
    ];
    const dir = fixture({
      'Cargo.toml': PACKAGE,
      ...Object.fromEntries(paths.map((file) => [file, 'pub fn helper() {}'])),
    });
    const config = await loadRustCargoTargets(dir);
    for (const target of paths.slice(1))
      expect(rustFilesShareCargoTarget(config, paths[0]!, target)).toBe(false);
  });

  it('follows normal, nested, inline and unit-test modules', async () => {
    const dir = fixture({
      'Cargo.toml': PACKAGE,
      'src/lib.rs': 'mod foo; #[cfg(test)] mod tests { mod helper; }',
      'src/foo.rs': 'mod nested;',
      'src/foo/nested.rs': '',
      'src/tests/helper.rs': '',
    });
    const config = await loadRustCargoTargets(dir);
    for (const file of ['src/foo.rs', 'src/foo/nested.rs', 'src/tests/helper.rs']) {
      expect(rustFilesShareCargoTarget(config, 'src/lib.rs', file)).toBe(true);
    }
  });

  it('does not mistake an auto-target named target for a build artifact directory', async () => {
    const dir = fixture({
      'Cargo.toml': PACKAGE,
      'src/lib.rs': '',
      'tests/helper.rs': '',
      'src/bin/target/main.rs':
        '#[path="../../lib.rs"] mod lib; #[path="../../../tests/helper.rs"] mod helper;',
    });
    expect(
      rustFilesShareCargoTarget(await loadRustCargoTargets(dir), 'src/lib.rs', 'tests/helper.rs'),
    ).toBe(true);
  });

  it('permits a tests/ file shared with the library using #[path]', async () => {
    const dir = fixture({
      'Cargo.toml': PACKAGE,
      'src/lib.rs': '#[path = "../tests/helper.rs"] mod helper;',
      'tests/helper.rs': '',
    });
    expect(
      rustFilesShareCargoTarget(await loadRustCargoTargets(dir), 'src/lib.rs', 'tests/helper.rs'),
    ).toBe(true);
  });

  it('a #[path] file owns its directory when loading its own submodules', async () => {
    const dir = fixture({
      'Cargo.toml': PACKAGE,
      'src/lib.rs': '#[path="../tests/helper.rs"] mod helper;',
      'tests/helper.rs': 'pub mod inner;',
      'tests/inner.rs': 'pub fn found() {}',
      'tests/helper/inner.rs': 'pub fn different() {}',
    });
    const config = await loadRustCargoTargets(dir);
    expect(rustFilesShareCargoTarget(config, 'src/lib.rs', 'tests/inner.rs')).toBe(true);
    expect(
      rustFilesShareCargoTarget(config, 'src/lib.rs', 'tests/helper/inner.rs'),
    ).toBeUndefined();
  });

  it('supports raw-string paths and inline path bases in non-mod.rs files', async () => {
    const dir = fixture({
      'Cargo.toml': PACKAGE,
      'src/lib.rs': 'mod foo;',
      'src/foo.rs': 'mod inner { #[path = r#"helper.rs"#] mod helper; }',
      'src/foo/inner/helper.rs': '',
    });
    expect(
      rustFilesShareCargoTarget(
        await loadRustCargoTargets(dir),
        'src/lib.rs',
        'src/foo/inner/helper.rs',
      ),
    ).toBe(true);
  });

  it('an inline module path override is relative to the source directory', async () => {
    const dir = fixture({
      'Cargo.toml': PACKAGE,
      'src/lib.rs': 'mod foo;',
      'src/foo.rs': '#[path="thread_files"] mod thread { #[path="tls.rs"] mod local_data; }',
      'src/thread_files/tls.rs': '',
    });
    expect(
      rustFilesShareCargoTarget(
        await loadRustCargoTargets(dir),
        'src/lib.rs',
        'src/thread_files/tls.rs',
      ),
    ).toBe(true);
  });

  it.each([
    'include!("generated.rs");',
    '#[cfg_attr(feature="x", path="elsewhere.rs")] mod helper;',
    '#[custom_macro] mod helper;',
    'mod missing;',
    'mod broken {',
  ])('returns unknown for incomplete module evidence: %s', async (source) => {
    const dir = fixture({ 'Cargo.toml': PACKAGE, 'src/lib.rs': source, 'tests/helper.rs': '' });
    expect(
      rustFilesShareCargoTarget(await loadRustCargoTargets(dir), 'src/lib.rs', 'tests/helper.rs'),
    ).toBeUndefined();
  });

  it('ignores module-like text in strings and comments', async () => {
    const dir = fixture({
      'Cargo.toml': PACKAGE,
      'src/lib.rs': '// mod missing;\nconst S: &str = "mod absent;";',
      'tests/helper.rs': '',
    });
    expect(
      rustFilesShareCargoTarget(await loadRustCargoTargets(dir), 'src/lib.rs', 'tests/helper.rs'),
    ).toBe(false);
  });

  it('does not retain membership across changed source snapshots', async () => {
    const dir = fixture({ 'Cargo.toml': PACKAGE, 'src/lib.rs': '', 'tests/helper.rs': '' });
    expect(
      rustFilesShareCargoTarget(await loadRustCargoTargets(dir), 'src/lib.rs', 'tests/helper.rs'),
    ).toBe(false);
    fs.writeFileSync(path.join(dir, 'src/lib.rs'), '#[path="../tests/helper.rs"] mod helper;');
    expect(
      rustFilesShareCargoTarget(await loadRustCargoTargets(dir), 'src/lib.rs', 'tests/helper.rs'),
    ).toBe(true);
  });

  it('honors inherited workspace editions and package-local custom targets', async () => {
    const dir = fixture({
      'Cargo.toml':
        '[workspace]\nmembers=["crates/a", "crates/b"]\n[workspace.package]\nedition="2021"\n',
      'crates/a/Cargo.toml':
        '[package]\nname="a"\nedition.workspace=true\n[lib]\npath="library/entry.rs"\n',
      'crates/a/library/entry.rs': '',
      'crates/a/tests/helper.rs': '',
      'crates/b/Cargo.toml': PACKAGE,
      'crates/b/src/lib.rs': '',
    });
    const config = await loadRustCargoTargets(dir);
    expect(
      rustFilesShareCargoTarget(config, 'crates/a/library/entry.rs', 'crates/a/tests/helper.rs'),
    ).toBe(false);
    expect(
      rustFilesShareCargoTarget(config, 'crates/a/library/entry.rs', 'crates/b/src/lib.rs'),
    ).toBe(false);
  });

  it('a disabled integration target can still be a library module', async () => {
    const dir = fixture({
      'Cargo.toml': `${PACKAGE}autotests=false\n`,
      'src/lib.rs': '#[path="../tests/helper.rs"] mod helper;',
      'tests/helper.rs': '',
    });
    expect(
      rustFilesShareCargoTarget(await loadRustCargoTargets(dir), 'src/lib.rs', 'tests/helper.rs'),
    ).toBe(true);
    fs.writeFileSync(path.join(dir, 'src/lib.rs'), '');
    expect(
      rustFilesShareCargoTarget(await loadRustCargoTargets(dir), 'src/lib.rs', 'tests/helper.rs'),
    ).toBeUndefined();
  });

  it('inspects external modules and expansion uncertainty in function bodies', async () => {
    const dir = fixture({
      'Cargo.toml': PACKAGE,
      'src/lib.rs': 'fn local() { #[path="../tests/helper.rs"] mod helper; }',
      'tests/helper.rs': '',
    });
    expect(
      rustFilesShareCargoTarget(await loadRustCargoTargets(dir), 'src/lib.rs', 'tests/helper.rs'),
    ).toBe(true);
    fs.writeFileSync(path.join(dir, 'src/lib.rs'), 'fn local() { include!("generated.rs"); }');
    expect(
      rustFilesShareCargoTarget(await loadRustCargoTargets(dir), 'src/lib.rs', 'tests/helper.rs'),
    ).toBeUndefined();
  });

  it('uses the safe parser for sources exceeding the native Windows string limit', async () => {
    const dir = fixture({
      'Cargo.toml': PACKAGE,
      'src/lib.rs': `// ${'x'.repeat(40_000)}\nmod helper;`,
      'src/helper.rs': '',
      'tests/helper.rs': '',
    });
    const config = await loadRustCargoTargets(dir);
    expect(rustFilesShareCargoTarget(config, 'src/lib.rs', 'src/helper.rs')).toBe(true);
    expect(rustFilesShareCargoTarget(config, 'src/lib.rs', 'tests/helper.rs')).toBe(false);
  });

  it('does not read through a module symlink outside the repository', async () => {
    const outside = fixture({ 'helper.rs': 'pub fn helper() {}' });
    const dir = fixture({
      'Cargo.toml': PACKAGE,
      'src/lib.rs': 'mod helper;',
      'tests/helper.rs': '',
    });
    fs.symlinkSync(path.join(outside, 'helper.rs'), path.join(dir, 'src/helper.rs'));
    expect(
      rustFilesShareCargoTarget(await loadRustCargoTargets(dir), 'src/lib.rs', 'tests/helper.rs'),
    ).toBeUndefined();
  });

  it('discards membership when a checked source is replaced before the read', async () => {
    const dir = fixture({ 'Cargo.toml': PACKAGE, 'src/lib.rs': '', 'tests/helper.rs': '' });
    const source = path.join(dir, 'src/lib.rs');
    const originalStat = fs.statSync(source);
    let replaced = false;
    const replace = (stat: fs.Stats) => {
      if (!replaced && stat.dev === originalStat.dev && stat.ino === originalStat.ino) {
        replaced = true;
        fs.renameSync(source, `${source}.old`);
        fs.writeFileSync(source, `// ${'x'.repeat(1024 * 1024)}\n`);
      }
    };
    // Exercise the same replacement against the old path-stat/read sequence
    // and the descriptor-based reader. Neither may accept the unchecked file.
    const pathStat = fs.promises.stat.bind(fs.promises);
    vi.spyOn(fs.promises, 'stat').mockImplementation(async (...args) => {
      const stat = await pathStat(...args);
      replace(stat as fs.Stats);
      return stat;
    });
    const descriptorStat = fs.fstatSync.bind(fs);
    vi.spyOn(fs, 'fstatSync').mockImplementation((...args) => {
      const stat = descriptorStat(...args);
      replace(stat as fs.Stats);
      return stat;
    });
    const config = await loadRustCargoTargets(dir);
    expect(replaced).toBe(true);
    expect(rustFilesShareCargoTarget(config, 'src/lib.rs', 'tests/helper.rs')).toBeUndefined();
  });
});
