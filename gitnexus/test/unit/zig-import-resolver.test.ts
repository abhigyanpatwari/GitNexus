/**
 * Unit tests for the Zig import resolver, covering both relative-path
 * imports and bare-name imports resolved through build.zig.zon.
 */
import { describe, it, expect } from 'vitest';
import { resolveZigImportInternal } from '../../src/core/ingestion/import-resolvers/zig.js';
import { parseZigBuildZon } from '../../src/core/ingestion/language-config.js';

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

  it('returns null when no `.dependencies` block is present', () => {
    const raw = `.{ .name = "x", .version = "0.0.0", .paths = .{""} }`;
    expect(parseZigBuildZon(raw)).toBeNull();
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
