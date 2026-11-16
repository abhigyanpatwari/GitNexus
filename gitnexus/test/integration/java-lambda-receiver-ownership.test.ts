import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { getRelationships, runPipelineFromRepo, writeFixtureRepo } from './resolvers/helpers.js';

it('keeps typed, unknown, sibling and nested lambda receivers in their lexical scopes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-java-lambda-ownership-'));
  try {
    writeFixtureRepo(root, {
      'Main.java': `class User { void save() {} void audit() {} }
class Other { void save() {} }
class App {
  User x; User y;
  void accept(Object callback) {}
  void own() {}
  void sibling() {
    accept((User x) -> x.save());
    accept((Other x) -> { x.save(); });
  }
  void unknown() { accept(x -> x.audit()); }
  void unknownList() { accept((x, y) -> x.audit()); }
  void nested() { accept((User outer) -> { accept(y -> y.audit()); outer.save(); }); }
  void lexicalThis() { accept(x -> this.own()); }
  void afterLambda() { accept((Other x) -> x.save()); x.audit(); }
}
`,
    });
    const result = await runPipelineFromRepo(root, () => {}, {});
    const targets = (caller: string, member: string) =>
      getRelationships(result, 'CALLS')
        .filter(
          (edge) =>
            edge.rel.sourceId === `Method:Main.java:App.${caller}#0` && edge.target === member,
        )
        .map((edge) => edge.rel.targetId)
        .sort();
    expect(targets('sibling', 'save')).toEqual([
      'Method:Main.java:Other.save#0',
      'Method:Main.java:User.save#0',
    ]);
    expect(targets('unknown', 'audit')).toEqual([]);
    expect(targets('unknownList', 'audit')).toEqual([]);
    expect(targets('nested', 'audit')).toEqual([]);
    expect(targets('nested', 'save')).toEqual(['Method:Main.java:User.save#0']);
    expect(targets('lexicalThis', 'own')).toEqual(['Method:Main.java:App.own#0']);
    expect(targets('afterLambda', 'audit')).toEqual(['Method:Main.java:User.audit#0']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 120000);
