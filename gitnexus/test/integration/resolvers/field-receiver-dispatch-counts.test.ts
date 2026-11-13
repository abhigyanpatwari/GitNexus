/**
 * Edge accounting for interface dispatch through a FIELD receiver (#2834).
 *
 * `this.repo.save(u)` is a dotted receiver, so it takes Case 0 in
 * `receiver-bound-calls.ts`; `r.save(u)` on a parameter is a bare name and
 * takes Case 4. #2829 gave Case 0 the fan-out and subtype closure Case 4
 * already had, and `generic-field-receiver-matrix.test.ts` pins that a field
 * receiver reaches its implementors. It compares targets as a set with one
 * implementor and one call site, so it cannot see two things this file pins:
 *
 *   - the closure: an implementor reached through a sub-interface and one
 *     reached through an abstract base, next to two direct implementors;
 *   - the count: two calls through the same receiver in one caller. Java and
 *     C# set `collapseMemberCallsByCallerTarget`, so they emit one edge per
 *     (caller, target); TypeScript and Kotlin emit one per call site.
 *
 * The collapse flag is per language provider, so each language gets its own
 * fixture. Every type lives in its own file, so a target is named by the file
 * it landed in: the five `save` methods share a name.
 *
 * The parameter caller is the Case 4 control. Its targets must equal the field
 * caller's, which is the Case 0 / Case 4 asymmetry #2813 was filed for.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'path';
import fs from 'node:fs';
import os from 'node:os';
import {
  getRelationships,
  runPipelineFromRepo,
  writeFixtureRepo,
  type PipelineResult,
} from './helpers.js';

interface Fixture {
  language: string;
  files: Record<string, string>;
  /** Files the interface method and its implementations are declared in. */
  targets: string[];
  /** CALLS edges per target for two calls in one caller. */
  edgesPerTarget: 1 | 2;
}

