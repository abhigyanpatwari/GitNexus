/**
 * C++ receiver typing through qualified type spellings.
 *
 * Every row names a caller in the `cpp-qualified-receiver-typing` fixture and
 * the exact `m` targets it must reach, as `<file>:<Owner>.m`. The fixture puts
 * a global `C` (other.h) beside `rp::C` (mod.h), and `a::Config` beside a
 * `b::Config` declared in the caller's own namespace, so a lookup that drops
 * the qualifier and lands on the nearer same-tail class fails a row instead of
 * passing it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo, type PipelineResult } from './helpers.js';

const RP_C = 'mod.h:C.m';
const GLOBAL_C = 'other.h:C.m';

describe('C++ qualified receiver typing', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'cpp-qualified-receiver-typing'),
      () => {},
    );
  }, 60000);

  /** `<file>:<Owner>.m` for every CALLS edge from `caller` to a method `m`. */
  const memberTargets = (caller: string): string[] =>
    getRelationships(result, 'CALLS')
      .filter((edge) => edge.source === caller && edge.target === 'm')
      .map((edge) => `${edge.targetFilePath}:${edge.rel.targetId.split(':')[2]?.split('#')[0]}`)
      .sort();

  it.each<[string, string[]]>([
    // A qualified spelling reaches the namespace member it names, never the
    // global `C` that other.h makes visible under the same tail.
    ['declared_init', [RP_C]],
    ['param_ns', [RP_C]],
    ['param_ns_ptr', [RP_C]],
    ['param_template', ['mod.h:Box.m']],
    ['bare_global', [GLOBAL_C]],
    // `a::Config` written inside `namespace b`, which declares its own Config.
    ['param_qualified', ['a.h:Config.m']],
    ['param_local', ['callers.cpp:Config.m']],
  ])('qualified type spelling: %s -> %j', (caller, expected) => {
    expect(memberTargets(caller)).toEqual(expected);
  });

  it.each<[string, string[]]>([
    ['brace_ns', [RP_C]],
    ['brace_qualified', ['a.h:Config.m']],
    ['field_qualified', ['a.h:Config.m']],
  ])('qualified brace-init and member field: %s -> %j', (caller, expected) => {
    expect(memberTargets(caller)).toEqual(expected);
  });
});
