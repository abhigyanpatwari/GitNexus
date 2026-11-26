import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { detectServiceBoundaries } from '../../../src/core/group/service-boundary-detector.js';

describe('ServiceBoundaryDetector', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `gitnexus-sbd-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFile(relPath: string, content = ''): void {
    const full = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  describe('detectServiceBoundaries', () => {
    it('test_detect_go_mod_marker_returns_boundary', async () => {
      writeFile('services/api/go.mod', 'module example.com/api');
      writeFile('services/api/main.go', 'package main');

      const boundaries = await detectServiceBoundaries(tmpDir);

      expect(boundaries).toHaveLength(1);
      expect(boundaries[0].serviceName).toBe('api');
      expect(boundaries[0].markers).toContain('go.mod');
    });

    it('test_detect_dockerfile_marker_returns_boundary', async () => {
      writeFile('apps/worker/Dockerfile', 'FROM python:3.12');
      writeFile('apps/worker/requirements.txt', 'flask');
      writeFile('apps/worker/app.py', 'print("worker")');

      const boundaries = await detectServiceBoundaries(tmpDir);

      expect(boundaries).toHaveLength(1);
      expect(boundaries[0].serviceName).toBe('worker');
      expect(boundaries[0].markers).toContain('Dockerfile');
      expect(boundaries[0].markers).toContain('requirements.txt');
    });

    it('test_detect_cargo_toml_marker_returns_boundary', async () => {
      writeFile('crates/parser/Cargo.toml', '[package]');
      writeFile('crates/parser/src/lib.rs', 'pub fn parse() {}');

      const boundaries = await detectServiceBoundaries(tmpDir);

      expect(boundaries).toHaveLength(1);
      expect(boundaries[0].serviceName).toBe('parser');
      expect(boundaries[0].markers).toContain('Cargo.toml');
    });

    it('test_detect_empty_repo_returns_empty', async () => {
      const boundaries = await detectServiceBoundaries(tmpDir);
      expect(boundaries).toHaveLength(0);
    });

    it('test_detect_pyproject_toml_marker_returns_boundary', async () => {
      writeFile('services/ml/pyproject.toml', '[project]');
      writeFile('services/ml/src/model.py', '');

      const boundaries = await detectServiceBoundaries(tmpDir);

      expect(boundaries).toHaveLength(1);
      expect(boundaries[0].markers).toContain('pyproject.toml');
    });

    it('test_detect_skips_pycache_directory', async () => {
      writeFile('services/ml/pyproject.toml', '[project]');
      writeFile('services/ml/model.py', '');
      // __pycache__ with a marker + source files — would be detected as
      // a boundary if not excluded, since it has package.json + .py file
      writeFile('__pycache__/package.json', '{}');
      writeFile('__pycache__/cached.py', '');

      const boundaries = await detectServiceBoundaries(tmpDir);

      const paths = boundaries.map((b) => b.servicePath);
      expect(paths).toContain('services/ml');
      expect(paths.every((p) => !p.includes('__pycache__'))).toBe(true);
    });
  });
});
