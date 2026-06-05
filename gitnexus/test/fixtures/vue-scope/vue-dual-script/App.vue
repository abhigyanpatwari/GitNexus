<template>
  <div>Hello</div>
</template>
<script>
export default {
  name: 'MyComponent',
  data() { return { count: 0 }; },
};
</script>
<script setup lang="ts">
import { ref } from 'vue';
const count = ref(0);
</script>
