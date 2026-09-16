import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getRelationships, runPipelineFromRepo, writeFixtureRepo } from './helpers.js';
import {
  loadRustCargoTargets,
  rustFilesShareCargoTarget,
} from '../../../src/core/ingestion/languages/rust/cargo-targets.js';

const PACKAGE = '[package]\nname="demo"\nedition="2021"\n';

async function check(files: Record<string, string>, expectedCalls: number, complete = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-cargo-review-'));
  try {
    writeFixtureRepo(dir, { 'Cargo.toml': PACKAGE, ...files });
    const config = await loadRustCargoTargets(dir);
    if (complete) expect(config).toBeDefined();
    else expect(config).toBeUndefined();
    const result = await runPipelineFromRepo(dir, () => {});
    const candidates = [...result.graph.iterNodes()].filter(
      (node) => node.properties.name === 'helper',
    );
    expect(candidates.length).toBeGreaterThan(0);
    const calls = getRelationships(result, 'CALLS').filter(
      (edge) => edge.source === 'caller' && edge.target === 'helper',
    );
    expect(calls).toHaveLength(expectedCalls);
    return { config, calls };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

describe('Cargo review regressions (#3294)', () => {
  it.each(['', 'use crate::helper;', 'use super::helper;', 'use crate::*;', 'use super::*;'])(
    'requires lexical import evidence within the same Cargo target: %s',
    async (imported) => {
      await check(
        {
          'src/lib.rs': 'fn helper() {} mod child;',
          'src/child.rs': `${imported} pub fn caller() { helper(); }`,
        },
        imported === '' ? 0 : 1,
      );
    },
  );
  it.each([
    '#[derive(Debug, Clone)] pub struct T;',
    'fn noisy() { println!("x"); assert_eq!(1, 1); let _v = vec![1, 2]; }',
    'fn noisy() { std::println!("x"); core::assert_eq!(1, 1); }',
    '#[derive(Debug)] struct T; #[cfg(test)] mod tests { use super::*; #[test] fn f() { assert_eq!(1,1); } }',
    'use std::fmt::*; fn noisy() { println!("x"); }',
    '#[test] #[should_panic] #[ignore] fn expected_panic() { panic!("expected"); }',
  ])('retains target separation with ordinary Rust: %s', async (source) => {
    await check(
      {
        'src/lib.rs': `${source} use crate::helper; pub fn caller() { helper(); }`,
        'tests/helper.rs': 'pub fn helper() {}',
      },
      0,
    );
  });

  it('ordinary macros in a sibling target do not erase the proof', async () => {
    await check(
      {
        'src/lib.rs': 'use crate::helper; pub fn caller() { helper(); }',
        'tests/helper.rs': 'pub fn helper() {}',
        'tests/other.rs': '#[test] fn ordinary() { assert_eq!(1, 1); }',
      },
      0,
    );
  });

  it('restores a real module directory named target', async () => {
    const { config } = await check(
      {
        'src/lib.rs': 'mod target; use crate::helper; pub fn caller() { helper(); }',
        'src/target/mod.rs': 'pub fn other() {}',
        'tests/helper.rs': 'pub fn helper() {}',
      },
      0,
    );
    expect(rustFilesShareCargoTarget(config, 'src/lib.rs', 'src/target/mod.rs')).toBe(true);
  });

  it('does not import a build-script root into the library', async () => {
    await check(
      {
        'src/lib.rs': 'use std::build::*; pub fn caller() { helper(); }',
        'build.rs': 'pub fn helper() {} fn main() {}',
      },
      0,
    );
  });

  it('restores explicit roots under artifact-pruned directories', async () => {
    await check(
      {
        'Cargo.toml': `${PACKAGE}[[bin]]\nname="custom"\npath="target/entry.rs"\n`,
        'target/entry.rs': 'fn main() {}',
        'src/lib.rs': 'use crate::helper; pub fn caller() { helper(); }',
        'tests/helper.rs': 'pub fn helper() {}',
      },
      0,
    );
  });

  it('keeps a custom library root import when that file is shared with a binary', async () => {
    await check(
      {
        'Cargo.toml': `${PACKAGE}[lib]\npath="custom/entry.rs"\n`,
        'custom/entry.rs': 'pub fn helper() {}',
        'src/main.rs': '#[path="../custom/entry.rs"] mod shared; fn main() {}',
        'tests/caller.rs': 'use demo::*; pub fn caller() { helper(); }',
      },
      1,
    );
  });

  it.each(['', 'pub(crate) ', 'pub(super) ', 'pub(in crate) ', 'pub '])(
    'honors re-export visibility for %suse',
    async (visibility) => {
      for (const imported of ['helper', '*']) {
        await check(
          {
            'src/lib.rs': `#[derive(Debug)] struct T; mod nested { pub fn helper() {} } ${visibility}use nested::${imported};`,
            'tests/caller.rs': 'use demo::*; pub fn caller() { helper(); }',
          },
          visibility === 'pub ' ? 1 : 0,
        );
      }
    },
  );

  it.each([
    ['pub fn helper() {}', 'demo', 1],
    ['pub fn helper() {}', 'demo::nested', 0],
    ['pub mod nested { pub fn helper() {} }', 'demo', 0],
    ['pub mod nested { pub fn helper() {} }', 'demo::nested', 1],
  ] as const)(
    'selects the imported root role even for a shared root: %s / %s',
    async (source, imported, count) => {
      await check(
        {
          'src/lib.rs': source,
          'src/main.rs': '#[path="lib.rs"] mod shared; fn main() {}',
          'tests/caller.rs': `use ${imported}::*; pub fn caller() { helper(); }`,
        },
        count,
      );
    },
  );

  it('keeps uncertainty for an unknown macro that can share both files', async () => {
    const { calls } = await check(
      {
        'src/lib.rs': 'use crate::helper; pub fn caller() { helper(); }',
        'tests/helper.rs': 'pub fn helper() {}',
        'src/main.rs':
          'macro_rules! share { () => { include!("../tests/helper.rs"); #[path="lib.rs"] mod library; } } share!(); fn main() {}',
      },
      1,
      false,
    );
    expect(calls[0]?.rel).toMatchObject({ reason: 'global-name-fallback', confidence: 0.5 });
  });

  it('preserves a labeled guess for an unmodeled extern-crate alias, not an alias-resolution claim', async () => {
    const { calls } = await check(
      {
        'src/lib.rs': 'pub fn helper() {}',
        'tests/caller.rs': 'extern crate demo as api; use api::*; pub fn caller() { helper(); }',
      },
      1,
      false,
    );
    expect(calls[0]?.targetFilePath).toBe('src/lib.rs');
    expect(calls[0]?.rel).toMatchObject({ reason: 'global-name-fallback', confidence: 0.5 });
  });
});
