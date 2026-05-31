/**
 * Vue SFC: scope-based resolution (RFC #909 Ring 3, issue #940).
 *
 * Three fixture repos covering the main Vue SFC patterns:
 *
 *   - vue-composition-api — `<script setup lang="ts">` with cross-file
 *     imports, computed refs, defineProps/defineEmits macros.
 *   - vue-options-api     — `<script lang="ts">` with defineComponent,
 *     data()/methods/computed; `this.X()` method calls.
 *   - vue-cross-file      — composable functions, class models, multi-
 *     component app with cross-file CALLS chains.
 *
 * The `createResolverParityIt` wrapper runs each test under BOTH the
 * legacy DAG path (REGISTRY_PRIMARY_VUE=0) and the registry-primary
 * path (default) so the CI scope-parity gate can compare them.
 */

import { describe, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  getRelationships,
  getNodesByLabel,
  getNodesByLabelFull,
  runPipelineFromRepo,
  createResolverParityIt,
  type PipelineResult,
} from './helpers.js';

const VUE_SCOPE_FIXTURES = path.resolve(__dirname, '..', '..', 'fixtures', 'vue-scope');

const it = createResolverParityIt('vue');

// ─── Composition API (`<script setup lang="ts">`) ───────────────────────────

describe('Vue Composition API (<script setup>)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(
      path.join(VUE_SCOPE_FIXTURES, 'vue-composition-api'),
      () => {},
    );
  }, 60000);

  // Symbol extraction --------------------------------------------------------

  it('extracts Function nodes from <script setup> components', () => {
    const fns = getNodesByLabel(result, 'Function');
    expect(fns).toContain('loadData');
    expect(fns).toContain('handleSave');
    expect(fns).toContain('selectPost');
    expect(fns).toContain('getLabel');
    expect(fns).toContain('onPostSelected');
  });

  it('extracts Function nodes from .ts utility files', () => {
    const fns = getNodesByLabel(result, 'Function');
    expect(fns).toContain('formatUser');
    expect(fns).toContain('formatPost');
    expect(fns).toContain('fetchUser');
    expect(fns).toContain('fetchPosts');
    expect(fns).toContain('saveUser');
  });

  it('extracts Interface nodes from .ts files', () => {
    const ifaces = getNodesByLabel(result, 'Interface');
    expect(ifaces).toContain('User');
    expect(ifaces).toContain('Post');
  });

  // Import resolution --------------------------------------------------------

  it('resolves imports from .vue to .ts type files', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const vueToTypes = imports.filter(
      (e) => e.sourceFilePath.endsWith('UserProfile.vue') && e.targetFilePath.endsWith('types.ts'),
    );
    expect(vueToTypes.length).toBeGreaterThanOrEqual(1);
  });

  it('resolves imports from .vue to .ts api files', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const vueToApi = imports.filter(
      (e) => e.sourceFilePath.endsWith('UserProfile.vue') && e.targetFilePath.endsWith('api.ts'),
    );
    expect(vueToApi.length).toBeGreaterThanOrEqual(1);
  });

  it('resolves imports between .vue files', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const vueToVue = imports.filter(
      (e) => e.sourceFilePath.endsWith('App.vue') && e.targetFilePath.endsWith('UserProfile.vue'),
    );
    expect(vueToVue.length).toBeGreaterThanOrEqual(1);
  });

  // CALLS edges --------------------------------------------------------------

  it('emits CALLS edge from <script setup> to imported TS function (formatUser)', () => {
    const calls = getRelationships(result, 'CALLS');
    const toFormatUser = calls.filter(
      (e) => e.sourceFilePath.endsWith('UserProfile.vue') && e.target === 'formatUser',
    );
    expect(toFormatUser.length).toBeGreaterThanOrEqual(1);
  });

  it('emits CALLS edge from <script setup> to imported TS function (fetchUser)', () => {
    const calls = getRelationships(result, 'CALLS');
    const toFetchUser = calls.filter(
      (e) => e.sourceFilePath.endsWith('UserProfile.vue') && e.target === 'fetchUser',
    );
    expect(toFetchUser.length).toBeGreaterThanOrEqual(1);
  });

  it('emits CALLS edge from <script setup> to imported TS function (saveUser)', () => {
    const calls = getRelationships(result, 'CALLS');
    const toSaveUser = calls.filter(
      (e) => e.sourceFilePath.endsWith('UserProfile.vue') && e.target === 'saveUser',
    );
    expect(toSaveUser.length).toBeGreaterThanOrEqual(1);
  });

  it('emits CALLS edge from PostList.vue to formatPost', () => {
    const calls = getRelationships(result, 'CALLS');
    const toFormatPost = calls.filter(
      (e) => e.sourceFilePath.endsWith('PostList.vue') && e.target === 'formatPost',
    );
    expect(toFormatPost.length).toBeGreaterThanOrEqual(1);
  });

  // <script setup> top-level export ------------------------------------------

  it('marks <script setup> top-level functions as exported', () => {
    const allFns = getNodesByLabelFull(result, 'Function');
    const loadData = allFns.find(
      (n) => n.properties.name === 'loadData' && n.properties.filePath.endsWith('UserProfile.vue'),
    );
    expect(loadData).toBeDefined();
    expect(loadData!.properties.isExported).toBe(true);
  });

  it('marks <script setup> top-level functions in PostList as exported', () => {
    const allFns = getNodesByLabelFull(result, 'Function');
    const selectPost = allFns.find(
      (n) => n.properties.name === 'selectPost' && n.properties.filePath.endsWith('PostList.vue'),
    );
    expect(selectPost).toBeDefined();
    expect(selectPost!.properties.isExported).toBe(true);
  });

  // File nodes ---------------------------------------------------------------

  it('creates File nodes for .vue files', () => {
    const files = getNodesByLabel(result, 'File');
    expect(files.some((f) => f.endsWith('UserProfile.vue'))).toBe(true);
    expect(files.some((f) => f.endsWith('PostList.vue'))).toBe(true);
    expect(files.some((f) => f.endsWith('App.vue'))).toBe(true);
  });
});

