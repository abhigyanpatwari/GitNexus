import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getRelationships,
  runPipelineFromRepo,
  writeFixtureRepo,
  type PipelineResult,
} from './helpers.js';

describe('C++ lexical using declarations and directives', () => {
  let repoDir: string;
  let result: PipelineResult;

  beforeAll(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-cpp-local-using-'));
    writeFixtureRepo(repoDir, {
      'alpha.hpp': `namespace alpha {
int work() { return 1; }
int collision() { return 1; }
struct Worker { int run() { return 1; } };
namespace detail { int nested_work() { return 1; } }
}
int included_helper() { return 1; }
`,
      'beta.hpp': `namespace beta {
int work() { return 2; }
struct Worker { int run() { return 2; } };
namespace detail { int nested_work() { return 2; } }
}
`,
      'decoy.cpp': 'int work() { return 9; }\n',
      'main.cpp': `#include "alpha.hpp"
#include "beta.hpp"
int collision() { return 0; }
int named_alpha() { using alpha::work; return work(); }
int named_beta() { using beta::work; return work(); }
int before_named() { return work(); using alpha::work; }
int unresolved_named() { using missing::work; return work(); }
int missing_member() { using alpha::absent; return absent(); }
int directive_alpha() { using namespace alpha; return work(); }
int directive_beta() { using namespace beta; return work(); }
int before_directive() { return work(); using namespace alpha; }
int sibling() { return work(); }
int nested_block() { { using alpha::work; work(); } return 0; }
int outside_block() { { using alpha::work; } return work(); }
int ambiguous_directives() { using namespace alpha; using namespace beta; return work(); }
int type_alpha() { using alpha::Worker; Worker worker; return worker.run(); }
int type_beta() { using beta::Worker; Worker worker; return worker.run(); }
int directive_type() { using namespace alpha; Worker worker; return worker.run(); }
int before_type() { Worker worker; using alpha::Worker; return worker.run(); }
int value_shadow() { using namespace alpha; { int work = 0; return work(); } }
int ancestor_value_shadow() { int work = 0; { using namespace alpha; return work(); } }
int global_collision() { using namespace alpha; return collision(); }
int directive_before_value() { using namespace alpha; work(); int work = 0; return 0; }
int prototype_parameter() { using namespace alpha; void unused(int work); return work(); }
int function_pointer_parameter(void (*callback)(int work)) { using namespace alpha; return work(); }
int actual_parameter(int work) { using namespace alpha; return work(); }
int nested_alpha() { using alpha::detail::nested_work; return nested_work(); }
int nested_beta() { using beta::detail::nested_work; return nested_work(); }
struct InlineCaller { int inline_method() { using alpha::work; return work(); } };
int header_control() { return included_helper(); }
`,
      'overloads.hpp': 'namespace imported { int choose(int value) { return value; } }\n',
      'overloads.cpp': `#include "overloads.hpp"
int choose(double value) { return 1; }
int before_using() { return choose(1.0); }
using imported::choose;
int local_overload() { return choose(1.0); }
int imported_overload() { return choose(1); }
int block_hides_outer() { using imported::choose; return choose(1.0); }
`,
      'nested-overloads.cpp': `#include "overloads.hpp"
namespace nested {
int choose(double value) { return 2; }
using imported::choose;
int nested_local() { return choose(1.0); }
int nested_imported() { return choose(1); }
}
`,
      'absent.cpp': 'int absent() { return 0; }\n',
    });
    result = await runPipelineFromRepo(repoDir, () => {});
  }, 60_000);

  afterAll(() => {
    if (repoDir !== undefined) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it.each([
    ['named_alpha', 'alpha.hpp'],
    ['named_beta', 'beta.hpp'],
    ['directive_alpha', 'alpha.hpp'],
    ['directive_beta', 'beta.hpp'],
    ['nested_block', 'alpha.hpp'],
    ['inline_method', 'alpha.hpp'],
    ['directive_before_value', 'alpha.hpp'],
    ['prototype_parameter', 'alpha.hpp'],
    ['function_pointer_parameter', 'alpha.hpp'],
  ])('resolves %s to its exact namespace member', (caller, targetFile) => {
    const calls = getRelationships(result, 'CALLS').filter(
      (edge) => edge.source === caller && edge.target === 'work',
    );
    expect(calls.map((edge) => edge.targetFilePath)).toEqual([targetFile]);
  });

  it.each([
    ['nested_alpha', 'alpha.hpp'],
    ['nested_beta', 'beta.hpp'],
  ])('preserves the full namespace path in %s', (caller, targetFile) => {
    const calls = getRelationships(result, 'CALLS').filter(
      (edge) => edge.source === caller && edge.target === 'nested_work',
    );
    expect(calls.map((edge) => edge.targetFilePath)).toEqual([targetFile]);
  });

  it.each(['before_named', 'before_directive', 'sibling', 'outside_block'])(
    'does not leak a namespace using into %s',
    (caller) => {
      const calls = getRelationships(result, 'CALLS').filter(
        (edge) => edge.source === caller && edge.target === 'work',
      );
      expect(calls.some((edge) => edge.targetFilePath === 'alpha.hpp')).toBe(false);
      expect(calls.some((edge) => edge.targetFilePath === 'beta.hpp')).toBe(false);
    },
  );

  it.each([
    'unresolved_named',
    'missing_member',
    'ambiguous_directives',
    'value_shadow',
    'ancestor_value_shadow',
    'actual_parameter',
    'global_collision',
    'before_type',
  ])('does not guess an unrelated target for %s', (caller) => {
    expect(getRelationships(result, 'CALLS').filter((edge) => edge.source === caller)).toEqual([]);
  });

  it.each([
    ['type_alpha', 'alpha.hpp'],
    ['type_beta', 'beta.hpp'],
    ['directive_type', 'alpha.hpp'],
  ])('uses the namespace type identity in %s', (caller, targetFile) => {
    const calls = getRelationships(result, 'CALLS').filter(
      (edge) => edge.source === caller && edge.target === 'run',
    );
    expect(calls.map((edge) => edge.targetFilePath)).toEqual([targetFile]);
  });

  it('preserves compilation-unit include bindings', () => {
    const calls = getRelationships(result, 'CALLS').filter(
      (edge) => edge.source === 'header_control' && edge.target === 'included_helper',
    );
    expect(calls.map((edge) => edge.targetFilePath)).toEqual(['alpha.hpp']);
  });

  it.each([
    ['before_using', 'overloads.cpp'],
    ['local_overload', 'overloads.cpp'],
    ['imported_overload', 'overloads.hpp'],
    ['nested_local', 'nested-overloads.cpp'],
    ['nested_imported', 'overloads.hpp'],
    ['block_hides_outer', 'overloads.hpp'],
  ])('preserves the exact overload selected by %s', (caller, targetFile) => {
    const calls = getRelationships(result, 'CALLS').filter(
      (edge) => edge.source === caller && edge.target === 'choose',
    );
    expect(calls.map((edge) => edge.targetFilePath)).toEqual([targetFile]);
  });
});
