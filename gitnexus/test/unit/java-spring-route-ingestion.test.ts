/**
 * Unit test: Java Spring @RequestMapping / @GetMapping route extraction
 * in the parse-worker (decorator routes + class-level prefix joining).
 */
import { describe, it, expect } from 'vitest';
import { parseFilesWithWorkers, distWorkerExists } from '../helpers/worker-parse.js';

describe('Java Spring route annotation ingestion', () => {
  it('extracts method-level routes with class-level @RequestMapping prefix', async () => {
    if (!distWorkerExists()) return;
    const { data } = await parseFilesWithWorkers([
      {
        path: 'src/main/java/com/example/controller/UserController.java',
        content: `
package com.example.controller;

import org.springframework.web.bind.annotation.*;
import java.util.List;

@RestController
@RequestMapping("/api/users")
public class UserController {

    @GetMapping("/list")
    public List<User> listUsers() {
        return null;
    }

    @PostMapping("/create")
    public User createUser() {
        return null;
    }

    @DeleteMapping(path = "/delete")
    public void deleteUser() {}

    @PutMapping(value = "/update")
    public void updateUser() {}
}
`,
      },
    ]);

    const routes = data.decoratorRoutes;
    expect(routes.length).toBe(4);

    // All routes should have the class-level prefix applied
    const getRoute = routes.find((r) => r.httpMethod === 'GET');
    expect(getRoute).toBeDefined();
    expect(getRoute!.routePath).toBe('/list');
    expect(getRoute!.prefix).toBe('/api/users');

    const postRoute = routes.find((r) => r.httpMethod === 'POST');
    expect(postRoute).toBeDefined();
    expect(postRoute!.routePath).toBe('/create');
    expect(postRoute!.prefix).toBe('/api/users');

    const deleteRoute = routes.find((r) => r.httpMethod === 'DELETE');
    expect(deleteRoute).toBeDefined();
    expect(deleteRoute!.routePath).toBe('/delete');
    expect(deleteRoute!.prefix).toBe('/api/users');

    const putRoute = routes.find((r) => r.httpMethod === 'PUT');
    expect(putRoute).toBeDefined();
    expect(putRoute!.routePath).toBe('/update');
    expect(putRoute!.prefix).toBe('/api/users');
  });

  it('emits bare routes when no class-level @RequestMapping exists', async () => {
    if (!distWorkerExists()) return;
    const { data } = await parseFilesWithWorkers([
      {
        path: 'src/main/java/com/example/controller/HealthController.java',
        content: `
package com.example.controller;

import org.springframework.web.bind.annotation.*;

@RestController
public class HealthController {

    @GetMapping("/health")
    public String health() {
        return "OK";
    }

    @GetMapping("/ready")
    public String ready() {
        return "OK";
    }
}
`,
      },
    ]);

    const routes = data.decoratorRoutes;
    expect(routes.length).toBe(2);
    // Without class-level prefix, prefix should be undefined
    for (const route of routes) {
      expect(route.prefix).toBeUndefined();
    }
    const paths = routes.map((r) => r.routePath).sort();
    expect(paths).toEqual(['/health', '/ready']);
  });

  it('does NOT push class-level @RequestMapping as a standalone decorator route', async () => {
    if (!distWorkerExists()) return;
    const { data } = await parseFilesWithWorkers([
      {
        path: 'src/main/java/com/example/controller/UserController.java',
        content: `
package com.example.controller;

import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/users")
public class UserController {

    @GetMapping("/list")
    public List<User> listUsers() {
        return null;
    }
}
`,
      },
    ]);

    // Only the method-level route, not the class-level prefix
    expect(data.decoratorRoutes.length).toBe(1);
    expect(data.decoratorRoutes[0].decoratorName).toBe('GetMapping');
  });

  it('handles multiple controllers in separate files with independent prefixes', async () => {
    if (!distWorkerExists()) return;
    const { data } = await parseFilesWithWorkers([
      {
        path: 'src/main/java/com/example/controller/UserController.java',
        content: `
package com.example.controller;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/users")
public class UserController {
    @GetMapping("/list")
    public String listUsers() { return "[]"; }
}
`,
      },
      {
        path: 'src/main/java/com/example/controller/OrderController.java',
        content: `
package com.example.controller;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/orders")
public class OrderController {
    @GetMapping("/list")
    public String listOrders() { return "[]"; }
}
`,
      },
    ]);

    const routes = data.decoratorRoutes;
    expect(routes.length).toBe(2);

    const userRoute = routes.find((r) => r.filePath.includes('UserController'));
    expect(userRoute).toBeDefined();
    expect(userRoute!.prefix).toBe('/api/users');

    const orderRoute = routes.find((r) => r.filePath.includes('OrderController'));
    expect(orderRoute).toBeDefined();
    expect(orderRoute!.prefix).toBe('/api/orders');
  });
});
