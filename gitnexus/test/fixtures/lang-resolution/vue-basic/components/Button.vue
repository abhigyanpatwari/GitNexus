<template>
  <button :class="classes" @click="handleClick">
    <slot />
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  variant?: 'primary' | 'secondary';
  disabled?: boolean;
}>();

const emit = defineEmits<{
  click: [event: MouseEvent];
}>();

const classes = computed(() => ({
  btn: true,
  [`btn-${props.variant ?? 'primary'}`]: true,
  'btn-disabled': props.disabled,
}));

function handleClick(event: MouseEvent) {
  if (!props.disabled) {
    emit('click', event);
  }
}
</script>
