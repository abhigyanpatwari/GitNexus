/**
 * Perl: package detection + subroutine calls + use statements + inheritance patterns
 */
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
// Basic Perl package and subroutine detection
// ---------------------------------------------------------------------------

describe('Perl basic package and subroutine detection', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    // Skip graph phases for faster testing
    result = await runPipelineFromRepo(path.join(FIXTURES, 'perl-basic'), () => {}, {
      skipGraphPhases: true,
    });
  }, 120000);

  it('detects Test::Module package as Namespace', () => {
    const namespaces = getNodesByLabel(result, 'Namespace');
    expect(namespaces).toContain('Test::Module');
  });

  it('detects Perl subroutines', () => {
    const functions = getNodesByLabel(result, 'Function');
    expect(functions).toContain('new');
    expect(functions).toContain('hello');
  });

  it('detects main subroutine in script', () => {
    const functions = getNodesByLabel(result, 'Function');
    expect(functions).toContain('main');
  });

  it('emits DEFINES edges for symbols and CALLS for method invocations', () => {
    const defines = getRelationships(result, 'DEFINES');
    const calls = getRelationships(result, 'CALLS');

    // Check DEFINES relationships for package and subroutine definitions
    const packageDefine = defines.find((e) => e.target === 'Test::Module');
    const newDefine = defines.find((e) => e.target === 'new');
    const helloDefine = defines.find((e) => e.target === 'hello');

    expect(packageDefine).toBeDefined();
    expect(newDefine).toBeDefined();
    expect(helloDefine).toBeDefined();

    // Check CALLS relationships for method invocations
    const newCall = calls.find((e) => e.source === 'main' && e.target === 'new');
    const helloCall = calls.find((e) => e.source === 'main' && e.target === 'hello');

    expect(newCall).toBeDefined();
    expect(helloCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Perl import resolution: use statements
// ---------------------------------------------------------------------------

describe('Perl use statement resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'perl-imports'), () => {}, {
      skipGraphPhases: true,
    });
  }, 120000);

  it('detects modules and their used dependencies', () => {
    const namespaces = getNodesByLabel(result, 'Namespace');
    expect(namespaces).toContain('MyApp');
    expect(namespaces).toContain('Utils::Logger');
  });

  it('detects subroutines across modules', () => {
    const functions = getNodesByLabel(result, 'Function');
    expect(functions).toContain('log');
    expect(functions).toContain('run');
    expect(functions).toContain('main');
  });

  it('resolves subroutine calls across modules', () => {
    const calls = getRelationships(result, 'CALLS');
    const logCall = calls.find((c) => c.target === 'log' && c.source === 'main');
    expect(logCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Perl method call resolution: object -> method()
// ---------------------------------------------------------------------------

describe('Perl method call resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'perl-methods'), () => {}, {
      skipGraphPhases: true,
    });
  }, 120000);

  it('detects User class with methods', () => {
    const namespaces = getNodesByLabel(result, 'Namespace');
    const functions = getNodesByLabel(result, 'Function');
    expect(namespaces).toContain('User');
    expect(functions).toContain('save');
    expect(functions).toContain('load');
  });

  it('resolves method calls and constructor calls', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveCall = calls.find((c) => c.target === 'save');
    const newCall = calls.find((c) => c.target === 'new');

    expect(saveCall).toBeDefined();
    expect(newCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Perl cross-file symbol resolution
// ---------------------------------------------------------------------------

describe('Perl cross-file symbol resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'perl-cross-file'), () => {}, {
      skipGraphPhases: true,
    });
  }, 120000);

  it('detects packages across files', () => {
    const namespaces = getNodesByLabel(result, 'Namespace');
    expect(namespaces).toContain('DataProcessor');
    expect(namespaces).toContain('Validator');
  });

  it('detects subroutines across files', () => {
    const functions = getNodesByLabel(result, 'Function');
    expect(functions).toContain('process_data');
    expect(functions).toContain('validate_input');
  });

  it('resolves calls across files', () => {
    const calls = getRelationships(result, 'CALLS');
    expect(calls.length).toBeGreaterThan(0);

    // Should have calls from main to functions in other files
    const crossFileCalls = calls.filter((c) => c.source === 'main');
    expect(crossFileCalls.length).toBeGreaterThan(0);
  });
});