const FIXTURES: Fixture[] = [
  {
    language: 'Java',
    files: {
      'Repo.java': `package probe;
        public interface Repo { void save(String u); }`,
      'SubRepo.java': `package probe;
        public interface SubRepo extends Repo {}`,
      'BaseRepo.java': `package probe;
        public abstract class BaseRepo implements Repo {}`,
      'UserRepo.java': `package probe;
        public class UserRepo implements Repo { public void save(String u) {} }`,
      'MockRepo.java': `package probe;
        public class MockRepo implements Repo { public void save(String u) {} }`,
      'SubImpl.java': `package probe;
        public class SubImpl implements SubRepo { public void save(String u) {} }`,
      'BaseImpl.java': `package probe;
        public class BaseImpl extends BaseRepo { public void save(String u) {} }`,
      'Service.java': `package probe;
        public class Service {
          private Repo repo;
          public void runField(String u) { this.repo.save(u); this.repo.save(u); }
          public void runParam(Repo r, String u) { r.save(u); r.save(u); }
        }`,
    },
    targets: ['BaseImpl.java', 'MockRepo.java', 'Repo.java', 'SubImpl.java', 'UserRepo.java'],
    edgesPerTarget: 1,
  },
  {
    language: 'C#',
    files: {
      'IRepo.cs': `namespace Probe;
        public interface IRepo { void Save(string u); }`,
      'ISubRepo.cs': `namespace Probe;
        public interface ISubRepo : IRepo {}`,
      'BaseRepo.cs': `namespace Probe;
        public abstract class BaseRepo : IRepo { public abstract void Save(string u); }`,
      'UserRepo.cs': `namespace Probe;
        public class UserRepo : IRepo { public void Save(string u) {} }`,
      'MockRepo.cs': `namespace Probe;
        public class MockRepo : IRepo { public void Save(string u) {} }`,
      'SubImpl.cs': `namespace Probe;
        public class SubImpl : ISubRepo { public void Save(string u) {} }`,
      'BaseImpl.cs': `namespace Probe;
        public class BaseImpl : BaseRepo { public override void Save(string u) {} }`,
      'Service.cs': `namespace Probe;
        public class Service {
          private IRepo repo;
          public void RunField(string u) { this.repo.Save(u); this.repo.Save(u); }
          public void RunParam(IRepo r, string u) { r.Save(u); r.Save(u); }
        }`,
    },
    targets: ['BaseImpl.cs', 'IRepo.cs', 'MockRepo.cs', 'SubImpl.cs', 'UserRepo.cs'],
    edgesPerTarget: 1,
  },
  {
    language: 'TypeScript',
    files: {
      'repo.ts': `export interface Repo { save(u: string): void; }`,
      'sub-repo.ts': `import { Repo } from './repo';
        export interface SubRepo extends Repo {}`,
      'base-repo.ts': `import { Repo } from './repo';
        export abstract class BaseRepo implements Repo { abstract save(u: string): void; }`,
      'user-repo.ts': `import { Repo } from './repo';
        export class UserRepo implements Repo { save(u: string): void {} }`,
      'mock-repo.ts': `import { Repo } from './repo';
        export class MockRepo implements Repo { save(u: string): void {} }`,
      'sub-impl.ts': `import { SubRepo } from './sub-repo';
        export class SubImpl implements SubRepo { save(u: string): void {} }`,
      'base-impl.ts': `import { BaseRepo } from './base-repo';
        export class BaseImpl extends BaseRepo { save(u: string): void {} }`,
      'service.ts': `import { Repo } from './repo';
        export class Service {
          private repo: Repo;
          constructor(repo: Repo) { this.repo = repo; }
          runField(u: string): void { this.repo.save(u); this.repo.save(u); }
          runParam(r: Repo, u: string): void { r.save(u); r.save(u); }
        }`,
    },
    targets: ['base-impl.ts', 'mock-repo.ts', 'repo.ts', 'sub-impl.ts', 'user-repo.ts'],
    edgesPerTarget: 2,
  },
  {
    language: 'Kotlin',
    files: {
      'Repo.kt': `package probe
        interface Repo { fun save(u: String) }`,
      'SubRepo.kt': `package probe
        interface SubRepo : Repo`,
      'BaseRepo.kt': `package probe
        abstract class BaseRepo : Repo`,
      'UserRepo.kt': `package probe
        class UserRepo : Repo { override fun save(u: String) {} }`,
      'MockRepo.kt': `package probe
        class MockRepo : Repo { override fun save(u: String) {} }`,
      'SubImpl.kt': `package probe
        class SubImpl : SubRepo { override fun save(u: String) {} }`,
      'BaseImpl.kt': `package probe
        class BaseImpl : BaseRepo() { override fun save(u: String) {} }`,
      'Service.kt': `package probe
        class Service(private val repo: Repo) {
          fun runField(u: String) { this.repo.save(u); this.repo.save(u) }
          fun runParam(r: Repo, u: String) { r.save(u); r.save(u) }
        }`,
    },
    targets: ['BaseImpl.kt', 'MockRepo.kt', 'Repo.kt', 'SubImpl.kt', 'UserRepo.kt'],
    edgesPerTarget: 2,
  },
];

/** Target file of every CALLS edge out of `caller` to the save method, with
 *  multiplicity, sorted. Deliberately not a set: the count is under test. */
function saveTargets(result: PipelineResult, caller: string): string[] {
  return getRelationships(result, 'CALLS')
    .filter((edge) => edge.source === caller && edge.target.toLowerCase() === 'save')
    .map((edge) => path.basename(edge.targetFilePath))
    .sort();
}

for (const fixture of FIXTURES) {
  const fieldCaller = fixture.language === 'C#' ? 'RunField' : 'runField';
  const paramCaller = fixture.language === 'C#' ? 'RunParam' : 'runParam';
  const expected = fixture.targets.flatMap((file) =>
    Array.from({ length: fixture.edgesPerTarget }, () => file),
  );

  describe(`${fixture.language} interface dispatch through a field receiver (#2834)`, () => {
    let result: PipelineResult;
    let root: string;

    beforeAll(async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-field-dispatch-counts-'));
      writeFixtureRepo(root, fixture.files);
      result = await runPipelineFromRepo(root, () => {});
    }, 120000);

    afterAll(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('reaches the declaration and every implementor, with the expected edge count', () => {
      expect(saveTargets(result, fieldCaller)).toEqual(expected);
    });

    it('gives the parameter receiver the same edges as the field receiver', () => {
      expect(saveTargets(result, paramCaller)).toEqual(saveTargets(result, fieldCaller));
    });
  });
}
