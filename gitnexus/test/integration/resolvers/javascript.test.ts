/**
 * JavaScript: self/this resolution, parent resolution, super resolution
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES, getRelationships, getNodesByLabel, edgeSet,
  runPipelineFromRepo, type PipelineResult,
} from './helpers.js';

// ---------------------------------------------------------------------------
// skipGraphPhases: verify pipeline works correctly when graph phases are skipped
// ---------------------------------------------------------------------------

describe('Pipeline skipGraphPhases option', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'javascript-self-this-resolution'),
      () => {},
      { skipGraphPhases: true },
    );
  }, 60000);

  it('produces graph nodes without community/process phases', () => {
    expect(getNodesByLabel(result, 'Class').length).toBeGreaterThan(0);
  });

  it('still resolves CALLS edges correctly', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.length).toBeGreaterThan(0);
  });

  it('omits communityResult when skipGraphPhases is true', () => {
    expect(result.communityResult).toBeUndefined();
  });

  it('omits processResult when skipGraphPhases is true', () => {
    expect(result.processResult).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// this.save() resolves to enclosing class's own save method
// ---------------------------------------------------------------------------

describe('JavaScript this resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'javascript-self-this-resolution'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes, each with a save method', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Repo', 'User']);
    const saveMethods = getNodesByLabel(result, 'Method').filter(m => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves this.save() inside User.process to User.save, not Repo.save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save' && c.source === 'process');
    expect(saveCall).toBeDefined();
    expect(saveCall!.targetFilePath).toBe('src/models/User.js');
  });
});

// ---------------------------------------------------------------------------
// Parent class resolution: EXTENDS edge
// ---------------------------------------------------------------------------

describe('JavaScript parent resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'javascript-parent-resolution'),
      () => {},
    );
  }, 60000);

  it('detects BaseModel and User classes', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['BaseModel', 'User']);
  });

  it('emits EXTENDS edge: User → BaseModel', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.length).toBe(1);
    expect(extends_[0].source).toBe('User');
    expect(extends_[0].target).toBe('BaseModel');
  });

  it('EXTENDS edge points to real graph node', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    const target = result.graph.getNode(extends_[0].rel.targetId);
    expect(target).toBeDefined();
    expect(target!.properties.name).toBe('BaseModel');
  });
});

// ---------------------------------------------------------------------------
// Nullable receiver: JSDoc @param {User | null} strips nullable via TypeEnv
// ---------------------------------------------------------------------------

describe('JavaScript nullable receiver resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'js-nullable-receiver'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes, both with save methods', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Repo', 'User']);
    const saveMethods = getNodesByLabel(result, 'Method').filter(m => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.save() to src/user.js via nullable-stripped JSDoc type', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c => c.target === 'save' && c.source === 'processEntities' && c.targetFilePath === 'src/user.js');
    expect(userSave).toBeDefined();
  });

  it('resolves repo.save() to src/repo.js via nullable-stripped JSDoc type', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c => c.target === 'save' && c.source === 'processEntities' && c.targetFilePath === 'src/repo.js');
    expect(repoSave).toBeDefined();
  });

  it('emits exactly 2 save() CALLS edges (one per receiver type)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter(c => c.target === 'save');
    expect(saveCalls.length).toBe(2);
  });

  it('each save() call resolves to a distinct file (no duplicates)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter(c => c.target === 'save' && c.source === 'processEntities');
    const files = saveCalls.map(c => c.targetFilePath).sort();
    expect(files).toEqual(['src/repo.js', 'src/user.js']);
  });
});

// ---------------------------------------------------------------------------
// super.save() resolves to parent class's save method
// ---------------------------------------------------------------------------

describe('JavaScript super resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'javascript-super-resolution'),
      () => {},
    );
  }, 60000);

  it('detects BaseModel, User, and Repo classes, each with a save method', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['BaseModel', 'Repo', 'User']);
    const saveMethods = getNodesByLabel(result, 'Method').filter(m => m === 'save');
    expect(saveMethods.length).toBe(3);
  });

  it('emits EXTENDS edge: User → BaseModel', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.length).toBe(1);
    expect(extends_[0].source).toBe('User');
    expect(extends_[0].target).toBe('BaseModel');
  });

  it('resolves super.save() inside User to BaseModel.save, not Repo.save', () => {
    const calls = getRelationships(result, 'CALLS');
    const superSave = calls.find(c => c.source === 'save' && c.target === 'save'
      && c.targetFilePath === 'src/models/Base.js');
    expect(superSave).toBeDefined();
    const repoSave = calls.find(c => c.target === 'save' && c.targetFilePath === 'src/models/Repo.js');
    expect(repoSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Chained method calls: svc.getUser().save()
// Tests that JavaScript chain call resolution correctly infers the intermediate
// receiver type from getUser()'s JSDoc @returns {User} and resolves save().
// ---------------------------------------------------------------------------

describe('JavaScript chained method call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'javascript-chain-call'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes, and UserService', () => {
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

  it('resolves svc.getUser().save() to User#save via chain resolution', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c =>
      c.target === 'save' &&
      c.source === 'processUser' &&
      c.targetFilePath?.includes('user.js'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve svc.getUser().save() to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c =>
      c.target === 'save' &&
      c.source === 'processUser' &&
      c.targetFilePath?.includes('repo.js'),
    );
    expect(repoSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 8: Field/property type resolution — class field_definition capture
// ---------------------------------------------------------------------------

describe('Field type resolution (JavaScript)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'js-field-types'),
      () => {},
    );
  }, 60000);

  it('detects classes: Address, Config, User', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Address', 'Config', 'User']);
  });

  it('detects Property nodes for JS class fields', () => {
    const properties = getNodesByLabel(result, 'Property');
    expect(properties).toContain('address');
    expect(properties).toContain('name');
    expect(properties).toContain('city');
  });

  it('emits HAS_PROPERTY edges linking fields to classes', () => {
    const propEdges = getRelationships(result, 'HAS_PROPERTY');
    expect(propEdges.length).toBeGreaterThanOrEqual(3);
    expect(edgeSet(propEdges)).toContain('User → address');
    expect(edgeSet(propEdges)).toContain('User → name');
    expect(edgeSet(propEdges)).toContain('Address → city');
  });
});
