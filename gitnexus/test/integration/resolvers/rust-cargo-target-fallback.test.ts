import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getRelationships, runPipelineFromRepo, writeFixtureRepo } from './helpers.js';

describe('Rust Cargo target boundaries in name fallback (#3253)', () => {
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
    'extern crate target_boundary as api; use api::*;',
  ])('preserves an explicit library import from an integration target: %s', async (source) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-rust-cargo-library-'));
    try {
      writeFixtureRepo(dir, {
        'Cargo.toml': '[package]\nname="target-boundary"\nversion="0.1.0"\nedition="2021"\n',
        'src/lib.rs': 'pub fn helper() {}',
        'tests/caller.rs': `${source} pub fn caller() { helper(); }`,
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
      expect(
        getRelationships(result, 'CALLS').filter((edge) => edge.target === 'helper'),
      ).toHaveLength(allowed ? 1 : 0);
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
  ])('preserves a labeled guess with %s', async (_name, manifest, prefix) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-rust-cargo-unknown-'));
    try {
      writeFixtureRepo(dir, {
        ...(manifest === undefined ? {} : { 'Cargo.toml': manifest }),
        'src/lib.rs': `${prefix}\nuse crate::helper; pub fn caller() { helper(); }`,
        'tests/helper.rs': 'pub fn helper() {}',
      });
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
});
