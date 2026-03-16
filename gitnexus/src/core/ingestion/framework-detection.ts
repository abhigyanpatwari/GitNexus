/**
 * Framework Detection
 * 
 * Detects frameworks from:
 * 1) file path patterns
 * 2) AST definition text (decorators/annotations/attributes)
 * and provides entry point multipliers for process scoring.
 * 
 * DESIGN: Returns null for unknown frameworks, which causes a 1.0 multiplier
 * (no bonus, no penalty) - same behavior as before this feature.
 */

// ============================================================================
// TYPES
// ============================================================================

export interface FrameworkHint {
  framework: string;
  entryPointMultiplier: number;
  reason: string;
}

// ============================================================================
// PATH-BASED FRAMEWORK DETECTION
// ============================================================================

/**
 * Detect framework from file path patterns
 * 
 * This provides entry point multipliers based on well-known framework conventions.
 * Returns null if no framework pattern is detected (falls back to 1.0 multiplier).
 */
export function detectFrameworkFromPath(filePath: string): FrameworkHint | null {
  // Normalize path separators and ensure leading slash for consistent matching
  let p = filePath.toLowerCase().replace(/\\/g, '/');
  if (!p.startsWith('/')) {
    p = '/' + p;  // Add leading slash so patterns like '/app/' match 'app/...'
  }
  
  // ========== JAVASCRIPT / TYPESCRIPT FRAMEWORKS ==========
  
  // Next.js - Pages Router (high confidence)
  if (p.includes('/pages/') && !p.includes('/_') && !p.includes('/api/')) {
    if (p.endsWith('.tsx') || p.endsWith('.ts') || p.endsWith('.jsx') || p.endsWith('.js')) {
      return { framework: 'nextjs-pages', entryPointMultiplier: 3.0, reason: 'nextjs-page' };
    }
  }
  
  // Next.js - App Router (page.tsx files)
  if (p.includes('/app/') && (
    p.endsWith('page.tsx') || p.endsWith('page.ts') || 
    p.endsWith('page.jsx') || p.endsWith('page.js')
  )) {
    return { framework: 'nextjs-app', entryPointMultiplier: 3.0, reason: 'nextjs-app-page' };
  }
  
  // Next.js - API Routes
  if (p.includes('/pages/api/') || (p.includes('/app/') && p.includes('/api/') && p.endsWith('route.ts'))) {
    return { framework: 'nextjs-api', entryPointMultiplier: 3.0, reason: 'nextjs-api-route' };
  }
  
  // Next.js - Layout files (moderate - they're entry-ish but not the main entry)
  if (p.includes('/app/') && (p.endsWith('layout.tsx') || p.endsWith('layout.ts'))) {
    return { framework: 'nextjs-app', entryPointMultiplier: 2.0, reason: 'nextjs-layout' };
  }
  
  // Express / Node.js routes
  if (p.includes('/routes/') && (p.endsWith('.ts') || p.endsWith('.js'))) {
    return { framework: 'express', entryPointMultiplier: 2.5, reason: 'routes-folder' };
  }
  
  // Generic controllers (MVC pattern)
  if (p.includes('/controllers/') && (p.endsWith('.ts') || p.endsWith('.js'))) {
    return { framework: 'mvc', entryPointMultiplier: 2.5, reason: 'controllers-folder' };
  }
  
  // Generic handlers
  if (p.includes('/handlers/') && (p.endsWith('.ts') || p.endsWith('.js'))) {
    return { framework: 'handlers', entryPointMultiplier: 2.5, reason: 'handlers-folder' };
  }
  
  // React components (lower priority - not all are entry points)
  if ((p.includes('/components/') || p.includes('/views/')) && 
      (p.endsWith('.tsx') || p.endsWith('.jsx'))) {
    // Only boost if PascalCase filename (likely a component, not util)
    const fileName = p.split('/').pop() || '';
    if (/^[A-Z]/.test(fileName)) {
      return { framework: 'react', entryPointMultiplier: 1.5, reason: 'react-component' };
    }
  }
  
  // ========== PYTHON FRAMEWORKS ==========
  
  // Django views (high confidence)
  if (p.endsWith('views.py')) {
    return { framework: 'django', entryPointMultiplier: 3.0, reason: 'django-views' };
  }
  
  // Django URL configs
  if (p.endsWith('urls.py')) {
    return { framework: 'django', entryPointMultiplier: 2.0, reason: 'django-urls' };
  }
  
  // FastAPI / Flask routers
  if ((p.includes('/routers/') || p.includes('/endpoints/') || p.includes('/routes/')) && 
      p.endsWith('.py')) {
    return { framework: 'fastapi', entryPointMultiplier: 2.5, reason: 'api-routers' };
  }
  
  // Python API folder
  if (p.includes('/api/') && p.endsWith('.py') && !p.endsWith('__init__.py')) {
    return { framework: 'python-api', entryPointMultiplier: 2.0, reason: 'api-folder' };
  }
  
  // ========== JAVA FRAMEWORKS ==========
  
  // Spring Boot controllers
  if ((p.includes('/controller/') || p.includes('/controllers/')) && p.endsWith('.java')) {
    return { framework: 'spring', entryPointMultiplier: 3.0, reason: 'spring-controller' };
  }
  
  // Spring Boot - files ending in Controller.java
  if (p.endsWith('controller.java')) {
    return { framework: 'spring', entryPointMultiplier: 3.0, reason: 'spring-controller-file' };
  }
  
  // Java service layer (often entry points for business logic)
  if ((p.includes('/service/') || p.includes('/services/')) && p.endsWith('.java')) {
    return { framework: 'java-service', entryPointMultiplier: 1.8, reason: 'java-service' };
  }
  
  // ========== KOTLIN FRAMEWORKS ==========

  // Spring Boot Kotlin controllers
  if ((p.includes('/controller/') || p.includes('/controllers/')) && p.endsWith('.kt')) {
    return { framework: 'spring-kotlin', entryPointMultiplier: 3.0, reason: 'spring-kotlin-controller' };
  }

  // Spring Boot - files ending in Controller.kt
  if (p.endsWith('controller.kt')) {
    return { framework: 'spring-kotlin', entryPointMultiplier: 3.0, reason: 'spring-kotlin-controller-file' };
  }

  // Ktor routes
  if (p.includes('/routes/') && p.endsWith('.kt')) {
    return { framework: 'ktor', entryPointMultiplier: 2.5, reason: 'ktor-routes' };
  }

  // Ktor plugins folder or Routing.kt files
  if (p.includes('/plugins/') && p.endsWith('.kt')) {
    return { framework: 'ktor', entryPointMultiplier: 2.0, reason: 'ktor-plugin' };
  }
  if (p.endsWith('routing.kt') || p.endsWith('routes.kt')) {
    return { framework: 'ktor', entryPointMultiplier: 2.5, reason: 'ktor-routing-file' };
  }

  // Android Activities, Fragments
  if ((p.includes('/activity/') || p.includes('/ui/')) && p.endsWith('.kt')) {
    return { framework: 'android-kotlin', entryPointMultiplier: 2.5, reason: 'android-ui' };
  }
  if (p.endsWith('activity.kt') || p.endsWith('fragment.kt')) {
    return { framework: 'android-kotlin', entryPointMultiplier: 2.5, reason: 'android-component' };
  }

  // Kotlin main entry point
  if (p.endsWith('/main.kt')) {
    return { framework: 'kotlin', entryPointMultiplier: 3.0, reason: 'kotlin-main' };
  }

  // Kotlin Application entry point (common naming)
  if (p.endsWith('/application.kt')) {
    return { framework: 'kotlin', entryPointMultiplier: 2.5, reason: 'kotlin-application' };
  }

  // ========== C# / .NET FRAMEWORKS ==========
  
  // ASP.NET Controllers
  if (p.includes('/controllers/') && p.endsWith('.cs')) {
    return { framework: 'aspnet', entryPointMultiplier: 3.0, reason: 'aspnet-controller' };
  }
  
  // ASP.NET - files ending in Controller.cs
  if (p.endsWith('controller.cs')) {
    return { framework: 'aspnet', entryPointMultiplier: 3.0, reason: 'aspnet-controller-file' };
  }

  // ASP.NET Services
  if ((p.includes('/services/') || p.includes('/service/')) && p.endsWith('.cs')) {
    return { framework: 'aspnet', entryPointMultiplier: 1.8, reason: 'aspnet-service' };
  }

  // ASP.NET Middleware
  if (p.includes('/middleware/') && p.endsWith('.cs')) {
    return { framework: 'aspnet', entryPointMultiplier: 2.5, reason: 'aspnet-middleware' };
  }

  // SignalR Hubs
  if (p.includes('/hubs/') && p.endsWith('.cs')) {
    return { framework: 'signalr', entryPointMultiplier: 2.5, reason: 'signalr-hub' };
  }
  if (p.endsWith('hub.cs')) {
    return { framework: 'signalr', entryPointMultiplier: 2.5, reason: 'signalr-hub-file' };
  }

  // Minimal API / Program.cs / Startup.cs
  if (p.endsWith('/program.cs') || p.endsWith('/startup.cs')) {
    return { framework: 'aspnet', entryPointMultiplier: 3.0, reason: 'aspnet-entry' };
  }

  // Background services / Hosted services
  if ((p.includes('/backgroundservices/') || p.includes('/hostedservices/')) && p.endsWith('.cs')) {
    return { framework: 'aspnet', entryPointMultiplier: 2.0, reason: 'aspnet-background-service' };
  }

  // Blazor pages
  if (p.includes('/pages/') && p.endsWith('.razor')) {
    return { framework: 'blazor', entryPointMultiplier: 2.5, reason: 'blazor-page' };
  }
  
  // ========== GO FRAMEWORKS ==========
  
  // Go handlers
  if ((p.includes('/handlers/') || p.includes('/handler/')) && p.endsWith('.go')) {
    return { framework: 'go-http', entryPointMultiplier: 2.5, reason: 'go-handlers' };
  }
  
  // Go routes
  if (p.includes('/routes/') && p.endsWith('.go')) {
    return { framework: 'go-http', entryPointMultiplier: 2.5, reason: 'go-routes' };
  }
  
  // Go controllers
  if (p.includes('/controllers/') && p.endsWith('.go')) {
    return { framework: 'go-mvc', entryPointMultiplier: 2.5, reason: 'go-controller' };
  }
  
  // Go main.go files (THE entry point)
  if (p.endsWith('/main.go') || p.endsWith('/cmd/') && p.endsWith('.go')) {
    return { framework: 'go', entryPointMultiplier: 3.0, reason: 'go-main' };
  }
  
  // ========== RUST FRAMEWORKS ==========
  
  // Rust handlers/routes
  if ((p.includes('/handlers/') || p.includes('/routes/')) && p.endsWith('.rs')) {
    return { framework: 'rust-web', entryPointMultiplier: 2.5, reason: 'rust-handlers' };
  }
  
  // Rust main.rs (THE entry point)
  if (p.endsWith('/main.rs')) {
    return { framework: 'rust', entryPointMultiplier: 3.0, reason: 'rust-main' };
  }
  
  // Rust bin folder (executables)
  if (p.includes('/bin/') && p.endsWith('.rs')) {
    return { framework: 'rust', entryPointMultiplier: 2.5, reason: 'rust-bin' };
  }
  
  // ========== C / C++ ==========
  
  // C/C++ main files
  if (p.endsWith('/main.c') || p.endsWith('/main.cpp') || p.endsWith('/main.cc')) {
    return { framework: 'c-cpp', entryPointMultiplier: 3.0, reason: 'c-main' };
  }
  
  // C/C++ src folder entry points (if named specifically)
  if ((p.includes('/src/') && (p.endsWith('/app.c') || p.endsWith('/app.cpp')))) {
    return { framework: 'c-cpp', entryPointMultiplier: 2.5, reason: 'c-app' };
  }
  
  // ========== PHP / LARAVEL FRAMEWORKS ==========

  // Laravel routes (highest - these ARE the entry point definitions)
  if (p.includes('/routes/') && p.endsWith('.php')) {
    return { framework: 'laravel', entryPointMultiplier: 3.0, reason: 'laravel-routes' };
  }

  // Laravel controllers (very high - receive HTTP requests)
  if ((p.includes('/http/controllers/') || p.includes('/controllers/')) && p.endsWith('.php')) {
    return { framework: 'laravel', entryPointMultiplier: 3.0, reason: 'laravel-controller' };
  }

  // Laravel controller by file name convention
  if (p.endsWith('controller.php')) {
    return { framework: 'laravel', entryPointMultiplier: 3.0, reason: 'laravel-controller-file' };
  }

  // Laravel console commands
  if ((p.includes('/console/commands/') || p.includes('/commands/')) && p.endsWith('.php')) {
    return { framework: 'laravel', entryPointMultiplier: 2.5, reason: 'laravel-command' };
  }

  // Laravel jobs (queue entry points)
  if (p.includes('/jobs/') && p.endsWith('.php')) {
    return { framework: 'laravel', entryPointMultiplier: 2.5, reason: 'laravel-job' };
  }

  // Laravel listeners (event-driven entry points)
  if (p.includes('/listeners/') && p.endsWith('.php')) {
    return { framework: 'laravel', entryPointMultiplier: 2.5, reason: 'laravel-listener' };
  }

  // Laravel middleware
  if (p.includes('/http/middleware/') && p.endsWith('.php')) {
    return { framework: 'laravel', entryPointMultiplier: 2.5, reason: 'laravel-middleware' };
  }

  // Laravel service providers
  if (p.includes('/providers/') && p.endsWith('.php')) {
    return { framework: 'laravel', entryPointMultiplier: 1.8, reason: 'laravel-provider' };
  }

  // Laravel policies
  if (p.includes('/policies/') && p.endsWith('.php')) {
    return { framework: 'laravel', entryPointMultiplier: 2.0, reason: 'laravel-policy' };
  }

  // Laravel models (important but not entry points per se)
  if (p.includes('/models/') && p.endsWith('.php')) {
    return { framework: 'laravel', entryPointMultiplier: 1.5, reason: 'laravel-model' };
  }

  // Laravel services (Service Repository pattern)
  if (p.includes('/services/') && p.endsWith('.php')) {
    return { framework: 'laravel', entryPointMultiplier: 1.8, reason: 'laravel-service' };
  }

  // Laravel repositories (Service Repository pattern)
  if (p.includes('/repositories/') && p.endsWith('.php')) {
    return { framework: 'laravel', entryPointMultiplier: 1.5, reason: 'laravel-repository' };
  }

  // ========== RUBY ==========

  // Ruby: bin/ or exe/ (CLI entry points)
  if ((p.includes('/bin/') || p.includes('/exe/')) && p.endsWith('.rb')) {
    return { framework: 'ruby', entryPointMultiplier: 2.5, reason: 'ruby-executable' };
  }

  // Ruby: Rakefile or *.rake (task definitions)
  if (p.endsWith('/rakefile') || p.endsWith('.rake')) {
    return { framework: 'ruby', entryPointMultiplier: 1.5, reason: 'ruby-rake' };
  }
  
  // ========== SWIFT / iOS ==========

  // iOS App entry points (highest priority)
  if (p.endsWith('/appdelegate.swift') || p.endsWith('/scenedelegate.swift') || p.endsWith('/app.swift')) {
    return { framework: 'ios', entryPointMultiplier: 3.0, reason: 'ios-app-entry' };
  }

  // SwiftUI App entry (@main)
  if (p.endsWith('app.swift') && p.includes('/sources/')) {
    return { framework: 'swiftui', entryPointMultiplier: 3.0, reason: 'swiftui-app' };
  }

  // UIKit ViewControllers (high priority - screen entry points)
  if ((p.includes('/viewcontrollers/') || p.includes('/controllers/') || p.includes('/screens/')) && p.endsWith('.swift')) {
    return { framework: 'uikit', entryPointMultiplier: 2.5, reason: 'uikit-viewcontroller' };
  }

  // ViewController by filename convention
  if (p.endsWith('viewcontroller.swift') || p.endsWith('vc.swift')) {
    return { framework: 'uikit', entryPointMultiplier: 2.5, reason: 'uikit-viewcontroller-file' };
  }

  // Coordinator pattern (navigation entry points)
  if (p.includes('/coordinators/') && p.endsWith('.swift')) {
    return { framework: 'ios-coordinator', entryPointMultiplier: 2.5, reason: 'ios-coordinator' };
  }

  // Coordinator by filename
  if (p.endsWith('coordinator.swift')) {
    return { framework: 'ios-coordinator', entryPointMultiplier: 2.5, reason: 'ios-coordinator-file' };
  }

  // SwiftUI Views (moderate - reusable components)
  if ((p.includes('/views/') || p.includes('/scenes/')) && p.endsWith('.swift')) {
    return { framework: 'swiftui', entryPointMultiplier: 1.8, reason: 'swiftui-view' };
  }

  // Service layer
  if (p.includes('/services/') && p.endsWith('.swift')) {
    return { framework: 'ios-service', entryPointMultiplier: 1.8, reason: 'ios-service' };
  }

  // Router / navigation
  if (p.includes('/router/') && p.endsWith('.swift')) {
    return { framework: 'ios-router', entryPointMultiplier: 2.0, reason: 'ios-router' };
  }

  // ========== GENERIC PATTERNS ==========

  // Any language: index files in API folders
  if (p.includes('/api/') && (
    p.endsWith('/index.ts') || p.endsWith('/index.js') || 
    p.endsWith('/__init__.py')
  )) {
    return { framework: 'api', entryPointMultiplier: 1.8, reason: 'api-index' };
  }
  
  // No framework detected - return null for graceful fallback (1.0 multiplier)
  return null;
}

