<template>
  <div class="user-profile">
    <h1>{{ displayName }}</h1>
    <p>{{ user?.email }}</p>
    <button @click="handleSave">Save</button>
    <ul>
      <li v-for="post in posts" :key="post.id">{{ formatPost(post) }}</li>
    </ul>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import type { User, Post } from './types';
import { formatUser, formatPost } from './types';
import { fetchUser, fetchPosts, saveUser } from './api';

const props = defineProps<{
  userId: number;
}>();

const user = ref<User | null>(null);
const posts = ref<Post[]>([]);

const displayName = computed(() => {
  if (user.value === null) return 'Loading...';
  return formatUser(user.value);
});

async function loadData() {
  user.value = await fetchUser(props.userId);
  posts.value = await fetchPosts(props.userId);
}

async function handleSave() {
  if (user.value === null) return;
  user.value = await saveUser(user.value);
}

onMounted(() => {
  loadData();
});
</script>
