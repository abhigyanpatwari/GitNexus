import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES,
  getRelationships,
  getNodesByLabel,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';

// ---------------------------------------------------------------------------
// JavaScript constructor-inferred type resolution: const user = new User()
// ---------------------------------------------------------------------------

describe('JavaScript constructor-inferred type resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'javascript-constructor-type-inference'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes, both with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.save() to src/user.js via constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find((c) => c.target === 'save' && c.targetFilePath === 'src/user.js');
    expect(userSave).toBeDefined();
    expect(userSave!.source).toBe('processEntities');
  });

  it('resolves repo.save() to src/repo.js via constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find((c) => c.target === 'save' && c.targetFilePath === 'src/repo.js');
    expect(repoSave).toBeDefined();
    expect(repoSave!.source).toBe('processEntities');
  });

  it('emits exactly 2 save() CALLS edges (one per receiver type)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'save');
    expect(saveCalls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// JavaScript return type inference via JSDoc @returns annotation
// ---------------------------------------------------------------------------

describe('JavaScript return type inference via JSDoc @returns annotation', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'js-jsdoc-return-type'), () => {});
  }, 60000);

  it('detects User and Repo classes with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
  });

  it('resolves user.save() to User#save via JSDoc @returns {User}', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('user.js'),
    );
    expect(saveCall).toBeDefined();
    // Negative: must NOT resolve to Repo#save
    const wrongCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('repo.js'),
    );
    expect(wrongCall).toBeUndefined();
  });

  it('resolves repo.save() to Repo#save via JSDoc @returns {Repo}', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processRepo' && c.targetFilePath.includes('repo.js'),
    );
    expect(saveCall).toBeDefined();
    // Negative: must NOT resolve to User#save
    const wrongCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processRepo' && c.targetFilePath.includes('user.js'),
    );
    expect(wrongCall).toBeUndefined();
  });

  it('resolves user.save() via JSDoc @param {User} in handleUser()', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'handleUser' && c.targetFilePath.includes('user.js'),
    );
    expect(saveCall).toBeDefined();
    // Negative: must NOT resolve to Repo#save
    const wrongCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'handleUser' && c.targetFilePath.includes('repo.js'),
    );
    expect(wrongCall).toBeUndefined();
  });

  it('resolves repo.save() via JSDoc @param {Repo} in handleRepo()', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'handleRepo' && c.targetFilePath.includes('repo.js'),
    );
    expect(saveCall).toBeDefined();
    // Negative: must NOT resolve to User#save
    const wrongCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'handleRepo' && c.targetFilePath.includes('user.js'),
    );
    expect(wrongCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// JavaScript async return type inference via JSDoc @returns {Promise<User>}
// Verifies that wrapper generics (Promise) are unwrapped to the inner type.
// ---------------------------------------------------------------------------

describe('JavaScript async return type inference via JSDoc @returns {Promise<User>}', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'js-jsdoc-async-return-type'), () => {});
  }, 60000);

  it('detects User and Repo classes with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
  });

  it('resolves user.save() to User#save via @returns {Promise<User>} unwrapping', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('user.js'),
    );
    expect(saveCall).toBeDefined();
    // Negative: must NOT resolve to Repo#save
    const wrongCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('repo.js'),
    );
    expect(wrongCall).toBeUndefined();
  });

  it('resolves repo.save() to Repo#save via @returns {Promise<Repo>} unwrapping', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processRepo' && c.targetFilePath.includes('repo.js'),
    );
    expect(saveCall).toBeDefined();
    // Negative: must NOT resolve to User#save
    const wrongCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processRepo' && c.targetFilePath.includes('user.js'),
    );
    expect(wrongCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// JavaScript qualified return type: @returns {Promise<models.User>}
// Verifies that dot-qualified names inside generics are not corrupted.
// ---------------------------------------------------------------------------

describe('JavaScript qualified return type via JSDoc @returns {Promise<models.User>}', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'js-jsdoc-qualified-return-type'),
      () => {},
    );
  }, 60000);

  it('resolves user.save() to User#save despite qualified return type', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('user.js'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// JavaScript call-result variable binding (Phase 9) via JSDoc @returns
// ---------------------------------------------------------------------------

describe('JavaScript call-result variable binding (Tier 2b)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'js-call-result-binding'), () => {});
  }, 60000);

  it('resolves user.save() to User#save via call-result binding with JSDoc', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'processUser' && c.targetFilePath.includes('models'),
    );
    expect(saveCall).toBeDefined();
  });
});
