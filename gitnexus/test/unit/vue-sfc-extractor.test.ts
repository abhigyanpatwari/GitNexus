import { describe, it, expect } from 'vitest';
import {
  extractVueScript,
  extractTemplateComponents,
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

  it('prefers <script setup> when both blocks exist', () => {
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
    expect(result!.isSetup).toBe(true);
    expect(result!.scriptContent).toContain("const name = ref('test')");
    expect(result!.scriptContent).not.toContain('inheritAttrs');
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