// ============================================================================
// AST-BASED FRAMEWORK DETECTION
// ============================================================================

/**
 * Patterns that indicate framework entry points within code definitions.
 * These are matched against AST node text (class/method/function declaration text).
 */
export const FRAMEWORK_AST_PATTERNS = {
  // JavaScript/TypeScript decorators
  'nestjs': ['@Controller', '@Get', '@Post', '@Put', '@Delete', '@Patch'],
  'express': ['app.get', 'app.post', 'app.put', 'app.delete', 'router.get', 'router.post'],
  
  // Python decorators
  'fastapi': ['@app.get', '@app.post', '@app.put', '@app.delete', '@router.get'],
  'flask': ['@app.route', '@blueprint.route'],
  
  // Java annotations
  'spring': ['@RestController', '@Controller', '@GetMapping', '@PostMapping', '@RequestMapping'],
  'jaxrs': ['@Path', '@GET', '@POST', '@PUT', '@DELETE'],
  
  // C# attributes
  'aspnet': ['[ApiController]', '[HttpGet]', '[HttpPost]', '[HttpPut]', '[HttpDelete]',
             '[Route]', '[Authorize]', '[AllowAnonymous]'],
  'signalr': ['[HubMethodName]', ': Hub', ': Hub<'],
  'blazor': ['@page', '[Parameter]', '@inject'],
  'efcore': ['DbContext', 'DbSet<', 'OnModelCreating'],
  
  // Go patterns (function signatures)
  'go-http': ['http.Handler', 'http.HandlerFunc', 'ServeHTTP'],

  // PHP/Laravel
  'laravel': ['Route::get', 'Route::post', 'Route::put', 'Route::delete',
              'Route::resource', 'Route::apiResource', '#[Route('],

  // Rust macros
  'actix': ['#[get', '#[post', '#[put', '#[delete'],
  'axum': ['Router::new'],
  'rocket': ['#[get', '#[post'],

  // Swift/iOS
  'uikit': ['viewDidLoad', 'viewWillAppear', 'viewDidAppear', 'UIViewController'],
  'swiftui': ['@main', 'WindowGroup', 'ContentView', '@StateObject', '@ObservedObject'],
  'combine': ['sink', 'assign', 'Publisher', 'Subscriber'],
};

