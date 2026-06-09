<template>
  <div>Hello</div>
</template>
<script>
function legacySetup() {
  return { count: 0 };
}
</script>
<script setup lang="ts">
function setupInit() {
  return 42;
}
</script>
