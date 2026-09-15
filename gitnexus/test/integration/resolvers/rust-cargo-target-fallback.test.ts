import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getRelationships, runPipelineFromRepo, writeFixtureRepo } from './helpers.js';

describe('Rust Cargo target boundaries in name fallback (#3253)', () => {
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

  it.each(['use target_boundary::helper;', 'use target_boundary::*;'])(
    'preserves an explicit library import from an integration target: %s',
    async (source) => {
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
