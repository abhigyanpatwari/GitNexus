/**
 * C: struct + include-based imports + function calls across files
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES,
  getRelationships,
  getNodesByLabel,
  edgeSet,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';

// ---------------------------------------------------------------------------
// C structs + include-based imports + cross-file function calls
// ---------------------------------------------------------------------------

describe('C struct & include resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'c-structs'), () => {});
  }, 60000);

  it('detects User and Service structs', () => {
    const structs = getNodesByLabel(result, 'Struct');
    expect(structs).toContain('User');
    expect(structs).toContain('Service');
  });

  it('detects functions across all files', () => {
    const fns = getNodesByLabel(result, 'Function');
    expect(fns).toContain('main');
    expect(fns).toContain('create_user');
    expect(fns).toContain('free_user');
    expect(fns).toContain('get_user_age');
    expect(fns).toContain('create_service');
    expect(fns).toContain('service_add_user');
    expect(fns).toContain('destroy_service');
  });

  it('resolves #include imports between .c and .h files', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const edges = edgeSet(imports);
    // user.c includes user.h
    expect(edges).toContain('user.c → user.h');
    // service.h includes user.h
    expect(edges).toContain('service.h → user.h');
    // service.c includes service.h
    expect(edges).toContain('service.c → service.h');
    // main.c includes service.h
    expect(edges).toContain('main.c → service.h');
  });

  it('emits CALLS edges for cross-file function calls', () => {
    const calls = getRelationships(result, 'CALLS');
    const edges = edgeSet(calls);
    // main.c calls functions from service
    expect(edges).toContain('main → create_service');
    expect(edges).toContain('main → service_add_user');
    expect(edges).toContain('main → destroy_service');
    // service.c calls functions from user
    expect(edges).toContain('service_add_user → create_user');
    expect(edges).toContain('service_add_user → free_user');
    expect(edges).toContain('destroy_service → free_user');
  });
});

// ---------------------------------------------------------------------------
// C static function isolation — static functions must NOT leak across files
// ---------------------------------------------------------------------------

describe('C static function isolation', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'c-static-isolation'), () => {});
  }, 60000);

  it('detects both static and non-static helper functions', () => {
    const fns = getNodesByLabel(result, 'Function');
    expect(fns).toContain('helper');
    expect(fns).toContain('public_a');
    expect(fns).toContain('public_b');
    expect(fns).toContain('main');
  });

  it('caller.c calls b:helper via include, NOT a:static helper', () => {
    const calls = getRelationships(result, 'CALLS');
    const edges = edgeSet(calls);

    // caller.c should call public_b (included via b.h)
    expect(edges).toContain('main → public_b');

    // a.c's static helper calls itself locally
    expect(edges).toContain('public_a → helper');

    // caller.c should NOT have a CALLS edge to a.c's static helper.
    // Filter edges to only those originating from main → helper to
    // verify the correct target file.
    const mainToHelper = calls.filter((r) => r.source === 'main' && r.target === 'helper');
    // If a main→helper edge exists, it should point to b.c, not a.c
    for (const edge of mainToHelper) {
      expect(edge.targetFilePath).not.toContain('a.c');
    }
  });
});

// ---------------------------------------------------------------------------
// C static-linkage survives the worker→main boundary (#1983 / worker-only path)
//
// The worker pool is now the SOLE parse path. C `static`-linkage is tracked in
// a module-level map populated by `emitCScopeCaptures` INSIDE the worker
// (`markStaticName`). Without the capture side-channel, that map is lost across
// the MessageChannel and the main-thread `isStaticName` reads empty, so a
// file-local `static` function becomes eligible for cross-file global free-call
// resolution — a FALSE CALLS edge.
//
// This fixture isolates that leak (which `c-static-isolation` above does NOT
// exercise — there the colliding name resolves via `#include` before the global
// fallback runs). Here `caller.c` calls `compute()` with no include of
// `local.c`; the only legitimate cross-file target is `lib.c`'s free `compute`.
// `local.c`'s `static compute` MUST stay file-local.
//
// Without the c-cpp.ts `collectCaptureSideChannel` + c/scope-resolver.ts
// `applyCaptureSideChannel` wiring, this test fails: `caller_entry` resolves to
// `compute@local.c`.
// ---------------------------------------------------------------------------

describe('C static-linkage survives the worker→main boundary (#1983)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'c-static-linkage-worker'), () => {});
  }, 60000);

  it('parses via the worker pool (the path the side-channel covers)', () => {
    expect(result.usedWorkerPool).toBe(true);
  });

  it('does NOT emit a cross-file CALLS edge to the file-local static compute', () => {
    const calls = getRelationships(result, 'CALLS');

    // The caller's `compute()` must resolve to lib.c's free function, never to
    // local.c's `static` (file-local) one.
    const callerToCompute = calls.filter(
      (r) => r.source === 'caller_entry' && r.target === 'compute',
    );
    // The free `compute` in lib.c is the only valid cross-file target.
    expect(callerToCompute.length).toBeGreaterThan(0);
    for (const edge of callerToCompute) {
      expect(edge.targetFilePath).toContain('lib.c');
      expect(edge.targetFilePath).not.toContain('local.c');
    }

    // Belt-and-suspenders: NO edge anywhere may reach local.c's static compute
    // from outside local.c (the intra-file local_entry → compute call is fine).
    const leakedToStatic = calls.filter(
      (r) =>
        r.target === 'compute' &&
        r.targetFilePath.includes('local.c') &&
        !r.sourceFilePath.includes('local.c'),
    );
    expect(leakedToStatic).toEqual([]);
  });
});
