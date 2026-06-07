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
 */

import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import {
  getRelationships,
  getNodesByLabel,
  getNodesByLabelFull,
  runPipelineFromRepo,
  type PipelineResult,
} from './helpers.js';

const VUE_SCOPE_FIXTURES = path.resolve(__dirname, '..', '..', 'fixtures', 'vue-scope');

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

  it('resolves value imports from UserProfile.vue to types.ts', () => {
    const imports = getRelationships(result, 'IMPORTS');
    // File-level IMPORTS edge: multiple imported symbols collapse to one edge.
    const vueToTypes = imports.filter(
      (e) => e.sourceFilePath.endsWith('UserProfile.vue') && e.targetFilePath.endsWith('types.ts'),
    );
    expect(vueToTypes.length).toBe(1);
  });

  it('resolves value imports from UserProfile.vue to api.ts', () => {
    const imports = getRelationships(result, 'IMPORTS');
    // File-level IMPORTS edge: multiple imported symbols collapse to one edge.
    const vueToApi = imports.filter(
      (e) => e.sourceFilePath.endsWith('UserProfile.vue') && e.targetFilePath.endsWith('api.ts'),
    );
    expect(vueToApi.length).toBe(1);
  });

  it('resolves default import from App.vue to UserProfile.vue', () => {
    const imports = getRelationships(result, 'IMPORTS');
    // import UserProfile from './UserProfile.vue' → 1 default-import edge
    const vueToVue = imports.filter(
      (e) => e.sourceFilePath.endsWith('App.vue') && e.targetFilePath.endsWith('UserProfile.vue'),
    );
    expect(vueToVue.length).toBe(1);
  });

  // CALLS edges --------------------------------------------------------------

  it('emits CALLS edge from <script setup> to imported formatUser', () => {
    const calls = getRelationships(result, 'CALLS');
    const toFormatUser = calls.filter(
      (e) => e.sourceFilePath.endsWith('UserProfile.vue') && e.target === 'formatUser',
    );
    expect(toFormatUser.length).toBe(1);
  });

  it('emits CALLS edge from <script setup> to imported fetchUser', () => {
    const calls = getRelationships(result, 'CALLS');
    const toFetchUser = calls.filter(
      (e) => e.sourceFilePath.endsWith('UserProfile.vue') && e.target === 'fetchUser',
    );
    expect(toFetchUser.length).toBe(1);
  });

  it('emits CALLS edge from <script setup> to imported saveUser', () => {
    const calls = getRelationships(result, 'CALLS');
    const toSaveUser = calls.filter(
      (e) => e.sourceFilePath.endsWith('UserProfile.vue') && e.target === 'saveUser',
    );
    expect(toSaveUser.length).toBe(1);
  });

  it('emits CALLS edge from PostList.vue to formatPost', () => {
    const calls = getRelationships(result, 'CALLS');
    const toFormatPost = calls.filter(
      (e) => e.sourceFilePath.endsWith('PostList.vue') && e.target === 'formatPost',
    );
    expect(toFormatPost.length).toBe(1);
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

  // Template event-handler CALLS --------------------------------------------

  it('emits CALLS edge from @click="handleSave" in UserProfile.vue template', () => {
    const calls = getRelationships(result, 'CALLS');
    const templateToSave = calls.filter(
      (e) =>
        e.sourceFilePath.endsWith('UserProfile.vue') &&
        e.target === 'handleSave' &&
        e.rel.reason === 'vue-template-callback',
    );
    expect(templateToSave.length).toBe(1);
  });

  it('emits BINDS_EVENT_HANDLER from onPostSelected to PostList (component event)', () => {
    const bindings = getRelationships(result, 'BINDS_EVENT_HANDLER');
    const toPostList = bindings.filter(
      (e) =>
        e.sourceFilePath.endsWith('App.vue') &&
        e.source === 'onPostSelected' &&
        e.targetFilePath.endsWith('PostList.vue') &&
        e.rel.reason === 'vue-event: @select',
    );
    expect(toPostList.length).toBe(1);
  });

  it('emits EMITS_EVENT from PostList.vue for emit("select")', () => {
    const emits = getRelationships(result, 'EMITS_EVENT');
    const postListEmit = emits.filter(
      (e) => e.sourceFilePath.endsWith('PostList.vue') && e.rel.reason === 'vue-emit: select',
    );
    expect(postListEmit.length).toBe(1);
  });

  // Template attribute-binding ACCESSES -------------------------------------

  it('emits ACCESSES edge for :userId="currentUserId" in App.vue template', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    const attrAccess = accesses.filter(
      (e) =>
        e.sourceFilePath.endsWith('App.vue') &&
        e.target === 'currentUserId' &&
        e.rel.reason === 'vue-template-attribute',
    );
    expect(attrAccess.length).toBe(1);
  });

  it('emits ACCESSES edge for :posts="allPosts" in App.vue template', () => {
    const accesses = getRelationships(result, 'ACCESSES');
    const attrAccess = accesses.filter(
      (e) =>
        e.sourceFilePath.endsWith('App.vue') &&
        e.target === 'allPosts' &&
        e.rel.reason === 'vue-template-attribute',
    );
    expect(attrAccess.length).toBe(1);
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

  it('extracts Method nodes from methods block', () => {
    const methods = getNodesByLabel(result, 'Method');
    expect(methods).toContain('addTodo');
    expect(methods).toContain('toggleItem');
    expect(methods).toContain('clearDone');
    expect(methods).toContain('increment');
    expect(methods).toContain('decrement');
    expect(methods).toContain('reset');
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

  it('resolves value imports from TodoList.vue to utils.ts', () => {
    const imports = getRelationships(result, 'IMPORTS');
    // File-level IMPORTS edge: multiple imported symbols collapse to one edge.
    const vueToUtils = imports.filter(
      (e) => e.sourceFilePath.endsWith('TodoList.vue') && e.targetFilePath.endsWith('utils.ts'),
    );
    expect(vueToUtils.length).toBe(1);
  });

  // CALLS edges --------------------------------------------------------------

  it('emits CALLS edge from addTodo in TodoList.vue to createTodo', () => {
    const calls = getRelationships(result, 'CALLS');
    const toCreateTodo = calls.filter(
      (e) => e.sourceFilePath.endsWith('TodoList.vue') && e.target === 'createTodo',
    );
    expect(toCreateTodo.length).toBe(1);
  });

  it('emits CALLS edge from TodoList.vue to filterDone (computed doneCount)', () => {
    const calls = getRelationships(result, 'CALLS');
    const toFilterDone = calls.filter(
      (e) => e.sourceFilePath.endsWith('TodoList.vue') && e.target === 'filterDone',
    );
    expect(toFilterDone.length).toBe(1);
  });

  it('emits CALLS edge from TodoList.vue to filterPending (computed pendingTodos)', () => {
    const calls = getRelationships(result, 'CALLS');
    const toFilterPending = calls.filter(
      (e) => e.sourceFilePath.endsWith('TodoList.vue') && e.target === 'filterPending',
    );
    // Two call sites in the same file: `pendingTodos` and `clearDone`.
    expect(toFilterPending.length).toBe(2);
  });

  it('emits CALLS edge from clearDone to filterPending', () => {
    const calls = getRelationships(result, 'CALLS');
    const toClearDone = calls.filter(
      (e) => e.source === 'clearDone' && e.target === 'filterPending',
    );
    expect(toClearDone.length).toBe(1);
  });

  // Non-setup scripts should not be implicitly exported ----------------------

  it('does not mark non-setup <script> methods as implicitly exported', () => {
    const allFns = getNodesByLabelFull(result, 'Function');
    const addTodo = allFns.find(
      (n) => n.properties.name === 'addTodo' && n.properties.filePath.endsWith('TodoList.vue'),
    );
    if (addTodo !== undefined) {
      expect(addTodo.properties.isExported).toBe(false);
    }
  });

  // Template event-handler CALLS --------------------------------------------

  it('emits CALLS edge from @keyup.enter="addTodo" in TodoList.vue template', () => {
    const calls = getRelationships(result, 'CALLS');
    const templateToAdd = calls.filter(
      (e) =>
        e.sourceFilePath.endsWith('TodoList.vue') &&
        e.target === 'addTodo' &&
        e.rel.reason === 'vue-template-callback',
    );
    expect(templateToAdd.length).toBe(1);
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

  it('extracts composable function usePost from usePost.ts', () => {
    const fns = getNodesByLabel(result, 'Function');
    expect(fns).toContain('usePost');
  });

  // Import resolution --------------------------------------------------------

  it('resolves import from useUser.ts to models.ts (1 named export: UserModel)', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const compToModel = imports.filter(
      (e) => e.sourceFilePath.endsWith('useUser.ts') && e.targetFilePath.endsWith('models.ts'),
    );
    expect(compToModel.length).toBe(1);
  });

  it('resolves import from UserCard.vue to useUser.ts (1 named export: useUser)', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const vueToComp = imports.filter(
      (e) => e.sourceFilePath.endsWith('UserCard.vue') && e.targetFilePath.endsWith('useUser.ts'),
    );
    expect(vueToComp.length).toBe(1);
  });

  it('resolves import from App.vue to useUser.ts (1 named export: useUserList)', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const appToComp = imports.filter(
      (e) => e.sourceFilePath.endsWith('App.vue') && e.targetFilePath.endsWith('useUser.ts'),
    );
    expect(appToComp.length).toBe(1);
  });

  it('resolves import from App.vue to models.ts (1 named export: UserModel)', () => {
    const imports = getRelationships(result, 'IMPORTS');
    const appToModel = imports.filter(
      (e) => e.sourceFilePath.endsWith('App.vue') && e.targetFilePath.endsWith('models.ts'),
    );
    expect(appToModel.length).toBe(1);
  });

  // CALLS edges --------------------------------------------------------------

  it('emits CALLS edge from UserCard.vue to useUser composable', () => {
    const calls = getRelationships(result, 'CALLS');
    const toUseUser = calls.filter(
      (e) => e.sourceFilePath.endsWith('UserCard.vue') && e.target === 'useUser',
    );
    expect(toUseUser.length).toBe(1);
  });

  it('emits CALLS edge from PostCard.vue to usePost composable', () => {
    const calls = getRelationships(result, 'CALLS');
    const toUsePost = calls.filter(
      (e) => e.sourceFilePath.endsWith('PostCard.vue') && e.target === 'usePost',
    );
    expect(toUsePost.length).toBe(1);
  });

  it('emits CALLS edge from App.vue to useUserList composable', () => {
    const calls = getRelationships(result, 'CALLS');
    const toUseUserList = calls.filter(
      (e) => e.sourceFilePath.endsWith('App.vue') && e.target === 'useUserList',
    );
    expect(toUseUserList.length).toBe(1);
  });

  it('emits CALLS edge from useUser.ts to UserModel constructor', () => {
    const calls = getRelationships(result, 'CALLS');
    const toUserModel = calls.filter(
      (e) => e.sourceFilePath.endsWith('useUser.ts') && e.target === 'UserModel',
    );
    expect(toUserModel.length).toBe(1);
  });

  it('does not currently emit CALLS edge to addUser returned from useUserList', () => {
    const calls = getRelationships(result, 'CALLS');
    const toAddUser = calls.filter(
      (e) => e.sourceFilePath.endsWith('App.vue') && e.target === 'addUser',
    );
    expect(toAddUser.length).toBe(0);
  });

  // Template event-handler CALLS --------------------------------------------

  it('emits BINDS_EVENT_HANDLER from onUserLoaded to UserCard (component event)', () => {
    const bindings = getRelationships(result, 'BINDS_EVENT_HANDLER');
    const toUserCard = bindings.filter(
      (e) =>
        e.sourceFilePath.endsWith('App.vue') &&
        e.source === 'onUserLoaded' &&
        e.targetFilePath.endsWith('UserCard.vue') &&
        e.rel.reason === 'vue-event: @loaded',
    );
    expect(toUserCard.length).toBe(1);
  });

  it('emits EMITS_EVENT from UserCard.vue for emit("loaded")', () => {
    const emits = getRelationships(result, 'EMITS_EVENT');
    const userCardEmit = emits.filter(
      (e) => e.sourceFilePath.endsWith('UserCard.vue') && e.rel.reason === 'vue-emit: loaded',
    );
    expect(userCardEmit.length).toBe(1);
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

// ---------------------------------------------------------------------------
// F90 — dual-script merge (<script> + <script setup>)
// ---------------------------------------------------------------------------

describe('F90 — dual-script (<script> + <script setup>)', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(VUE_SCOPE_FIXTURES, 'vue-dual-script'), () => {});
  }, 60000);

  it('includes symbols from both the non-setup and setup blocks', () => {
    const funcs = getNodesByLabel(result, 'Function');
    expect(funcs).toContain('legacySetup');
    expect(funcs).toContain('setupInit');
  });
});

// ---------------------------------------------------------------------------
// F92 — JS-lang script block (<script lang="js">)
// ---------------------------------------------------------------------------

describe('F92 — JS-lang script block', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(VUE_SCOPE_FIXTURES, 'vue-js-lang'), () => {});
  }, 60000);

  it('parses <script lang="js"> content and finds functions', () => {
    const funcs = getNodesByLabel(result, 'Function');
    expect(funcs).toContain('greet');
  });
});
