import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  detectServiceBoundaries,
  assignService,
  type ServiceBoundary,
} from '../../../src/core/group/service-boundary-detector.js';

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
    it('test_detect_services_with_package_json_and_dockerfile_returns_boundaries', async () => {
      writeFile('services/auth/package.json', '{}');
      writeFile('services/auth/Dockerfile', 'FROM node:20');
      writeFile('services/auth/src/index.ts', 'export default {}');
      writeFile('services/orders/package.json', '{}');
      writeFile('services/orders/src/main.ts', 'console.log("ok")');

      const boundaries = await detectServiceBoundaries(tmpDir);

      expect(boundaries).toHaveLength(2);
      const names = boundaries.map((b) => b.serviceName).sort();
      expect(names).toEqual(['auth', 'orders']);
    });

    it('test_detect_root_package_json_excluded_from_boundaries', async () => {
      writeFile('package.json', '{}');
      writeFile('src/index.ts', 'export default {}');

      const boundaries = await detectServiceBoundaries(tmpDir);

      expect(boundaries).toHaveLength(0);
    });

    it('test_detect_go_mod_marker_returns_boundary', async () => {
      writeFile('services/api/go.mod', 'module example.com/api');
      writeFile('services/api/main.go', 'package main');

      const boundaries = await detectServiceBoundaries(tmpDir);

      expect(boundaries).toHaveLength(1);
      expect(boundaries[0].serviceName).toBe('api');
      expect(boundaries[0].markers).toContain('go.mod');
    });

    it('test_detect_pom_xml_marker_returns_boundary', async () => {
      writeFile('microservices/billing/pom.xml', '<project/>');
      writeFile('microservices/billing/src/Main.java', 'class Main {}');

      const boundaries = await detectServiceBoundaries(tmpDir);

      expect(boundaries).toHaveLength(1);
      expect(boundaries[0].serviceName).toBe('billing');
      expect(boundaries[0].markers).toContain('pom.xml');
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

    it('test_detect_multiple_markers_increases_confidence', async () => {
      writeFile('services/auth/package.json', '{}');
      writeFile('services/auth/Dockerfile', 'FROM node:20');
      writeFile('services/auth/src/index.ts', '');
      writeFile('services/api/package.json', '{}');
      writeFile('services/api/src/index.ts', '');

      const boundaries = await detectServiceBoundaries(tmpDir);
      const auth = boundaries.find((b) => b.serviceName === 'auth')!;
      const api = boundaries.find((b) => b.serviceName === 'api')!;

      expect(auth.confidence).toBeGreaterThan(api.confidence);
    });

    it('test_detect_nested_services_returns_deepest_match', async () => {
      writeFile('platform/services/auth/package.json', '{}');
      writeFile('platform/services/auth/src/index.ts', '');
      writeFile('platform/package.json', '{}');
      writeFile('platform/src/shared.ts', '');

      const boundaries = await detectServiceBoundaries(tmpDir);
      const paths = boundaries.map((b) => b.servicePath).sort();

      // Both detected; assignService will use the deepest match
      expect(paths.length).toBeGreaterThanOrEqual(1);
      expect(paths).toContain('platform/services/auth');
    });

    it('test_detect_cargo_toml_marker_returns_boundary', async () => {
      writeFile('crates/parser/Cargo.toml', '[package]');
      writeFile('crates/parser/src/lib.rs', 'pub fn parse() {}');

      const boundaries = await detectServiceBoundaries(tmpDir);

      expect(boundaries).toHaveLength(1);
      expect(boundaries[0].serviceName).toBe('parser');
      expect(boundaries[0].markers).toContain('Cargo.toml');
    });

    it('test_detect_build_gradle_marker_returns_boundary', async () => {
      writeFile('modules/gateway/build.gradle', 'apply plugin: "java"');
      writeFile('modules/gateway/src/Main.java', '');

      const boundaries = await detectServiceBoundaries(tmpDir);

      expect(boundaries).toHaveLength(1);
      expect(boundaries[0].serviceName).toBe('gateway');
      expect(boundaries[0].markers).toContain('build.gradle');
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

    it('test_detect_skips_vendor_directory', async () => {
      writeFile('services/auth/package.json', '{}');
      writeFile('services/auth/src/index.ts', '');
      // vendor should be skipped — its contents should not create a boundary
      writeFile('vendor/some-dep/package.json', '{}');
      writeFile('vendor/some-dep/src/lib.go', '');

      const boundaries = await detectServiceBoundaries(tmpDir);

      const paths = boundaries.map((b) => b.servicePath);
      expect(paths).toContain('services/auth');
      expect(paths).not.toContain('vendor/some-dep');
    });

    it('test_detect_skips_target_directory', async () => {
      writeFile('services/api/go.mod', 'module api');
      writeFile('services/api/main.go', '');
      writeFile('target/classes/Main.java', '');
      writeFile('target/pom.xml', '<project/>');

      const boundaries = await detectServiceBoundaries(tmpDir);

      const paths = boundaries.map((b) => b.servicePath);
      expect(paths).toContain('services/api');
      expect(paths).not.toContain('target');
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

    it('test_detect_skips_dotfile_directories_regression', async () => {
      writeFile('services/api/package.json', '{}');
      writeFile('services/api/src/index.ts', '');
      writeFile('.hidden/package.json', '{}');
      writeFile('.hidden/src/index.ts', '');

      const boundaries = await detectServiceBoundaries(tmpDir);

      const paths = boundaries.map((b) => b.servicePath);
      expect(paths).toContain('services/api');
      expect(paths).not.toContain('.hidden');
    });

    it('test_detect_does_not_skip_regular_source_directories', async () => {
      writeFile('services/api/package.json', '{}');
      writeFile('services/api/src/index.ts', '');

      const boundaries = await detectServiceBoundaries(tmpDir);

      expect(boundaries).toHaveLength(1);
      expect(boundaries[0].serviceName).toBe('api');
    });
  });

  describe('assignService', () => {
    it('test_assign_file_to_correct_service', () => {
      const boundaries: ServiceBoundary[] = [
        {
          servicePath: 'services/auth',
          serviceName: 'auth',
          markers: ['package.json'],
          confidence: 0.8,
        },
        {
          servicePath: 'services/orders',
          serviceName: 'orders',
          markers: ['package.json'],
          confidence: 0.8,
        },
      ];

      expect(assignService('services/auth/src/index.ts', boundaries)).toBe('services/auth');
      expect(assignService('services/orders/src/main.ts', boundaries)).toBe('services/orders');
    });

    it('test_assign_file_outside_services_returns_undefined', () => {
      const boundaries: ServiceBoundary[] = [
        {
          servicePath: 'services/auth',
          serviceName: 'auth',
          markers: ['package.json'],
          confidence: 0.8,
        },
      ];

      expect(assignService('libs/shared/utils.ts', boundaries)).toBeUndefined();
      expect(assignService('README.md', boundaries)).toBeUndefined();
    });

    it('test_assign_nested_file_uses_deepest_boundary', () => {
      const boundaries: ServiceBoundary[] = [
        {
          servicePath: 'platform',
          serviceName: 'platform',
          markers: ['package.json'],
          confidence: 0.7,
        },
        {
          servicePath: 'platform/services/auth',
          serviceName: 'auth',
          markers: ['package.json'],
          confidence: 0.8,
        },
      ];

      expect(assignService('platform/services/auth/src/index.ts', boundaries)).toBe(
        'platform/services/auth',
      );
      expect(assignService('platform/shared/utils.ts', boundaries)).toBe('platform');
    });

    it('test_assign_with_empty_boundaries_returns_undefined', () => {
      expect(assignService('src/index.ts', [])).toBeUndefined();
    });
  });
});
