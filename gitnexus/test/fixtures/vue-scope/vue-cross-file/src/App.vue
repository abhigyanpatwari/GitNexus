<template>
  <div id="app">
    <UserCard :userId="1" @loaded="onUserLoaded" />
    <PostCard :postId="42" />
  </div>
</template>

<script setup lang="ts">
import { useUserList } from './composables/useUser';
import { UserModel } from './models';
import UserCard from './components/UserCard.vue';
import PostCard from './components/PostCard.vue';

const { users, addUser } = useUserList();

function onUserLoaded(userId: number) {
  const u = new UserModel(userId, 'Loaded', 'user');
  addUser(u);
}
</script>
