/**
 * Unit tests for the Zig import resolver, covering both relative-path
 * imports and bare-name imports resolved through build.zig.zon.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveZigImportInternal } from '../../src/core/ingestion/import-resolvers/zig.js';
import {
  loadZigBuildConfig,
  parseZigBuildModules,
  parseZigRootModules,
  parseZigBuildModuleRoots,
  parseZigBuildZon,
} from '../../src/core/ingestion/language-config.js';

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/lang-resolution',
);

describe('resolveZigImportInternal', () => {
  it('returns null for stdlib / builtin / root', () => {
    const files = new Set<string>(['src/main.zig']);
    expect(resolveZigImportInternal('src/main.zig', 'std', files)).toBeNull();
    expect(resolveZigImportInternal('src/main.zig', 'builtin', files)).toBeNull();
    expect(resolveZigImportInternal('src/main.zig', 'root', files)).toBeNull();
  });

  it('resolves "./foo.zig" relative to the importer', () => {
    const files = new Set<string>(['src/main.zig', 'src/foo.zig']);
    expect(resolveZigImportInternal('src/main.zig', './foo.zig', files)).toBe('src/foo.zig');
  });

  it('resolves "foo.zig" without a "./" prefix as filesystem-relative', () => {
    const files = new Set<string>(['src/main.zig', 'src/foo.zig']);
    expect(resolveZigImportInternal('src/main.zig', 'foo.zig', files)).toBe('src/foo.zig');
  });

  it('resolves "../sibling/file.zig" with parent traversal', () => {
    const files = new Set<string>(['src/a/main.zig', 'src/b/util.zig']);
    expect(resolveZigImportInternal('src/a/main.zig', '../b/util.zig', files)).toBe(
      'src/b/util.zig',
    );
  });

  it('rejects parent traversal above the repository root instead of aliasing a root file', () => {
    // `currentDir.pop()` on an empty stack used to swallow the `..`, so
    // `../bar.zig` from `main.zig` resolved to the unrelated repo-root `bar.zig`.
    const files = new Set<string>(['main.zig', 'bar.zig', 'src/a.zig', 'x.zig']);
    expect(resolveZigImportInternal('main.zig', '../bar.zig', files)).toBeNull();
    expect(resolveZigImportInternal('src/a.zig', '../../x.zig', files)).toBeNull();
    // One level up from src/ is still inside the repo.
    expect(resolveZigImportInternal('src/a.zig', '../bar.zig', files)).toBe('bar.zig');
  });

  it('rejects absolute import paths instead of reading them as importer-relative', () => {
    // The path walker skipped every empty component, so the leading `/` of
    // `/foo.zig` vanished and it resolved to `src/foo.zig` — an in-repo edge
    // for an import Zig itself rejects as outside the module path.
    const files = new Set<string>(['src/main.zig', 'src/foo.zig', 'foo.zig', 'main.zig']);
    expect(resolveZigImportInternal('src/main.zig', '/foo.zig', files)).toBeNull();
    expect(resolveZigImportInternal('main.zig', '/foo.zig', files)).toBeNull();
    expect(resolveZigImportInternal('src/main.zig', '/src/foo.zig', files)).toBeNull();
    // Backslash-spelled absolute paths normalize to the same rejection.
    expect(resolveZigImportInternal('src/main.zig', '\\foo.zig', files)).toBeNull();
    // A drive-qualified spelling carries a `/` after normalization and used to
    // take the importer-relative branch (probing `src/C:/foo.zig`).
    const drive = new Set<string>([...files, 'src/C:/foo.zig']);
    expect(resolveZigImportInternal('src/main.zig', 'C:\\foo.zig', drive)).toBeNull();
    expect(resolveZigImportInternal('src/main.zig', 'C:/foo.zig', drive)).toBeNull();
    // The relative spelling next to it still resolves.
    expect(resolveZigImportInternal('src/main.zig', 'foo.zig', files)).toBe('src/foo.zig');
  });

  it('returns null for a bare name when no build.zig.zon is supplied', () => {
    const files = new Set<string>(['src/main.zig', 'vendor/ziggit/src/ziggit.zig']);
    expect(resolveZigImportInternal('src/main.zig', 'ziggit', files)).toBeNull();
  });

  it('resolves a bare name via a `.path` build.zig.zon dep (`<root>/src/<name>.zig`)', () => {
    const files = new Set<string>(['src/main.zig', 'vendor/ziggit/src/ziggit.zig']);
    const buildZon = { pathDeps: new Map([['ziggit', 'vendor/ziggit']]) };
    expect(resolveZigImportInternal('src/main.zig', 'ziggit', files, buildZon)).toBe(
      'vendor/ziggit/src/ziggit.zig',
    );
  });

  it('resolves a bare name to `<root>/src/root.zig` — the `zig init` library root since 0.12', () => {
    // 0.12+ `zig init` writes src/root.zig for libraries (0.14 writes both
    // root.zig and main.zig). Knowing only src/<name>.zig and src/main.zig
    // left every such dep unresolved.
    const files = new Set<string>(['src/main.zig', 'libs/geo/src/root.zig']);
    const zon = { pathDeps: new Map([['geo', 'libs/geo']]) };
    expect(resolveZigImportInternal('src/main.zig', 'geo', files, zon)).toBe(
      'libs/geo/src/root.zig',
    );
  });

  it('prefers the root the dep’s own build.zig declares over every conventional layout', () => {
    // A dep can call its module root anything (`lib/geo.zig`); when its
    // build.zig says so, that beats src/root.zig even if both exist.
    const files = new Set<string>([
      'src/main.zig',
      'libs/geo/lib/geo.zig',
      'libs/geo/src/root.zig',
      'libs/geo/src/main.zig',
    ]);
    const zon = {
      pathDeps: new Map([['geo', 'libs/geo']]),
      moduleRoots: new Map([['geo', ['libs/geo/lib/geo.zig']]]),
    };
    expect(resolveZigImportInternal('src/main.zig', 'geo', files, zon)).toBe(
      'libs/geo/lib/geo.zig',
    );
  });

  it('falls back to `<root>/src/main.zig` when no `<name>.zig` exists', () => {
    const files = new Set<string>(['src/main.zig', 'vendor/ziggit/src/main.zig']);
    const buildZon = { pathDeps: new Map([['ziggit', 'vendor/ziggit']]) };
    expect(resolveZigImportInternal('src/main.zig', 'ziggit', files, buildZon)).toBe(
      'vendor/ziggit/src/main.zig',
    );
  });

  it('resolves a `.path = "."` dep against the repo root without a leading slash', () => {
    // `normalizeDepPath('.')` is '' — the candidates used to become
    // `/src/<name>.zig`, which can never match a repo-relative file key.
    const files = new Set<string>(['src/main.zig', 'src/mylib.zig', 'examples/demo.zig']);
    for (const dot of ['.', './']) {
      const buildZon = { pathDeps: new Map([['mylib', dot]]) };
      expect(resolveZigImportInternal('examples/demo.zig', 'mylib', files, buildZon)).toBe(
        'src/mylib.zig',
      );
    }
    // …and the `src/main.zig` fallback for a root dep too.
    const buildZon = { pathDeps: new Map([['root_pkg', '.']]) };
    expect(resolveZigImportInternal('examples/demo.zig', 'root_pkg', files, buildZon)).toBe(
      'src/main.zig',
    );
  });

  it('returns null for absolute `.path` deps, POSIX and Windows spellings alike', () => {
    // `normalizeZigDepPath` promises null for anything outside the repo; a
    // `/`-only check let `C:\\local_dep` through as the relative `C:/local_dep`,
    // and an absolute check that ran BEFORE backslash normalization let the
    // UNC `\\\\server\\share\\local_dep` (and root-relative `\\local_dep`)
    // through as relative paths. The `root.zig` entries below are the files
    // those misreadings WOULD resolve — each spelling must reject, not merely
    // miss.
    const files = new Set<string>([
      'src/main.zig',
      'C:/local_dep/src/dep.zig',
      'local_dep/src/dep.zig',
      'local_dep/src/root.zig',
      'server/share/local_dep/src/root.zig',
    ]);
    for (const abs of [
      '/local_dep',
      'C:\\local_dep',
      'c:/local_dep',
      'D:\\x\\local_dep',
      '\\\\server\\share\\local_dep',
      '\\local_dep',
    ]) {
      const zon = { pathDeps: new Map([['dep', abs]]) };
      expect(resolveZigImportInternal('src/main.zig', 'dep', files, zon)).toBeNull();
    }
  });

  it('returns null for `.path` deps that escape the repo root (`..`)', () => {
    const files = new Set<string>(['src/main.zig']);
    const buildZon = { pathDeps: new Map([['ziggit', '../ziggit']]) };
    expect(resolveZigImportInternal('src/main.zig', 'ziggit', files, buildZon)).toBeNull();
  });

  it('returns null when the conventional layout file is missing', () => {
    const files = new Set<string>(['src/main.zig', 'vendor/ziggit/lib/something.zig']);
    const buildZon = { pathDeps: new Map([['ziggit', 'vendor/ziggit']]) };
    expect(resolveZigImportInternal('src/main.zig', 'ziggit', files, buildZon)).toBeNull();
  });

  it('resolves the repo’s OWN module (root build.zig `addModule`) with no build.zig.zon at all', () => {
    // Lightpanda: `const lp = @import("lightpanda");` in 378 of 567 files,
    // declared only by the root build.zig — bare names were resolved through
    // zon path deps alone, so the package's own root module had ZERO IMPORTS
    // edges and every `lp.X` downstream stayed unresolved.
    const files = new Set<string>(['src/main.zig', 'src/lightpanda.zig', 'src/browser/page.zig']);
    const config = {
      pathDeps: new Map<string, string>(),
      rootModules: new Map([['lightpanda', 'src/lightpanda.zig']]),
    };
    expect(resolveZigImportInternal('src/browser/page.zig', 'lightpanda', files, config)).toBe(
      'src/lightpanda.zig',
    );
    // From the root file itself (the circular self-import build.zig allows).
    expect(resolveZigImportInternal('src/lightpanda.zig', 'lightpanda', files, config)).toBe(
      'src/lightpanda.zig',
    );
    // A generated module (`addOptions().createModule()`) is not declared and
    // must not resolve to anything.
    expect(resolveZigImportInternal('src/main.zig', 'build_config', files, config)).toBeNull();
    // A declared root that is not among the indexed files resolves nothing.
    const stale = {
      pathDeps: new Map<string, string>(),
      rootModules: new Map([['gone', 'src/gone.zig']]),
    };
    expect(resolveZigImportInternal('src/main.zig', 'gone', files, stale)).toBeNull();
  });

  it('never resolves std / builtin / root through a same-named root module', () => {
    const files = new Set<string>(['src/main.zig', 'src/std.zig']);
    const config = {
      pathDeps: new Map<string, string>(),
      rootModules: new Map([['std', 'src/std.zig']]),
    };
    expect(resolveZigImportInternal('src/main.zig', 'std', files, config)).toBeNull();
  });

  it('consults root modules BEFORE build.zig.zon path deps', () => {
    // A `.path = "."` self-dep and an `addModule` for the same name must agree
    // on the addModule root — the build.zig declaration is the source of truth
    // for what the name means, the zon layout heuristics are a fallback.
    const files = new Set<string>(['src/main.zig', 'src/root.zig', 'lib/pkg.zig']);
    const config = {
      pathDeps: new Map([['pkg', '.']]),
      rootModules: new Map([['pkg', 'lib/pkg.zig']]),
    };
    expect(resolveZigImportInternal('src/main.zig', 'pkg', files, config)).toBe('lib/pkg.zig');
    // Without the root module, the zon fallback still applies.
    expect(
      resolveZigImportInternal('src/main.zig', 'pkg', files, { pathDeps: config.pathDeps }),
    ).toBe('src/root.zig');
  });

  it('resolves a bare name through the importer’s OWN build module table, not the first-declared alias', () => {
    // Two executables each `addImport("config", …)` their own config.zig. The
    // flat `rootModules` map keeps the first, so every tool/ file imported
    // app's config. The per-module table is consulted first, by membership.
    const files = new Set<string>([
      'src/app/main.zig',
      'src/app/config.zig',
      'src/app/util.zig',
      'src/tool/main.zig',
      'src/tool/config.zig',
    ]);
    const config = {
      pathDeps: new Map<string, string>(),
      rootModules: new Map([['config', 'src/app/config.zig']]),
      buildModules: [
        { root: 'src/app/main.zig', imports: new Map([['config', 'src/app/config.zig']]) },
        { root: 'src/tool/main.zig', imports: new Map([['config', 'src/tool/config.zig']]) },
      ],
    };
    expect(resolveZigImportInternal('src/tool/main.zig', 'config', files, config)).toBe(
      'src/tool/config.zig',
    );
    expect(resolveZigImportInternal('src/app/main.zig', 'config', files, config)).toBe(
      'src/app/config.zig',
    );
    // A non-root file is attributed to the module whose root shares its
    // directory (deepest prefix).
    expect(resolveZigImportInternal('src/app/util.zig', 'config', files, config)).toBe(
      'src/app/config.zig',
    );
    // A file outside every module directory falls back to the flat map.
    expect(resolveZigImportInternal('examples/demo.zig', 'config', files, config)).toBe(
      'src/app/config.zig',
    );
  });

  it('fails closed when same-directory modules disagree on an alias, instead of taking the first', () => {
    // `src/main.zig` (exe) and `src/root.zig` (lib) share a directory — the
    // `zig init` layout. A third file there cannot be attributed; resolving
    // through either would be a confident wrong edge, and the flat fallback
    // would only restore the first-wins answer, so the chain stops at null.
    const files = new Set<string>([
      'src/main.zig',
      'src/root.zig',
      'src/util.zig',
      'src/cfg_exe.zig',
      'src/cfg_lib.zig',
    ]);
    const config = {
      pathDeps: new Map<string, string>(),
      rootModules: new Map([['cfg', 'src/cfg_exe.zig']]),
      buildModules: [
        { root: 'src/main.zig', imports: new Map([['cfg', 'src/cfg_exe.zig']]) },
        { root: 'src/root.zig', imports: new Map([['cfg', 'src/cfg_lib.zig']]) },
      ],
    };
    expect(resolveZigImportInternal('src/util.zig', 'cfg', files, config)).toBeNull();
    // The roots themselves are unambiguous: each is its own module.
    expect(resolveZigImportInternal('src/main.zig', 'cfg', files, config)).toBe('src/cfg_exe.zig');
    expect(resolveZigImportInternal('src/root.zig', 'cfg', files, config)).toBe('src/cfg_lib.zig');
    // Agreement is not a conflict: two modules binding one alias to one root
    // resolve it for their shared directory.
    const agreeing = {
      ...config,
      buildModules: [
        { root: 'src/main.zig', imports: new Map([['cfg', 'src/cfg_lib.zig']]) },
        { root: 'src/root.zig', imports: new Map([['cfg', 'src/cfg_lib.zig']]) },
      ],
    };
    expect(resolveZigImportInternal('src/util.zig', 'cfg', files, agreeing)).toBe(
      'src/cfg_lib.zig',
    );
  });

  it('falls through to the flat root-module map when the containing module does not bind the name', () => {
    // A module table answers only for the aliases it declares; the package's
    // own `addModule` name stays importable from everywhere, as before.
    const files = new Set<string>(['src/main.zig', 'src/lib.zig', 'src/cfg.zig']);
    const config = {
      pathDeps: new Map<string, string>(),
      rootModules: new Map([['mylib', 'src/lib.zig']]),
      buildModules: [{ root: 'src/main.zig', imports: new Map([['cfg', 'src/cfg.zig']]) }],
    };
    expect(resolveZigImportInternal('src/main.zig', 'mylib', files, config)).toBe('src/lib.zig');
    // A table entry whose root is not indexed is not an answer either — and
    // it does not fall through: the module's table is the authority for the
    // alias, so a same-named repo-wide `addModule("cfg")` pointing elsewhere
    // must not answer in its place (gitnexus-check on 5299c552).
    const stale = {
      ...config,
      rootModules: new Map([
        ['mylib', 'src/lib.zig'],
        ['cfg', 'src/cfg.zig'],
      ]),
      buildModules: [{ root: 'src/main.zig', imports: new Map([['cfg', 'src/gone.zig']]) }],
    };
    expect(resolveZigImportInternal('src/main.zig', 'cfg', files, stale)).toBeNull();
    // …while a file OUTSIDE that module (`src/lib.zig` shares the root's
    // directory and so belongs to it; `other/x.zig` does not) still reaches
    // the repo-wide name.
    const outside = new Set<string>([...files, 'other/x.zig']);
    expect(resolveZigImportInternal('other/x.zig', 'cfg', outside, stale)).toBe('src/cfg.zig');
  });

  it('returns null for an unknown bare name not in build.zig.zon', () => {
    const files = new Set<string>(['src/main.zig']);
    const buildZon = { pathDeps: new Map([['ziggit', 'vendor/ziggit']]) };
    expect(resolveZigImportInternal('src/main.zig', 'mystery_pkg', files, buildZon)).toBeNull();
  });
});

describe('parseZigBuildZon', () => {
  it('extracts `.path = "..."` deps and skips `.url`-based deps', () => {
    const raw = `
.{
    .name = "myproject",
    .version = "0.1.0",
    .dependencies = .{
        .ziggit_pkg = .{
            .url = "https://github.com/.../archive/abc.tar.gz",
            .hash = "1220abc",
        },
        .local_dep = .{
            .path = "../local_dep",
        },
        .vendor_dep = .{
            .path = "vendor/foo",
        },
    },
    .paths = .{ "" },
}
`;
    const cfg = parseZigBuildZon(raw);
    expect(cfg).not.toBeNull();
    expect(cfg!.pathDeps.get('local_dep')).toBe('../local_dep');
    expect(cfg!.pathDeps.get('vendor_dep')).toBe('vendor/foo');
    // .url-based deps are intentionally absent
    expect(cfg!.pathDeps.has('ziggit_pkg')).toBe(false);
  });

  it('ignores commented-out entries and `.path` lines', () => {
    // A `// .path = "vendor/foo"` inside an entry used to be captured as a real
    // dep because the regex ran over raw source. `//` inside a `.url` string
    // must survive the strip — it is not a comment.
    const raw = `
.{
    .dependencies = .{
        // .disabled = .{ .path = "vendor/disabled" },
        .remote = .{
            .url = "https://github.com/x/y/archive/abc.tar.gz",
            // .path = "vendor/remote-override",
            .hash = "1220abc",
        },
        .live = .{ .path = "vendor/live" }, // trailing note: .path = "nope"
    },
}
`;
    const cfg = parseZigBuildZon(raw);
    expect(cfg).not.toBeNull();
    expect([...cfg!.pathDeps.entries()]).toEqual([['live', 'vendor/live']]);
  });

  it('is not derailed by braces inside comments or string literals', () => {
    // Every `{`/`}` used to count toward the block depth, so a `// }` comment or
    // a `}` inside a string closed the `.dependencies` block early and dropped
    // every dep after it.
    const raw = `
.{
    .dependencies = .{
        .first = .{
            .url = "https://example.com/weird}name{.tar.gz",
            .hash = "1220x", // } stray brace in a comment
        },
        // } another one
        .second = .{ .path = "vendor/second" },
        .third = .{ .path = "vendor/third" },
    },
    .paths = .{ "" },
}
`;
    const cfg = parseZigBuildZon(raw);
    expect(cfg).not.toBeNull();
    expect([...cfg!.pathDeps.entries()]).toEqual([
      ['second', 'vendor/second'],
      ['third', 'vendor/third'],
    ]);
  });

  it('does not take a `.dependencies = .{` spelled inside a string literal as the block header', () => {
    // The header search was a raw regex over the whole text: a `.name` (or
    // `.description`) value that spells `.dependencies = .{ … }` matched
    // first, the parser started at that embedded brace, and returned the
    // fake `.path` dep instead of the real top-level block.
    const raw = `
.{
    .name = ".dependencies = .{ .fake = .{ .path = \\"vendor/fake\\" } }",
    .version = "0.0.0",
    .dependencies = .{
        .real = .{ .path = "vendor/real" },
    },
    .paths = .{ "" },
}
`;
    const cfg = parseZigBuildZon(raw);
    expect(cfg).not.toBeNull();
    expect([...cfg!.pathDeps.entries()]).toEqual([['real', 'vendor/real']]);
  });

  it('takes the top-level `.dependencies` block, not a same-named field nested in an earlier struct', () => {
    // Only a direct field of the file's `.{ … }` (brace depth 1) is the
    // manifest's dependency map; a nested `.dependencies = .{` seen first
    // used to be selected and the real map ignored.
    const zon = `
.{
    .name = .pkg,
    .metadata = .{
        .dependencies = .{
            .decoy = .{ .path = "decoy" },
        },
    },
    .dependencies = .{
        .real = .{ .path = "libs/real" },
    },
}
`;
    const cfg = parseZigBuildZon(zon);
    expect(cfg?.pathDeps.get('real')).toBe('libs/real');
    expect(cfg?.pathDeps.has('decoy')).toBe(false);
  });

  it('returns null when no `.dependencies` block is present', () => {
    const raw = `.{ .name = "x", .version = "0.0.0", .paths = .{""} }`;
    expect(parseZigBuildZon(raw)).toBeNull();
  });

  it('ignores a `.path` nested inside an entry — only a direct field makes a path dep', () => {
    // A URL dep whose body carries a nested object with its own `.path` must
    // not be reported as a path dep: the resolver would otherwise add an
    // import edge to an unrelated `<root>/<nested path>` for `@import("only_url")`.
    const raw = `
.{
    .dependencies = .{
        .only_url = .{
            .url = "https://x",
            .hash = "1220y",
            .meta = .{ .path = "vendor/unrelated" },
        },
        .real = .{ .path = "vendor/real", .extra = .{ .path = "vendor/nested" } },
    },
}
`;
    const cfg = parseZigBuildZon(raw);
    expect(cfg).not.toBeNull();
    expect([...cfg!.pathDeps.entries()]).toEqual([['real', 'vendor/real']]);
  });

  it('returns null when the deps block has no `.path` entries', () => {
    const raw = `
.{
    .dependencies = .{
        .only_url = .{ .url = "https://x", .hash = "1220y" },
    },
}
`;
    expect(parseZigBuildZon(raw)).toBeNull();
  });
});

describe('parseZigBuildModuleRoots', () => {
  it('reads `addModule("<name>", .{ .root_source_file = b.path("…") })`, preferring the named module', () => {
    const buildZig = `
const std = @import("std");
pub fn build(b: *std.Build) void {
    const lib = b.addStaticLibrary(.{ .name = "geo", .root_source_file = b.path("src/lib_entry.zig") });
    _ = b.addModule("helpers", .{ .root_source_file = b.path("src/helpers.zig") });
    _ = b.addModule("geo", .{
        .root_source_file = b.path("src/root.zig"),
        .target = b.standardTargetOptions(.{}),
    });
    b.installArtifact(lib);
}
`;
    // The module named like the dep comes first; the others stay as ordered
    // fallbacks (an importer's `@import("geo")` maps to the "geo" module).
    expect(parseZigBuildModuleRoots(buildZig, 'geo')).toEqual([
      'src/root.zig',
      'src/lib_entry.zig',
      'src/helpers.zig',
    ]);
  });

  it('skips roots that are not a static `b.path("….zig")` and normalizes `./`', () => {
    const buildZig = `
_ = b.addModule("x", .{ .root_source_file = .{ .cwd_relative = "/abs/x.zig" } });
_ = b.addModule("y", .{ .root_source_file = b.path("./src/y.zig") });
_ = b.addModule("z", .{ .root_source_file = generated.getPath() });
_ = b.addModule("w", .{ .root_source_file = b.path("../outside.zig") });
`;
    expect(parseZigBuildModuleRoots(buildZig, 'y')).toEqual(['src/y.zig']);
  });

  it('still names the module when a nested field precedes `.root_source_file`', () => {
    // `.imports = &.{ .{ … } }` closes an inner `}` before the root field; a
    // `[^}]*` regex ended there and demoted "dep" to an unnamed fallback,
    // so `@import("dep")` resolved to whichever root came first in the file.
    const buildZig = `
pub fn build(b: *std.Build) void {
    const exe = b.addExecutable(.{ .name = "tool", .root_source_file = b.path("src/main.zig") });
    _ = b.addModule("dep", .{
        .imports = &.{ .{ .name = "util", .module = util } },
        .root_source_file = b.path("lib/root.zig"),
    });
    // _ = b.addModule("dep", .{ .root_source_file = b.path("lib/commented_out.zig") });
    b.installArtifact(exe);
}
`;
    expect(parseZigBuildModuleRoots(buildZig, 'dep')).toEqual(['lib/root.zig', 'src/main.zig']);
  });

  it('returns [] for a build.zig that declares no module root', () => {
    expect(parseZigBuildModuleRoots('pub fn build(b: *std.Build) void { _ = b; }', 'x')).toEqual(
      [],
    );
  });
});

describe('parseZigRootModules', () => {
  it('maps the root build.zig’s named modules to their root files (Lightpanda-shaped build.zig)', () => {
    // Excerpt of Lightpanda's build.zig: `addModule` names the package's own
    // module, `addImport` re-aliases it (circular self-import), the options
    // module is generated (`addOptions().createModule()`) and `v8` comes from
    // a `.url` dep (`dep.module("v8")`) — neither of those is an in-repo file.
    const buildZig = `
const std = @import("std");
const Build = std.Build;

pub fn build(b: *Build) !void {
    var opts = b.addOptions();
    opts.addOption([]const u8, "version", version_string);

    const lightpanda_module = b.addModule("lightpanda", .{
        .root_source_file = b.path("src/lightpanda.zig"),
        .target = target,
        .optimize = optimize,
        .link_libc = true,
    });
    lightpanda_module.addImport("lightpanda", lightpanda_module); // allow circular "lightpanda" import
    lightpanda_module.addImport("build_config", opts.createModule());

    // A createModule binding named only through addImport.
    const testing_mod = b.createModule(.{
        .root_source_file = b.path("./src/testing.zig"),
        .imports = &.{
            .{ .name = "lightpanda", .module = lightpanda_module },
        },
    });
    lightpanda_module.addImport("testing", testing_mod);
    // \`.imports\` naming form, bare identifier.
    _ = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .imports = &.{ .{ .name = "lp_alias", .module = lightpanda_module } },
    });
    // Struct-field operand — not statically recoverable, skipped.
    _ = b.createModule(.{
        .root_source_file = b.path("src/other.zig"),
        .imports = &.{ .{ .name = "lightpanda_cfg", .module = config.lightpanda_module } },
    });
    // The addModule("v8", …) below lives in a string and a comment: neither counts.
    const note = "b.addModule(\\"decoy\\", .{ .root_source_file = b.path(\\"src/decoy.zig\\") })";
    // _ = b.addModule("commented", .{ .root_source_file = b.path("src/commented.zig") });
    _ = note;
}

fn linkV8(b: *Build, mod: *Build.Module) void {
    const dep = b.dependency("v8", .{});
    mod.addImport("v8", dep.module("v8"));
    const translate_c = b.addTranslateC(.{ .root_source_file = b.path("include/curl.h") });
    mod.addImport("curl", translate_c.createModule());
    mod.addImport("computed", b.createModule(.{ .root_source_file = generated.getPath() }));
}
`;
    expect(parseZigRootModules(buildZig)).toEqual(
      new Map([
        ['lightpanda', 'src/lightpanda.zig'],
        ['testing', 'src/testing.zig'],
        ['lp_alias', 'src/lightpanda.zig'],
      ]),
    );
  });

  it('keeps the first declaration of a name and ignores non-.zig / escaping roots', () => {
    const buildZig = `
_ = b.addModule("x", .{ .root_source_file = b.path("src/x.zig") });
_ = b.addModule("x", .{ .root_source_file = b.path("src/other.zig") });
_ = b.addModule("h", .{ .root_source_file = b.path("include/h.h") });
_ = b.addModule("out", .{ .root_source_file = b.path("../outside.zig") });
_ = b.addModule("abs", .{ .root_source_file = .{ .cwd_relative = "/abs/x.zig" } });
`;
    expect(parseZigRootModules(buildZig)).toEqual(new Map([['x', 'src/x.zig']]));
  });

  it('returns an empty map for a build.zig that names no module', () => {
    expect(parseZigRootModules('pub fn build(b: *std.Build) void { _ = b; }').size).toBe(0);
  });
});

describe('parseZigBuildModules', () => {
  it('keeps each module’s addImport aliases in ITS OWN table (two modules, one alias, two roots)', () => {
    // The review trigger: `app` and `tool` each bind "config". One flat map
    // kept app's; the per-module tables keep both, each on its module.
    const buildZig = `
pub fn build(b: *std.Build) void {
    const app_config = b.createModule(.{ .root_source_file = b.path("src/app/config.zig") });
    const tool_config = b.createModule(.{ .root_source_file = b.path("src/tool/config.zig") });
    const app = b.addExecutable(.{ .name = "app", .root_source_file = b.path("src/app/main.zig") });
    app.root_module.addImport("config", app_config);
    const tool_mod = b.createModule(.{
        .root_source_file = b.path("src/tool/main.zig"),
        .imports = &.{ .{ .name = "config", .module = tool_config } },
    });
    const tool = b.addExecutable(.{ .name = "tool", .root_module = tool_mod });
    tool.root_module.addImport("extra", app_config);
}
`;
    expect(parseZigBuildModules(buildZig)).toEqual([
      { root: 'src/app/config.zig', imports: new Map() },
      { root: 'src/tool/config.zig', imports: new Map() },
      { root: 'src/app/main.zig', imports: new Map([['config', 'src/app/config.zig']]) },
      {
        root: 'src/tool/main.zig',
        imports: new Map([
          ['config', 'src/tool/config.zig'],
          // `tool.root_module` IS `tool_mod`: the artifact alias lands on it.
          ['extra', 'src/app/config.zig'],
        ]),
      },
    ]);
  });

  it('names addModule modules, binds an inline `.root_module = b.createModule(…)` to its artifact, and keeps the first alias', () => {
    const buildZig = `
pub fn build(b: *std.Build) void {
    const lib = b.addModule("mylib", .{ .root_source_file = b.path("./src/lib.zig") });
    lib.addImport("mylib", lib);
    const exe = b.addExecutable(.{
        .name = "app",
        .root_module = b.createModule(.{ .root_source_file = b.path("src/main.zig") }),
    });
    exe.root_module.addImport("mylib", lib);
    exe.root_module.addImport("mylib", exe.root_module); // second binding of a name: ignored
    exe.root_module.addImport("gen", opts.createModule()); // generated: no file
    unbound.addImport("x", lib); // receiver bound to nothing: ignored
}
`;
    expect(parseZigBuildModules(buildZig)).toEqual([
      { name: 'mylib', root: 'src/lib.zig', imports: new Map([['mylib', 'src/lib.zig']]) },
      { root: 'src/main.zig', imports: new Map([['mylib', 'src/lib.zig']]) },
    ]);
  });

  it('resolves `addImport("api", dep.module("core"))` through the dep’s declared modules, and nothing without them', () => {
    const buildZig = `
pub fn build(b: *std.Build) void {
    const corelib = b.dependency("corelib", .{ .target = target });
    const exe = b.addExecutable(.{ .name = "app", .root_source_file = b.path("src/main.zig") });
    exe.root_module.addImport("api", corelib.module("core"));
    exe.root_module.addImport("other", corelib.module("missing"));
    exe.root_module.addImport("v8", v8.module("v8")); // not a b.dependency binding
}
`;
    const depModules = new Map([['corelib', new Map([['core', 'libs/corelib/src/core.zig']])]]);
    expect(parseZigBuildModules(buildZig, depModules)).toEqual([
      { root: 'src/main.zig', imports: new Map([['api', 'libs/corelib/src/core.zig']]) },
    ]);
    // The zon dep (or its build.zig) unknown: the alias is left unresolved
    // rather than guessed.
    expect(parseZigBuildModules(buildZig)).toEqual([{ root: 'src/main.zig', imports: new Map() }]);
  });

  it('ignores calls, aliases and roots spelled in comments or strings', () => {
    const buildZig = `
pub fn build(b: *std.Build) void {
    const m = b.createModule(.{ .root_source_file = b.path("src/m.zig") });
    // const decoy = b.createModule(.{ .root_source_file = b.path("src/decoy.zig") });
    // m.addImport("commented", m);
    const s = "m.addImport(\\"quoted\\", m)";
    _ = s;
}
`;
    expect(parseZigBuildModules(buildZig)).toEqual([{ root: 'src/m.zig', imports: new Map() }]);
    expect(parseZigBuildModules('pub fn build(b: *std.Build) void { _ = b; }')).toEqual([]);
  });
});

describe('loadZigBuildConfig (zig-buildmodules fixture)', () => {
  it('carries per-module tables, with dep.module(…) aliases resolved through the dep’s build.zig', async () => {
    const config = await loadZigBuildConfig(path.join(FIXTURES, 'zig-buildmodules'));
    expect(config).not.toBeNull();
    const byRoot = new Map(config!.buildModules!.map((m) => [m.root, m.imports]));
    expect(byRoot.get('src/app/main.zig')).toEqual(
      new Map([
        ['config', 'src/app/config.zig'],
        ['api', 'libs/corelib/src/core.zig'],
      ]),
    );
    expect(byRoot.get('src/tool/main.zig')).toEqual(new Map([['config', 'src/tool/config.zig']]));
    expect(byRoot.get('src/shared/a.zig')).toEqual(new Map([['clash', 'src/shared/clash_a.zig']]));
    expect(byRoot.get('src/shared/b.zig')).toEqual(new Map([['clash', 'src/shared/clash_b.zig']]));
    // The flat map is still there as the repo-wide fallback — and shows the
    // first-wins collapse the per-module tables exist to avoid.
    expect(config!.rootModules?.get('config')).toBe('src/app/config.zig');
  });
});

describe('loadZigBuildConfig (zig-rootmodule fixture: build.zig, no build.zig.zon)', () => {
  it('still yields a config carrying the root build.zig’s modules', async () => {
    // Before: no build.zig.zon → null → every bare-name import in the repo
    // unresolved, including the repo's own module.
    const config = await loadZigBuildConfig(path.join(FIXTURES, 'zig-rootmodule'));
    expect(config).not.toBeNull();
    expect(config!.pathDeps.size).toBe(0);
    expect(config!.rootModules).toEqual(new Map([['core', 'src/core.zig']]));
  });
});

describe('loadZigBuildConfig (zig-idioms fixture)', () => {
  it('reads the root build.zig’s own named modules alongside the zon path deps', async () => {
    const config = await loadZigBuildConfig(path.join(FIXTURES, 'zig-idioms'));
    // addModule("idioms", …src/idioms.zig) + the self-addImport; the
    // build_config (addOptions) module and geo (dependency module) are not
    // in-repo files.
    expect(config!.rootModules).toEqual(new Map([['idioms', 'src/idioms.zig']]));
  });

  it('reads each path dep’s build.zig for its module roots and leaves deps without one to the layout fallback', async () => {
    const config = await loadZigBuildConfig(path.join(FIXTURES, 'zig-idioms'));
    expect(config).not.toBeNull();
    expect([...config!.pathDeps.keys()].sort()).toEqual(['geo', 'oldlib']);
    // geo/build.zig: addModule("geo", .{ .root_source_file = b.path("src/root.zig") })
    expect(config!.moduleRoots?.get('geo')).toEqual(['libs/geo/src/root.zig']);
    // oldlib has no build.zig → no entry; the resolver falls back to
    // src/root.zig → src/oldlib.zig → src/main.zig.
    expect(config!.moduleRoots?.has('oldlib')).toBe(false);
  });
});
