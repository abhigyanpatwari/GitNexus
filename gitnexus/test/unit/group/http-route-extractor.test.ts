import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { HttpRouteExtractor } from '../../../src/core/group/extractors/http-route-extractor.js';
import type { RepoHandle } from '../../../src/core/group/types.js';

describe('HttpRouteExtractor', () => {
  const tmpDir = path.join(os.tmpdir(), `gitnexus-http-extract-${Date.now()}`);
  let extractor: HttpRouteExtractor;

  beforeEach(() => {
    extractor = new HttpRouteExtractor();
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const makeRepo = (repoPath: string): RepoHandle => ({
    id: 'test-repo',
    path: 'test/backend',
    repoPath,
    storagePath: path.join(repoPath, '.gitnexus'),
  });

  describe('provider extraction — graph-first (Strategy A)', () => {
    it('extracts routes from Route/HANDLES_ROUTE graph + source scan for method', async () => {
      const dir = path.join(tmpDir, 'graph-first');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/UserController.java'),
        `
@RestController
@RequestMapping("/api/v2")
public class UserController {
    @GetMapping("/users")
    public List<User> list() { return service.findAll(); }

    @PostMapping("/users")
    public User create(@RequestBody User user) { return service.save(user); }
}
`,
      );

      const mockDbExecutor = async (query: string) => {
        if (query.includes('HANDLES_ROUTE')) {
          return [
            {
              fileId: 'file-uid-ctrl',
              filePath: 'src/controller/UserController.java',
              routePath: '/api/v2/users',
              routeId: 'route-uid-users',
              responseKeys: null,
              routeSource: 'decorator-GetMapping',
            },
          ];
        }
        if (query.includes('CONTAINS')) {
          return [
            {
              uid: 'uid-ctrl-list',
              name: 'list',
              filePath: 'src/controller/UserController.java',
              labels: ['Method'],
            },
            {
              uid: 'uid-ctrl-create',
              name: 'create',
              filePath: 'src/controller/UserController.java',
              labels: ['Method'],
            },
          ];
        }
        return [];
      };

      const contracts = await extractor.extract(mockDbExecutor, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const getRoute = providers.find((c) => c.contractId === 'http::GET::/api/v2/users');
      expect(getRoute).toBeDefined();
      expect(getRoute!.confidence).toBe(0.9);
      expect(getRoute!.symbolUid).not.toBe('file-uid-ctrl');
    });
  });

  describe('provider extraction — source-scan fallback (Strategy B)', () => {
    it('extracts Spring @GetMapping annotation', async () => {
      const dir = path.join(tmpDir, 'spring');
      fs.mkdirSync(path.join(dir, 'src/controller'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/controller/UserController.java'),
        `
package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/v2")
public class UserController {
    @GetMapping("/users")
    public List<User> list() { return service.findAll(); }

    @PostMapping("/users")
    public User create(@RequestBody User user) { return service.save(user); }

    @GetMapping("/users/{id}")
    public User getById(@PathVariable Long id) { return service.findById(id); }
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers.length).toBeGreaterThanOrEqual(3);

      const listRoute = providers.find((c) => c.contractId === 'http::GET::/api/v2/users');
      expect(listRoute).toBeDefined();
      expect(listRoute!.meta.method).toBe('GET');
      expect(listRoute!.meta.path).toBe('/api/v2/users');

      const createRoute = providers.find((c) => c.contractId === 'http::POST::/api/v2/users');
      expect(createRoute).toBeDefined();

      const getByIdRoute = providers.find(
        (c) => c.contractId === 'http::GET::/api/v2/users/{param}',
      );
      expect(getByIdRoute).toBeDefined();
    });

    it('extracts Express router.get patterns', async () => {
      const dir = path.join(tmpDir, 'express');
      fs.mkdirSync(path.join(dir, 'src/routes'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/routes/users.ts'),
        `
import { Router } from 'express';
const router = Router();

router.get('/api/users', async (req, res) => { res.json([]); });
router.post('/api/users', async (req, res) => { res.json({}); });
router.delete('/api/users/:id', async (req, res) => { res.sendStatus(204); });

export default router;
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers.length).toBeGreaterThanOrEqual(3);
      expect(providers.find((c) => c.contractId === 'http::GET::/api/users')).toBeDefined();
      expect(providers.find((c) => c.contractId === 'http::POST::/api/users')).toBeDefined();
      expect(
        providers.find((c) => c.contractId === 'http::DELETE::/api/users/{param}'),
      ).toBeDefined();
    });
  });

  describe('consumer extraction — fetch patterns', () => {
    it('extracts fetch() calls', async () => {
      const dir = path.join(tmpDir, 'frontend');
      fs.mkdirSync(path.join(dir, 'src/api'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/api/users.ts'),
        `
export async function fetchUsers() {
  const res = await fetch('/api/users');
  return res.json();
}

export async function createUser(data: any) {
  const res = await fetch('/api/users', { method: 'POST', body: JSON.stringify(data) });
  return res.json();
}
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers.length).toBeGreaterThanOrEqual(2);
      expect(consumers.find((c) => c.contractId === 'http::GET::/api/users')).toBeDefined();
      expect(consumers.find((c) => c.contractId === 'http::POST::/api/users')).toBeDefined();
    });

    it('extracts axios calls', async () => {
      const dir = path.join(tmpDir, 'axios-fe');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/api.ts'),
        `
import axios from 'axios';
export const getUsers = () => axios.get('/api/users');
export const deleteUser = (id: string) => axios.delete(\`/api/users/\${id}\`);
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers.find((c) => c.contractId === 'http::GET::/api/users')).toBeDefined();
      expect(
        consumers.find((c) => c.contractId === 'http::DELETE::/api/users/{param}'),
      ).toBeDefined();
    });
  });

  describe('provider extraction — Laravel', () => {
    it('extracts Laravel Route::get patterns', async () => {
      const dir = path.join(tmpDir, 'laravel');
      fs.mkdirSync(path.join(dir, 'routes'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'routes/api.php'),
        `<?php
Route::get('/users', [UserController::class, 'index']);
Route::post('/users', [UserController::class, 'store']);
Route::delete('/users/{id}', [UserController::class, 'destroy']);
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers.length).toBeGreaterThanOrEqual(3);
      expect(providers.find((c) => c.contractId === 'http::GET::/users')).toBeDefined();
      expect(providers.find((c) => c.contractId === 'http::POST::/users')).toBeDefined();
      expect(providers.find((c) => c.contractId === 'http::DELETE::/users/{param}')).toBeDefined();
    });
  });

  describe('provider extraction — FastAPI', () => {
    it('extracts FastAPI @app.get decorator patterns', async () => {
      const dir = path.join(tmpDir, 'fastapi');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/main.py'),
        `from fastapi import FastAPI
app = FastAPI()

@app.get("/users")
async def list_users():
    return []

@app.post("/users")
async def create_user(user: UserCreate):
    return user
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers.length).toBeGreaterThanOrEqual(2);
      expect(providers.find((c) => c.contractId === 'http::GET::/users')).toBeDefined();
      expect(providers.find((c) => c.contractId === 'http::POST::/users')).toBeDefined();
    });
  });

  describe('consumer extraction — graph-first (Strategy A)', () => {
    it('extracts consumers from FETCHES graph edges', async () => {
      const dir = path.join(tmpDir, 'graph-consumers');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src/api.ts'), 'export const api = {};');

      const mockDbExecutor = async (query: string) => {
        if (query.includes('HANDLES_ROUTE')) return [];
        if (query.includes('FETCHES')) {
          return [
            {
              fileId: 'file-uid-api',
              filePath: 'src/api.ts',
              routePath: '/api/users',
              routeId: 'route-uid-users',
              fetchReason: 'fetch-url-match',
            },
          ];
        }
        if (query.includes('CONTAINS')) {
          return [
            {
              uid: 'uid-fn-fetch',
              name: 'fetchUsers',
              filePath: 'src/api.ts',
              labels: ['Function'],
            },
          ];
        }
        return [];
      };

      const contracts = await extractor.extract(mockDbExecutor, dir, makeRepo(dir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers.length).toBeGreaterThanOrEqual(1);
      expect(consumers[0].confidence).toBe(0.9);
      expect(consumers[0].symbolName).toBe('fetchUsers');
    });
  });

  describe('edge cases', () => {
    it('returns empty for repo with no matching files', async () => {
      const dir = path.join(tmpDir, 'empty-repo');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'README.md'), '# Hello');

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      expect(contracts).toHaveLength(0);
    });

    it('handles graph queries that throw gracefully', async () => {
      const dir = path.join(tmpDir, 'graph-error');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src/routes.ts'), `router.get('/api/health', handler);`);

      const throwingExecutor = async () => {
        throw new Error('DB unavailable');
      };

      const contracts = await extractor.extract(throwingExecutor, dir, makeRepo(dir));
      // Should fall back to source scan
      const providers = contracts.filter((c) => c.role === 'provider');
      expect(providers.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('interface regex anchoring', () => {
    it('skips Feign client interfaces (no @Controller)', async () => {
      const dir = path.join(tmpDir, 'feign-skip');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/UserClient.java'),
        `
package com.example;
@FeignClient(name = "user-service")
public interface UserClient {
    @GetMapping("/users")
    List<User> getUsers();
}
`,
      );
      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      expect(contracts.filter((c) => c.role === 'provider')).toHaveLength(0);
    });

    it('does NOT skip when @RestController is present', async () => {
      const dir = path.join(tmpDir, 'ctrl-iface');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/UserController.java'),
        `
@RestController
@RequestMapping("/api")
public class UserController {
    @GetMapping("/users")
    public List<User> list() { return null; }
}
`,
      );
      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      expect(contracts.filter((c) => c.role === 'provider').length).toBeGreaterThanOrEqual(1);
    });

    it('does NOT false-positive on interface in comments', async () => {
      const dir = path.join(tmpDir, 'iface-comment');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/Api.java'),
        `
// implements the interface UserApi
public class Api {
    @GetMapping("/health")
    public String health() { return "ok"; }
}
`,
      );
      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      expect(contracts.filter((c) => c.role === 'provider').length).toBeGreaterThanOrEqual(1);
    });

    it('does NOT false-positive on interface in a string', async () => {
      const dir = path.join(tmpDir, 'iface-str');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/Svc.java'),
        `
public class Svc {
    String desc = "implements interface Foo";
    @GetMapping("/status")
    public String status() { return desc; }
}
`,
      );
      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      expect(contracts.filter((c) => c.role === 'provider').length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('path normalization', () => {
    it('strips trailing slash', async () => {
      const dir = path.join(tmpDir, 'trailing');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/router.ts'),
        `
router.get('/api/users/', handler);
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      const provider = contracts.find((c) => c.role === 'provider');
      expect(provider?.meta.path).toBe('/api/users');
    });

    it('normalizes path params from multiple syntaxes', async () => {
      const dir = path.join(tmpDir, 'params');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'src/router.ts'),
        `
router.get('/api/users/:id', handler1);
router.get('/api/posts/{postId}', handler2);
`,
      );

      const contracts = await extractor.extract(null, dir, makeRepo(dir));
      contracts.forEach((c) => {
        expect(c.meta.path).not.toContain(':id');
        expect(c.meta.path).not.toContain('{postId}');
        if (typeof c.meta.path === 'string' && c.meta.path.includes('users/')) {
          expect(c.meta.path).toContain('{param}');
        }
      });
    });
  });
});