// ─── Options API (`<script lang="ts">` + defineComponent) ──────────────────

describe('Vue Options API (defineComponent)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(VUE_SCOPE_FIXTURES, 'vue-options-api'), () => {});
  }, 60000);

  // Symbol extraction --------------------------------------------------------

  it('extracts Function nodes from methods block', () => {
    const fns = getNodesByLabel(result, 'Function');
    // TodoList methods
    expect(fns).toContain('addTodo');
    expect(fns).toContain('toggleItem');
    expect(fns).toContain('clearDone');
    // Counter methods
    expect(fns).toContain('increment');
    expect(fns).toContain('decrement');
    expect(fns).toContain('reset');
  });

  it('extracts utility functions from .ts file', () => {
    const fns = getNodesByLabel(result, 'Function');
    expect(fns).toContain('createTodo');
    expect(fns).toContain('toggleTodo');
    expect(fns).toContain('filterDone');
    expect(fns).toContain('filterPending');
  });

  it('extracts Interface node for Todo', () => {
    const ifaces = getNodesByLabel(result, 'Interface');
    expect(ifaces).toContain('Todo');
  });

  // Import resolution --------------------------------------------------------

  it('resolves imports from Options API .vue to .ts utils', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const vueToUtils = imports.filter(
      (e) => e.sourceFilePath.endsWith('TodoList.vue') && e.targetFilePath.endsWith('utils.ts'),
    );
    expect(vueToUtils.length).toBeGreaterThanOrEqual(1);
  });

  // CALLS edges --------------------------------------------------------------

  it('emits CALLS edge from Options API component to imported createTodo', () => {
    const calls = getRelationships(result, 'CALLS');
    const toCreateTodo = calls.filter(
      (e) => e.sourceFilePath.endsWith('TodoList.vue') && e.target === 'createTodo',
    );
    expect(toCreateTodo.length).toBeGreaterThanOrEqual(1);
  });

  it('emits CALLS edge from Options API component to imported filterDone', () => {
    const calls = getRelationships(result, 'CALLS');
    const toFilterDone = calls.filter(
      (e) => e.sourceFilePath.endsWith('TodoList.vue') && e.target === 'filterDone',
    );
    expect(toFilterDone.length).toBeGreaterThanOrEqual(1);
  });

  it('emits CALLS edge from Options API component to imported filterPending', () => {
    const calls = getRelationships(result, 'CALLS');
    const toFilterPending = calls.filter(
      (e) => e.sourceFilePath.endsWith('TodoList.vue') && e.target === 'filterPending',
    );
    expect(toFilterPending.length).toBeGreaterThanOrEqual(1);
  });

  it('emits CALLS edge from clearDone to filterPending', () => {
    const calls = getRelationships(result, 'CALLS');
    const toClearDone = calls.filter(
      (e) => e.source === 'clearDone' && e.target === 'filterPending',
    );
    expect(toClearDone.length).toBeGreaterThanOrEqual(1);
  });

  // Non-setup scripts should not be implicitly exported ----------------------

  it('does not mark non-setup <script> methods as implicitly exported', () => {
    const allFns = getNodesByLabelFull(result, 'Function');
    const addTodo = allFns.find(
      (n) => n.properties.name === 'addTodo' && n.properties.filePath.endsWith('TodoList.vue'),
    );
    if (addTodo !== undefined) {
      // Options API methods inside defineComponent are not top-level exports
      expect(addTodo.properties.isExported).toBe(false);
    }
  });

  // File nodes ---------------------------------------------------------------

  it('creates File nodes for Options API .vue files', () => {
    const files = getNodesByLabel(result, 'File');
    expect(files.some((f) => f.endsWith('TodoList.vue'))).toBe(true);
    expect(files.some((f) => f.endsWith('Counter.vue'))).toBe(true);
  });
});

