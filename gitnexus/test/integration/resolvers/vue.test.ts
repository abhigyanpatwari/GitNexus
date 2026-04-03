/**
 * Vue SFC: script extraction, symbol parsing, import resolution, template component edges
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  FIXTURES,
  getRelationships,
  getNodesByLabel,
  getNodesByLabelFull,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';

describe('Vue SFC support', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'vue-basic'), () => {});
  }, 60000);

  // -------------------------------------------------------------------------
  // Symbol extraction from <script setup>
  // -------------------------------------------------------------------------

  it('extracts Function nodes from <script setup> .vue files', () => {
    const functions = getNodesByLabel(result, 'Function');
    // App.vue: onButtonClick; Button.vue: handleClick; types.ts: formatUser
    // OldStyle.vue: defineComponent call not a function definition, but greet/data might be
    expect(functions).toContain('handleClick');
    expect(functions).toContain('onButtonClick');
    expect(functions).toContain('formatUser');
  });

  it('extracts Interface nodes from .ts files used by .vue', () => {
    const interfaces = getNodesByLabel(result, 'Interface');
    expect(interfaces).toContain('User');
  });

  it('marks <script setup> top-level bindings as exported', () => {
    const allNodes = getNodesByLabelFull(result, 'Function');
    const handleClick = allNodes.find(
      (n) => n.properties.name === 'handleClick' && n.properties.filePath.endsWith('Button.vue'),
    );
    expect(handleClick).toBeDefined();
    expect(handleClick!.properties.isExported).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Line offset accuracy
  // -------------------------------------------------------------------------

  it('reports correct startLine in the .vue file (not offset 0)', () => {
    const allNodes = getNodesByLabelFull(result, 'Function');
    const handleClick = allNodes.find(
      (n) => n.properties.name === 'handleClick' && n.properties.filePath.endsWith('Button.vue'),
    );
    expect(handleClick).toBeDefined();
    // handleClick is inside <script setup> which starts after 7 lines of template
    // The function starts several lines into the script block
    expect(handleClick!.properties.startLine).toBeGreaterThan(5);
  });

  // -------------------------------------------------------------------------
  // Import resolution: .vue ↔ .ts
  // -------------------------------------------------------------------------

  it('resolves imports from .vue to .ts files', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const vueToTs = imports.filter(
      (e) => e.sourceFilePath.endsWith('App.vue') && e.targetFilePath.endsWith('types.ts'),
    );
    expect(vueToTs.length).toBeGreaterThanOrEqual(1);
  });

  it('resolves imports between .vue files', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const vueToVue = imports.filter(
      (e) => e.sourceFilePath.endsWith('App.vue') && e.targetFilePath.endsWith('Button.vue'),
    );
    expect(vueToVue.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // Cross-file function calls
  // -------------------------------------------------------------------------

  it('resolves CALLS edges from .vue to .ts functions', () => {
    const calls = getRelationships(result, 'CALLS');
    const vueToTs = calls.filter(
      (e) => e.sourceFilePath.endsWith('App.vue') && e.target === 'formatUser',
    );
    expect(vueToTs.length).toBeGreaterThanOrEqual(1);
  });

  it('emits CALLS edge for PascalCase component used in <template>', () => {
    const calls = getRelationships(result, 'CALLS');
    const templateCalls = calls.filter(
      (e) => e.sourceFilePath.endsWith('App.vue') && e.targetFilePath.endsWith('Button.vue'),
    );
    expect(templateCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('does not mark non-setup <script> symbols as implicitly exported', () => {
    const allNodes = getNodesByLabelFull(result, 'Function');
    const oldStyleFns = allNodes.filter((n) => n.properties.filePath.endsWith('OldStyle.vue'));
    // OldStyle.vue uses options API (no <script setup>), so any extracted
    // symbols without an explicit `export` keyword should have isExported: false.
    for (const fn of oldStyleFns) {
      expect(fn.properties.isExported).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // File nodes exist for .vue files
  // -------------------------------------------------------------------------

  it('creates File nodes for .vue files', () => {
    const files = getNodesByLabel(result, 'File');
    expect(files.some((f) => f.endsWith('.vue'))).toBe(true);
  });
});
