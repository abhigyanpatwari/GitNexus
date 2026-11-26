<template><div>Example</div></template>

<script setup lang="ts">
function target(): void {}
function invoke(callback: () => void): void { callback(); }
const first = target;
const second = first;
invoke(second);
</script>
