<script setup lang="ts">
import { Writer } from "./model";
function run() {
  const writer = new Writer();
  const { close: closeWriter } = writer;
  return writer.close();
}
</script>
<template><button @click="run()">Close</button></template>
