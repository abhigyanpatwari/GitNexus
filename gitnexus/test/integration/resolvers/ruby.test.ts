/**
 * Ruby: require_relative imports, include heritage (mixins), attr_* properties,
 *       calls, member calls, ambiguous disambiguation, local shadow,
 *       constructor-inferred type resolution
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES, getRelationships, getNodesByLabel, edgeSet,
  runPipelineFromRepo, type PipelineResult,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Heritage: require_relative imports + include heritage + attr_* properties + calls
// ---------------------------------------------------------------------------

describe('Ruby require_relative, heritage & property resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'ruby-app'),
      () => {},
    );
  }, 60000);

  // --- Node detection ---

  it('detects 3 classes', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual([
      'BaseModel', 'User', 'UserService',
    ]);
  });

  it('detects 3 modules', () => {
    expect(getNodesByLabel(result, 'Module')).toEqual(['Cacheable', 'Loggable', 'Serializable']);
  });

  it('detects methods on classes and modules', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('persist');
    expect(methods).toContain('run_validations');
    expect(methods).toContain('greet_user');
    expect(methods).toContain('serialize_data');
    expect(methods).toContain('create_user');
  });

  it('detects singleton method (def self.factory) as Method', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('factory');
  });

  it('emits CALLS from singleton method: factory → run_validations', () => {
    const calls = getRelationships(result, 'CALLS')
      .filter(e => e.source === 'factory' && e.target === 'run_validations');
    expect(calls.length).toBe(1);
    expect(calls[0].sourceLabel).toBe('Method');
  });

  // --- Import resolution via require_relative ---

  it('resolves 5 require_relative imports to IMPORTS edges', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const importEdges = edgeSet(imports);
    expect(importEdges).toContain('user.rb → base_model.rb');
    expect(importEdges).toContain('user.rb → serializable.rb');
    expect(importEdges).toContain('user.rb → loggable.rb');
    expect(importEdges).toContain('user.rb → cacheable.rb');
    expect(importEdges).toContain('service.rb → user.rb');
  });

  it('resolves bare require to IMPORTS edge', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const bareRequire = imports.find(e =>
      e.sourceFilePath.includes('base_model.rb') &&
      e.targetFilePath.includes('serializable.rb')
    );
    expect(bareRequire).toBeDefined();
  });

  // --- Heritage: include → IMPLEMENTS ---

  it('emits IMPLEMENTS edge for include Serializable with reason "include"', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    const edge = implements_.find(e => e.source === 'User' && e.target === 'Serializable');
    expect(edge).toBeDefined();
    expect(edge!.rel.reason).toBe('include');
  });

  it('emits IMPLEMENTS edge for extend Loggable with reason "extend"', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    const edge = implements_.find(e => e.source === 'User' && e.target === 'Loggable');
    expect(edge).toBeDefined();
    expect(edge!.rel.reason).toBe('extend');
  });

  it('emits IMPLEMENTS edge for prepend Cacheable with reason "prepend"', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    const edge = implements_.find(e => e.source === 'User' && e.target === 'Cacheable');
    expect(edge).toBeDefined();
    expect(edge!.rel.reason).toBe('prepend');
  });

  // --- Extends: class inheritance ---

  it('emits EXTENDS edge: User → BaseModel', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.length).toBeGreaterThanOrEqual(1);
    const edges = edgeSet(extends_);
    expect(edges).toContain('User → BaseModel');
  });

  // --- Property nodes: attr_accessor, attr_reader, attr_writer ---

  it('creates Property nodes for attr_accessor :id and :created_at', () => {
    const props = getNodesByLabel(result, 'Property');
    expect(props).toContain('id');
    expect(props).toContain('created_at');
  });

  it('creates Property nodes for attr_reader :name and attr_writer :email', () => {
    const props = getNodesByLabel(result, 'Property');
    expect(props).toContain('name');
    expect(props).toContain('email');
  });

  it('emits HAS_METHOD from User to attr_reader :name', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const edge = hasMethod.find(e => e.source === 'User' && e.target === 'name');
    expect(edge).toBeDefined();
  });

  it('emits HAS_METHOD from BaseModel to attr_accessor :id', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const edge = hasMethod.find(e => e.source === 'BaseModel' && e.target === 'id');
    expect(edge).toBeDefined();
  });

  // --- Call resolution: method-level attribution ---

  it('emits method-level CALLS: create_user → persist (member call)', () => {
    const calls = getRelationships(result, 'CALLS')
      .filter(e => e.source === 'create_user' && e.target === 'persist');
    expect(calls.length).toBe(1);
    expect(calls[0].sourceLabel).toBe('Method');
    expect(calls[0].targetLabel).toBe('Method');
  });

  it('emits method-level CALLS: create_user → greet_user (member call)', () => {
    const calls = getRelationships(result, 'CALLS')
      .filter(e => e.source === 'create_user' && e.target === 'greet_user');
    expect(calls.length).toBe(1);
    expect(calls[0].sourceLabel).toBe('Method');
    expect(calls[0].targetLabel).toBe('Method');
  });

  it('emits method-level CALLS: greet_user → persist (bare call)', () => {
    const calls = getRelationships(result, 'CALLS')
      .filter(e => e.source === 'greet_user' && e.target === 'persist');
    expect(calls.length).toBe(1);
  });

  it('emits method-level CALLS: greet_user → serialize_data (bare call)', () => {
    const calls = getRelationships(result, 'CALLS')
      .filter(e => e.source === 'greet_user' && e.target === 'serialize_data');
    expect(calls.length).toBe(1);
  });

  it('emits method-level CALLS: persist → run_validations (bare call)', () => {
    const calls = getRelationships(result, 'CALLS')
      .filter(e => e.source === 'persist' && e.target === 'run_validations');
    expect(calls.length).toBe(1);
  });

  // --- Heritage edges point to real graph nodes ---

  it('all heritage edges point to real graph nodes', () => {
    for (const edge of [...getRelationships(result, 'EXTENDS'), ...getRelationships(result, 'IMPLEMENTS')]) {
      const target = result.graph.getNode(edge.rel.targetId);
      expect(target).toBeDefined();
    }
  });

  // --- No OVERRIDES edges target Property nodes ---

  it('no OVERRIDES edges target Property nodes', () => {
    const overrides = getRelationships(result, 'OVERRIDES');
    for (const edge of overrides) {
      const target = result.graph.getNode(edge.rel.targetId);
      expect(target).toBeDefined();
      expect(target!.label).not.toBe('Property');
    }
  });
});

// ---------------------------------------------------------------------------
// Calls: arity-based disambiguation
// ---------------------------------------------------------------------------

describe('Ruby call resolution with arity filtering', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'ruby-calls'),
      () => {},
    );
  }, 60000);

  it('resolves run_task → write_audit to one_arg.rb via arity narrowing', () => {
    const calls = getRelationships(result, 'CALLS');
    const auditCall = calls.find(c => c.target === 'write_audit');
    expect(auditCall).toBeDefined();
    expect(auditCall!.source).toBe('run_task');
    expect(auditCall!.targetFilePath).toContain('one_arg.rb');
    expect(auditCall!.rel.reason).toBe('import-resolved');
  });
});

// ---------------------------------------------------------------------------
// Member-call resolution: obj.method() resolves through pipeline
// ---------------------------------------------------------------------------

describe('Ruby member-call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'ruby-member-calls'),
      () => {},
    );
  }, 60000);

  it('resolves process_user → persist_record as a member call on User', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'persist_record');
    expect(saveCall).toBeDefined();
    expect(saveCall!.source).toBe('process_user');
    expect(saveCall!.targetFilePath).toContain('user.rb');
  });

  it('detects User class and persist_record method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('persist_record');
  });

  it('emits HAS_METHOD edge from User to persist_record', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const edge = hasMethod.find(e => e.source === 'User' && e.target === 'persist_record');
    expect(edge).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Ambiguous: Handler in two dirs, require_relative disambiguates
// ---------------------------------------------------------------------------

describe('Ruby ambiguous symbol resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'ruby-ambiguous'),
      () => {},
    );
  }, 60000);

  it('detects 2 Handler classes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes.filter(n => n === 'Handler').length).toBe(2);
    expect(classes).toContain('UserHandler');
  });

  it('resolves EXTENDS to models/handler.rb (not other/handler.rb)', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.length).toBe(1);
    expect(extends_[0].source).toBe('UserHandler');
    expect(extends_[0].target).toBe('Handler');
    expect(extends_[0].targetFilePath).toBe('models/handler.rb');
  });

  it('import edge points to models/ not other/', () => {
    const imports = getRelationships(result, 'IMPORTS');
    expect(imports.length).toBe(1);
    expect(imports[0].targetFilePath).toBe('models/handler.rb');
  });

  it('all heritage edges point to real graph nodes', () => {
    for (const edge of getRelationships(result, 'EXTENDS')) {
      const target = result.graph.getNode(edge.rel.targetId);
      expect(target).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Local shadow: same-file definition takes priority over imported name
// ---------------------------------------------------------------------------

describe('Ruby local definition shadows import', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'ruby-local-shadow'),
      () => {},
    );
  }, 60000);

  it('resolves run_app → do_work to same-file definition, not the imported one', () => {
    const calls = getRelationships(result, 'CALLS');
    const doWorkCall = calls.find(c => c.target === 'do_work' && c.source === 'run_app');
    expect(doWorkCall).toBeDefined();
    expect(doWorkCall!.targetFilePath).toContain('app.rb');
  });
});

// ---------------------------------------------------------------------------
// Constructor-inferred type resolution: user = User.new; user.save → User.save
// ---------------------------------------------------------------------------

describe('Ruby constructor-inferred type resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'ruby-constructor-type-inference'),
      () => {},
    );
  }, 60000);

  it('detects User, Repo, and AppService classes', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
    expect(getNodesByLabel(result, 'Class')).toContain('AppService');
  });

  it('detects save on User and Repo, cleanup on all three', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods.filter(m => m === 'save').length).toBe(2);
    expect(methods.filter(m => m === 'cleanup').length).toBe(3);
  });

  it('resolves user.save to models/user.rb via constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(c => c.target === 'save' && c.targetFilePath === 'models/user.rb');
    expect(userSave).toBeDefined();
    expect(userSave!.source).toBe('process_entities');
  });

  it('resolves repo.save to models/repo.rb via constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(c => c.target === 'save' && c.targetFilePath === 'models/repo.rb');
    expect(repoSave).toBeDefined();
    expect(repoSave!.source).toBe('process_entities');
  });

  it('emits exactly 2 save CALLS edges (one per receiver type)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter(c => c.target === 'save');
    expect(saveCalls.length).toBe(2);
  });

  it('resolves self.process_entities to services/app.rb (unique method)', () => {
    const calls = getRelationships(result, 'CALLS');
    const selfCall = calls.find(c =>
      c.source === 'greet' && c.target === 'process_entities'
    );
    expect(selfCall).toBeDefined();
    expect(selfCall!.targetFilePath).toContain('app.rb');
  });

  it('resolves self.cleanup to services/app.rb, not models/user.rb or models/repo.rb', () => {
    const calls = getRelationships(result, 'CALLS');
    const selfCleanup = calls.find(c =>
      c.source === 'greet' && c.target === 'cleanup'
    );
    expect(selfCleanup).toBeDefined();
    expect(selfCleanup!.targetFilePath).toContain('app.rb');
  });
});

// ---------------------------------------------------------------------------
// self.save resolves to enclosing class's own save method
// ---------------------------------------------------------------------------

describe('Ruby self resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'ruby-self-this-resolution'),
      () => {},
    );
  }, 60000);

  it('detects User and Repo classes, each with a save method', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Repo', 'User']);
    const saveMethods = getNodesByLabel(result, 'Method').filter(m => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves self.save inside User#process to User#save, not Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c => c.target === 'save' && c.source === 'process');
    expect(saveCall).toBeDefined();
    expect(saveCall!.targetFilePath).toBe('lib/models/user.rb');
  });
});

// ---------------------------------------------------------------------------
// Parent class resolution: < BaseModel + include Module
// ---------------------------------------------------------------------------

describe('Ruby parent resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'ruby-parent-resolution'),
      () => {},
    );
  }, 60000);

  it('detects BaseModel and User classes plus Serializable module', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['BaseModel', 'User']);
    expect(getNodesByLabel(result, 'Module')).toEqual(['Serializable']);
  });

  it('emits EXTENDS edge: User < BaseModel', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.length).toBe(1);
    expect(extends_[0].source).toBe('User');
    expect(extends_[0].target).toBe('BaseModel');
  });

  it('emits IMPLEMENTS edge: User includes Serializable', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    const includeEdge = implements_.find(e => e.source === 'User' && e.target === 'Serializable');
    expect(includeEdge).toBeDefined();
    expect(includeEdge!.rel.reason).toBe('include');
  });
});

// ---------------------------------------------------------------------------
// Ruby super: standalone keyword calls same-named method on parent
// ---------------------------------------------------------------------------

describe('Ruby super resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'ruby-super-resolution'),
      () => {},
    );
  }, 60000);

  it('detects BaseModel, User, and Repo classes', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['BaseModel', 'Repo', 'User']);
  });

  it('emits EXTENDS edge: User < BaseModel', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.length).toBe(1);
    expect(extends_[0].source).toBe('User');
    expect(extends_[0].target).toBe('BaseModel');
  });

  it('detects save methods on all three classes', () => {
    const saveMethods = getNodesByLabel(result, 'Method').filter(m => m === 'save');
    expect(saveMethods.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Ruby constant constructor: SERVICE = UserService.new; SERVICE.process
// ---------------------------------------------------------------------------

describe('Ruby constant constructor binding resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'ruby-constant-constructor'),
      () => {},
    );
  }, 60000);

  it('detects UserService class with process and validate methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('UserService');
    expect(getNodesByLabel(result, 'Method')).toContain('process');
    expect(getNodesByLabel(result, 'Method')).toContain('validate');
  });

  it('resolves SERVICE.process() via constant constructor binding', () => {
    const calls = getRelationships(result, 'CALLS');
    const processCall = calls.find(c => c.target === 'process' && c.targetFilePath === 'models.rb');
    expect(processCall).toBeDefined();
  });

  it('resolves SERVICE.validate() via constant constructor binding', () => {
    const calls = getRelationships(result, 'CALLS');
    const validateCall = calls.find(c => c.target === 'validate' && c.targetFilePath === 'models.rb');
    expect(validateCall).toBeDefined();
  });
});
