import { describe, it, expect } from 'vitest';
import { detectFrameworkFromPath, detectFrameworkFromAST, FRAMEWORK_AST_PATTERNS } from '../../src/core/ingestion/framework-detection.js';

describe('detectFrameworkFromPath', () => {
  describe('Next.js', () => {
    it('detects Pages Router pages', () => {
      const result = detectFrameworkFromPath('pages/users.tsx');
      expect(result).not.toBeNull();
      expect(result!.framework).toBe('nextjs-pages');
      expect(result!.entryPointMultiplier).toBe(3.0);
    });

    it('ignores _app and _document pages', () => {
      expect(detectFrameworkFromPath('pages/_app.tsx')).toBeNull();
    });

    it('detects App Router page.tsx', () => {
      const result = detectFrameworkFromPath('app/dashboard/page.tsx');
      expect(result).not.toBeNull();
      expect(result!.framework).toBe('nextjs-app');
    });

    it('detects API routes in pages', () => {
      const result = detectFrameworkFromPath('pages/api/users.ts');
      expect(result).not.toBeNull();
      expect(result!.framework).toBe('nextjs-api');
    });

    it('detects App Router API route.ts', () => {
      const result = detectFrameworkFromPath('app/api/users/route.ts');
      expect(result).not.toBeNull();
      expect(result!.framework).toBe('nextjs-api');
    });

    it('detects layout files', () => {
      const result = detectFrameworkFromPath('app/layout.tsx');
      expect(result).not.toBeNull();
      expect(result!.entryPointMultiplier).toBe(2.0);
    });
  });

  describe('Express / Node.js', () => {
    it('detects route files', () => {
      const result = detectFrameworkFromPath('routes/auth.ts');
      expect(result).not.toBeNull();
      expect(result!.framework).toBe('express');
      expect(result!.entryPointMultiplier).toBe(2.5);
    });
  });

  describe('MVC controllers', () => {
    it('detects controller folder', () => {
      const result = detectFrameworkFromPath('controllers/UserController.ts');
      expect(result).not.toBeNull();
      expect(result!.framework).toBe('mvc');
    });

    it('detects handlers folder', () => {
      const result = detectFrameworkFromPath('handlers/auth.ts');
      expect(result).not.toBeNull();
      expect(result!.framework).toBe('handlers');
    });
  });

  describe('React', () => {
    it('has React component detection rule for views/components folders', () => {
      // Note: The current implementation lowercases the path before checking
      // PascalCase, so PascalCase detection currently can't match.
      // This test documents the current behavior.
      const result = detectFrameworkFromPath('views/Button.tsx');
      // Returns null because path is lowercased before PascalCase regex check
      expect(result).toBeNull();
    });
  });

  describe('Python frameworks', () => {
    it('detects Django views', () => {
      const result = detectFrameworkFromPath('myapp/views.py');
      expect(result).not.toBeNull();
      expect(result!.framework).toBe('django');
      expect(result!.entryPointMultiplier).toBe(3.0);
    });

    it('detects Django URLs', () => {
      const result = detectFrameworkFromPath('myapp/urls.py');
      expect(result).not.toBeNull();
      expect(result!.framework).toBe('django');
    });

    it('detects FastAPI routers', () => {
      const result = detectFrameworkFromPath('routers/users.py');
      expect(result).not.toBeNull();
      expect(result!.framework).toBe('fastapi');
    });
  });

  describe('Java frameworks', () => {
    it('detects Spring controllers folder', () => {
      const result = detectFrameworkFromPath('controller/UserController.java');
      expect(result).not.toBeNull();
      expect(result!.framework).toBe('spring');
    });

    it('detects Spring controller by filename', () => {
      const result = detectFrameworkFromPath('src/UserController.java');
      expect(result).not.toBeNull();
      expect(result!.framework).toBe('spring');
    });

    it('detects Java service layer', () => {
      const result = detectFrameworkFromPath('service/UserService.java');
      expect(result).not.toBeNull();
      expect(result!.framework).toBe('java-service');
    });
  });

  describe('C# / .NET', () => {
    it('detects ASP.NET controllers', () => {
      const result = detectFrameworkFromPath('controllers/UsersController.cs');
      expect(result).not.toBeNull();
      expect(result!.framework).toBe('aspnet');
    });

    it('detects Blazor pages', () => {
      const result = detectFrameworkFromPath('pages/Index.razor');
      expect(result).not.toBeNull();
      expect(result!.framework).toBe('blazor');
    });
  });

  describe('Go frameworks', () => {
    it('detects Go handlers', () => {
      const result = detectFrameworkFromPath('handlers/user.go');
      expect(result).not.toBeNull();
      expect(result!.framework).toBe('go-http');
    });

    it('detects Go main.go', () => {
      const result = detectFrameworkFromPath('cmd/server/main.go');
      expect(result).not.toBeNull();
      expect(result!.entryPointMultiplier).toBe(3.0);
    });
  });

  describe('Rust frameworks', () => {
    it('detects Rust handlers', () => {
      const result = detectFrameworkFromPath('handlers/auth.rs');
      expect(result).not.toBeNull();
      expect(result!.framework).toBe('rust-web');
    });

    it('detects main.rs', () => {
      const result = detectFrameworkFromPath('src/main.rs');
      expect(result).not.toBeNull();
      expect(result!.framework).toBe('rust');
      expect(result!.entryPointMultiplier).toBe(3.0);
    });

    it('detects bin folder', () => {
      const result = detectFrameworkFromPath('src/bin/cli.rs');
      expect(result).not.toBeNull();
      expect(result!.framework).toBe('rust');
    });
  });

  describe('C / C++', () => {
    it('detects main.c', () => {
      const result = detectFrameworkFromPath('src/main.c');
      expect(result).not.toBeNull();
      expect(result!.framework).toBe('c-cpp');
    });

    it('detects main.cpp', () => {
      const result = detectFrameworkFromPath('src/main.cpp');
      expect(result).not.toBeNull();
      expect(result!.framework).toBe('c-cpp');
    });
  });

  describe('PHP / Laravel', () => {
    it('detects Laravel routes', () => {
      const result = detectFrameworkFromPath('routes/web.php');
      expect(result).not.toBeNull();
      expect(result!.framework).toBe('laravel');
      expect(result!.entryPointMultiplier).toBe(3.0);
    });

    it('detects Laravel controllers', () => {
      const result = detectFrameworkFromPath('http/controllers/UserController.php');
      expect(result).not.toBeNull();
      expect(result!.framework).toBe('laravel');
    });

    it('detects Laravel jobs', () => {
      const result = detectFrameworkFromPath('jobs/SendEmail.php');
      expect(result).not.toBeNull();
      expect(result!.reason).toBe('laravel-job');
    });

    it('detects Laravel middleware', () => {
      const result = detectFrameworkFromPath('http/middleware/Auth.php');
      expect(result).not.toBeNull();
      expect(result!.reason).toBe('laravel-middleware');
    });

    it('detects Laravel models', () => {
      const result = detectFrameworkFromPath('models/User.php');
      expect(result).not.toBeNull();
      expect(result!.entryPointMultiplier).toBe(1.5);
    });
  });

  describe('Swift / iOS', () => {
    it('detects AppDelegate', () => {
      const result = detectFrameworkFromPath('Sources/AppDelegate.swift');
      expect(result).not.toBeNull();
      expect(result!.framework).toBe('ios');
    });

    it('detects ViewControllers folder', () => {
      const result = detectFrameworkFromPath('ViewControllers/LoginVC.swift');
      expect(result).not.toBeNull();
      expect(result!.framework).toBe('uikit');
    });

    it('detects Coordinator pattern', () => {
      const result = detectFrameworkFromPath('Coordinators/AppCoordinator.swift');
      expect(result).not.toBeNull();
      expect(result!.framework).toBe('ios-coordinator');
    });

    it('detects SwiftUI views folder', () => {
      const result = detectFrameworkFromPath('views/ContentView.swift');
      expect(result).not.toBeNull();
      expect(result!.framework).toBe('swiftui');
    });
  });

  describe('generic patterns', () => {
    it('returns null for unknown paths', () => {
      expect(detectFrameworkFromPath('src/internal/crypto.ts')).toBeNull();
    });

    it('normalizes Windows backslashes', () => {
      const result = detectFrameworkFromPath('routes\\auth.ts');
      expect(result).not.toBeNull();
      expect(result!.framework).toBe('express');
    });
  });
});

