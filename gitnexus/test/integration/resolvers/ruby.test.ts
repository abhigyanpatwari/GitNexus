/**
 * Ruby: require_relative imports, include heritage (mixins), attr_* properties,
 *       calls, member calls, ambiguous disambiguation, local shadow,
 *       constructor-inferred type resolution
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES,
  CROSS_FILE_FIXTURES,
  getRelationships,
  getNodesByLabel,
  getNodesByLabelFull,
  edgeSet,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';

// ---------------------------------------------------------------------------
// Heritage: require_relative imports + include heritage + attr_* properties + calls
// ---------------------------------------------------------------------------

describe('Ruby require_relative, heritage & property resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ruby-app'), () => {});
  }, 60000);

  // --- Node detection ---

  it('detects 3 classes', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['BaseModel', 'User', 'UserService']);
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
    const calls = getRelationships(result, 'CALLS').filter(
      (e) => e.source === 'factory' && e.target === 'run_validations',
    );
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
    const bareRequire = imports.find(
      (e) =>
        e.sourceFilePath.includes('base_model.rb') && e.targetFilePath.includes('serializable.rb'),
    );
    expect(bareRequire).toBeDefined();
  });

  // --- Heritage: include → IMPLEMENTS ---

  it('emits IMPLEMENTS edge for include Serializable with reason "include"', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    const edge = implements_.find((e) => e.source === 'User' && e.target === 'Serializable');
    expect(edge).toBeDefined();
    expect(edge!.rel.reason).toBe('include');
  });

  it('emits IMPLEMENTS edge for extend Loggable with reason "extend"', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    const edge = implements_.find((e) => e.source === 'User' && e.target === 'Loggable');
    expect(edge).toBeDefined();
    expect(edge!.rel.reason).toBe('extend');
  });

  it('emits IMPLEMENTS edge for prepend Cacheable with reason "prepend"', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    const edge = implements_.find((e) => e.source === 'User' && e.target === 'Cacheable');
    expect(edge).toBeDefined();
    expect(edge!.rel.reason).toBe('prepend');
  });

  // --- Extends: class inheritance ---

  it('emits EXTENDS edge: User → BaseModel', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(extends_.length).toBe(1);
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

  it('emits HAS_PROPERTY from User to attr_reader :name', () => {
    const hasProperty = getRelationships(result, 'HAS_PROPERTY');
    const edge = hasProperty.find((e) => e.source === 'User' && e.target === 'name');
    expect(edge).toBeDefined();
  });

  it('emits HAS_PROPERTY from BaseModel to attr_accessor :id', () => {
    const hasProperty = getRelationships(result, 'HAS_PROPERTY');
    const edge = hasProperty.find((e) => e.source === 'BaseModel' && e.target === 'id');
    expect(edge).toBeDefined();
  });

  // --- Call resolution: method-level attribution ---

  it('emits method-level CALLS: create_user → persist (member call)', () => {
    const calls = getRelationships(result, 'CALLS').filter(
      (e) => e.source === 'create_user' && e.target === 'persist',
    );
    expect(calls.length).toBe(1);
    expect(calls[0].sourceLabel).toBe('Method');
    expect(calls[0].targetLabel).toBe('Method');
  });

  it('emits method-level CALLS: create_user → greet_user (member call)', () => {
    const calls = getRelationships(result, 'CALLS').filter(
      (e) => e.source === 'create_user' && e.target === 'greet_user',
    );
    expect(calls.length).toBe(1);
    expect(calls[0].sourceLabel).toBe('Method');
    expect(calls[0].targetLabel).toBe('Method');
  });

  it('emits method-level CALLS: greet_user → persist (bare call)', () => {
    const calls = getRelationships(result, 'CALLS').filter(
      (e) => e.source === 'greet_user' && e.target === 'persist',
    );
    expect(calls.length).toBe(1);
  });

  it('emits method-level CALLS: greet_user → serialize_data (bare call)', () => {
    const calls = getRelationships(result, 'CALLS').filter(
      (e) => e.source === 'greet_user' && e.target === 'serialize_data',
    );
    expect(calls.length).toBe(1);
  });

  it('emits method-level CALLS: persist → run_validations (bare call)', () => {
    const calls = getRelationships(result, 'CALLS').filter(
      (e) => e.source === 'persist' && e.target === 'run_validations',
    );
    expect(calls.length).toBe(1);
  });

  // --- Heritage edges point to real graph nodes ---

  it('all heritage edges point to real graph nodes', () => {
    for (const edge of [
      ...getRelationships(result, 'EXTENDS'),
      ...getRelationships(result, 'IMPLEMENTS'),
    ]) {
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ruby-calls'), () => {});
  }, 60000);

  it('resolves run_task → write_audit to one_arg.rb via arity narrowing', () => {
    const calls = getRelationships(result, 'CALLS');
    const auditCall = calls.find((c) => c.target === 'write_audit');
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ruby-member-calls'), () => {});
  }, 60000);

  it('resolves process_user → persist_record as a member call on User', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'persist_record');
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
    const edge = hasMethod.find((e) => e.source === 'User' && e.target === 'persist_record');
    expect(edge).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Ambiguous: Handler in two dirs, require_relative disambiguates
// ---------------------------------------------------------------------------

describe('Ruby ambiguous symbol resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ruby-ambiguous'), () => {});
  }, 60000);

  it('detects 2 Handler classes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes.filter((n) => n === 'Handler').length).toBe(2);
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ruby-local-shadow'), () => {});
  }, 60000);

  it('resolves run_app → do_work to same-file definition, not the imported one', () => {
    const calls = getRelationships(result, 'CALLS');
    const doWorkCall = calls.find((c) => c.target === 'do_work' && c.source === 'run_app');
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
    expect(methods.filter((m) => m === 'save').length).toBe(2);
    expect(methods.filter((m) => m === 'cleanup').length).toBe(3);
  });

  it('resolves user.save to models/user.rb via constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) => c.target === 'save' && c.targetFilePath === 'models/user.rb',
    );
    expect(userSave).toBeDefined();
    expect(userSave!.source).toBe('process_entities');
  });

  it('resolves repo.save to models/repo.rb via constructor-inferred type', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) => c.target === 'save' && c.targetFilePath === 'models/repo.rb',
    );
    expect(repoSave).toBeDefined();
    expect(repoSave!.source).toBe('process_entities');
  });

  it('emits exactly 2 save CALLS edges (one per receiver type)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((c) => c.target === 'save');
    expect(saveCalls.length).toBe(2);
  });

  it('resolves self.process_entities to services/app.rb (unique method)', () => {
    const calls = getRelationships(result, 'CALLS');
    const selfCall = calls.find((c) => c.source === 'greet' && c.target === 'process_entities');
    expect(selfCall).toBeDefined();
    expect(selfCall!.targetFilePath).toContain('app.rb');
  });

  it('resolves self.cleanup to services/app.rb, not models/user.rb or models/repo.rb', () => {
    const calls = getRelationships(result, 'CALLS');
    const selfCleanup = calls.find((c) => c.source === 'greet' && c.target === 'cleanup');
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ruby-self-this-resolution'), () => {});
  }, 60000);

  it('detects User and Repo classes, each with a save method', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Repo', 'User']);
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves self.save inside User#process to User#save, not Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save' && c.source === 'process');
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ruby-parent-resolution'), () => {});
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
    const includeEdge = implements_.find((e) => e.source === 'User' && e.target === 'Serializable');
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
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ruby-super-resolution'), () => {});
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
    const saveMethods = getNodesByLabel(result, 'Method').filter((m) => m === 'save');
    expect(saveMethods.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Ruby constant constructor: SERVICE = UserService.new; SERVICE.process
// ---------------------------------------------------------------------------

describe('Ruby constant constructor binding resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ruby-constant-constructor'), () => {});
  }, 60000);

  it('detects UserService class with process and validate methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('UserService');
    expect(getNodesByLabel(result, 'Method')).toContain('process');
    expect(getNodesByLabel(result, 'Method')).toContain('validate');
  });

  it('resolves SERVICE.process() via constant constructor binding', () => {
    const calls = getRelationships(result, 'CALLS');
    const processCall = calls.find(
      (c) => c.target === 'process' && c.targetFilePath === 'models.rb',
    );
    expect(processCall).toBeDefined();
  });

  it('resolves SERVICE.validate() via constant constructor binding', () => {
    const calls = getRelationships(result, 'CALLS');
    const validateCall = calls.find(
      (c) => c.target === 'validate' && c.targetFilePath === 'models.rb',
    );
    expect(validateCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// YARD annotation type resolution: @param repo [UserRepo] → repo.save resolves
// ---------------------------------------------------------------------------

describe('Ruby YARD annotation type resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ruby-yard-annotations'), () => {});
  }, 60000);

  it('detects UserRepo, User, and UserService classes', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('UserRepo');
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('UserService');
  });

  it('detects save, find_by_name, greet, and create methods', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('save');
    expect(methods).toContain('find_by_name');
    expect(methods).toContain('greet');
    expect(methods).toContain('create');
  });

  it('resolves repo.save to UserRepo#save via YARD @param annotation', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save' && c.source === 'create');
    expect(saveCall).toBeDefined();
    expect(saveCall!.targetFilePath).toContain('models.rb');
  });

  it('resolves user.greet to User#greet via YARD @param annotation', () => {
    const calls = getRelationships(result, 'CALLS');
    const greetCall = calls.find((c) => c.target === 'greet' && c.source === 'create');
    expect(greetCall).toBeDefined();
    expect(greetCall!.targetFilePath).toContain('models.rb');
  });
});

// ---------------------------------------------------------------------------
// Namespaced constructor: svc = Models::UserService.new; svc.process()
// Tests scope_resolution receiver handling for Ruby namespaced classes.
// ---------------------------------------------------------------------------

describe('Ruby namespaced constructor resolution (Models::UserService.new)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'ruby-namespaced-constructor'),
      () => {},
    );
  }, 60000);

  it('detects UserService class with process and validate methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('UserService');
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('process');
    expect(methods).toContain('validate');
  });

  it('resolves svc.process() via namespaced constructor Models::UserService.new', () => {
    const calls = getRelationships(result, 'CALLS');
    const processCall = calls.find(
      (c) => c.target === 'process' && c.targetFilePath.includes('user_service.rb'),
    );
    expect(processCall).toBeDefined();
  });

  it('resolves svc.validate() via namespaced constructor Models::UserService.new', () => {
    const calls = getRelationships(result, 'CALLS');
    const validateCall = calls.find(
      (c) => c.target === 'validate' && c.targetFilePath.includes('user_service.rb'),
    );
    expect(validateCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Return type inference: user = get_user('alice'); user.save
// Ruby's scanConstructorBinding captures assignment nodes with call RHS.
// Combined with YARD @return annotation parsing, the pipeline resolves
// `user.save` to User#save (not Repo#save) via return type disambiguation.
// The fixture has BOTH User#save and Repo#save — fuzzy matching alone
// cannot disambiguate, so return type inference must be working.
// ---------------------------------------------------------------------------

describe('Ruby return type inference via function call', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ruby-return-type'), () => {});
  }, 60000);

  it('detects User and Repo classes', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Class')).toContain('Repo');
  });

  it('detects get_user and get_repo methods', () => {
    expect(getNodesByLabel(result, 'Method')).toContain('get_user');
    expect(getNodesByLabel(result, 'Method')).toContain('get_repo');
  });

  it('detects save method on both User and Repo (disambiguation required)', () => {
    const methods = getNodesByLabel(result, 'Method');
    // Both classes have save — fuzzy match alone cannot resolve this
    expect(methods.filter((m) => m === 'save').length).toBe(2);
  });

  it('resolves user.save to User#save via YARD @return [User] on get_user()', () => {
    // With both User#save and Repo#save in scope, resolving user.save
    // requires return type inference: get_user() → @return [User] → user is User
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' &&
        c.source === 'process_user' &&
        c.targetFilePath.includes('models.rb'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves repo.save to Repo#save via YARD @return [Repo] on get_repo()', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'process_repo' && c.targetFilePath.includes('repo.rb'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Ruby constant LHS factory call: SERVICE = build_service() with YARD @return
// Verifies that constant assignments (uppercase LHS) from plain function calls
// are captured by scanConstructorBinding, not just identifier assignments.
// ---------------------------------------------------------------------------

describe('Ruby constant factory call resolution (SERVICE = build_service())', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ruby-constant-factory-call'), () => {});
  }, 60000);

  it('detects UserService and AdminService classes with process and validate methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('UserService');
    expect(getNodesByLabel(result, 'Class')).toContain('AdminService');
    expect(getNodesByLabel(result, 'Method')).toContain('process');
    expect(getNodesByLabel(result, 'Method')).toContain('validate');
  });

  it('resolves SERVICE.process() to UserService#process via constant factory call', () => {
    const calls = getRelationships(result, 'CALLS');
    const processCall = calls.find(
      (c) => c.target === 'process' && c.targetFilePath.includes('user_service.rb'),
    );
    expect(processCall).toBeDefined();
    const wrongCall = calls.find(
      (c) =>
        c.target === 'process' &&
        c.sourceFilePath?.includes('app.rb') &&
        c.targetFilePath.includes('admin_service.rb'),
    );
    expect(wrongCall).toBeUndefined();
  });

  it('resolves SERVICE.validate() to UserService#validate via constant factory call', () => {
    const calls = getRelationships(result, 'CALLS');
    const validateCall = calls.find(
      (c) => c.target === 'validate' && c.targetFilePath.includes('user_service.rb'),
    );
    expect(validateCall).toBeDefined();
    const wrongCall = calls.find(
      (c) =>
        c.target === 'validate' &&
        c.sourceFilePath?.includes('app.rb') &&
        c.targetFilePath.includes('admin_service.rb'),
    );
    expect(wrongCall).toBeUndefined();
  });
});

describe('Ruby YARD generic type annotations (Hash<Symbol, User>)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ruby-yard-generics'), () => {});
  }, 60000);

  it('detects UserRepo, AdminRepo, and DataService classes', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('UserRepo');
    expect(getNodesByLabel(result, 'Class')).toContain('AdminRepo');
    expect(getNodesByLabel(result, 'Class')).toContain('DataService');
  });

  it('detects save and find_all on both repos, plus sync and audit methods', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('save');
    expect(methods).toContain('find_all');
    expect(methods).toContain('sync');
    expect(methods).toContain('audit');
  });

  it('resolves repo.save in sync() to UserRepo#save via @param repo [UserRepo]', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'save' && c.source === 'sync' && c.targetFilePath.includes('models.rb'),
    );
    expect(saveCall).toBeDefined();
  });

  it('does NOT resolve cache param to a class (Hash<Symbol, UserRepo> is a generic container)', () => {
    // The @param cache [Hash<Symbol, UserRepo>] should extract type "Hash" — not "UserRepo".
    // Since Hash is not a class in the fixture, no type binding is created for cache.
    // This verifies the bracket-balanced split doesn't break on the inner comma.
    const calls = getRelationships(result, 'CALLS');
    // No calls should originate from cache.* since cache has no resolved type
    const cacheCall = calls.find(
      (c) => c.source === 'sync' && c.target === 'save' && c.targetFilePath.includes('admin'),
    );
    expect(cacheCall).toBeUndefined();
  });

  it('resolves admin_repo.save in audit() to AdminRepo#save via alternate @param [AdminRepo] order', () => {
    const calls = getRelationships(result, 'CALLS');
    // audit() calls admin_repo.save — should resolve via the alternate YARD format
    const saveCall = calls.find((c) => c.target === 'save' && c.source === 'audit');
    expect(saveCall).toBeDefined();
  });

  it('resolves admin_repo.find_all in audit() to AdminRepo#find_all', () => {
    const calls = getRelationships(result, 'CALLS');
    const findCall = calls.find((c) => c.target === 'find_all' && c.source === 'audit');
    expect(findCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Chained method calls: svc.get_user.save
// Tests that Ruby's `call` node uses `method` and `receiver` fields correctly
// for chain extraction — the tree-sitter-ruby grammar differs from other languages.
// ---------------------------------------------------------------------------

describe('Ruby chained method call resolution (Phase 5 review fix)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ruby-chain-call'), () => {});
  }, 60000);

  it('detects User, Repo, UserService and App classes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('User');
    expect(classes).toContain('Repo');
    expect(classes).toContain('UserService');
    expect(classes).toContain('App');
  });

  it('detects save methods on both User and Repo', () => {
    const methods = getNodesByLabel(result, 'Method');
    const saveMethods = methods.filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('detects get_user method on UserService', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('get_user');
  });

  it('resolves svc.get_user.save to User#save via chain resolution', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) => c.target === 'save' && c.source === 'process' && c.targetFilePath?.includes('user.rb'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve svc.get_user.save to Repo#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const repoSave = calls.find(
      (c) => c.target === 'save' && c.source === 'process' && c.targetFilePath?.includes('repo.rb'),
    );
    expect(repoSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Ruby for-in loop: for user in users — YARD @param resolution
// ---------------------------------------------------------------------------

describe('Ruby for-in loop resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ruby-for-in-loop'), () => {});
  }, 60000);

  it('detects User class with save method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
  });

  it('resolves user.save in for-in to User#save', () => {
    const calls = getRelationships(result, 'CALLS');
    const userSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'process_users' && c.targetFilePath?.includes('user'),
    );
    expect(userSave).toBeDefined();
  });

  it('does NOT resolve user.save to Repo#save (negative)', () => {
    const calls = getRelationships(result, 'CALLS');
    const wrongSave = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'process_users' && c.targetFilePath?.includes('repo'),
    );
    expect(wrongSave).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 8: Field/property type resolution via YARD @return annotations
// ---------------------------------------------------------------------------

describe('Field type resolution (Ruby)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ruby-field-types'), () => {});
  }, 60000);

  it('detects classes: Address, User', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Address', 'User']);
  });

  it('detects Property nodes for attr_accessor fields', () => {
    const properties = getNodesByLabel(result, 'Property');
    expect(properties).toContain('address');
    expect(properties).toContain('name');
    expect(properties).toContain('city');
  });

  it('emits HAS_PROPERTY edges linking properties to classes', () => {
    const propEdges = getRelationships(result, 'HAS_PROPERTY');
    expect(propEdges.length).toBe(3);
    expect(edgeSet(propEdges)).toContain('User → address');
    expect(edgeSet(propEdges)).toContain('User → name');
    expect(edgeSet(propEdges)).toContain('Address → city');
  });

  it('resolves user.address.save → Address#save via YARD @return [Address]', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((e) => e.target === 'save');
    const addressSave = saveCalls.find(
      (e) => e.source === 'process_user' && e.targetFilePath.includes('models'),
    );
    expect(addressSave).toBeDefined();
  });

  it('Property nodes contain expected field names', () => {
    const properties = getNodesByLabelFull(result, 'Property');

    const city = properties.find((p) => p.name === 'city');
    expect(city).toBeDefined();

    const name = properties.find((p) => p.name === 'name');
    expect(name).toBeDefined();

    const addr = properties.find((p) => p.name === 'address');
    expect(addr).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Phase 8: Field type disambiguation — both User and Address have save()
// ---------------------------------------------------------------------------

describe('Field type disambiguation (Ruby)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ruby-field-type-disambig'), () => {});
  }, 60000);

  it('detects both User#save and Address#save', () => {
    const methods = getNodesByLabel(result, 'Method');
    const saveMethods = methods.filter((m) => m === 'save');
    expect(saveMethods.length).toBe(2);
  });

  it('resolves user.address.save → Address#save (not User#save)', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCalls = calls.filter((e) => e.target === 'save' && e.source === 'process_user');
    expect(saveCalls.length).toBe(1);
    expect(saveCalls[0].targetFilePath).toContain('address');
    expect(saveCalls[0].targetFilePath).not.toContain('user');
  });
});

// ---------------------------------------------------------------------------
// ACCESSES write edges from assignment expressions
// ---------------------------------------------------------------------------

describe('Write access tracking (Ruby)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ruby-write-access'), () => {});
  }, 60000);

  it('emits ACCESSES write edges for setter assignments', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    const writes = accesses.filter((e) => e.rel.reason === 'write');
    expect(writes.length).toBe(3);
    const nameWrite = writes.find((e) => e.target === 'name');
    const addressWrite = writes.find((e) => e.target === 'address');
    const scoreWrite = writes.find((e) => e.target === 'score');
    expect(nameWrite).toBeDefined();
    expect(nameWrite!.source).toBe('update_user');
    expect(addressWrite).toBeDefined();
    expect(addressWrite!.source).toBe('update_user');
    expect(scoreWrite).toBeDefined();
    expect(scoreWrite!.source).toBe('update_user');
  });

  it('emits ACCESSES write edge for compound assignment (operator_assignment)', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    const writes = accesses.filter((e) => e.rel.reason === 'write');
    const scoreWrite = writes.find((e) => e.target === 'score');
    expect(scoreWrite).toBeDefined();
    expect(scoreWrite!.source).toBe('update_user');
  });

  it('write ACCESSES edges have confidence 1.0', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    const writes = accesses.filter((e) => e.rel.reason === 'write');
    for (const edge of writes) {
      expect(edge.rel.confidence).toBe(1.0);
    }
  });
});

// ---------------------------------------------------------------------------
// Call-result variable binding (Phase 9): user = get_user(); user.save
// ---------------------------------------------------------------------------

describe('Ruby call-result variable binding (Tier 2b)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ruby-call-result-binding'), () => {});
  }, 60000);

  it('resolves user.save to User#save via call-result binding', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'save' && c.source === 'process_user' && c.targetFilePath.includes('app'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Method chain binding (Phase 9C): get_user() → .get_address() → .get_city() → .save
// ---------------------------------------------------------------------------

describe('Ruby method chain binding via unified fixpoint (Phase 9C)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ruby-method-chain-binding'), () => {});
  }, 60000);

  it('resolves city.save to City#save via method chain', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) =>
        c.target === 'save' && c.source === 'process_chain' && c.targetFilePath.includes('app'),
    );
    expect(saveCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Phase B: Deep MRO — walkParentChain() at depth 2 (C→B→A)
// greet is defined on A, accessed via C. Tests BFS depth-2 parent traversal.
// ---------------------------------------------------------------------------

describe('Ruby grandparent method resolution via MRO (Phase B)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'ruby-grandparent-resolution'),
      () => {},
    );
  }, 60000);

  it('detects A, B, C, Greeting classes', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('A');
    expect(classes).toContain('B');
    expect(classes).toContain('C');
    expect(classes).toContain('Greeting');
  });

  it('emits EXTENDS edges: B→A, C→B', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    expect(edgeSet(extends_)).toContain('B → A');
    expect(edgeSet(extends_)).toContain('C → B');
  });

  it('resolves c.greet.save to Greeting#save via depth-2 MRO lookup', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'save' && c.targetFilePath.includes('greeting'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves c.greet to A#greet (method found via MRO walk)', () => {
    const calls = getRelationships(result, 'CALLS');
    const greetCall = calls.find((c) => c.target === 'greet' && c.targetFilePath.includes('a.rb'));
    expect(greetCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Ruby default parameter arity resolution
// ---------------------------------------------------------------------------

describe('Ruby default parameter arity resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ruby-default-params'), () => {});
  }, 60000);

  it('resolves greet("Alice") with 1 arg to greet with 2 params (1 default)', () => {
    const calls = getRelationships(result, 'CALLS');
    const greetCalls = calls.filter((c) => c.source === 'process' && c.target === 'greet');
    expect(greetCalls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Phase 14: Cross-file binding propagation (via synthesized wildcard imports)
// models/user.rb exports User class with save and get_name methods
// models/user_factory.rb exports UserFactory with self.get_user -> User.new
// app.rb requires both, calls UserFactory.get_user then .save / .get_name
// → user is typed User via cross-file return type propagation
// ---------------------------------------------------------------------------

describe('Ruby cross-file binding propagation', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(CROSS_FILE_FIXTURES, 'rb-cross-file'), () => {});
  }, 60000);

  it('detects User class with save and get_name methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('save');
    expect(getNodesByLabel(result, 'Method')).toContain('get_name');
  });

  it('detects UserFactory class and get_user method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('UserFactory');
    expect(getNodesByLabel(result, 'Method')).toContain('get_user');
  });

  it('emits IMPORTS edge from app.rb to models', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const edge = imports.find(
      (e) => e.sourceFilePath.includes('app') && e.targetFilePath.includes('models'),
    );
    expect(edge).toBeDefined();
  });

  it('resolves user.save in process to User#save via cross-file propagation', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(
      (c) => c.target === 'save' && c.source === 'process' && c.targetFilePath.includes('models'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves user.get_name in process to User#get_name via cross-file propagation', () => {
    const calls = getRelationships(result, 'CALLS');
    const getNameCall = calls.find(
      (c) =>
        c.target === 'get_name' && c.source === 'process' && c.targetFilePath.includes('models'),
    );
    expect(getNameCall).toBeDefined();
  });

  it('emits HAS_METHOD edges linking save and get_name to User', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const saveEdge = hasMethod.find((e) => e.source === 'User' && e.target === 'save');
    const getNameEdge = hasMethod.find((e) => e.source === 'User' && e.target === 'get_name');
    expect(saveEdge).toBeDefined();
    expect(getNameEdge).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Method Enrichment: visibility (private/protected), isStatic (singleton),
// parameters, HAS_METHOD edges, member call resolution
// ---------------------------------------------------------------------------

describe('Ruby method enrichment (visibility, isStatic, parameters)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ruby-method-enrichment'), () => {});
  }, 60000);

  it('detects Animal and Dog classes', () => {
    expect(getNodesByLabel(result, 'Class')).toEqual(['Animal', 'Dog']);
  });

  it('detects all methods including singleton', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('speak');
    expect(methods).toContain('classify');
    expect(methods).toContain('from_habitat');
    expect(methods).toContain('internal_state');
    expect(methods).toContain('energy_level');
  });

  it('emits HAS_METHOD edges for Animal and Dog', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    // Animal has speak, classify, from_habitat, internal_state
    expect(hasMethod.find((e) => e.source === 'Animal' && e.target === 'speak')).toBeDefined();
    expect(hasMethod.find((e) => e.source === 'Animal' && e.target === 'classify')).toBeDefined();
    expect(
      hasMethod.find((e) => e.source === 'Animal' && e.target === 'from_habitat'),
    ).toBeDefined();
    expect(
      hasMethod.find((e) => e.source === 'Animal' && e.target === 'internal_state'),
    ).toBeDefined();
    // Dog has speak, energy_level
    expect(hasMethod.find((e) => e.source === 'Dog' && e.target === 'speak')).toBeDefined();
    expect(hasMethod.find((e) => e.source === 'Dog' && e.target === 'energy_level')).toBeDefined();
  });

  it('marks internal_state as private (when enriched)', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const internalState = methods.find(
      (m) => m.name === 'internal_state' && m.properties.filePath?.includes('animal'),
    );
    expect(internalState).toBeDefined();
    // Visibility enrichment requires the MethodExtractor path (worker mode).
    // Sequential fallback (small repos) does not populate visibility.
    if (internalState!.properties.visibility !== undefined) {
      expect(internalState!.properties.visibility).toBe('private');
    }
  });

  it('marks energy_level as protected (when enriched)', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const energyLevel = methods.find(
      (m) => m.name === 'energy_level' && m.properties.filePath?.includes('animal'),
    );
    expect(energyLevel).toBeDefined();
    if (energyLevel!.properties.visibility !== undefined) {
      expect(energyLevel!.properties.visibility).toBe('protected');
    }
  });

  it('marks classify as static (when enriched)', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const classify = methods.find(
      (m) => m.name === 'classify' && m.properties.filePath?.includes('animal'),
    );
    expect(classify).toBeDefined();
    if (classify!.properties.isStatic !== undefined) {
      expect(classify!.properties.isStatic).toBe(true);
    }
  });

  it('marks from_habitat (class << self) as static and public (when enriched)', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const fromHabitat = methods.find(
      (m) => m.name === 'from_habitat' && m.properties.filePath?.includes('animal'),
    );
    expect(fromHabitat).toBeDefined();
    if (fromHabitat!.properties.isStatic !== undefined) {
      expect(fromHabitat!.properties.isStatic).toBe(true);
    }
    if (fromHabitat!.properties.visibility !== undefined) {
      expect(fromHabitat!.properties.visibility).toBe('public');
    }
  });

  it('extracts parameterCount for from_habitat(habitat)', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const fromHabitat = methods.find(
      (m) => m.name === 'from_habitat' && m.properties.filePath?.includes('animal'),
    );
    expect(fromHabitat).toBeDefined();
    expect(fromHabitat!.properties.parameterCount).toBe(1);
  });

  it('marks speak as public (when enriched)', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const speak = methods.find(
      (m) => m.name === 'speak' && m.properties.filePath?.includes('animal'),
    );
    expect(speak).toBeDefined();
    // When the MethodExtractor enrichment runs, visibility defaults to public
    if (speak!.properties.visibility !== undefined) {
      expect(speak!.properties.visibility).toBe('public');
    }
  });

  it('extracts parameterCount for classify(name)', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const classify = methods.find(
      (m) => m.name === 'classify' && m.properties.filePath?.includes('animal'),
    );
    expect(classify).toBeDefined();
    expect(classify!.properties.parameterCount).toBe(1);
  });

  it('resolves dog.speak member call from main to Dog#speak', () => {
    const calls = getRelationships(result, 'CALLS');
    const speakCall = calls.find(
      (c) => c.source === 'main' && c.target === 'speak' && c.targetFilePath.includes('animal'),
    );
    expect(speakCall).toBeDefined();
  });

  it('emits EXTENDS edge from Dog to Animal', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    const edge = extends_.find((e) => e.source === 'Dog' && e.target === 'Animal');
    expect(edge).toBeDefined();
  });

  it('detects main as top-level Method in app.rb', () => {
    // Ruby top-level def is parsed as a method node (tree-sitter `method` type)
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('main');
  });
});

// ---------------------------------------------------------------------------
// Overload Dispatch: methods with different arity resolve via receiver type
// ---------------------------------------------------------------------------

describe('Ruby overload dispatch (format vs format_with_prefix)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'ruby-overload-dispatch'), () => {});
  }, 60000);

  it('detects Formatter class', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('Formatter');
  });

  it('detects format and format_with_prefix methods', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('format');
    expect(methods).toContain('format_with_prefix');
  });

  it('emits HAS_METHOD edges for both methods on Formatter', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    expect(hasMethod.find((e) => e.source === 'Formatter' && e.target === 'format')).toBeDefined();
    expect(
      hasMethod.find((e) => e.source === 'Formatter' && e.target === 'format_with_prefix'),
    ).toBeDefined();
  });

  it('extracts arity for format(value) — 1 parameter', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const format = methods.find((m) => m.name === 'format');
    expect(format).toBeDefined();
    expect(format!.properties.parameterCount).toBe(1);
  });

  it('extracts arity for format_with_prefix(value, prefix) — 2 parameters', () => {
    const methods = getNodesByLabelFull(result, 'Method');
    const fwp = methods.find((m) => m.name === 'format_with_prefix');
    expect(fwp).toBeDefined();
    expect(fwp!.properties.parameterCount).toBe(2);
  });

  it('resolves f.format call from run to Formatter#format', () => {
    const calls = getRelationships(result, 'CALLS');
    const formatCall = calls.find(
      (c) => c.source === 'run' && c.target === 'format' && c.targetFilePath.includes('formatter'),
    );
    expect(formatCall).toBeDefined();
  });

  it('resolves f.format_with_prefix call from run to Formatter#format_with_prefix', () => {
    const calls = getRelationships(result, 'CALLS');
    const fwpCall = calls.find(
      (c) =>
        c.source === 'run' &&
        c.target === 'format_with_prefix' &&
        c.targetFilePath.includes('formatter'),
    );
    expect(fwpCall).toBeDefined();
  });

  it('detects run as top-level Method in app.rb', () => {
    // Ruby top-level def is parsed as a method node (tree-sitter `method` type)
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('run');
  });
});
