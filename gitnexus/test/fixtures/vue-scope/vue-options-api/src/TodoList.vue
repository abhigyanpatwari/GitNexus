<template>
  <div class="todo-list">
    <input v-model="newTodoText" @keyup.enter="addTodo" />
    <ul>
      <li v-for="todo in pendingTodos" :key="todo.id" @click="toggleItem(todo)">
        {{ todo.text }}
      </li>
    </ul>
    <p>Done: {{ doneCount }}</p>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import type { Todo } from './utils';
import { createTodo, toggleTodo, filterDone, filterPending } from './utils';

export default defineComponent({
  name: 'TodoList',
  data() {
    return {
      newTodoText: '',
      todos: [] as Todo[],
    };
  },
  computed: {
    doneCount(): number {
      return filterDone(this.todos).length;
    },
    pendingTodos(): Todo[] {
      return filterPending(this.todos);
    },
  },
  methods: {
    addTodo() {
      if (this.newTodoText.trim() === '') return;
      this.todos.push(createTodo(this.newTodoText));
      this.newTodoText = '';
    },
    toggleItem(todo: Todo) {
      const idx = this.todos.findIndex((t) => t.id === todo.id);
      if (idx !== -1) {
        this.todos[idx] = toggleTodo(todo);
      }
    },
    clearDone() {
      this.todos = filterPending(this.todos);
    },
  },
});
</script>
