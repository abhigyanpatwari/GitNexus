<template>
  <div id="app">
    <Counter :initialValue="0" :step="1" />
    <TodoList />
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import Counter from './Counter.vue';
import TodoList from './TodoList.vue';

export default defineComponent({
  name: 'App',
  components: { Counter, TodoList },
});
</script>
