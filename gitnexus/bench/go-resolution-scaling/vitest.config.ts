import { defineConfig } from 'vitest/config';

const benchmarkConfig = defineConfig({
  test: { include: ['bench/go-resolution-scaling/measure.test.ts'], testTimeout: 1_800_000 },
});

export default benchmarkConfig;
