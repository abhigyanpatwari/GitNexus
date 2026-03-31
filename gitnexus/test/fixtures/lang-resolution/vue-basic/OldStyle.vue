<template>
  <div>{{ message }}</div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';

export default defineComponent({
  name: 'OldStyle',
  data() {
    return {
      message: 'Hello from options API',
    };
  },
  methods: {
    greet() {
      return this.message;
    },
  },
});
</script>
