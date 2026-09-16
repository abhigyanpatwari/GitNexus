import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getRelationships, runPipelineFromRepo, writeFixtureRepo } from './helpers.js';
import { loadRustCargoTargets } from '../../../src/core/ingestion/languages/rust/cargo-targets.js';

describe('Rust Cargo target boundaries in name fallback (#3253)', () => {
  it.each([
    ['use demo::*;', false],
    ['use demo::helper;', false],
    ['use demo::nested::*;', true],
    ['use demo::nested::helper;', true],
    ['use demo as api; use api::nested::*;', true],
    ['use ::demo as demo; use demo::nested::*;', true],
    ['use b as a; use a as b; use a::*;', false],
  ] as const)('matches inline modules within a Cargo root: %s', async (source, allowed) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-rust-cargo-inline-root-'));
    try {
      writeFixtureRepo(dir, {
        'Cargo.toml': '[package]\nname="demo"\nedition="2021"\n',
        'src/lib.rs': 'pub mod nested { pub fn helper() {} }',
        'tests/caller.rs': `${source} pub fn caller() { helper(); }`,
      });
      const result = await runPipelineFromRepo(dir, () => {});
      expect(
        getRelationships(result, 'CALLS').filter(
          (edge) => edge.source === 'caller' && edge.target === 'helper',
        ),
      ).toHaveLength(allowed ? 1 : 0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it.each([
    ['pub mod nested { pub fn helper() {} } pub use nested::helper;', 'demo'],
    ['pub mod nested { pub fn helper() {} } pub use nested::*;', 'demo'],
    ['pub fn helper() {} pub mod nested { pub use super::helper; }', 'demo::nested'],
    [
      'pub mod a { pub fn helper() {} } pub mod b { pub use crate::a::helper; } pub use b::helper;',
      'demo',
    ],
  ])('preserves same-file re-export evidence: %s', async (library, imported) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-rust-cargo-reexport-'));
    try {
      writeFixtureRepo(dir, {
        'Cargo.toml': '[package]\nname="demo"\nedition="2021"\n',
        'src/lib.rs': library,
        'tests/caller.rs': `use ${imported}::*; pub fn caller() { helper(); }`,
      });
      const result = await runPipelineFromRepo(dir, () => {});
      expect(
        getRelationships(result, 'CALLS').filter(
          (edge) => edge.source === 'caller' && edge.target === 'helper',
        ),
      ).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it.each(['tests/fmt.rs', 'benches/fmt.rs', 'examples/fmt.rs'])(
    'uses Cargo root identity for the nonempty file stem %s',
    async (target) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-rust-cargo-root-stem-'));
      try {
        writeFixtureRepo(dir, {
          'Cargo.toml': '[package]\nname="demo"\nversion="0.1.0"\nedition="2021"\n',
          'src/lib.rs': 'use std::fmt::*; pub fn caller() { helper(); }',
          [target]: 'pub fn helper() {}',
        });
        const result = await runPipelineFromRepo(dir, () => {});
        expect(result.graph.getNode(`Function:${target}:helper`)).toBeDefined();
        expect(
          getRelationships(result, 'CALLS').filter(
            (edge) => edge.source === 'caller' && edge.target === 'helper',
          ),
        ).toEqual([]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    },
  );

  it('recognizes a custom library entry file as the imported crate root', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-rust-cargo-custom-root-'));
    try {
      writeFixtureRepo(dir, {
        'Cargo.toml':
          '[package]\nname="demo"\nversion="0.1.0"\nedition="2021"\n[lib]\npath="library/entry.rs"\n',
        'library/entry.rs': 'pub fn helper() {}',
        'tests/caller.rs': 'use demo::*; pub fn caller() { helper(); }',
      });
      const result = await runPipelineFromRepo(dir, () => {});
      expect(
        getRelationships(result, 'CALLS').filter(
          (edge) => edge.source === 'caller' && edge.target === 'helper',
        ),
      ).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it.each([
    ['use target_boundary::shared::*;', true],
    ['use target_boundary as api; use api::shared::*;', true],
    ['use std::shared::*;', false],
  ] as const)(
    'keeps crate identity for a file shared as both module and target: %s',
    async (source, allowed) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-rust-cargo-shared-root-'));
      try {
        writeFixtureRepo(dir, {
          'Cargo.toml': '[package]\nname="target-boundary"\nversion="0.1.0"\nedition="2021"\n',
          'src/lib.rs': '#[path="../tests/shared.rs"] pub mod shared;',
          'tests/shared.rs': 'pub fn helper() {}',
          'examples/caller.rs': `${source} pub fn caller() { helper(); }`,
        });
        const result = await runPipelineFromRepo(dir, () => {});
        expect(
          getRelationships(result, 'CALLS').filter(
            (edge) => edge.source === 'caller' && edge.target === 'helper',
          ),
        ).toHaveLength(allowed ? 1 : 0);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    },
  );

  it.each(['use std::fmt::*;', 'use target_boundary::nested::*;', 'use std::helper;'])(
    'an unrelated import cannot reach a binary-root helper: %s',
    async (source) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-rust-cargo-unrelated-glob-'));
      try {
        writeFixtureRepo(dir, {
          'Cargo.toml': '[package]\nname="target-boundary"\nversion="0.1.0"\nedition="2021"\n',
          'src/lib.rs': `${source} pub fn caller() { helper(); }`,
          'src/main.rs': 'pub fn helper() {}',
        });
        const result = await runPipelineFromRepo(dir, () => {});
        expect(result.graph.getNode('Function:src/main.rs:helper')).toBeDefined();
        expect(
          getRelationships(result, 'CALLS').filter(
            (edge) => edge.source === 'caller' && edge.target === 'helper',
          ),
        ).toEqual([]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    },
  );

  it('an unrelated import cannot revive a rejected crate-root candidate', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-rust-cargo-unrelated-'));
    try {
      writeFixtureRepo(dir, {
        'Cargo.toml': '[package]\nname="target-boundary"\nversion="0.1.0"\nedition="2021"\n',
        'src/lib.rs': 'use crate::helper; use std::fmt; pub fn caller() { helper(); }',
        'src/main.rs': 'pub fn helper() {}',
      });
      const result = await runPipelineFromRepo(dir, () => {});
      expect(result.graph.getNode('Function:src/main.rs:helper')).toBeDefined();
      expect(
        getRelationships(result, 'CALLS').filter(
          (edge) => edge.source === 'caller' && edge.target === 'helper',
        ),
      ).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it.each([
    'use target_boundary::helper;',
    'use target_boundary::*;',
    'use target_boundary as api; use api::*;',
  ])('preserves an explicit library import from an integration target: %s', async (source) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-rust-cargo-library-'));
    try {
      writeFixtureRepo(dir, {
        'Cargo.toml': '[package]\nname="target-boundary"\nversion="0.1.0"\nedition="2021"\n',
        'src/lib.rs': 'pub fn helper() {}',
        'tests/caller.rs': `${source} pub fn caller() { helper(); }`,
      });
      expect(await loadRustCargoTargets(dir)).toBeDefined();
      const result = await runPipelineFromRepo(dir, () => {});
      const calls = getRelationships(result, 'CALLS').filter(
        (edge) => edge.source === 'caller' && edge.target === 'helper',
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]!.targetFilePath).toBe('src/lib.rs');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it.each([
    ['mod target_boundary {} use target_boundary::*;', '', false],
    ['mod target_boundary {} use ::target_boundary::*;', '', true],
    ['fn target_boundary() {} use target_boundary::*;', '', true],
    ['mod api {} fn allowed() { use target_boundary as api; use api::*; helper(); }', '', true],
    ['use std::*;', '', false],
    ['use target_boundary::nested::*;', '', false],
    ['use public_api::*;', '[lib]\nname="public_api"\n', true],
    ['use target_boundary::*;', '[lib]\nname="public_api"\n', false],
    [
      'use target_boundary as api; fn denied() { use std::fmt as api; use api::*; helper(); }',
      '',
      false,
    ],
  ] as const)('requires the actual library root for %s', async (source, lib, allowed) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-rust-cargo-root-name-'));
    try {
      writeFixtureRepo(dir, {
        'Cargo.toml': `[package]\nname="target-boundary"\nversion="0.1.0"\nedition="2021"\n${lib}`,
        'src/lib.rs': 'pub fn helper() {}',
        'tests/caller.rs': `${source} pub fn caller() { helper(); }`,
      });
      const result = await runPipelineFromRepo(dir, () => {});
      const calls = getRelationships(result, 'CALLS').filter((edge) => edge.target === 'helper');
      expect(calls).toHaveLength(allowed ? 1 : 0);
      expect(calls.map((edge) => edge.source)).toEqual(
        allowed ? [source.includes('fn allowed()') ? 'allowed' : 'caller'] : [],
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it.each([false, true])(
    'recognizes a renamed path dependency (workspace inherited: %s)',
    async (inherited) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-rust-cargo-dep-alias-'));
      try {
        writeFixtureRepo(dir, {
          'Cargo.toml':
            '[package]\nname="root-lib"\nversion="0.1.0"\nedition="2021"\n[workspace]\nmembers=["consumer"]\n' +
            (inherited ? '[workspace.dependencies]\nrenamed={package="root-lib",path="."}\n' : ''),
          'src/lib.rs': 'pub fn helper() {}',
          'consumer/Cargo.toml':
            '[package]\nname="consumer"\nversion="0.1.0"\nedition="2021"\n[dependencies]\n' +
            (inherited ? 'renamed={workspace=true}\n' : 'renamed={package="root-lib",path=".."}\n'),
          'consumer/src/lib.rs': 'use renamed::*; pub fn caller() { helper(); }',
        });
        const result = await runPipelineFromRepo(dir, () => {});
        const calls = getRelationships(result, 'CALLS').filter(
          (edge) => edge.source === 'caller' && edge.target === 'helper',
        );
        expect(calls).toHaveLength(1);
        expect(calls[0]!.targetFilePath).toBe('src/lib.rs');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    },
  );

  it.each([
    'tests/helper.rs',
    'benches/helper.rs',
    'examples/helper.rs',
    'src/bin/helper.rs',
    'src/main.rs',
  ])('does not use the separate target %s to satisfy a library crate import', async (target) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-rust-cargo-target-'));
    try {
      writeFixtureRepo(dir, {
        'Cargo.toml': '[package]\nname = "target-boundary"\nversion = "0.1.0"\nedition = "2021"\n',
        '.gitnexusignore': '!src/bin/\n',
        'src/lib.rs': 'use crate::helper;\npub fn caller() { helper(); }\n',
        [target]: 'pub fn helper() {}\n',
      });
      const result = await runPipelineFromRepo(dir, () => {});
      expect(result.graph.getNode(`Function:${target}:helper`)).toBeDefined();
      const calls = getRelationships(result, 'CALLS').filter(
        (edge) => edge.source === 'caller' && edge.target === 'helper',
      );
      expect(calls).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it.each([
    ['library module', 'src/helper.rs', 'mod helper; use crate::helper::helper;'],
    [
      'unit-test module',
      'src/tests/helper.rs',
      '#[cfg(test)] mod tests { pub mod helper; } use crate::tests::helper::helper;',
    ],
    [
      'shared integration-test source',
      'tests/helper.rs',
      '#[path="../tests/helper.rs"] mod shared; use crate::shared::helper;',
    ],
  ])('preserves a valid %s call', async (_name, target, source) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-rust-cargo-positive-'));
    try {
      writeFixtureRepo(dir, {
        'Cargo.toml': '[package]\nname="positive"\nversion="0.1.0"\nedition="2021"\n',
        'src/lib.rs': `${source}\npub fn caller() { helper(); }\n`,
        [target]: 'pub fn helper() {}\n',
      });
      const result = await runPipelineFromRepo(dir, () => {});
      const calls = getRelationships(result, 'CALLS').filter(
        (edge) => edge.source === 'caller' && edge.target === 'helper',
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]!.targetFilePath).toBe(target);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it.each([
    ['missing metadata', undefined, ''],
    ['malformed metadata', '[package', ''],
    [
      'unmodeled module expansion',
      '[package]\nname="unknown"\nversion="0.1.0"\nedition="2021"\n',
      'include!("generated.rs");',
    ],
    [
      'unmodeled extern-crate alias',
      '[package]\nname="unknown"\nversion="0.1.0"\nedition="2021"\n',
      'extern crate self as api;',
    ],
  ])('preserves a labeled guess with %s', async (_name, manifest, prefix) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-rust-cargo-unknown-'));
    try {
      writeFixtureRepo(dir, {
        ...(manifest === undefined ? {} : { 'Cargo.toml': manifest }),
        'src/lib.rs': `${prefix}\nuse crate::helper; pub fn caller() { helper(); }`,
        'tests/helper.rs': 'pub fn helper() {}',
      });
      expect(await loadRustCargoTargets(dir)).toBeUndefined();
      const result = await runPipelineFromRepo(dir, () => {});
      const calls = getRelationships(result, 'CALLS').filter(
        (edge) => edge.source === 'caller' && edge.target === 'helper',
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]!.rel.reason).toBe('global-name-fallback');
      expect(calls[0]!.rel.confidence).toBe(0.5);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('refuses a crate-root helper from another target on typical derive/assert_eq source', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-rust-cargo-derive-'));
    try {
      writeFixtureRepo(dir, {
        'Cargo.toml': '[package]\nname="demo"\nversion="0.1.0"\nedition="2021"\n',
        'src/lib.rs':
          '#[derive(Debug)] struct S;\npub fn helper() {}\nfn t() { assert_eq!(1, 1); }\n',
        'tests/caller.rs': 'pub fn caller() { helper(); }\n',
      });
      const result = await runPipelineFromRepo(dir, () => {});
      expect(
        getRelationships(result, 'CALLS').filter(
          (edge) => edge.source === 'caller' && edge.target === 'helper',
        ),
      ).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('does not treat pub(crate) use as a public re-export for integration targets', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-rust-cargo-pub-crate-'));
    try {
      writeFixtureRepo(dir, {
        'Cargo.toml': '[package]\nname="demo"\nedition="2021"\n',
        'src/lib.rs': 'pub mod nested { pub fn helper() {} } pub(crate) use nested::helper;',
        'tests/caller.rs': 'use demo::*; pub fn caller() { helper(); }',
      });
      const result = await runPipelineFromRepo(dir, () => {});
      expect(
        getRelationships(result, 'CALLS').filter(
          (edge) => edge.source === 'caller' && edge.target === 'helper',
        ),
      ).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
});
