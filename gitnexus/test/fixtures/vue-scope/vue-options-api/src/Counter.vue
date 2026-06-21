<template>
  <div class="counter">
    <button @click="decrement">-</button>
    <span>{{ count }}</span>
    <button @click="increment">+</button>
    <button @click="reset">Reset</button>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';

export default defineComponent({
  name: 'Counter',
  props: {
    initialValue: {
      type: Number,
      default: 0,
    },
    step: {
      type: Number,
      default: 1,
    },
  },
  data() {
    return {
      count: this.initialValue,
    };
  },
  methods: {
    increment() {
      this.count += this.step;
    },
    decrement() {
      this.count -= this.step;
    },
    reset() {
      this.count = this.initialValue;
    },
  },
});
</script>
