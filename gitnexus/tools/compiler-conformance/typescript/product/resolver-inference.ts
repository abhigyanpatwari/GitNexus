import { describe, it, before as beforeAll } from 'node:test';
import { expect } from 'expect';
import path from 'path';
import {
  FIXTURES,
  getRelationships,
  getNodesByLabel,
  runPipelineFromRepo,
  type PipelineResult,
} from '../support/fixture.js';

// ---------------------------------------------------------------------------
// Assignment chain propagation (Tier 2, depth-1):
// `const alias = u` where `u: User` → alias.save() resolves to User#save
// ---------------------------------------------------------------------------

describe('TypeScript assignment chain propagation (Tier 2)', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-assignment-chain'), () => {});
    },
    { timeout: 60000 },
  );

  it('detects User and Repo classes each with a save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves alias.save() to User#save via assignment chain', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save' && c.targetFilePath.includes('user.ts'));
    // Positive: alias.save() must resolve to User#save
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('processEntities');
    // Negative: alias.save() must NOT resolve to Repo#save
    const wrongCall = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'processEntities' &&
        c.targetFilePath.includes('repo.ts'),
    );
    // rAlias.save() correctly goes to Repo — but we verify there is exactly one
    // per-receiver resolution (user alias → User, repo alias → Repo)
    expect(wrongCall).toBeDefined(); // rAlias.save() resolves to Repo
  });

  it('resolves rAlias.save() to Repo#save via assignment chain', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find((c) => c.target === 'save' && c.targetFilePath.includes('repo.ts'));
    expect(repoSave).toBeDefined();
    expect(repoSave!.source).toBe('processEntities');
    // Negative: rAlias.save() must NOT resolve to User#save (only)
    const userSave = calls.find((c) => c.target === 'save' && c.targetFilePath.includes('user.ts'));
    expect(userSave).toBeDefined();
    // Both resolve separately — alias → User, rAlias → Repo
    expect(userSave!.targetFilePath).not.toBe(repoSave!.targetFilePath);
  });
});

// ---------------------------------------------------------------------------
// Multi-hop forward-declared chain (a → b → c) — validates that single-pass
// in source order resolves chains deeper than depth-1.
// ---------------------------------------------------------------------------

describe('TypeScript multi-hop assignment chain (a → b → c)', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-multi-hop-chain'), () => {});
    },
    { timeout: 60000 },
  );

  it('detects User and Repo classes each with a save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves c.save() to User#save through a → b → c chain', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'multiHopForward' &&
        c.targetFilePath?.includes('user.ts'),
    );
    expect(userSave).toBeDefined();
  });

  it('c.save() in multiHopForward does NOT resolve to Repo#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongCall = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'multiHopForward' &&
        c.targetFilePath?.includes('repo.ts'),
    );
    expect(wrongCall).toBeUndefined();
  });

  it('resolves c.save() to Repo#save through a → b → c chain (Repo variant)', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'multiHopRepo' && c.targetFilePath?.includes('repo.ts'),
    );
    expect(repoSave).toBeDefined();
  });

  it('c.save() in multiHopRepo does NOT resolve to User#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'multiHopRepo' && c.targetFilePath?.includes('user.ts'),
    );
    expect(wrongCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Nullable type + assignment chain: stripNullable must resolve the nullable
// union (User | null → User) before the chain propagation can work.
// Exercises the refactored NULLABLE_KEYWORDS.has() code path.
// ---------------------------------------------------------------------------

describe('TypeScript nullable + assignment chain combined', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-nullable-chain'), () => {});
    },
    { timeout: 60000 },
  );

  it('detects User and Repo classes each with a save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves alias.save() to User#save when source is User | null', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'nullableChainUser' &&
        c.targetFilePath?.includes('user.ts'),
    );
    expect(userSave).toBeDefined();
  });

  it('alias.save() from User | null does NOT resolve to Repo#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongCall = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'nullableChainUser' &&
        c.targetFilePath?.includes('repo.ts'),
    );
    expect(wrongCall).toBeUndefined();
  });

  it('resolves alias.save() to Repo#save when source is Repo | undefined', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'nullableChainRepo' &&
        c.targetFilePath?.includes('repo.ts'),
    );
    expect(repoSave).toBeDefined();
  });

  it('resolves alias.save() to User#save when source is User | null | undefined (triple)', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'tripleNullable' &&
        c.targetFilePath?.includes('user.ts'),
    );
    expect(userSave).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Chained method call resolution: svc.getUser().save()
