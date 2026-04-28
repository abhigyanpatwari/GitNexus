<template>
  <div id="app">
    <h1>{{ title }}</h1>
    <Button variant="primary" @click="onButtonClick">
      Click me
    </Button>
    <p>{{ userDisplay }}</p>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';
import type { User } from './types';
import { formatUser } from './types';
import Button from './components/Button.vue';

const title = ref('Hello Vue');

const user = ref<User>({
  id: 1,
  name: 'Alice',
  email: 'alice@example.com',
});

const userDisplay = computed(() => formatUser(user.value));

function onButtonClick() {
  title.value = 'Clicked!';
}
</script>
