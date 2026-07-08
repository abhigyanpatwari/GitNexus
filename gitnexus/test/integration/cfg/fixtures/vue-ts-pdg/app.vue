<!--
  Vue SFC that imports a sibling TypeScript module (`./shared`). The Vue
  provider's `collectScopeContextPaths` follows that import and adds shared.ts
  to the Vue resolution pass, so shared.ts is PDG-emitted in BOTH the
  TypeScript pass and the Vue context pass — the cross-pass double-emit the
  #2202 streaming per-file dedup must collapse (review #8a). The <script>'s own
  functions add a second, Vue-side CFG so the graph holds blocks from both
  files.
-->
<template>
  <div class="panel" @click="onClick">{{ label }}</div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { classify, accumulate, guard } from './shared';

const count = ref(0);
const label = classify(guard(accumulate(10)));

function onClick(): void {
  if (count.value > 0) {
    count.value = count.value - 1;
  } else {
    count.value = 0;
  }
}
</script>
