import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

describe('Rust qualified factory spelling follows declarations', () => {
  let root: string;
  let result: Awaited<ReturnType<typeof runPipelineFromRepo>>;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'rust-factory-spellings-'));
    await fs.mkdir(path.join(root, 'src'));
    await fs.writeFile(
      path.join(root, 'Cargo.toml'),
      '[package]\nname="spellings"\nversion="0.1.0"\nedition="2021"\n',
    );
    await fs.writeFile(
      path.join(root, 'src/Factory.rs'),
      'pub struct Upper; impl Upper { pub fn m(&self) {} } pub fn make() -> Upper { Upper }',
    );
    await fs.writeFile(
      path.join(root, 'src/módulo.rs'),
      'pub struct Unicode; impl Unicode { pub fn m(&self) {} } pub fn hacer() -> Unicode { Unicode } pub fn créer() -> Unicode { Unicode }',
    );
    await fs.writeFile(
      path.join(root, 'src/main.rs'),
      `
mod Factory;
mod módulo;
#[allow(non_camel_case_types)] struct lowercase_type;
impl lowercase_type { fn new() -> Self { Self } fn m(&self) {} }
#[derive(Default)] #[allow(non_camel_case_types)] struct derived_type;
impl derived_type { fn m(&self) {} }
struct Decoy; impl Decoy { fn m(&self) {} }
fn lower_type() { let x = lowercase_type::new(); x.m(); }
fn derived_default() { let x = derived_type::default(); x.m(); }
fn upper_module() { let x = Factory::make(); x.m(); }
fn unicode_module() { let x = módulo::hacer(); x.m(); }
fn unicode_function() { let x = módulo::créer(); x.m(); }
`,
    );
    result = await runPipelineFromRepo(root, () => {}, {});
  }, 120000);
  afterAll(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });
  it.each([
    ['lower_type', 'Function:src/main.rs:lowercase_type.m#0'],
    ['derived_default', 'Function:src/main.rs:derived_type.m#0'],
    ['upper_module', 'Function:src/Factory.rs:Upper.m#0'],
    ['unicode_module', 'Function:src/módulo.rs:Unicode.m#0'],
    ['unicode_function', 'Function:src/módulo.rs:Unicode.m#0'],
  ])('%s resolves its declared receiver', (caller, target) => {
    expect(
      [...result.graph.iterRelationships()]
        .filter(
          (edge) =>
            edge.type === 'CALLS' &&
            result.graph.getNode(edge.sourceId)?.properties.name === caller &&
            result.graph.getNode(edge.targetId)?.properties.name === 'm',
        )
        .map((edge) => edge.targetId),
    ).toEqual([target]);
  });
});
