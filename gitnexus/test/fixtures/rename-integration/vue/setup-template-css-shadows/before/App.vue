<template>
  <button title="color" @click="color">color {{ color() }}</button>
  <div v-for="color in [1]">{{ color }}</div>
</template>
<script setup lang="ts">
// color stays here.
function color() { return "color"; }
function shadow(color: string) { return color; }
const callback = color;
</script>
<style scoped>
/* v-bind(color) stays here. */
.box { color: v-bind(color()); border-color: v-bind('color()'); content: "v-bind(color)"; }
</style>
