import { it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFixtureRepo, runPipelineFromRepo, getRelationships } from './resolvers/helpers.js';
const fixtures = [
  [
    'models.ts',
    `class User { save(): void {} }
class Admin extends User { override save(): void {} }
class Base { find(id: number): User { return new User(); } }
class Child extends Base { override find(id: number): Admin { return new Admin(); } }
function probe(svc: Child) { svc.find(1).save(); }
function probe_bound(svc: Child) { const user = svc.find(1); user.save(); }
`,
  ],
  [
    'models.py',
    `class User:
    def save(self): pass
class Admin(User):
    def save(self): pass
class Base:
    def find(self, id: int) -> User: return User()
class Child(Base):
    def find(self, id: int) -> Admin: return Admin()
def probe(svc: Child):
    svc.find(1).save()
def probe_bound(svc: Child):
    user = svc.find(1)
    user.save()
`,
  ],
] as const;
it.each(fixtures)(
  '%s keeps parameterized override receivers outside the owner opt-in',
  async (file, source) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hoisted-opt-in-'));
    try {
      writeFixtureRepo(root, { [file]: source });
      const r = await runPipelineFromRepo(root, () => {});
      for (const caller of ['probe', 'probe_bound']) {
        const targets = getRelationships(r, 'CALLS')
          .filter((e) => e.source === caller && e.target === 'save')
          .map((e) => e.rel.targetId)
          .sort();
        expect(targets).toHaveLength(1);
        expect(targets[0]).toMatch(/:Admin\.save(?:#\d+)?$/);
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  180000,
);
