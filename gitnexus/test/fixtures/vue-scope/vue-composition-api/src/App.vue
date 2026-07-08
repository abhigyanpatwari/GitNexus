<template>
  <div id="app">
    <UserProfile :userId="currentUserId" />
    <PostList :posts="allPosts" @select="onPostSelected" />
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import type { Post } from './types';
import UserProfile from './UserProfile.vue';
import PostList from './PostList.vue';

const currentUserId = ref(1);
const allPosts = ref<Post[]>([]);

function onPostSelected(post: Post) {
  console.log('selected', post.id);
}
</script>
