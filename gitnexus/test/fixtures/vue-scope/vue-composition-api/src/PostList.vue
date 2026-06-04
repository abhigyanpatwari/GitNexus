<template>
  <div class="post-list">
    <div v-for="post in posts" :key="post.id" class="post-item">
      <h3>{{ post.title }}</h3>
      <button @click="selectPost(post)">View</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import type { Post } from './types';
import { formatPost } from './types';

const props = defineProps<{
  posts: Post[];
}>();

const emit = defineEmits<{
  select: [post: Post];
}>();

const selectedPost = ref<Post | null>(null);

function selectPost(post: Post) {
  selectedPost.value = post;
  emit('select', post);
}

function getLabel(post: Post): string {
  return formatPost(post);
}
</script>
