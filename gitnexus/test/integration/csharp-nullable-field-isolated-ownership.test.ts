import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getRelationships,
  getResolutionOutcomes,
  runPipelineFromRepo,
  writeFixtureRepo,
} from './resolvers/helpers.js';

describe('C# nullable field isolated owner boundary', () => {
  it.each([
    ['external qualified owner', 'External.User?', '', false],
    ['local nullable owner', 'User?', '', true],
    [
      'workspace qualified owner remains unsupported',
      'Actual.User?',
      'namespace Actual { public class User { public void Save() {} } }',
      false,
    ],
  ] as const)(
    '%s',
    async (_label, type, qualifiedDefinition, expected) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-csharp-isolated-owner-'));
      try {
        writeFixtureRepo(root, {
          'Models.cs': `${qualifiedDefinition}
public class User { public void Save() {} }
public class Decoy { public void Save() {} }
public class Host { private ${type} repo; public void Probe() { this.repo.Save(); } }
`,
        });
        const result = await runPipelineFromRepo(root, () => {}, {});
        const calls = getRelationships(result, 'CALLS').filter(
          (e) => e.source === 'Probe' && e.target === 'Save',
        );
        expect(calls).toHaveLength(expected ? 1 : 0);
        if (expected) expect(calls[0]!.rel.targetId).toContain('User.Save');
        else
          expect(
            getResolutionOutcomes(result).some(
              (outcome) =>
                outcome.kind === 'suppressed' &&
                outcome.name === 'Save' &&
                outcome.reason === 'receiver-unresolved',
            ),
          ).toBe(true);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    120000,
  );
});
