import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';

describe('pipeline error handling', () => {
  it('returns empty result for non-existent repo path', async () => {
    const result = await runPipelineFromRepo('/nonexistent/path/xyz123', () => {});
    expect(result.totalFileCount).toBe(0);
  }, 30000);

  it('handles empty directory gracefully', async () => {
    const tmpDir = path.join(os.tmpdir(), `gn-pipeline-empty-${Date.now()}`);
    await fs.mkdir(tmpDir, { recursive: true });
    try {
      const result = await runPipelineFromRepo(tmpDir, () => {});
      // Empty repo should produce empty or minimal graph
      expect(result.totalFileCount).toBe(0);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  }, 30000);
});
