import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { TransitionalScopeTree } from '../../src/storage/scope-index-store.js';

describe('Rust qualified factory boundaries', () => {
  it('keeps an alias type parameter out of the enclosing module', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rust-alias-parameter-'));
    try {
      await fs.writeFile(
        path.join(root, 'main.rs'),
        'mod T { pub struct Product; impl Product { pub fn m(&self) {} } pub fn make() -> Product { Product } }\ntype Alias<T> = Option<T>;\nfn caller() { let x = T::make(); x.m(); }\n',
      );
      const result = await runPipelineFromRepo(root, () => {}, {});
      const calls = [...result.graph.iterRelationships()].filter(
        (edge) =>
          edge.type === 'CALLS' &&
          result.graph.getNode(edge.sourceId)?.properties.name === 'caller',
      );
      expect(
        calls.map((edge) => result.graph.getNode(edge.targetId)?.properties.name).sort(),
      ).toEqual(['m', 'make']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 120000);
  it('retains the outer unresolved call when its member repeats the inner callee', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rust-qualified-repeat-'));
    try {
      await fs.writeFile(
        path.join(root, 'main.rs'),
        'mod factory { pub fn untyped() {} }\nfn caller() { factory::untyped().untyped(); }\n',
      );
      const result = await runPipelineFromRepo(root, () => {}, {});
      const drops = result.resolutionOutcomes.filter(
        (outcome) =>
          outcome.kind === 'suppressed' &&
          outcome.reason === 'receiver-unresolved' &&
          outcome.siteKind === 'call' &&
          outcome.name === 'untyped',
      );
      expect(drops).toHaveLength(1);
      const calls = [...result.graph.iterRelationships()].filter(
        (edge) =>
          edge.type === 'CALLS' &&
          result.graph.getNode(edge.sourceId)?.properties.name === 'caller' &&
          result.graph.getNode(edge.targetId)?.properties.name === 'untyped',
      );
      expect(calls).toHaveLength(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 120000);

  it('resolves a cold inline-only module after sealing disk scopes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rust-qualified-disk-'));
    const store = await fs.mkdtemp(path.join(os.tmpdir(), 'rust-qualified-store-'));
    const previous = process.env.GITNEXUS_DISK_SCOPE_INDEX;
    const original = TransitionalScopeTree.prototype.seal;
    let seals = 0;
    TransitionalScopeTree.prototype.seal = function (...args: Parameters<typeof original>) {
      seals++;
      return original.apply(this, args);
    };
    try {
      process.env.GITNEXUS_DISK_SCOPE_INDEX = '1';
      await fs.writeFile(
        path.join(root, 'main.rs'),
        'mod factory { pub fn untyped() {} }\nfn caller() { factory::untyped().m(); }\n',
      );
      const result = await runPipelineFromRepo(root, () => {}, { parsedFileStorePath: store });
      expect(seals).toBe(1);
      expect(
        [...result.graph.iterRelationships()].filter(
          (edge) =>
            edge.type === 'CALLS' && result.graph.getNode(edge.targetId)?.properties.name === 'm',
        ),
      ).toEqual([]);
      expect(
        result.resolutionOutcomes.some(
          (outcome) =>
            outcome.kind === 'suppressed' &&
            outcome.reason === 'receiver-unresolved' &&
            outcome.siteKind === 'call' &&
            outcome.name === 'm',
        ),
      ).toBe(true);
    } finally {
      TransitionalScopeTree.prototype.seal = original;
      if (previous === undefined) delete process.env.GITNEXUS_DISK_SCOPE_INDEX;
      else process.env.GITNEXUS_DISK_SCOPE_INDEX = previous;
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(store, { recursive: true, force: true });
    }
  }, 120000);
});