import { SupportedLanguages } from '../../config/supported-languages.js';

interface AstFrameworkPatternConfig {
  framework: string;
  entryPointMultiplier: number;
  reason: string;
  patterns: string[];
}

const AST_FRAMEWORK_PATTERNS_BY_LANGUAGE: Record<string, AstFrameworkPatternConfig[]> = {
  [SupportedLanguages.JavaScript]: [
    { framework: 'nestjs', entryPointMultiplier: 3.2, reason: 'nestjs-decorator', patterns: FRAMEWORK_AST_PATTERNS.nestjs },
  ],
  [SupportedLanguages.TypeScript]: [
    { framework: 'nestjs', entryPointMultiplier: 3.2, reason: 'nestjs-decorator', patterns: FRAMEWORK_AST_PATTERNS.nestjs },
  ],
  [SupportedLanguages.Python]: [
    { framework: 'fastapi', entryPointMultiplier: 3.0, reason: 'fastapi-decorator', patterns: FRAMEWORK_AST_PATTERNS.fastapi },
    { framework: 'flask', entryPointMultiplier: 2.8, reason: 'flask-decorator', patterns: FRAMEWORK_AST_PATTERNS.flask },
  ],
  [SupportedLanguages.Java]: [
    { framework: 'spring', entryPointMultiplier: 3.2, reason: 'spring-annotation', patterns: FRAMEWORK_AST_PATTERNS.spring },
    { framework: 'jaxrs', entryPointMultiplier: 3.0, reason: 'jaxrs-annotation', patterns: FRAMEWORK_AST_PATTERNS.jaxrs },
  ],
  [SupportedLanguages.Kotlin]: [
    { framework: 'spring-kotlin', entryPointMultiplier: 3.2, reason: 'spring-kotlin-annotation', patterns: FRAMEWORK_AST_PATTERNS.spring },
    { framework: 'jaxrs', entryPointMultiplier: 3.0, reason: 'jaxrs-annotation', patterns: FRAMEWORK_AST_PATTERNS.jaxrs },
    { framework: 'ktor', entryPointMultiplier: 2.8, reason: 'ktor-routing', patterns: ['routing', 'embeddedServer', 'Application.module'] },
    { framework: 'android-kotlin', entryPointMultiplier: 2.5, reason: 'android-annotation', patterns: ['@AndroidEntryPoint', 'AppCompatActivity', 'Fragment('] },
  ],
  [SupportedLanguages.CSharp]: [
    { framework: 'aspnet', entryPointMultiplier: 3.2, reason: 'aspnet-attribute', patterns: FRAMEWORK_AST_PATTERNS.aspnet },
    { framework: 'signalr', entryPointMultiplier: 2.8, reason: 'signalr-attribute', patterns: FRAMEWORK_AST_PATTERNS.signalr },
    { framework: 'blazor', entryPointMultiplier: 2.5, reason: 'blazor-attribute', patterns: FRAMEWORK_AST_PATTERNS.blazor },
    { framework: 'efcore', entryPointMultiplier: 2.0, reason: 'efcore-pattern', patterns: FRAMEWORK_AST_PATTERNS.efcore },
  ],
  [SupportedLanguages.PHP]: [
    { framework: 'laravel', entryPointMultiplier: 3.0, reason: 'php-route-attribute', patterns: FRAMEWORK_AST_PATTERNS.laravel },
  ],
};