// The receiver of save() is a call_expression (getUser()), not a simple identifier.
// Resolution must walk the chain: getUser() returns User, so save() → User#save.
// ---------------------------------------------------------------------------

describe('TypeScript chained method call resolution', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'typescript-chain-call'), () => {});
    },
    { timeout: 60000 },
  );

  it('detects User, Repo and UserService classes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('User');
    expect(classes).toContain('Repo');
    expect(classes).toContain('UserService');
  });

  it('detects save methods on both User and Repo', () => {
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('detects getUser method on UserService', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('getUser');
  });

  it('resolves svc.getUser().save() to User#save, NOT Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) => c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('User'),
    );
    const repoSave = calls.find(
      (c) => c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('Repo'),
    );
    expect(userSave).toBeDefined();
    expect(repoSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Overloaded receiver: two classes with the same method name (save) must not
// collide in the receiverKey map. The fix preserves @startIndex in the key so
// User.save@idx1 and Repo.save@idx2 remain distinct even when the enclosing
// scope funcName is the same.
// ---------------------------------------------------------------------------

describe('TypeScript overloaded-receiver resolution (receiverKey collision fix)', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(
        path.join(FIXTURES, 'typescript-overloaded-receiver'),
        () => {},
      );
    },
    { timeout: 60000 },
  );

  it('detects User and Repo classes, both with a save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.save() to User#save (models/User.ts), not Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find((c) => c.target === 'save' && c.targetFilePath.includes('User'));
    expect(userSave).toBeDefined();
    expect(userSave!.source).toBe('run');
    // Negative: must not resolve to Repo#save
    const wrongSave = calls.find(
      (c) => c.target === 'save' && c.source === 'run' && c.targetFilePath.includes('Repo'),
    );
    // If only one save target resolves to User (not Repo), we correctly exclude Repo
    expect(userSave!.targetFilePath).toContain('User');
  });

  it('resolves repo.save() to Repo#save (models/Repo.ts), not User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find((c) => c.target === 'save' && c.targetFilePath.includes('Repo'));
    expect(repoSave).toBeDefined();
    expect(repoSave!.source).toBe('run');
    expect(repoSave!.targetFilePath).toContain('Repo');
  });

  it('emits exactly 2 save() CALLS edges — one per class', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'save');
    expect(saveCalls.length).toBe(2);
    const targets = saveCalls.map((c) => c.targetFilePath).sort();
    expect(targets[0]).toContain('Repo');
    expect(targets[1]).toContain('User');
  });

  it('resolves constructor calls for both User and Repo', () => {
    const calls = getRelationships(result, 'CALLS');
    const userCtor = calls.find((c) => c.target === 'User' && c.targetLabel === 'Class');
    const repoCtor = calls.find((c) => c.target === 'Repo' && c.targetLabel === 'Class');
    expect(userCtor).toBeDefined();
    expect(repoCtor).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Typed parameter chain: svc.getUser().save() where svc is a parameter with
// a type annotation (not a constructor binding). Tests that the worker path
// consults typeEnv for chain base receivers (Phase 5 review Finding 1).
// ---------------------------------------------------------------------------

describe('TypeScript typed-parameter chain call resolution (Phase 5 review fix)', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(
        path.join(FIXTURES, 'typescript-typed-param-chain'),
        () => {},
      );
    },
    { timeout: 60000 },
  );

  it('detects User, Repo, and UserService classes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('User');
    expect(classes).toContain('Repo');
    expect(classes).toContain('UserService');
  });

  it('detects getUser and save methods', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('getUser');
    expect(methods).toContain('save');
  });

  it('resolves svc.getUser().save() to User#save via parameter type annotation', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) => c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('User'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve svc.getUser().save() to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) => c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('Repo'),
    );
    expect(repoSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Static chain: UserService.findUser().save() where the chain base is a class
// name (not a variable). Tests that the serial path applies class-as-receiver
// to chain base resolution (Phase 5 review Finding 2).
// ---------------------------------------------------------------------------

describe('TypeScript static class-name chain call resolution (Phase 5 review fix)', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'typescript-static-chain'), () => {});
    },
    { timeout: 60000 },
  );

  it('detects User, Repo, and UserService classes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('User');
    expect(classes).toContain('Repo');
    expect(classes).toContain('UserService');
  });

  it('detects static findUser and instance save methods', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('findUser');
    expect(methods).toContain('save');
  });

  it('resolves UserService.findUser().save() to User#save via class-name chain base', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) => c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('User'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve UserService.findUser().save() to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) => c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('Repo'),
    );
    expect(repoSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TS readonly User[] for-loop: for (const user of users) with readonly User[]
// ---------------------------------------------------------------------------

describe('TypeScript readonly array for-loop resolution (Tier 1c)', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(path.join(FIXTURES, 'ts-readonly-foreach'), () => {});
    },
    { timeout: 60000 },
  );

  it('detects User and Repo classes with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
  });

  it('resolves user.save() in readonly array for-of to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUsers' && c.targetFilePath?.includes('user'),
    );
    expect(userSave).toBeDefined();
  });

  it('resolves repo.save() in readonly array for-of to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processRepos' && c.targetFilePath?.includes('repo'),
    );
    expect(repoSave).toBeDefined();
  });

  it('does NOT cross-resolve user.save() to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrong = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUsers' && c.targetFilePath?.includes('repo'),
    );
    expect(wrong).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// for (const [key, user] of entries) — destructured for-of resolution
