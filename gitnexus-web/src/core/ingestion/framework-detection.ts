/**
 * Framework Detection
 * 
 * Detects frameworks from file path patterns and provides entry point multipliers.
 * This enables framework-aware entry point scoring.
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
  
  // ========== C# / .NET FRAMEWORKS ==========
  
  // ASP.NET Controllers
  if (p.includes('/controllers/') && p.endsWith('.cs')) {
    return { framework: 'aspnet', entryPointMultiplier: 3.0, reason: 'aspnet-controller' };
  }
  
  // ASP.NET - files ending in Controller.cs
  if (p.endsWith('controller.cs')) {
    return { framework: 'aspnet', entryPointMultiplier: 3.0, reason: 'aspnet-controller-file' };
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

  // ========== DART / FLUTTER ==========

  // Flutter main entry point
  if (p.endsWith('/main.dart')) {
    return { framework: 'flutter', entryPointMultiplier: 3.0, reason: 'flutter-main' };
  }

  // Flutter screens/pages (high priority - route entry points)
  if ((p.includes('/lib/screens/') || p.includes('/lib/pages/')) && p.endsWith('.dart')) {
    return { framework: 'flutter', entryPointMultiplier: 2.5, reason: 'flutter-screen' };
  }

  // Flutter BLoC / controllers (state management entry points)
  if ((p.includes('/lib/bloc/') || p.includes('/lib/controllers/') || p.includes('/lib/cubit/')) && p.endsWith('.dart')) {
    return { framework: 'flutter', entryPointMultiplier: 2.0, reason: 'flutter-state-management' };
  }

  // Flutter services
  if (p.includes('/lib/services/') && p.endsWith('.dart')) {
    return { framework: 'flutter', entryPointMultiplier: 1.8, reason: 'flutter-service' };
  }

  // Flutter widgets (reusable components)
  if (p.includes('/lib/widgets/') && p.endsWith('.dart')) {
    return { framework: 'flutter', entryPointMultiplier: 1.5, reason: 'flutter-widget' };
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
// PARTIALLY IMPLEMENTED: Route::* detection via procedural AST walk in parse-worker/call-processor
// Remaining: NestJS, Express, FastAPI, Flask, Spring, etc.
// ============================================================================

/**
 * Patterns that indicate entry points within code (for future AST-based detection)
 * These would require parsing decorators/annotations in the code itself.
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
  'aspnet': ['[ApiController]', '[HttpGet]', '[HttpPost]', '[Route]'],
  
  // Go patterns (function signatures)
  'go-http': ['http.Handler', 'http.HandlerFunc', 'ServeHTTP'],

  // PHP/Laravel
  'laravel': ['Route::get', 'Route::post', 'Route::put', 'Route::delete',
              'Route::resource', 'Route::apiResource', '#[Route('],

  // Rust macros
  'actix': ['#[get', '#[post', '#[put', '#[delete'],
  'axum': ['Router::new'],
  'rocket': ['#[get', '#[post'],

  // Dart/Flutter
  'flutter': ['StatelessWidget', 'StatefulWidget', 'BuildContext', 'Widget build',
              'ChangeNotifier', 'GetxController', 'Cubit<', 'Bloc<'],

  // Swift/iOS
  'uikit': ['viewDidLoad', 'viewWillAppear', 'viewDidAppear', 'UIViewController'],
  'swiftui': ['@main', 'WindowGroup', 'ContentView', '@StateObject', '@ObservedObject'],
  'combine': ['sink', 'assign', 'Publisher', 'Subscriber'],
};
