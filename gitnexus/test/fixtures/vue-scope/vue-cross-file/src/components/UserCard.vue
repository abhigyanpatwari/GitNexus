<template>
  <div class="user-card">
    <h2>{{ displayName }}</h2>
    <span v-if="isAdmin" class="badge">Admin</span>
    <button @click="reload">Reload</button>
  </div>
</template>

<script setup lang="ts">
import { useUser } from '../composables/useUser';

const props = defineProps<{ userId: number }>();
const emit = defineEmits<{ loaded: [userId: number] }>();

const { user, isAdmin, loadUser, getDisplayName } = useUser(props.userId);

const displayName = getDisplayName();

async function reload() {
  await loadUser(props.userId);
  emit('loaded', props.userId);
}
</script>
