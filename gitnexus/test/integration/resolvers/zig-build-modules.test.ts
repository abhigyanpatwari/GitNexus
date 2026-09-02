/**
 * Zig: per-build-module import tables (PR #1432 review, finding 8.2).
 *
 * `build.zig` binds bare-name aliases PER MODULE (`exe.root_module.addImport
 * ("config", …)`); flattening every alias into one repo-wide first-wins map
 * sent the second module's `@import("config")` to the first module's file.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  edgeSet,
  FIXTURES,
  getRelationships,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';
import { SupportedLanguages } from '../../../src/config/supported-languages.js';
import { describeGrammarPresence, optionalGrammarGate } from '../../helpers/optional-grammar.js';

const zig = optionalGrammarGate(SupportedLanguages.Zig);
const zigAvailable = zig.available;

describeGrammarPresence(zig);

describe.skipIf(!zigAvailable)('Zig per-module build imports (zig-buildmodules fixture)', () => {
  let result: PipelineResult;
  let imports: string[];
  let calls: Set<string>;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'zig-buildmodules'), () => {});
    imports = getRelationships(result, 'IMPORTS').map(
      (e) => `${e.sourceFilePath.replace(/\\/g, '/')} → ${e.targetFilePath.replace(/\\/g, '/')}`,
    );
    calls = edgeSet(getRelationships(result, 'CALLS'));
  }, 60000);

  it('resolves each module’s `@import("config")` through ITS OWN import table, not the first-declared alias', () => {
    // Before: one `config → src/app/config.zig` entry for the whole repo, so
    // tool/main.zig imported app's config and `config.load_tool()` resolved
    // nothing (while `impact` on app's `load_app` gained a phantom caller).
    expect(imports).toContain('src/app/main.zig → src/app/config.zig');
    expect(imports).toContain('src/tool/main.zig → src/tool/config.zig');
    expect(imports).not.toContain('src/tool/main.zig → src/app/config.zig');
    expect(calls).toContain('main → load_app');
    expect(calls).toContain('run_tool → load_tool');
  });

  it('resolves `addImport("api", dep.module("core"))` through the path dep’s own `addModule("core")`', () => {
    // `dep.module(…)` operands were deliberately unmodelled; the alias stayed
    // unresolved even though the dep's build.zig names the module statically.
    expect(imports).toContain('src/app/main.zig → libs/corelib/src/core.zig');
    expect(calls).toContain('main → ping');
  });

  it('resolves a module ROOT through its own table even when it shares a directory with a disagreeing module', () => {
    expect(imports).toContain('src/shared/a.zig → src/shared/clash_a.zig');
    expect(imports).toContain('src/shared/b.zig → src/shared/clash_b.zig');
    expect(calls).toContain('use_a → hit_a');
    expect(calls).toContain('use_b → hit_b');
  });

  it('fails closed for a non-root file whose same-directory modules disagree on the alias', () => {
    // helper.zig belongs to neither root; `shared_a` says clash_a.zig and
    // `shared_b` says clash_b.zig. First-wins would emit helper → clash_a —
    // a confident wrong edge — so the import resolves nothing instead.
    expect(imports.some((e) => e.startsWith('src/shared/helper.zig → '))).toBe(false);
    expect(calls).not.toContain('use_helper → hit_a');
  });
});
