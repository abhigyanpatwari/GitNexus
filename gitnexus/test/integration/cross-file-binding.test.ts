/**
 * Phase 14: Cross-file type binding propagation
 *
 * When file A exports `const user = getUser()` (resolved to type User), and
 * file B imports `user`, Phase 14 seeds `user → User` into file B's type
 * environment, enabling `user.save()` in file B to produce a CALLS edge to
 * User#save.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  getRelationships,
  getNodesByLabel,
  runPipelineFromRepo,
  type PipelineResult,
} from './resolvers/helpers.js';

const CROSS_FILE_FIXTURES = path.resolve(__dirname, '..', 'fixtures', 'cross-file-binding');

// ---------------------------------------------------------------------------
// Simple cross-file: models → service → app
// models.ts exports getUser(): User
// service.ts exports const user = getUser()   (user → User via call-result)
// app.ts imports user from service → seeds user → User → resolves user.save()
// ---------------------------------------------------------------------------

describe('Cross-File Binding Propagation: TypeScript simple cross-file', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(CROSS_FILE_FIXTURES, 'ts-simple'),
      () => {},
    );
  }, 60000);

  it('detects User class with save and getName methods', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('User');
    expect(getNodesByLabel(result, 'Method')).toContain('save');
    expect(getNodesByLabel(result, 'Method')).toContain('getName');
  });

  it('detects getUser function and main function', () => {
    expect(getNodesByLabel(result, 'Function')).toContain('getUser');
    expect(getNodesByLabel(result, 'Function')).toContain('main');
  });

  it('resolves user.save() in main() to User#save via cross-file binding', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find(c =>
      c.target === 'save' &&
      c.source === 'main' &&
      c.targetFilePath.includes('models'),
    );
    expect(saveCall).toBeDefined();
  });

  it('resolves user.getName() in main() to User#getName via cross-file binding', () => {
    const calls = getRelationships(result, 'CALLS');
    const getNameCall = calls.find(c =>
      c.target === 'getName' &&
      c.source === 'main' &&
      c.targetFilePath.includes('models'),
    );
    expect(getNameCall).toBeDefined();
  });

  it('emits HAS_METHOD edges linking save and getName to User', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const saveEdge = hasMethod.find(e => e.source === 'User' && e.target === 'save');
    const getNameEdge = hasMethod.find(e => e.source === 'User' && e.target === 'getName');
    expect(saveEdge).toBeDefined();
    expect(getNameEdge).toBeDefined();
  });

  it('emits IMPORTS edges across all three files', () => {
    const imports = getRelationships(result, 'IMPORTS');
    // service.ts → models.ts and app.ts → service.ts
    expect(imports.length).toBeGreaterThanOrEqual(2);
    const paths = imports.map(e => `${e.sourceFilePath} → ${e.targetFilePath}`);
    expect(paths.some(p => p.includes('service') && p.includes('models'))).toBe(true);
    expect(paths.some(p => p.includes('app') && p.includes('service'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Re-export chain: core → index (barrel) → app
// core.ts exports getConfig(): Config
// index.ts re-exports getConfig from core (no new bindings)
// app.ts imports getConfig from index, creates local const config = getConfig()
// → config.validate() resolves to Config#validate via local call-result binding
// ---------------------------------------------------------------------------

describe('Cross-File Binding Propagation: TypeScript re-export chain', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(CROSS_FILE_FIXTURES, 'ts-reexport'),
      () => {},
    );
  }, 60000);

  it('detects Config class with validate method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('Config');
    expect(getNodesByLabel(result, 'Method')).toContain('validate');
  });

  it('detects getConfig function and init function', () => {
    expect(getNodesByLabel(result, 'Function')).toContain('getConfig');
    expect(getNodesByLabel(result, 'Function')).toContain('init');
  });

  it('resolves config.validate() in init() to Config#validate', () => {
    const calls = getRelationships(result, 'CALLS');
    const validateCall = calls.find(c =>
      c.target === 'validate' &&
      c.source === 'init' &&
      c.targetFilePath.includes('core'),
    );
    expect(validateCall).toBeDefined();
  });

  it('emits HAS_METHOD edge from Config to validate', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const edge = hasMethod.find(e => e.source === 'Config' && e.target === 'validate');
    expect(edge).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// E3: Cross-file return type propagation
// api.ts exports getConfig(): Config
// consumer.ts imports getConfig, calls const c = getConfig(); c.validate()
// → c is typed Config via importedReturnTypes (E3), enabling Config#validate edge
// ---------------------------------------------------------------------------

describe('Cross-File Binding Propagation: TypeScript E3 return type propagation', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(CROSS_FILE_FIXTURES, 'ts-return-type'),
      () => {},
    );
  }, 60000);

  it('detects Config class with validate method', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('Config');
    expect(getNodesByLabel(result, 'Method')).toContain('validate');
  });

  it('detects getConfig function and run function', () => {
    expect(getNodesByLabel(result, 'Function')).toContain('getConfig');
    expect(getNodesByLabel(result, 'Function')).toContain('run');
  });

  it('resolves c.validate() in run() to Config#validate via cross-file return type propagation', () => {
    const calls = getRelationships(result, 'CALLS');
    const validateCall = calls.find(c =>
      c.target === 'validate' &&
      c.source === 'run' &&
      c.targetFilePath.includes('api'),
    );
    expect(validateCall).toBeDefined();
  });

  it('emits HAS_METHOD edge from Config to validate', () => {
    const hasMethod = getRelationships(result, 'HAS_METHOD');
    const edge = hasMethod.find(e => e.source === 'Config' && e.target === 'validate');
    expect(edge).toBeDefined();
  });

  it('emits IMPORTS edge from consumer to api', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const edge = imports.find(e =>
      e.sourceFilePath.includes('consumer') && e.targetFilePath.includes('api'),
    );
    expect(edge).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Circular imports: a.ts ↔ b.ts
// a.ts imports getB from b.ts; b.ts imports A from a.ts
// Conservative expectation: pipeline completes without error.
// Cross-file binding propagation across cycles is not guaranteed.
// ---------------------------------------------------------------------------

describe('Cross-File Binding Propagation: TypeScript circular imports', () => {
  let result: PipelineResult;
  let pipelineError: unknown;

  beforeAll(async () => {
    try {
      result = await runPipelineFromRepo(
        path.join(CROSS_FILE_FIXTURES, 'ts-circular'),
        () => {},
      );
    } catch (err) {
      pipelineError = err;
    }
  }, 60000);

  it('pipeline completes without throwing on circular imports', () => {
    expect(pipelineError).toBeUndefined();
  });

  it('detects both class A and class B', () => {
    expect(getNodesByLabel(result, 'Class')).toContain('A');
    expect(getNodesByLabel(result, 'Class')).toContain('B');
  });

  it('detects doA and doB methods', () => {
    expect(getNodesByLabel(result, 'Method')).toContain('doA');
    expect(getNodesByLabel(result, 'Method')).toContain('doB');
  });

  it('detects processA and getB functions', () => {
    expect(getNodesByLabel(result, 'Function')).toContain('processA');
    expect(getNodesByLabel(result, 'Function')).toContain('getB');
  });

  it('emits IMPORTS edges reflecting the circular dependency', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const paths = imports.map(e => `${e.sourceFilePath} → ${e.targetFilePath}`);
    // a.ts imports from b.ts
    expect(paths.some(p => p.includes('a.ts') && p.includes('b.ts'))).toBe(true);
    // b.ts imports from a.ts
    expect(paths.some(p => p.includes('b.ts') && p.includes('a.ts'))).toBe(true);
  });
});