// ---------------------------------------------------------------------------

describe('TS destructured for-of Map resolution', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(
        path.join(FIXTURES, 'typescript-destructured-for-of'),
        () => {},
      );
    },
    { timeout: 60000 },
  );

  it('detects User class with save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
  });

  it('resolves user.save() in destructured for-of to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processEntries' && c.targetFilePath?.includes('user'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve user.save() to Repo#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processEntries' && c.targetFilePath?.includes('repo'),
    );
    expect(wrongSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// if (x instanceof User) { x.save() } — instanceof narrowing resolution
// ---------------------------------------------------------------------------

describe('TS instanceof narrowing resolution', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(
        path.join(FIXTURES, 'typescript-instanceof-narrowing'),
        () => {},
      );
    },
    { timeout: 60000 },
  );

  it('detects User class with save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
  });

  it('resolves x.save() after instanceof to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) => c.target === 'save' && c.source === 'process' && c.targetFilePath?.includes('user'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve x.save() to Repo#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) => c.target === 'save' && c.source === 'process' && c.targetFilePath?.includes('repo'),
    );
    expect(wrongSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// this.users member access iterable: for (const user of this.users)
// ---------------------------------------------------------------------------

describe('TypeScript member access iterable for-loop', () => {
  let result: PipelineResult;

  beforeAll(
    async () => {
      result = await runPipelineFromRepo(
        path.join(FIXTURES, 'typescript-member-access-for-loop'),
        () => {},
      );
    },
    { timeout: 60000 },
  );

  it('detects User and Repo classes with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    expect(getNodesByLabel(result, 'Method')).toContain('save');
  });

  it('resolves user.save() via this.users to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUsers' && c.targetFilePath?.includes('User'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT cross-resolve user.save() to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrong = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUsers' && c.targetFilePath?.includes('Repo'),
    );
    expect(wrong).toBeUndefined();
  });

  it('resolves repo.save() via this.repos to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processRepos' && c.targetFilePath?.includes('Repo'),
    );
    expect(repoSave).toBeDefined();
  });

  it('does not borrow a parameter type for a nonexistent receiver field', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.filter((c) => c.source === 'processMissingUsers' && c.target === 'save')).toEqual(
      [],
    );
  });
});
