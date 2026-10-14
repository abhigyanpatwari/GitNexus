<script setup lang="ts">
import { shade as localColor } from "./api";
import { middle } from "./middle";
function run() { return middle() + localColor(); }
</script>
<template><button @click="localColor">{{ localColor() }} {{ run() }}</button></template>
<style>.box { color: v-bind('localColor()'); }</style>
