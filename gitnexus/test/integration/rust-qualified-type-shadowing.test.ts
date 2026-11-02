import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

describe('Rust qualified factory type shadows', () => {
  let root: string;
  let result: Awaited<ReturnType<typeof runPipelineFromRepo>>;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'rust-factory-type-shadow-'));
    await fs.writeFile(
      path.join(root, 'main.rs'),
      `
mod factory { pub struct Wrong; impl Wrong { pub fn m(&self) {} } pub fn make() -> Wrong { Wrong } }
mod módulo { pub struct UnicodeWrong; impl UnicodeWrong { pub fn m(&self) {} } pub fn make() -> UnicodeWrong { UnicodeWrong } }
struct Other; impl Other { fn make() -> Self { Self } fn m(&self) {} }
fn type_alias() { type factory = Other; let x = factory::make(); x.m(); }
fn type_parameter<factory>() { factory::make().m(); }
fn const_parameter<const factory: usize>() { factory::make().m(); }
fn unicode_type_parameter<módulo>() { módulo::make().m(); }
struct ConstHolder<const factory: usize>;
impl<const factory: usize> ConstHolder<factory> { fn struct_const_parameter() { factory::make().m(); } }
`,
    );
    result = await runPipelineFromRepo(root, () => {}, {});
  }, 120000);
  afterAll(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });
  const targets = (caller: string) =>
    [...result.graph.iterRelationships()]
      .filter(
        (edge) =>
          edge.type === 'CALLS' &&
          result.graph.getNode(edge.sourceId)?.properties.name === caller &&
          result.graph.getNode(edge.targetId)?.properties.name === 'm',
      )
      .map((edge) => edge.targetId);
  it('does not borrow a module through a local type alias', () => {
    expect(targets('type_alias')).toEqual([]);
  });
  it('does not borrow a module through a type parameter', () => {
    expect(targets('type_parameter')).toEqual([]);
  });
  it('keeps a module path visible beside a const generic value', () => {
    expect(targets('const_parameter')).toEqual(['Function:main.rs:factory.Wrong.m#0']);
  });
  it('does not borrow a module through a Unicode type parameter', () => {
    expect(targets('unicode_type_parameter')).toEqual([]);
  });
  it('keeps a module visible beside an impl const generic', () => {
    expect(targets('struct_const_parameter')).toEqual(['Function:main.rs:factory.Wrong.m#0']);
  });
});
