import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

describe('C++ qualified factory review boundaries', () => {
  let root: string;
  let result: Awaited<ReturnType<typeof runPipelineFromRepo>>;
  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cpp-factory-review-'));
    await fs.writeFile(
      path.join(root, 'products.h'),
      `
namespace lib { inline namespace v1 { struct InlineProduct { int m(); }; } }
struct NoArg { int m(); };
struct OneArg { int m(); };
NoArg create();
OneArg create(int);
namespace app { namespace json { struct ParsedDoc { void dump(); }; ParsedDoc parse(); } }
namespace outer { struct Factory { static NoArg make(); }; }
namespace Factory { OneArg make(); }
`,
    );
    await fs.writeFile(
      path.join(root, 'main.cpp'),
      `
#include "products.h"
void inline_brace() { auto x = lib::InlineProduct{}; x.m(); }
struct Holder { lib::InlineProduct field; void field_call() { field.m(); } };
void overloaded_bound() { auto x = create(); x.m(); }
void overloaded_inline() { create().m(); }
void overloaded_argument_bound() { auto x = create(1); x.m(); }
void overloaded_argument_inline() { create(1).m(); }
void outer_mismatch_bound() { auto x = ext::json::parse(); x.dump(); }
void outer_mismatch_inline() { ext::json::parse().dump(); }
void outer_match_bound() { auto x = app::json::parse(); x.dump(); }
void outer_match_inline() { app::json::parse().dump(); }
namespace app { void relative_match() { json::parse().dump(); } }
void class_qualifier_collision() { outer::Factory::make().m(); }
void actual_factory_namespace() { Factory::make().m(); }
`,
    );
    result = await runPipelineFromRepo(root, () => {}, {});
  }, 120000);
  afterAll(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });
  function targets(caller: string): string[] {
    const edges = [...result.graph.iterRelationships()];
    return edges
      .filter(
        (edge) =>
          edge.type === 'CALLS' &&
          result.graph.getNode(edge.sourceId)?.properties.name === caller &&
          ['m', 'dump'].includes(String(result.graph.getNode(edge.targetId)?.properties.name)),
      )
      .map((edge) => {
        const owner = edges.find(
          (candidate) => candidate.type === 'HAS_METHOD' && candidate.targetId === edge.targetId,
        );
        return String(owner && result.graph.getNode(owner.sourceId)?.properties.name);
      })
      .sort();
  }
  it.each(['inline_brace', 'field_call'])('%s sees through an inline namespace', (caller) => {
    expect(targets(caller)).toEqual(['InlineProduct']);
  });
  it.each([
    'overloaded_bound',
    'overloaded_inline',
    'overloaded_argument_bound',
    'overloaded_argument_inline',
  ])('%s declines ambiguous prototype returns', (caller) => {
    expect(targets(caller)).toEqual([]);
  });
  it.each(['outer_mismatch_bound', 'outer_mismatch_inline'])(
    '%s cannot borrow a different outer namespace',
    (caller) => {
      expect(targets(caller)).toEqual([]);
    },
  );
  it.each(['outer_match_bound', 'outer_match_inline', 'relative_match'])(
    '%s keeps a factory in the written namespace',
    (caller) => {
      expect(targets(caller)).toEqual(['ParsedDoc']);
    },
  );
  it('does not use a namespace for an intermediate class qualifier', () => {
    expect(targets('class_qualifier_collision')).toEqual([]);
  });
  it('keeps the real namespace that shares the class name', () => {
    expect(targets('actual_factory_namespace')).toEqual(['OneArg']);
  });
});
