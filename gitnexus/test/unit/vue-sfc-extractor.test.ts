import { describe, it, expect } from 'vitest';
import {
  extractVueScript,
  extractTemplateComponents,
  extractScriptEmitCalls,
  extractComponentEventBindings,
  extractNativeElementEventHandlers,
} from '../../src/core/ingestion/vue-sfc-extractor.js';

describe('extractVueScript', () => {
  it('extracts <script setup lang="ts"> content', () => {
    const vue = `<template>
  <div>Hello</div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

const count = ref(0);
</script>
`;
    const result = extractVueScript(vue);
    expect(result).not.toBeNull();
    expect(result!.isSetup).toBe(true);
    expect(result!.scriptContent).toContain("import { ref } from 'vue'");
    expect(result!.scriptContent).toContain('const count = ref(0)');
    // Line 0-3 is template + blank, line 4 is <script setup>, content starts at line 5
    expect(result!.lineOffset).toBe(5);
  });

  it('extracts <script lang="ts"> (non-setup)', () => {
    const vue = `<template>
  <div>Hello</div>
</template>

<script lang="ts">
export default {
  name: 'MyComponent',
};
</script>
`;
    const result = extractVueScript(vue);
    expect(result).not.toBeNull();
    expect(result!.isSetup).toBe(false);
    expect(result!.scriptContent).toContain('export default');
  });

  it('combines both blocks when <script> and <script setup> both exist', () => {
    const vue = `<script lang="ts">
export default {
  inheritAttrs: false,
};
</script>
<script setup lang="ts">
import { ref } from 'vue';
const name = ref('test');
</script>

<template><div /></template>
`;
    const result = extractVueScript(vue);
    expect(result).not.toBeNull();
    // F90: both blocks are combined
    expect(result!.isSetup).toBe(true);
    expect(result!.scriptContent).toContain("const name = ref('test')");
    expect(result!.scriptContent).toContain('inheritAttrs');
  });

  it('returns lang from the script block', () => {
    const vue = `<script lang="js">
export default {};
</script>
`;
    const result = extractVueScript(vue);
    expect(result).not.toBeNull();
    expect(result!.lang).toBe('js');
  });

  it('returns empty lang when no lang attribute', () => {
    const vue = `<script>
export default {};
</script>
`;
    const result = extractVueScript(vue);
    expect(result).not.toBeNull();
    expect(result!.lang).toBe('');
  });

  it('jsx lang triggers JS grammar (maps to lang=js)', () => {
    const vue = `<script lang="jsx">
export default {};
</script>
`;
    const result = extractVueScript(vue);
    expect(result).not.toBeNull();
    expect(result!.lang).toBe('js');
  });

  it('ts lang returns empty (only js/jsx triggers JS grammar)', () => {
    const vue = `<script lang="ts">
export default {};
</script>
`;
    const result = extractVueScript(vue);
    expect(result).not.toBeNull();
    expect(result!.lang).toBe('');
  });

  it('mixed js + ts blocks return empty lang (TypeScript wins)', () => {
    const vue = `<script lang="js">
export default {};
</script>
<script setup lang="ts">
import { ref } from 'vue';
</script>
`;
    const result = extractVueScript(vue);
    expect(result).not.toBeNull();
    expect(result!.lang).toBe('');
  });

  it('isSetup is true when at least one block is setup', () => {
    const vue = `<script lang="ts">
export default {};
</script>
<script setup lang="ts">
import { ref } from 'vue';
</script>
`;
    const result = extractVueScript(vue);
    expect(result).not.toBeNull();
    expect(result!.isSetup).toBe(true);
    // ts blocks — lang should be empty
    expect(result!.lang).toBe('');
  });

  it('returns null for .vue files with no <script> block', () => {
    const vue = `<template>
  <div>Hello</div>
</template>

<style scoped>
div { color: red; }
</style>
`;
    expect(extractVueScript(vue)).toBeNull();
  });

  it('handles <script> without lang attribute', () => {
    const vue = `<template><div /></template>

<script>
export default { name: 'NoLang' };
</script>
`;
    const result = extractVueScript(vue);
    expect(result).not.toBeNull();
    expect(result!.scriptContent).toContain('NoLang');
    expect(result!.isSetup).toBe(false);
  });

  it('handles <script setup> without lang attribute', () => {
    const vue = `<template><div /></template>

<script setup>
const x = 1;
</script>
`;
    const result = extractVueScript(vue);
    expect(result).not.toBeNull();
    expect(result!.isSetup).toBe(true);
    expect(result!.scriptContent).toContain('const x = 1');
  });

  it('computes correct lineOffset for script at top of file', () => {
    const vue = `<script setup lang="ts">
const x = 1;
</script>

<template><div /></template>
`;
    const result = extractVueScript(vue);
    expect(result).not.toBeNull();
    // <script> tag is line 0, content starts at line 1
    expect(result!.lineOffset).toBe(1);
  });

  it('handles multiline script tag attributes', () => {
    const vue = `<template><div /></template>

<script
  setup
  lang="ts"
>
import { ref } from 'vue';
</script>
`;
    const result = extractVueScript(vue);
    expect(result).not.toBeNull();
    expect(result!.isSetup).toBe(true);
    expect(result!.scriptContent).toContain("import { ref } from 'vue'");
  });
});

