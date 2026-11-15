/**
 * C++ receiver typing through qualified type spellings, header prototypes and
 * qualified factory callees.
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
const D = 'mod.h:D.m';

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
    ['declared_ns', [RP_C]],
    ['declared_ns_ptr', [RP_C]],
  ])('qualified declaration without initializer: %s -> %j', (caller, expected) => {
    expect(memberTargets(caller)).toEqual(expected);
  });

  it.each<[string, string[]]>([
    ['brace_ns', [RP_C]],
    ['brace_qualified', ['a.h:Config.m']],
    ['field_qualified', ['a.h:Config.m']],
  ])('qualified brace-init and member field: %s -> %j', (caller, expected) => {
    expect(memberTargets(caller)).toEqual(expected);
  });

  it.each<[string, string[]]>([
    ['auto_plain', [D]],
    ['inline_plain', [D]],
    ['auto_ptr', [D]],
    ['global_factory', [GLOBAL_C]],
    // A namespace prototype's return type is looked up inside its namespace,
    // never from the file's module scope where the global Widget sits.
    ['using_auto', [RP_C]],
    ['using_same_file', ['mod.h:Widget.m']],
    // The block-scope `E y();` in `vexing` must not hoist a file-level `y`.
    ['uses_vexing_name', []],
  ])('header prototype return type: %s -> %j', (caller, expected) => {
    expect(memberTargets(caller)).toEqual(expected);
  });

  it.each<[string, string[]]>([
    ['using_inline', [RP_C]],
    ['using_inline_same_file', ['mod.h:Widget.m']],
  ])('inline call receiver typed by definition identity: %s -> %j', (caller, expected) => {
    expect(memberTargets(caller)).toEqual(expected);
  });

  it.each<[string, string[]]>([
    ['auto_ns', [RP_C]],
    ['inline_ns', [RP_C]],
    ['ctor_ns', [RP_C]],
    // An unknown qualified factory types nothing, and the inner `x` must not
    // fall through to the outer `D x`.
    ['shadowed_auto', []],
  ])('qualified factory callee: %s -> %j', (caller, expected) => {
    expect(memberTargets(caller)).toEqual(expected);
  });
});
