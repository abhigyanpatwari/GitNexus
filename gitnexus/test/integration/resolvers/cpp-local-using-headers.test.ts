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

describe('C++ namespace using visibility through literal includes', () => {
  let repoDir: string;
  let result: PipelineResult;
  beforeAll(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-cpp-using-headers-'));
    writeFixtureRepo(repoDir, {
      'definitions.hpp': `namespace helpers {
int work() { return 1; }
struct Worker { int run() { return 1; } };
}
`,
      'named.hpp': '#include "definitions.hpp"\nusing helpers::work;\nusing helpers::Worker;\n',
      'forwarded.hpp': '#include "named.hpp"\n',
      'directive.hpp': '#include "definitions.hpp"\nusing namespace helpers;\n',
      'named.cpp':
        '#include "named.hpp"\nint from_named() { return work(); }\nint from_type() { Worker w; return w.run(); }\n',
      'forwarded.cpp': '#include "forwarded.hpp"\nint from_forwarded() { return work(); }\n',
      'directive.cpp': '#include "directive.hpp"\nint from_directive() { return work(); }\n',
      'before.cpp': 'int before_include() { return work(); }\n#include "named.hpp"\n',
    });
    result = await runPipelineFromRepo(repoDir, () => {});
  }, 60_000);
  afterAll(() => {
    if (repoDir !== undefined) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it.each(['from_named', 'from_forwarded', 'from_directive'])(
    'resolves %s through the included namespace using',
    (caller) => {
      const calls = getRelationships(result, 'CALLS').filter((edge) => edge.source === caller);
      expect(calls.map((edge) => [edge.target, edge.targetFilePath])).toEqual([
        ['work', 'definitions.hpp'],
      ]);
      expect(calls.every((edge) => edge.rel.reason !== 'global-name-fallback')).toBe(true);
    },
  );
  it('retains the imported class identity', () => {
    const calls = getRelationships(result, 'CALLS').filter(
      (edge) => edge.source === 'from_type' && edge.target === 'run',
    );
    expect(calls.map((edge) => edge.targetFilePath)).toEqual(['definitions.hpp']);
    expect(calls.every((edge) => edge.rel.reason !== 'global-name-fallback')).toBe(true);
  });
  it('does not make a later include visible in an earlier function definition', () => {
    expect(
      getRelationships(result, 'CALLS').filter((edge) => edge.source === 'before_include'),
    ).toEqual([]);
  });
});

describe('C++ unresolved named using through a literal include', () => {
  let repoDir: string;
  let result: PipelineResult;
  beforeAll(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-cpp-unresolved-using-header-'));
    writeFixtureRepo(repoDir, {
      'unresolved.hpp': 'using absent::work;\n',
      'caller.cpp': '#include "unresolved.hpp"\nint from_unresolved_header() { return work(); }\n',
      'forwarded.hpp': '#include "unresolved.hpp"\n',
      'forwarded.cpp':
        '#include "forwarded.hpp"\nint from_forwarded_unresolved_header() { return work(); }\n',
      'missing-export.hpp': 'namespace present {}\nusing present::work;\n',
      'missing-export.cpp':
        '#include "missing-export.hpp"\nint from_missing_export_header() { return work(); }\n',
      'before.cpp':
        'int before_unresolved_include() { return work(); }\n#include "unresolved.hpp"\n',
      'local-before.hpp': 'using absent::local_work;\n',
      'local-before.cpp':
        'int local_work() { return 1; }\nint before_local_unresolved_include() { return local_work(); }\n#include "local-before.hpp"\nint after_local_unresolved_include() { return local_work(); }\n',
      'unrelated.cpp': 'int work() { return 9; }\n',
    });
    result = await runPipelineFromRepo(repoDir, () => {});
  }, 60_000);
  afterAll(() => {
    if (repoDir !== undefined) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('does not fall back to an unrelated workspace function after including an unresolved named using', () => {
    expect(
      getRelationships(result, 'CALLS').filter((edge) => edge.source === 'from_unresolved_header'),
    ).toEqual([]);
  });
  it.each([
    'from_forwarded_unresolved_header',
    'from_missing_export_header',
    'after_local_unresolved_include',
  ])('preserves the unresolved header claim in %s', (caller) => {
    expect(getRelationships(result, 'CALLS').filter((edge) => edge.source === caller)).toEqual([]);
  });
  it('keeps global fallback available before an unresolved header include', () => {
    const calls = getRelationships(result, 'CALLS').filter(
      (edge) => edge.source === 'before_unresolved_include',
    );
    expect(calls.map((edge) => [edge.target, edge.targetFilePath, edge.rel.reason])).toEqual([
      ['work', 'unrelated.cpp', 'global-name-fallback'],
    ]);
  });
  it('retains the local declaration before an unresolved header include', () => {
    const calls = getRelationships(result, 'CALLS').filter(
      (edge) => edge.source === 'before_local_unresolved_include',
    );
    expect(calls.map((edge) => [edge.target, edge.targetFilePath])).toEqual([
      ['local_work', 'local-before.cpp'],
    ]);
  });
});

describe('C++ included and local overload identity', () => {
  let repoDir: string;
  let result: PipelineResult;
  beforeAll(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-cpp-include-overloads-'));
    writeFixtureRepo(repoDir, {
      'overloads.hpp': 'int choose(int value);\n',
      'main.cpp':
        '#include "overloads.hpp"\nint choose(double value) { return 2; }\nint choose_integer() { return choose(1); }\nint choose_double() { return choose(1.5); }\n',
    });
    result = await runPipelineFromRepo(repoDir, () => {});
  }, 60_000);
  afterAll(() => {
    if (repoDir !== undefined) fs.rmSync(repoDir, { recursive: true, force: true });
  });
  it('keeps a distinct included overload beside the local definition', () => {
    const calls = getRelationships(result, 'CALLS').filter(
      (edge) => edge.source === 'choose_integer',
    );
    expect(calls.map((edge) => [edge.target, edge.targetFilePath])).toEqual([
      ['choose', 'overloads.hpp'],
    ]);
    expect(result.graph.getNode(calls[0].rel.targetId)?.properties.parameterTypes).toEqual(['int']);
  });
  it('selects the local overload for its matching argument', () => {
    const calls = getRelationships(result, 'CALLS').filter(
      (edge) => edge.source === 'choose_double',
    );
    expect(calls.map((edge) => [edge.target, edge.targetFilePath])).toEqual([
      ['choose', 'main.cpp'],
    ]);
    expect(result.graph.getNode(calls[0].rel.targetId)?.properties.parameterTypes).toEqual([
      'double',
    ]);
  });
});