describe('extractTemplateComponents', () => {
  it('finds PascalCase component tags', () => {
    const vue = `<template>
  <div>
    <MyButton @click="doSomething" />
    <AppHeader title="hello" />
    <span>text</span>
  </div>
</template>

<script setup lang="ts">
// ...
</script>
`;
    const components = extractTemplateComponents(vue);
    expect(components).toContain('MyButton');
    expect(components).toContain('AppHeader');
    expect(components).not.toContain('div');
    expect(components).not.toContain('span');
  });

  it('returns empty array when no template', () => {
    const vue = `<script setup lang="ts">
const x = 1;
</script>
`;
    expect(extractTemplateComponents(vue)).toEqual([]);
  });

  it('deduplicates repeated component usage', () => {
    const vue = `<template>
  <MyButton />
  <MyButton />
  <MyButton />
</template>
`;
    const components = extractTemplateComponents(vue);
    expect(components.filter((c) => c === 'MyButton')).toHaveLength(1);
  });

  it('ignores HTML elements and lowercase tags', () => {
    const vue = `<template>
  <div>
    <p>text</p>
    <router-view />
    <transition name="fade">
      <MyComponent />
    </transition>
  </div>
</template>
`;
    const components = extractTemplateComponents(vue);
    expect(components).toEqual(['MyComponent']);
  });

  it('treats kebab-case component tags as component candidates', () => {
    const vue = `<template>
  <div>
    <post-list />
    <user-card />
  </div>
</template>`;
    const components = extractTemplateComponents(vue);
    expect(components).toContain('PostList');
    expect(components).toContain('UserCard');
  });
});

describe('extractScriptEmitCalls', () => {
  it('extracts bare emit() event names', () => {
    const vue = `<script setup lang="ts">
const emit = defineEmits(['select']);
emit('select', { id: 1 });
</script>`;
    expect(extractScriptEmitCalls(vue).map((c) => c.eventName)).toEqual(['select']);
  });

  it('ignores property emits and commented/string emit text', () => {
    const vue = `<script setup lang="ts">
const socket = createSocket();
socket.emit('message');
// emit('commented')
const text = "emit('inside-string')";
emit('actual');
</script>`;
    expect(extractScriptEmitCalls(vue).map((c) => c.eventName)).toEqual(['actual']);
  });
});

describe('extractComponentEventBindings', () => {
  it('captures kebab-case component event bindings', () => {
    const vue = `<template>
  <post-list @select="onPostSelected" />
</template>`;
    expect(extractComponentEventBindings(vue)).toEqual([
      { componentName: 'PostList', eventName: 'select', handlerName: 'onPostSelected' },
    ]);
  });

  it('captures hyphenated event names (@user-loaded)', () => {
    const vue = `<template>
  <UserCard @user-loaded="onUserLoaded" />
</template>`;
    const bindings = extractComponentEventBindings(vue);
    expect(bindings).toContainEqual({
      componentName: 'UserCard',
      eventName: 'user-loaded',
      handlerName: 'onUserLoaded',
    });
  });

  it('captures update:model-value style event names', () => {
    const vue = `<template>
  <MyInput @update:model-value="onChange" />
</template>`;
    const bindings = extractComponentEventBindings(vue);
    expect(bindings).toContainEqual({
      componentName: 'MyInput',
      eventName: 'update:model-value',
      handlerName: 'onChange',
    });
  });
});

