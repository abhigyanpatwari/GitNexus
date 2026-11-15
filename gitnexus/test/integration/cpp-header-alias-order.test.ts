import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

describe('C++ header alias activation and factory ownership', () => {
  let root: string;
  let result: Awaited<ReturnType<typeof runPipelineFromRepo>>;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cpp-header-alias-order-'));
    await fs.writeFile(
      path.join(root, 'provider.h'),
      'namespace pkg { struct Cross { int m(); }; Cross make(); } namespace imported = pkg;',
    );
    await fs.writeFile(
      path.join(root, 'main.cpp'),
      `
struct Decoy { int m(); };
void before_include() { imported::Cross x; x.m(); }
#include "provider.h"
void after_include() { imported::Cross x; x.m(); }
void bound_factory() { auto x = pkg::make(); x.m(); }
void inline_factory() { pkg::make().m(); }
void typed_value(int pkg) { pkg::Cross x; x.m(); }
void auto_value(auto pkg) { pkg::Cross x; x.m(); }
void alias_type() { using pkg = Decoy; pkg::Cross x; x.m(); }
void later_alias() { pkg::Cross x; using pkg = Decoy; x.m(); }
void later_alias_bound() { auto x = pkg::make(); using pkg = Decoy; x.m(); }
void later_alias_inline() { pkg::make().m(); using pkg = Decoy; }
void later_class_bound() { auto x = pkg::make(); struct pkg {}; x.m(); }
void later_class_inline() { pkg::make().m(); struct pkg {}; }
void prior_alias_bound() { using pkg = Decoy; auto x = pkg::make(); x.m(); }
void prior_alias_inline() { using pkg = Decoy; pkg::make().m(); }
template<class pkg> void dependent_type() { typename pkg::Cross x; x.m(); }
`,
    );
    result = await runPipelineFromRepo(root, () => {}, {});
  }, 120000);
  afterAll(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });
  it.each([
    ['before_include', []],
    ['after_include', ['Method:provider.h:Cross.m#0']],
    ['bound_factory', ['Method:provider.h:Cross.m#0']],
    ['inline_factory', ['Method:provider.h:Cross.m#0']],
    ['typed_value', ['Method:provider.h:Cross.m#0']],
    ['auto_value', ['Method:provider.h:Cross.m#0']],
    ['alias_type', []],
    ['later_alias', ['Method:provider.h:Cross.m#0']],
    ['later_alias_bound', ['Method:provider.h:Cross.m#0']],
    ['later_alias_inline', ['Method:provider.h:Cross.m#0']],
    ['later_class_bound', ['Method:provider.h:Cross.m#0']],
    ['later_class_inline', ['Method:provider.h:Cross.m#0']],
    ['prior_alias_bound', []],
    ['prior_alias_inline', []],
    ['dependent_type', []],
  ] as const)('%s uses only the visible producer', (caller, targets) => {
    expect(
      [...result.graph.iterRelationships()]
        .filter(
          (edge) =>
            edge.type === 'CALLS' &&
            result.graph.getNode(edge.sourceId)?.properties.name === caller &&
            result.graph.getNode(edge.targetId)?.properties.name === 'm',
        )
        .map((edge) => edge.targetId),
    ).toEqual(targets);
  });
});
