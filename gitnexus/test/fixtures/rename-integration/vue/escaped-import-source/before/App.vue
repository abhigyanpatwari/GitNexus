<script setup lang="ts">
import { calcu\u006cate as stable } from "./source";
function run() { return stable(); }
</script>
<template><button @click="run">Run</button></template>