describe('extractNativeElementEventHandlers', () => {
  it('captures handlers from native elements', () => {
    const vue = `<template>
  <button @click="handleSave" />
  <form @submit.prevent="onSubmit" />
</template>`;
    const handlers = extractNativeElementEventHandlers(vue);
    expect(handlers).toContain('handleSave');
    expect(handlers).toContain('onSubmit');
  });

  it('does not emit handlers for kebab-case component tags', () => {
    // <post-list> is a Vue component, not a native element.
    // The NATIVE_TAG_RE negative lookahead must prevent matching `post` as a native tag.
    const vue = `<template>
  <post-list @select="onSelect" />
  <button @click="handleClick" />
</template>`;
    const handlers = extractNativeElementEventHandlers(vue);
    expect(handlers).not.toContain('onSelect');
    expect(handlers).toContain('handleClick');
  });
});

describe('extractScriptEmitCalls — Options API this.$emit', () => {
  it('captures this.$emit() in Options API components', () => {
    const vue = `<script lang="ts">
export default {
  methods: {
    save() {
      this.$emit('save');
      this.$emit('update:modelValue', this.value);
    },
  },
};
</script>`;
    const events = extractScriptEmitCalls(vue).map((c) => c.eventName);
    expect(events).toContain('save');
    expect(events).toContain('update:modelValue');
  });

  it('does NOT capture socket.emit() or eventBus.emit() as component events', () => {
    const vue = `<script setup lang="ts">
const socket = getSocket();
socket.emit('message');
eventBus.emit('data');
emit('actual');
</script>`;
    const events = extractScriptEmitCalls(vue).map((c) => c.eventName);
    expect(events).toEqual(['actual']);
    expect(events).not.toContain('message');
    expect(events).not.toContain('data');
  });

  it('captures update:modelValue style event names with colon', () => {
    const vue = `<script setup lang="ts">
const emit = defineEmits(['update:modelValue', 'user-loaded']);
emit('update:modelValue', newVal);
emit('user-loaded');
</script>`;
    const events = extractScriptEmitCalls(vue).map((c) => c.eventName);
    expect(events).toContain('update:modelValue');
    expect(events).toContain('user-loaded');
  });
});

// ---------------------------------------------------------------------------
// Case-insensitive script-tag matching (CodeQL js/bad-tag-filter, PR #1330)
// ---------------------------------------------------------------------------

describe('extractVueScript — case-insensitive script-tag matching', () => {
  it('extracts content from <SCRIPT> ... </SCRIPT> (uppercase)', () => {
    // HTML tag names are case-insensitive per the spec; browsers and
    // Vue's SFC parser accept any case. The extractor MUST mirror that
    // — a strict lowercase regex would miss valid SFC content and
    // re-open the CodeQL js/bad-tag-filter alert PR #1330 closed.
    const vue = `<template>
  <div>Hello</div>
</template>

<SCRIPT setup lang="ts">
const greeting = 'hi';
</SCRIPT>
`;
    const result = extractVueScript(vue);
    expect(result).not.toBeNull();
    expect(result!.scriptContent).toContain("const greeting = 'hi'");
  });

  it('extracts content from mixed-case <Script> ... </Script>', () => {
    const vue = `<template>
  <div>Hello</div>
</template>

<Script lang="ts">
export default { name: 'Mixed' };
</Script>
`;
    const result = extractVueScript(vue);
    expect(result).not.toBeNull();
    expect(result!.scriptContent).toContain("name: 'Mixed'");
  });

  it('handles whitespace AND uppercase together: </SCRIPT >', () => {
    const vue = `<template>
  <div>Hi</div>
</template>

<SCRIPT setup>
const x = 1;
</SCRIPT >
`;
    const result = extractVueScript(vue);
    expect(result).not.toBeNull();
    expect(result!.scriptContent).toContain('const x = 1');
  });
});
