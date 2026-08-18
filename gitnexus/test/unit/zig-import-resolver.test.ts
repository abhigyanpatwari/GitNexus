/**
 * Unit tests for the Zig import resolver, covering both relative-path
 * imports and bare-name imports resolved through build.zig.zon.
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveZigImportInternal } from '../../src/core/ingestion/import-resolvers/zig.js';
import {
  loadZigBuildZon,
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

  it('returns [] for a build.zig that declares no module root', () => {
    expect(parseZigBuildModuleRoots('pub fn build(b: *std.Build) void { _ = b; }', 'x')).toEqual(
      [],
    );
  });
});

describe('loadZigBuildZon (zig-idioms fixture)', () => {
  it('reads each path dep’s build.zig for its module roots and leaves deps without one to the layout fallback', async () => {
    const config = await loadZigBuildZon(path.join(FIXTURES, 'zig-idioms'));
    expect(config).not.toBeNull();
    expect([...config!.pathDeps.keys()].sort()).toEqual(['geo', 'oldlib']);
    // geo/build.zig: addModule("geo", .{ .root_source_file = b.path("src/root.zig") })
    expect(config!.moduleRoots?.get('geo')).toEqual(['libs/geo/src/root.zig']);
    // oldlib has no build.zig → no entry; the resolver falls back to
    // src/root.zig → src/oldlib.zig → src/main.zig.
    expect(config!.moduleRoots?.has('oldlib')).toBe(false);
  });
});
