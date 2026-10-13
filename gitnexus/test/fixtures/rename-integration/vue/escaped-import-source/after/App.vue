<script setup lang="ts">
import { compute as stable } from "./source";
function run() { return stable(); }
</script>
<template><button @click="run">Run</button></template>
