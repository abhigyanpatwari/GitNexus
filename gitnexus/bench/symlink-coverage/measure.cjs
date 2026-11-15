#!/usr/bin/env node
// node --import tsx bench/symlink-coverage/measure.cjs [--check]
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '../..');
(async () => {
  const baseline = JSON.parse(await fs.readFile(path.join(__dirname, 'baseline.json'), 'utf8'));
  const { walkRepositoryPaths } = await import(
    pathToFileURL(path.join(root, 'src/core/ingestion/filesystem-walker.ts')).href
  );
  const environment = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0].model,
  };
  const sameEnvironment = Object.entries(environment).every(
    ([key, value]) => baseline.environment?.[key] === value,
  );
  const results = [];
  for (const files of baseline.sizes) {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-symlink-coverage-'));
    try {
      await fs.mkdir(path.join(repo, 'src'));
      for (let start = 0; start < files; start += 32) {
        await Promise.all(
          Array.from({ length: Math.min(32, files - start) }, (_, offset) =>
            fs.writeFile(
              path.join(repo, 'src', `file${start + offset}.ts`),
              'export const value = 1;\n',
            ),
          ),
        );
      }
      for (let i = 0; i < files / 32; i++)
        await fs.symlink('src', path.join(repo, `directory${i}`), 'dir');
      await fs.symlink('src/file0.ts', path.join(repo, 'alias.ts'), 'file');
      const samples = [];
      let paths;
      for (let trial = 0; trial < 6; trial++) {
        const start = performance.now();
        paths = await walkRepositoryPaths(repo, undefined, { quiet: true });
        if (trial > 0) samples.push(performance.now() - start);
      }
      samples.sort((a, b) => a - b);
      results.push({
        files,
        directory_links: files / 32,
        returned: paths.length,
        median_ms: samples[2],
        samples_ms: samples,
      });
      if (process.argv.includes('--check')) {
        assert.equal(paths.length, files + 1);
        assert.ok(paths.some((entry) => entry.path === 'alias.ts'));
        assert.ok(paths.every((entry) => !entry.path.startsWith('directory')));
      }
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  }
  const scaling =
    results[1].median_ms / results[0].median_ms / (results[1].files / results[0].files);
  console.log(JSON.stringify({ environment, results, normalized_scaling: scaling }, null, 2));
  if (process.argv.includes('--check')) {
    assert.ok(scaling <= baseline.linear_scaling_budget);
    if (!sameEnvironment)
      console.warn(
        'Absolute timing gate skipped: baseline environment differs; correctness and scaling gates still apply.',
      );
    for (const row of results) {
      const original = baseline.results?.find((item) => item.files === row.files);
      assert.ok(original, 'Record a main baseline before checking');
      if (sameEnvironment)
        assert.ok(row.median_ms / original.median_ms <= baseline.regression_budget);
    }
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
