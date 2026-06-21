<template>
  <div class="post-card">
    <h3>{{ title }}</h3>
    <p>{{ summary }}</p>
    <small>Words: {{ wordCount }}</small>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { usePost } from '../composables/usePost';

const props = defineProps<{ postId: number }>();

const { post, loadPost, getSummary } = usePost();

loadPost(props.postId);

const title = computed(() => post.value?.title ?? '');
const summary = getSummary();
const wordCount = computed(() => post.value?.wordCount() ?? 0);
</script>