// ─── Cross-file: composables + class models ─────────────────────────────────

describe('Vue cross-file composable and class resolution', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(VUE_SCOPE_FIXTURES, 'vue-cross-file'), () => {});
  }, 60000);

  // Symbol extraction --------------------------------------------------------

  it('extracts Class nodes from .ts model file', () => {
    const classes = getNodesByLabel(result, 'Class');
    expect(classes).toContain('UserModel');
    expect(classes).toContain('PostModel');
  });

  it('extracts Method nodes from UserModel', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('isAdmin');
    expect(methods).toContain('displayName');
  });

  it('extracts Method nodes from PostModel', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('summary');
    expect(methods).toContain('wordCount');
  });

  it('extracts composable functions from useUser.ts', () => {
    const fns = getNodesByLabel(result, 'Function');
    expect(fns).toContain('useUser');
    expect(fns).toContain('useUserList');
  });

  it('extracts composable functions from usePost.ts', () => {
    const fns = getNodesByLabel(result, 'Function');
    expect(fns).toContain('usePost');
  });

  // Import resolution --------------------------------------------------------

  it('resolves imports from composable to model file', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const compToModel = imports.filter(
      (e) => e.sourceFilePath.endsWith('useUser.ts') && e.targetFilePath.endsWith('models.ts'),
    );
    expect(compToModel.length).toBeGreaterThanOrEqual(1);
  });

  it('resolves imports from <script setup> to composable', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const vueToComp = imports.filter(
      (e) => e.sourceFilePath.endsWith('UserCard.vue') && e.targetFilePath.endsWith('useUser.ts'),
    );
    expect(vueToComp.length).toBeGreaterThanOrEqual(1);
  });

  it('resolves imports from App.vue to composable', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const appToComp = imports.filter(
      (e) => e.sourceFilePath.endsWith('App.vue') && e.targetFilePath.endsWith('useUser.ts'),
    );
    expect(appToComp.length).toBeGreaterThanOrEqual(1);
  });

  it('resolves imports from App.vue to models.ts', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const appToModel = imports.filter(
      (e) => e.sourceFilePath.endsWith('App.vue') && e.targetFilePath.endsWith('models.ts'),
    );
    expect(appToModel.length).toBeGreaterThanOrEqual(1);
  });

  // CALLS edges --------------------------------------------------------------

  it('emits CALLS edge from UserCard.vue to useUser composable', () => {
    const calls = getRelationships(result, 'CALLS');
    const toUseUser = calls.filter(
      (e) => e.sourceFilePath.endsWith('UserCard.vue') && e.target === 'useUser',
    );
    expect(toUseUser.length).toBeGreaterThanOrEqual(1);
  });

  it('emits CALLS edge from PostCard.vue to usePost composable', () => {
    const calls = getRelationships(result, 'CALLS');
    const toUsePost = calls.filter(
      (e) => e.sourceFilePath.endsWith('PostCard.vue') && e.target === 'usePost',
    );
    expect(toUsePost.length).toBeGreaterThanOrEqual(1);
  });

  it('emits CALLS edge from App.vue to useUserList composable', () => {
    const calls = getRelationships(result, 'CALLS');
    const toUseUserList = calls.filter(
      (e) => e.sourceFilePath.endsWith('App.vue') && e.target === 'useUserList',
    );
    expect(toUseUserList.length).toBeGreaterThanOrEqual(1);
  });

  it('emits CALLS edge from useUser.ts to UserModel constructor', () => {
    const calls = getRelationships(result, 'CALLS');
    const toUserModel = calls.filter(
      (e) => e.sourceFilePath.endsWith('useUser.ts') && e.target === 'UserModel',
    );
    expect(toUserModel.length).toBeGreaterThanOrEqual(1);
  });

  it('emits CALLS edge from App.vue to addUser (composable return)', () => {
    const calls = getRelationships(result, 'CALLS');
    const toAddUser = calls.filter(
      (e) => e.sourceFilePath.endsWith('App.vue') && e.target === 'addUser',
    );
    expect(toAddUser.length).toBeGreaterThanOrEqual(1);
  });

  // File nodes ---------------------------------------------------------------

  it('creates File nodes for all .vue and .ts files', () => {
    const files = getNodesByLabel(result, 'File');
    expect(files.some((f) => f.endsWith('UserCard.vue'))).toBe(true);
    expect(files.some((f) => f.endsWith('PostCard.vue'))).toBe(true);
    expect(files.some((f) => f.endsWith('useUser.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('models.ts'))).toBe(true);
  });
});
