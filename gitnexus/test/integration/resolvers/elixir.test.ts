/**
 * Elixir: alias imports, multi-alias expansion, pipe operator calls,
 *         Phoenix framework detection, behaviour heritage, def/defp visibility
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES, getRelationships, getNodesByLabel, edgeSet,
  runPipelineFromRepo, type PipelineResult,
} from './helpers.js';
import { isLanguageAvailable } from '../../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';

const elixirAvailable = isLanguageAvailable(SupportedLanguages.Elixir);

// ---------------------------------------------------------------------------
// Alias resolution & qualified calls
// ---------------------------------------------------------------------------

describe.skipIf(!elixirAvailable)('Elixir alias resolution & qualified calls', () => {

  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'elixir-alias'),
      () => {},
    );
  }, 60000);

  it('detects modules', () => {
    const modules = getNodesByLabel(result, 'Module');
    expect(modules).toContain('MyApp.User');
    expect(modules).toContain('MyApp.Repo');
  });

  it('detects functions', () => {
    const fns = getNodesByLabel(result, 'Function');
    expect(fns).toContain('create');
    expect(fns).toContain('insert');
  });

  it('resolves alias import: user.ex → repo.ex', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const userToRepo = imports.filter(e =>
      e.sourceFilePath.includes('user.ex') && e.targetFilePath.includes('repo.ex')
    );
    expect(userToRepo.length).toBeGreaterThanOrEqual(1);
  });

  it('emits CALLS edge from create → insert (Module.func() member call)', () => {
    const calls = getRelationships(result, 'CALLS');
    const createToInsert = calls.filter(e =>
      e.source === 'create' && e.target === 'insert'
    );
    expect(createToInsert.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Multi-alias expansion
// ---------------------------------------------------------------------------

describe.skipIf(!elixirAvailable)('Elixir multi-alias expansion', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'elixir-multi-alias'),
      () => {},
    );
  }, 60000);

  it('detects all modules', () => {
    const modules = getNodesByLabel(result, 'Module');
    expect(modules).toContain('MyApp.Accounts.User');
    expect(modules).toContain('MyApp.Accounts.Admin');
    expect(modules).toContain('MyApp.Service');
  });

  it('resolves multi-alias import: service.ex → both user.ex and admin.ex', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const serviceImports = imports.filter(e =>
      e.sourceFilePath.includes('service.ex')
    );
    expect(serviceImports.length).toBe(2);
    const targets = serviceImports.map(e => e.targetFilePath);
    expect(targets.some(t => t.includes('user.ex'))).toBe(true);
    expect(targets.some(t => t.includes('admin.ex'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pipe operator → call edges
// ---------------------------------------------------------------------------

describe.skipIf(!elixirAvailable)('Elixir pipe operator call edges', () => {

  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'elixir-pipe'),
      () => {},
    );
  }, 60000);

  it('detects module and functions', () => {
    const modules = getNodesByLabel(result, 'Module');
    expect(modules).toContain('Pipeline');

    const fns = getNodesByLabel(result, 'Function');
    expect(fns).toContain('process');
    expect(fns).toContain('step_one');
    expect(fns).toContain('step_two');
    expect(fns).toContain('step_three');
  });

  it('emits CALLS edges from pipe chain: process calls step_one, step_two, step_three', () => {
    const calls = getRelationships(result, 'CALLS');
    const processToSteps = calls.filter(e =>
      e.source === 'process' &&
      ['step_one', 'step_two', 'step_three'].includes(e.target)
    );
    // Each pipe stage should produce a call edge
    expect(processToSteps.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Phoenix framework detection
// ---------------------------------------------------------------------------

describe.skipIf(!elixirAvailable)('Elixir Phoenix framework detection', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'elixir-phoenix'),
      () => {},
    );
  }, 60000);

  it('detects controller, LiveView, and router modules', () => {
    const modules = getNodesByLabel(result, 'Module');
    expect(modules).toContain('MyAppWeb.UserController');
    expect(modules).toContain('MyAppWeb.UserLive');
    expect(modules).toContain('MyAppWeb.Router');
  });

  it('detects functions in controller', () => {
    const fns = getNodesByLabel(result, 'Function');
    expect(fns).toContain('index');
    expect(fns).toContain('show');
  });

  it('resolves alias import: controller → accounts', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const controllerToAccounts = imports.filter(e =>
      e.sourceFilePath.includes('user_controller.ex') &&
      e.targetFilePath.includes('accounts.ex')
    );
    expect(controllerToAccounts.length).toBeGreaterThanOrEqual(1);
  });

  it('emits EXTENDS edge from use Phoenix.Controller', () => {
    const extends_ = getRelationships(result, 'EXTENDS');
    const edge = extends_.find(e => e.sourceFilePath.includes('user_controller.ex'));
    expect(edge).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Behaviour heritage (use + @behaviour)
// ---------------------------------------------------------------------------

describe.skipIf(!elixirAvailable)('Elixir behaviour heritage', () => {

  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'elixir-behaviour'),
      () => {},
    );
  }, 60000);

  it('detects modules', () => {
    const modules = getNodesByLabel(result, 'Module');
    expect(modules).toContain('MyServer');
    expect(modules).toContain('Serializable');
  });

  it('detects functions including GenServer callbacks', () => {
    const fns = getNodesByLabel(result, 'Function');
    expect(fns).toContain('start_link');
    expect(fns).toContain('init');
    expect(fns).toContain('handle_call');
    expect(fns).toContain('serialize');
  });

  it('emits EXTENDS edges from use GenServer and @behaviour', () => {
    const heritage = getRelationships(result, 'EXTENDS');
    const targets = heritage.map(e => e.target);
    expect(targets).toContain('Class:GenServer');
  });

  it('emits IMPLEMENTS edges from @behaviour (alias and atom forms)', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    const targets = implements_.map(e => e.target);
    expect(targets).toContain('Serializable');
    // Atom-form: @behaviour :gen_server
    const atomTarget = implements_.find(e =>
      e.target.includes('gen_server') || e.rel.targetId.includes('gen_server')
    );
    expect(atomTarget).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Visibility (def = exported, defp = not exported)
// ---------------------------------------------------------------------------

describe.skipIf(!elixirAvailable)('Elixir def/defp visibility', () => {

  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'elixir-visibility'),
      () => {},
    );
  }, 60000);

  it('detects all functions (public and private)', () => {
    const fns = getNodesByLabel(result, 'Function');
    expect(fns).toContain('public_func');
    expect(fns).toContain('private_func');
  });

  it('detects macros (public and private)', () => {
    const macros = getNodesByLabel(result, 'Macro');
    expect(macros).toContain('public_macro');
    expect(macros).toContain('private_macro');
  });

  it('marks def functions as exported', () => {
    let found = false;
    result.graph.forEachNode(n => {
      if (n.properties.name === 'public_func') {
        expect(n.properties.isExported).toBe(true);
        found = true;
      }
    });
    expect(found).toBe(true);
  });

  it('marks defp functions as NOT exported', () => {
    let found = false;
    result.graph.forEachNode(n => {
      if (n.properties.name === 'private_func') {
        expect(n.properties.isExported).toBe(false);
        found = true;
      }
    });
    expect(found).toBe(true);
  });

  it('marks defmacro as exported', () => {
    let found = false;
    result.graph.forEachNode(n => {
      if (n.properties.name === 'public_macro') {
        expect(n.properties.isExported).toBe(true);
        found = true;
      }
    });
    expect(found).toBe(true);
  });

  it('marks defmacrop as NOT exported', () => {
    let found = false;
    result.graph.forEachNode(n => {
      if (n.properties.name === 'private_macro') {
        expect(n.properties.isExported).toBe(false);
        found = true;
      }
    });
    expect(found).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Member-based CALLS edges (Module.func())
// ---------------------------------------------------------------------------

describe.skipIf(!elixirAvailable)('Elixir member-based CALLS edges (Module.func())', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'elixir-member-calls'),
      () => {},
    );
  }, 60000);

  it('detects modules and functions', () => {
    const modules = getNodesByLabel(result, 'Module');
    expect(modules).toContain('MyApp.Repo');
    expect(modules).toContain('MyApp.Service');

    const fns = getNodesByLabel(result, 'Function');
    expect(fns).toContain('insert');
    expect(fns).toContain('save');
  });

  it('emits CALLS edge from save → insert', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveToInsert = calls.filter(e =>
      e.source === 'save' && e.target === 'insert'
    );
    expect(saveToInsert.length).toBeGreaterThanOrEqual(1);
  });

  it('CALLS edge targetFilePath contains repo.ex', () => {
    const calls = getRelationships(result, 'CALLS');
    const saveToInsert = calls.filter(e =>
      e.source === 'save' && e.target === 'insert'
    );
    expect(saveToInsert.length).toBeGreaterThanOrEqual(1);
    expect(saveToInsert[0].targetFilePath).toContain('repo.ex');
  });
});

// ---------------------------------------------------------------------------
// HAS_METHOD edges (functions have ownerId pointing to defmodule)
// ---------------------------------------------------------------------------

describe.skipIf(!elixirAvailable)('Elixir HAS_METHOD edges (defmodule ownerId)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'elixir-behaviour'),
      () => {},
    );
  }, 60000);

  it('functions inside defmodule have HAS_METHOD edges', () => {
    const hasMethods = getRelationships(result, 'HAS_METHOD');
    const myServerMethods = hasMethods.filter(e => e.source === 'MyServer');
    expect(myServerMethods.length).toBeGreaterThanOrEqual(1);
    const methodNames = myServerMethods.map(e => e.target);
    expect(methodNames).toContain('start_link');
  });
});

// ---------------------------------------------------------------------------
// defimpl creates IMPLEMENTS edges
// ---------------------------------------------------------------------------

describe.skipIf(!elixirAvailable)('Elixir defimpl IMPLEMENTS edges', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(FIXTURES, 'elixir-behaviour'),
      () => {},
    );
  }, 60000);

  it('emits IMPLEMENTS edge from defimpl for: Module → Protocol', () => {
    const implements_ = getRelationships(result, 'IMPLEMENTS');
    // defimpl Printable, for: MyServer should create an edge
    const printable = implements_.filter(e =>
      e.target.includes('Printable') || e.rel.targetId.includes('Printable')
    );
    expect(printable.length).toBeGreaterThanOrEqual(1);
  });
});