describe('detectFrameworkFromAST', () => {
  it('returns null for empty inputs', () => {
    expect(detectFrameworkFromAST('', '')).toBeNull();
    expect(detectFrameworkFromAST('typescript', '')).toBeNull();
    expect(detectFrameworkFromAST('', 'some code')).toBeNull();
  });

  it('detects NestJS decorators in TypeScript', () => {
    const result = detectFrameworkFromAST('typescript', '@Controller("/users")');
    expect(result).not.toBeNull();
    expect(result!.framework).toBe('nestjs');
    expect(result!.entryPointMultiplier).toBe(3.2);
  });

  it('detects NestJS decorators in JavaScript', () => {
    const result = detectFrameworkFromAST('javascript', '@Get("/")');
    expect(result).not.toBeNull();
    expect(result!.framework).toBe('nestjs');
  });

  it('detects FastAPI decorators in Python', () => {
    const result = detectFrameworkFromAST('python', '@app.get("/users")');
    expect(result).not.toBeNull();
    expect(result!.framework).toBe('fastapi');
  });

  it('detects Flask decorators in Python', () => {
    const result = detectFrameworkFromAST('python', '@app.route("/users")');
    expect(result).not.toBeNull();
    expect(result!.framework).toBe('flask');
  });

  it('detects Spring annotations in Java', () => {
    const result = detectFrameworkFromAST('java', '@RestController');
    expect(result).not.toBeNull();
    expect(result!.framework).toBe('spring');
  });

  it('detects ASP.NET attributes in C#', () => {
    const result = detectFrameworkFromAST('csharp', '[ApiController]');
    expect(result).not.toBeNull();
    expect(result!.framework).toBe('aspnet');
  });

  it('detects Laravel route definitions in PHP', () => {
    const result = detectFrameworkFromAST('php', "Route::get('/users', [UserController::class, 'index'])");
    expect(result).not.toBeNull();
    expect(result!.framework).toBe('laravel');
  });

  it('returns null for unsupported language', () => {
    expect(detectFrameworkFromAST('rust', '#[get("/")]')).toBeNull();
  });

  it('is case-insensitive', () => {
    const result = detectFrameworkFromAST('TypeScript', '@controller("/")');
    expect(result).not.toBeNull();
  });
});

describe('FRAMEWORK_AST_PATTERNS', () => {
  it('has patterns for all expected frameworks', () => {
    const expectedFrameworks = [
      'nestjs', 'express', 'fastapi', 'flask', 'spring', 'jaxrs',
      'aspnet', 'go-http', 'laravel', 'actix', 'axum', 'rocket',
      'uikit', 'swiftui', 'combine',
    ];
    for (const fw of expectedFrameworks) {
      expect(FRAMEWORK_AST_PATTERNS).toHaveProperty(fw);
      expect(FRAMEWORK_AST_PATTERNS[fw as keyof typeof FRAMEWORK_AST_PATTERNS].length).toBeGreaterThan(0);
    }
  });
});