/** Pre-lowercased patterns for O(1) pattern matching at runtime */
const AST_PATTERNS_LOWERED: Record<string, Array<{ framework: string; entryPointMultiplier: number; reason: string; patterns: string[] }>> =
  Object.fromEntries(
    Object.entries(AST_FRAMEWORK_PATTERNS_BY_LANGUAGE).map(([lang, cfgs]) => [
      lang,
      cfgs.map(cfg => ({ ...cfg, patterns: cfg.patterns.map(p => p.toLowerCase()) })),
    ])
  );

/**
 * Detect framework entry points from AST definition text (decorators/annotations/attributes).
 * Returns null if no known pattern is found.
 * Note: callers should slice definitionText to ~300 chars since annotations appear at the start.
 */
export function detectFrameworkFromAST(
  language: SupportedLanguages,
  definitionText: string
): FrameworkHint | null {
  if (!language || !definitionText) return null;

  const configs = AST_PATTERNS_LOWERED[language.toLowerCase()];
  if (!configs || configs.length === 0) return null;

  const normalized = definitionText.toLowerCase();

  for (const cfg of configs) {
    for (const pattern of cfg.patterns) {
      if (normalized.includes(pattern)) {
        return {
          framework: cfg.framework,
          entryPointMultiplier: cfg.entryPointMultiplier,
          reason: cfg.reason,
        };
      }
    }
  }

  return null;
}
