/**
 * Unit tests for the Rust module-path model (#2730 review).
 *
 * These pin the identity rules the qualified-call resolver depends on. The
 * integration tests exercise resolution end to end; these cover the arithmetic
 * directly, including the branches a fixture cannot reach (a file under no crate
 * root, `super::` walking above the crate root).
 */
import { describe, it, expect } from 'vitest';
import {
  buildRustModuleIndex,
  moduleOfDef,
  moduleOfFile,
  resolveAnchoredModulePath,
  sameModule,
} from '../../../../src/core/ingestion/languages/rust/module-path.js';

const WORKSPACE = buildRustModuleIndex(
  new Set([
    'crates/alpha/src/lib.rs',
    'crates/alpha/src/tools.rs',
    'crates/alpha/src/a/mod.rs',
    'crates/alpha/src/a/b.rs',
    'crates/beta/src/lib.rs',
    'crates/beta/src/tools.rs',
  ]),
);

const SINGLE = buildRustModuleIndex(new Set(['src/main.rs', 'src/tools.rs', 'src/a/mod.rs']));

describe('buildRustModuleIndex', () => {
  it('finds one crate root per member, longest first', () => {
    expect(WORKSPACE.crateRoots).toEqual(['crates/alpha/src', 'crates/beta/src']);
  });

  it('finds a single crate root for a plain package', () => {
    expect(SINGLE.crateRoots).toEqual(['src']);
  });
});

describe('moduleOfFile', () => {
  it('maps a crate root file to the crate-root module', () => {
    expect(moduleOfFile('src/main.rs', SINGLE)).toMatchObject({ crateRoot: 'src', segments: [] });
  });

  it('maps a plain module file to its own segment', () => {
    expect(moduleOfFile('src/tools.rs', SINGLE)).toMatchObject({
      crateRoot: 'src',
      segments: ['tools'],
    });
  });

  it('does not let mod.rs contribute a segment', () => {
    expect(moduleOfFile('src/a/mod.rs', SINGLE)).toMatchObject({
      crateRoot: 'src',
      segments: ['a'],
    });
  });

  it('maps a nested module file to the full path', () => {
    expect(moduleOfFile('crates/alpha/src/a/b.rs', WORKSPACE)).toMatchObject({
      crateRoot: 'crates/alpha/src',
      segments: ['a', 'b'],
    });
  });

  it('returns undefined for a file under no crate root', () => {
    expect(moduleOfFile('scripts/helper.rs', SINGLE)).toBeUndefined();
  });
});

describe('module identity carries the crate (#2730 review H1)', () => {
  it('gives two crates the same internal segments', () => {
    const alpha = moduleOfFile('crates/alpha/src/tools.rs', WORKSPACE);
    const beta = moduleOfFile('crates/beta/src/tools.rs', WORKSPACE);
    expect(alpha).toMatchObject({ segments: ['tools'] });
    expect(beta).toMatchObject({ segments: ['tools'] });
  });

  it('but does NOT treat them as the same module', () => {
    const alpha = moduleOfFile('crates/alpha/src/tools.rs', WORKSPACE)!;
    const beta = moduleOfFile('crates/beta/src/tools.rs', WORKSPACE)!;
    expect(sameModule(alpha, beta)).toBe(false);
  });

  it('treats a module as equal to itself', () => {
    const one = moduleOfFile('crates/alpha/src/tools.rs', WORKSPACE)!;
    const two = moduleOfFile('crates/alpha/src/tools.rs', WORKSPACE)!;
    expect(sameModule(one, two)).toBe(true);
  });
});

describe('moduleOfDef', () => {
  it('appends an inline mod prefix to the file module', () => {
    expect(moduleOfDef('src/tools.rs', 'inner', SINGLE)).toMatchObject({
      crateRoot: 'src',
      segments: ['tools', 'inner'],
    });
  });

  it('splits a nested inline prefix', () => {
    expect(moduleOfDef('src/main.rs', 'outer.inner', SINGLE)).toMatchObject({
      segments: ['outer', 'inner'],
    });
  });

  it('leaves the file module alone when there is no prefix', () => {
    expect(moduleOfDef('src/tools.rs', undefined, SINGLE)).toMatchObject({ segments: ['tools'] });
  });
});

describe('resolveAnchoredModulePath', () => {
  const caller = { crateRoot: 'src', segments: ['a', 'b'] };

  it('anchors crate:: at the caller crate root', () => {
    expect(resolveAnchoredModulePath(['crate', 'tools'], caller)).toMatchObject({
      anchored: true,
      module: { crateRoot: 'src', segments: ['tools'] },
    });
  });

  it('anchors self:: at the calling module', () => {
    expect(resolveAnchoredModulePath(['self', 'inner'], caller)).toMatchObject({
      anchored: true,
      module: { segments: ['a', 'b', 'inner'] },
    });
  });

  it('pops one segment per super', () => {
    expect(resolveAnchoredModulePath(['super', 'sibling'], caller)).toMatchObject({
      anchored: true,
      module: { segments: ['a', 'sibling'] },
    });
  });

  it('consumes a super chain left to right', () => {
    expect(resolveAnchoredModulePath(['super', 'super', 'top'], caller)).toMatchObject({
      anchored: true,
      module: { segments: ['top'] },
    });
  });

  it('refuses a super chain that walks above the crate root', () => {
    expect(resolveAnchoredModulePath(['super', 'super', 'super', 'x'], caller)).toBeUndefined();
  });

  it('keeps a bare path relative for the caller to try in context', () => {
    expect(resolveAnchoredModulePath(['tools'], caller)).toMatchObject({
      anchored: false,
      module: { crateRoot: 'src', segments: ['tools'] },
    });
  });

  it('keeps an anchored path inside the caller crate', () => {
    const inBeta = { crateRoot: 'crates/beta/src', segments: [] };
    expect(resolveAnchoredModulePath(['crate', 'tools'], inBeta)).toMatchObject({
      module: { crateRoot: 'crates/beta/src' },
    });
  });
});
