import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  cargoTargetRoots,
  loadRustCargoTargets,
  rustFilesShareCargoTarget,
  rustImportNamesCargoRoot,
} from '../../../src/core/ingestion/languages/rust/cargo-targets.js';
import { emitRustScopeCaptures } from '../../../src/core/ingestion/languages/rust/captures.js';
import { interpretRustImport } from '../../../src/core/ingestion/languages/rust/interpret.js';

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
  it.each(['crate', 'self', 'super'])('preserves the %s keyword in a glob import', (keyword) => {
    const imports = emitRustScopeCaptures(`use ${keyword}::*;`, 'fixture.rs')
      .map(interpretRustImport)
      .filter((entry) => entry !== null);
    expect(imports).toEqual([{ kind: 'wildcard', targetRaw: keyword }]);
  });
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

  it('accepts Cargo build=true and declines overlapping build and library roles', () => {
    expect(cargoTargetRoots('Cargo.toml', `${PACKAGE}build=true\n`, files)).toContain('build.rs');
    expect(
      cargoTargetRoots('Cargo.toml', `${PACKAGE}[lib]\npath="build.rs"\n`, files),
    ).toBeUndefined();
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
    expect(roots).toContain(key === 'autolib' ? 'src/main.rs' : 'src/lib.rs');
  });

  it('uses an explicit build-script path instead of the default', () => {
    const roots = cargoTargetRoots('Cargo.toml', `${PACKAGE}build="custom/entry.rs"\n`, files);
    expect(roots).toContain('custom/entry.rs');
    expect(roots).toContain('src/lib.rs');
    expect(roots).not.toContain('build.rs');
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
    `${PACKAGE}build=1\n`,
    `${PACKAGE}[[bin]]\npath="custom/entry.rs"\n`,
    `${PACKAGE}[[test]]\npath="custom/entry.rs"\n`,
  ])('does not manufacture evidence from malformed metadata', (manifest) => {
    expect(cargoTargetRoots('Cargo.toml', manifest, files)).toBeUndefined();
  });
});

