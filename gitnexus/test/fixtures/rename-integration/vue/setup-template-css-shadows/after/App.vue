<template>
  <button title="color" @click="shade">color {{ shade() }}</button>
  <div v-for="color in [1]">{{ color }}</div>
</template>
<script setup lang="ts">
// color stays here.
function shade() { return "color"; }
function shadow(color: string) { return color; }
const callback = shade;
</script>
<style scoped>
/* v-bind(color) stays here. */
.box { color: v-bind(shade()); border-color: v-bind('shade()'); content: "v-bind(color)"; }
</style>
