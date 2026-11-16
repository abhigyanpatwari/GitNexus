import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { getRelationships, runPipelineFromRepo, writeFixtureRepo } from './resolvers/helpers.js';

it('binds resources through the try body without leaking into handlers or later statements', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-java-resource-ownership-'));
  try {
    writeFixtureRepo(root, {
      'Main.java': `class Resource implements AutoCloseable {
  public void close() {}
  void inside() {} void caught() {} void finalized() {} void after() {} void save() {}
  Resource next() { return new Resource(); }
}
class Field {
  void inside() {} void caught() {} void finalized() {} void after() {} void save() {}
  Resource next() { return new Resource(); }
}
class App {
  Field r;
  Resource open() { return new Resource(); }
  void boundaries() {
    try (Resource r = open()) { r.inside(); }
    catch (Exception e) { r.caught(); }
    finally { r.finalized(); }
    r.after();
  }
  void constructed() { try (var r = new Resource()) { r.save(); } }
  void selectedCall() { try (var r = open()) { r.save(); } }
  void successive() { try (Resource r = open(); var q = r.next()) { q.save(); } }
  void existing(Resource r) { try (r) { r.save(); } r.after(); }
  void invalidSelfRead() { try (Resource r = r.next()) { } }
}
`,
    });
    const result = await runPipelineFromRepo(root, () => {}, {});
    const targets = (caller: string, member: string) =>
      getRelationships(result, 'CALLS')
        .filter(
          (edge) =>
            edge.rel.sourceId ===
              `Method:Main.java:App.${caller}#${caller === 'existing' ? 1 : 0}` &&
            edge.target === member,
        )
        .map((edge) => edge.rel.targetId)
        .sort();
    expect(targets('boundaries', 'inside')).toEqual(['Method:Main.java:Resource.inside#0']);
    for (const member of ['caught', 'finalized', 'after']) {
      expect(targets('boundaries', member)).toEqual([`Method:Main.java:Field.${member}#0`]);
    }
    for (const caller of ['constructed', 'selectedCall', 'successive', 'existing']) {
      expect(targets(caller, 'save')).toEqual(['Method:Main.java:Resource.save#0']);
    }
    expect(targets('existing', 'after')).toEqual(['Method:Main.java:Resource.after#0']);
    // Definite assignment is outside ingestion's contract; the self-read
    // belongs to the new local, typed `Resource`, and must never reconnect the
    // enclosing field.
    expect(targets('invalidSelfRead', 'next')).toEqual(['Method:Main.java:Resource.next#0']);
    expect(targets('successive', 'next')).toEqual(['Method:Main.java:Resource.next#0']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 120000);
