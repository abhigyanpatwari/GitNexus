<template>
  <div class="options-host">
    <Button variant="secondary" @click="onOptionsClick">
      Options click
    </Button>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import Button from './components/Button.vue';

/**
 * Options-API host: the `@click` handler lives in `methods:`, so the graph node
 * for it is a `Method`, not a `Function`. The BINDS_EVENT_HANDLER edge Vue's
 * scope resolver emits for a component-element binding therefore has a `Method`
 * source and a `File` target — the `Method→File` pair. The `<script setup>`
 * sibling (App.vue) only ever produces `Function→File`.
 */
export default defineComponent({
  name: 'OptionsHost',
  components: { Button },
  methods: {
    onOptionsClick() {
      return 'options-clicked';
    },
  },
});
</script>