describe('Rust module membership', () => {
  it.each([
    '.env',
    '.git/hidden.rs',
    '.GiT/hidden.rs',
    '.gitnexus/hidden.rs',
    'node_modules/pkg/hidden.rs',
  ])('does not restore excluded non-source/control paths: %s', async (hidden) => {
    const dir = fixture({
      'Cargo.toml': PACKAGE,
      'src/lib.rs': `#[path="../${hidden}"] mod hidden;`,
      [hidden]: 'pub fn helper() {}',
    });
    const realpath = vi.spyOn(fs.promises, 'realpath');
    expect(await loadRustCargoTargets(dir)).toBeUndefined();
    expect(realpath.mock.calls.some(([file]) => String(file) === path.join(dir, hidden))).toBe(
      false,
    );
  });

  it('does not interpret a Cargo std alias as the standard library', async () => {
    const dir = fixture({
      'Cargo.toml': `${PACKAGE}[dependencies]\nstd={package="custom",version="1"}\n`,
      'src/lib.rs': 'use std::*; fn f(){ println!(); }',
    });
    expect(await loadRustCargoTargets(dir)).toBeUndefined();
  });
  it('retains path dependencies from conditional target sections', async () => {
    const dir = fixture({
      'Cargo.toml': `${PACKAGE}[target.'cfg(unix)'.dependencies]\nother={path="other"}\n`,
      'src/lib.rs': '',
      'other/Cargo.toml': '[package]\nname="other"\nedition="2021"\n',
      'other/src/lib.rs': '',
    });
    const config = await loadRustCargoTargets(dir);
    expect(config).toBeDefined();
    expect(rustImportNamesCargoRoot(config, 'src/lib.rs', 'other/src/lib.rs', 'other')).toBe(true);
  });
  it.each(['../..', '../../'])(
    'resolves a directory-form workspace pointer: %s',
    async (workspace) => {
      const dir = fixture({
        'Cargo.toml':
          '[workspace]\nmembers=["crates/a", "crates/b"]\n[workspace.package]\nedition="2021"\n[workspace.dependencies]\nb={path="crates/b"}\n',
        'crates/a/Cargo.toml': `[package]\nname="a"\nworkspace="${workspace}"\nedition.workspace=true\n[dependencies]\nb.workspace=true\n`,
        'crates/a/src/lib.rs': '',
        'crates/a/tests/helper.rs': '',
        'crates/b/Cargo.toml': '[package]\nname="b"\nedition="2021"\n',
        'crates/b/src/lib.rs': '',
      });
      const config = await loadRustCargoTargets(dir);
      expect(config).toBeDefined();
      expect(
        rustFilesShareCargoTarget(config, 'crates/a/src/lib.rs', 'crates/a/tests/helper.rs'),
      ).toBe(false);
      expect(
        rustImportNamesCargoRoot(config, 'crates/a/src/lib.rs', 'crates/b/src/lib.rs', 'b'),
      ).toBe(true);
    },
  );

  it('rejects a manifest filename as workspace pointer, as Cargo does', async () => {
    const dir = fixture({
      'Cargo.toml': '[workspace]\nmembers=["crates/a"]\n[workspace.package]\nedition="2021"\n',
      'crates/a/Cargo.toml':
        '[package]\nname="a"\nworkspace="../../Cargo.toml"\nedition.workspace=true\n',
      'crates/a/src/lib.rs': '',
    });
    expect(await loadRustCargoTargets(dir)).toBeUndefined();
  });

  it.each([
    '#[derive(Custom)] struct T;',
    'use custom::Debug; #[derive(Debug)] struct T;',
    'macro_rules! println { () => { #[path="../tests/helper.rs"] mod shared; } } fn f() { println!(); }',
    'use custom::println; fn f() { println!(); }',
    'use custom::*; fn f() { println!(); }',
    'fn f() { println!("{}", { #[path="../tests/helper.rs"] mod shared; 1 }); }',
    'fn f() { println!("{}", include!("generated.rs")); }',
    '#[tokio::test] async fn f() {}',
    '#[some_macro::cfg] fn f() {}',
    '#[some_macro::allow] fn f() {}',
    'fn f() { custom::println!(); }',
    'println!("item position");',
  ])('does not mistake unknown or shadowed expansion for a builtin: %s', async (source) => {
    const dir = fixture({ 'Cargo.toml': PACKAGE, 'src/lib.rs': source, 'tests/helper.rs': '' });
    expect(await loadRustCargoTargets(dir)).toBeUndefined();
  });

  it('does not assume a child-module macro is std when its parent shadows that name', async () => {
    const dir = fixture({
      'Cargo.toml': PACKAGE,
      'src/lib.rs': 'macro_rules! println { () => { mod generated; } } mod child;',
      'src/child.rs': 'fn f() { println!(); }',
      'tests/helper.rs': '',
    });
    expect(await loadRustCargoTargets(dir)).toBeUndefined();
  });
  it('keeps build dependencies separate while retaining unit-test dependencies', async () => {
    const dir = fixture({
      'Cargo.toml': `${PACKAGE}[dependencies]\nnormal={path="normal"}\n[dev-dependencies]\ndev={path="dev"}\n[build-dependencies]\nbuilder={path="builder"}\n`,
      'src/lib.rs': '',
      'build.rs': 'fn main() {}',
      ...Object.fromEntries(
        ['normal', 'dev', 'builder'].flatMap((name) => [
          [`${name}/Cargo.toml`, `[package]\nname="${name}"\nedition="2021"\n`],
          [`${name}/src/lib.rs`, ''],
        ]),
      ),
    });
    const config = await loadRustCargoTargets(dir);
    expect(config).toBeDefined();
    for (const name of ['normal', 'dev', 'builder']) {
      expect(rustImportNamesCargoRoot(config, 'src/lib.rs', `${name}/src/lib.rs`, name)).toBe(
        name !== 'builder',
      );
      expect(rustImportNamesCargoRoot(config, 'build.rs', `${name}/src/lib.rs`, name)).toBe(
        name === 'builder',
      );
    }
    expect(rustImportNamesCargoRoot(config, 'build.rs', 'src/lib.rs', 'demo')).toBe(false);
  });

  it.each([false, true])(
    'uses the correct import name for a custom library (package explicit: %s)',
    async (explicit) => {
      const dir = fixture({
        'Cargo.toml': `${PACKAGE}[lib]\nname="public_api"\n`,
        'src/lib.rs': '',
        'consumer/Cargo.toml': `[package]\nname="consumer"\nedition="2021"\n[dependencies]\ndemo={${explicit ? 'package="demo",' : ''}path=".."}\n`,
        'consumer/src/lib.rs': '',
      });
      const config = await loadRustCargoTargets(dir);
      expect(
        rustImportNamesCargoRoot(
          config,
          'consumer/src/lib.rs',
          'src/lib.rs',
          explicit ? 'demo' : 'public_api',
        ),
      ).toBe(true);
      expect(
        rustImportNamesCargoRoot(
          config,
          'consumer/src/lib.rs',
          'src/lib.rs',
          explicit ? 'public_api' : 'demo',
        ),
      ).toBe(false);
    },
  );

  it('a dependency alias in another package is not import evidence for this caller', async () => {
    const dir = fixture({
      'Cargo.toml': PACKAGE,
      'src/lib.rs': '',
      'a/Cargo.toml':
        '[package]\nname="a"\nedition="2021"\n[dependencies]\napi={package="demo",path=".."}\n',
      'a/src/lib.rs': '',
      'b/Cargo.toml': '[package]\nname="b"\nedition="2021"\n',
      'b/src/lib.rs': '',
    });
    const config = await loadRustCargoTargets(dir);
    expect(rustImportNamesCargoRoot(config, 'a/src/lib.rs', 'src/lib.rs', 'api')).toBe(true);
    expect(rustImportNamesCargoRoot(config, 'b/src/lib.rs', 'src/lib.rs', 'api')).toBe(false);
  });

  it('uses Cargo library metadata rather than the entry file name', async () => {
    const dir = fixture({
      'Cargo.toml': `${PACKAGE}[lib]\npath="src/main.rs"\nname="api"\n`,
      'src/main.rs': '',
      'tests/caller.rs': '',
    });
    expect(
      rustImportNamesCargoRoot(
        await loadRustCargoTargets(dir),
        'tests/caller.rs',
        'src/main.rs',
        'api',
      ),
    ).toBe(true);
    fs.writeFileSync(
      path.join(dir, 'Cargo.toml'),
      `${PACKAGE}autolib=false\n[[bin]]\nname="api"\npath="src/main.rs"\n`,
    );
    expect(
      rustImportNamesCargoRoot(
        await loadRustCargoTargets(dir),
        'tests/caller.rs',
        'src/main.rs',
        'api',
      ),
    ).toBe(false);
  });

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

  it('does not treat derive or expression-position std macros as unknown expansion', async () => {
    const dir = fixture({
      'Cargo.toml': PACKAGE,
      'src/lib.rs':
        '#[derive(Debug)] struct S;\n#[test] #[should_panic] fn t() { println!("hi"); assert_eq!(1, 1); let _ = vec![1]; let _ = format!("{}", 1); }',
      'tests/helper.rs': '',
    });
    expect(
      rustFilesShareCargoTarget(await loadRustCargoTargets(dir), 'src/lib.rs', 'tests/helper.rs'),
    ).toBe(false);
  });

  it('keeps a library module whose path segment is named target', async () => {
    const dir = fixture({
      'Cargo.toml': PACKAGE,
      'src/lib.rs': 'mod target;',
      'src/target/mod.rs': '',
      'tests/helper.rs': '',
    });
    const config = await loadRustCargoTargets(dir);
    expect(rustFilesShareCargoTarget(config, 'src/lib.rs', 'src/target/mod.rs')).toBe(true);
    expect(rustFilesShareCargoTarget(config, 'src/lib.rs', 'tests/helper.rs')).toBe(false);
  });

  it('keeps an explicit [lib] path under target/', async () => {
    const dir = fixture({
      'Cargo.toml': `${PACKAGE}[lib]\npath = "target/entry.rs"\n`,
      'target/entry.rs': '',
      'tests/helper.rs': '',
    });
    expect(
      rustFilesShareCargoTarget(
        await loadRustCargoTargets(dir),
        'target/entry.rs',
        'tests/helper.rs',
      ),
    ).toBe(false);
  });

  it.each([
    'include!("generated.rs");',
    'extern crate self as api;',
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
        fs.writeFileSync(source, 'pub fn replacement() {}');
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
