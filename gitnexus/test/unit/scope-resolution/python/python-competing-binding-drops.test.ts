/**
 * A competing-binding barrier withholds the CALLS edge on purpose (see
 * `conflicting_try_imports` in python-local-imports.test.ts), but the dropped
 * site must still be recorded so `impact()` can report a lower bound instead
 * of a confident zero that reads like an unused function.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getRelationships,
  getResolutionOutcomes,
  runPipelineFromRepo,
  writeFixtureRepo,
  type PipelineResult,
} from '../../../integration/resolvers/helpers.js';

const COMPETING_BINDING_FIXTURES = {
  none_fallback: `try:
    from pkg.fast import speedy
except ImportError:
    speedy = None

def run():
    return speedy()
`,
  import_fallback: `try:
    from pkg.fast import speedy
except ImportError:
    from pkg.slow import speedy

def run():
    return speedy()
`,
  def_fallback: `try:
    from pkg.fast import speedy
except ImportError:
    def speedy():
        return 0

def run():
    return speedy()
`,
} as const;

/** An aliased import binds the local spelling to another source name; the drop
 *  must be recorded under the source name(s) so `impact` on them sees it. */
const ALIASED_FIXTURES = {
  alias_none_fallback: {
    source: `try:
    from pkg.fast import speedy as fast_impl
except ImportError:
    fast_impl = None

def run():
    return fast_impl()
`,
    names: ['fast_impl', 'speedy'],
  },
  alias_two_targets: {
    source: `try:
    from pkg.fast import speedy as fast_impl
except ImportError:
    from pkg.slow import slowpoke as fast_impl

def run():
    return fast_impl()
`,
    names: ['fast_impl', 'slowpoke', 'speedy'],
  },
} as const;

const PLAIN_IMPORT_FIXTURE = `from pkg.fast import speedy

def run():
    return speedy()
`;

const PACKAGE_FILES = {
  'pkg/__init__.py': '',
  'pkg/fast.py': 'def speedy():\n    return 1\n',
  'pkg/slow.py': 'def speedy():\n    return 2\n\ndef slowpoke():\n    return 3\n',
};

describe('Python competing-binding barrier drops', () => {
  let repoDir: string;
  let result: PipelineResult;

  beforeAll(async () => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-python-competing-binding-'));
    writeFixtureRepo(repoDir, {
      ...PACKAGE_FILES,
      ...Object.fromEntries(
        Object.entries(COMPETING_BINDING_FIXTURES).map(([name, source]) => [`${name}.py`, source]),
      ),
      ...Object.fromEntries(
        Object.entries(ALIASED_FIXTURES).map(([name, { source }]) => [`${name}.py`, source]),
      ),
      'plain_import.py': PLAIN_IMPORT_FIXTURE,
    });
    result = await runPipelineFromRepo(repoDir, () => {}, { skipGraphPhases: true });
  }, 60000);

  afterAll(() => {
    if (repoDir) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  const speedyCalls = (filePath: string) =>
    getRelationships(result, 'CALLS').filter(
      (edge) => edge.target === 'speedy' && edge.sourceFilePath === filePath,
    );
  const barrierDrops = (filePath: string) =>
    getResolutionOutcomes(result).filter(
      (outcome) =>
        outcome.kind === 'suppressed' &&
        outcome.reason === 'competing-binding-barrier' &&
        outcome.filePath === filePath,
    );

  it.each(Object.keys(COMPETING_BINDING_FIXTURES))(
    'keeps the barrier and records the dropped call in %s',
    (name) => {
      const filePath = `${name}.py`;
      expect(speedyCalls(filePath)).toEqual([]);
      expect(barrierDrops(filePath)).toMatchObject([
        { name: 'speedy', siteKind: 'call', phase: 'free-call-fallback' },
      ]);
    },
  );

  it.each(Object.entries(ALIASED_FIXTURES))(
    'records the dropped aliased call under its source names in %s',
    (name, { names }) => {
      const filePath = `${name}.py`;
      const drops = barrierDrops(filePath);
      expect(drops.map((outcome) => outcome.name).sort()).toEqual([...names]);
      // One call site, recorded once per name.
      expect(new Set(drops.map((outcome) => JSON.stringify(outcome.range))).size).toBe(1);
    },
  );

  it('records nothing for a plain import that resolves', () => {
    expect(speedyCalls('plain_import.py').map((edge) => edge.rel.targetId)).toEqual([
      'Function:pkg/fast.py:speedy',
    ]);
    expect(barrierDrops('plain_import.py')).toEqual([]);
  });
});
