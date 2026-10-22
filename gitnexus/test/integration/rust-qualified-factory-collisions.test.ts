import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

describe('Rust qualified factory lexical and declaration identity', () => {
  let root: string;
  let result: Awaited<ReturnType<typeof runPipelineFromRepo>>;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'rust-factory-collisions-'));
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(
      path.join(root, 'Cargo.toml'),
      '[package]\nname="collisions"\nversion="0.1.0"\nedition="2021"\n',
    );
    for (const [file, name] of [
      ['a', 'A'],
      ['b', 'B'],
    ])
      await fs.writeFile(
        path.join(root, `src/${file}.rs`),
        `pub struct ${name}; impl ${name} { pub fn m(&self) {} } pub fn make() -> ${name} { ${name} }`,
      );
    await fs.writeFile(
      path.join(root, 'src/model.rs'),
      `#[allow(non_camel_case_types)] pub struct model; impl model { pub fn make() -> Self { Self } pub fn m(&self) {} } pub struct Wrong; impl Wrong { pub fn m(&self) {} } pub fn make() -> Wrong { Wrong }`,
    );
    await fs.writeFile(
      path.join(root, 'src/main.rs'),
      `
mod a; mod b; mod model;
use crate::a as factory;
use crate::model::model as Maker;
fn scoped_import() { use crate::b as factory; factory::make().m(); }
fn type_import() { Maker::make().m(); }
`,
    );
    result = await runPipelineFromRepo(root, () => {}, {});
  }, 120000);
  afterAll(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });
  const targets = (caller: string, name: string) =>
    [...result.graph.iterRelationships()]
      .filter(
        (edge) =>
          edge.type === 'CALLS' &&
          result.graph.getNode(edge.sourceId)?.properties.name === caller &&
          result.graph.getNode(edge.targetId)?.properties.name === name,
      )
      .map((edge) => edge.targetId);
  it('uses the nearest module import', () => {
    expect(targets('scoped_import', 'm')).toEqual(['Function:src/b.rs:B.m#0']);
  });
  it('does not reinterpret a resolved type import as its module', () => {
    expect(targets('type_import', 'm')).not.toContain('Function:src/model.rs:Wrong.m#0');
    expect(targets('type_import', 'make')).not.toContain('Function:src/model.rs:make');
  });
});
