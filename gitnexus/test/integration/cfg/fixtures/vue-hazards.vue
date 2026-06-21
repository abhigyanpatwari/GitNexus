<!--
  Vue SFC CFG hazard fixture (#2195 capstone). The <script setup lang="ts">
  block is extracted by the SFC script extractor and parsed with the TypeScript
  grammar; the Vue provider reuses the TypeScript CfgVisitor, so the worker
  builds the same per-function CFG it would for a .ts file. Each function below
  carries real branching, AND `eventLoop` is a non-terminating `while (true)`
  with an interior `if` — the EXIT-reachability / CDG soundness hazard. The
  <template> exists only to make this a realistic SFC; the CFG comes from the
  script.
-->
<template>
  <div class="counter" @click="onClick">{{ count }}</div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

const count = ref(0);

// if / else-if / else — branch senses; rejoin at the return.
function classify(x: number): string {
  let label: string;
  if (x > 0) {
    label = positive();
  } else if (x < 0) {
    label = negative();
  } else {
    label = zero();
  }
  return label;
}

// A non-terminating loop with an interior branch — keeps EXIT reverse-reachable
// only via the structural escape edge, so CDG must stay > 0 (the silent-zero
// hazard). A loop-carried accumulator (`sum`) gives the def/use harvest a fact.
function eventLoop(x: number): number {
  let sum = 0;
  while (true) {
    if (shouldStop(x)) {
      return collect(sum);
    }
    sum = step(sum, x);
    x = advance(x);
  }
}

// A second branching shape so the script has multiple CFG-bearing functions.
function onClick(): void {
  if (count.value > 0) {
    handle(count.value);
  } else {
    reset();
  }
}

function positive(): string {
  return 'positive';
}
function negative(): string {
  return 'negative';
}
function zero(): string {
  return 'zero';
}
function shouldStop(x: number): boolean {
  return x > 100;
}
function collect(s: number): number {
  return s;
}
function step(s: number, x: number): number {
  return s + x;
}
function advance(x: number): number {
  return x + 1;
}
function handle(v: number): void {
  count.value = v - 1;
}
function reset(): void {
  count.value = 0;
}
</script>
