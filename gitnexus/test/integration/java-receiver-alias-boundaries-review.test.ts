import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { getRelationships, runPipelineFromRepo, writeFixtureRepo } from './resolvers/helpers.js';

it('preserves Java assigned factory results and their local aliases', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-java-factory-alias-'));
  try {
    writeFixtureRepo(root, {
      'Main.java': `class User { void save() {} }
class Service { User getUser() { return new User(); } }
class App {
  void probeBound(Service svc) { var u = svc.getUser(); u.save(); }
  void probeAlias(Service svc) { var u = svc.getUser(); var copy = u; copy.save(); }
}
`,
    });
    const result = await runPipelineFromRepo(root, () => {}, {});
    for (const caller of ['probeBound', 'probeAlias']) {
      const calls = getRelationships(result, 'CALLS').filter(
        (edge) => edge.source === caller && edge.target === 'save',
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]!.rel.targetId).toContain('User.save');
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 120000);
