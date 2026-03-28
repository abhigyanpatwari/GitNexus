/**
 * Entry Point Scoring
 *
 * Calculates entry point scores for process detection based on:
 * 1. Call ratio (existing algorithm - callees / (callers + 1))
 * 2. Export status (exported functions get higher priority)
 * 3. Name patterns (functions matching entry point patterns like handle*, on*, *Controller)
 * 4. Framework detection (path-based detection for Next.js, Express, Django, etc.)
 *
 * This module is language-agnostic - language-specific patterns are defined per language.
 */

import { detectFrameworkFromPath } from './framework-detection.js';
import { SupportedLanguages } from 'gitnexus-shared';

// ============================================================================
// NAME PATTERNS - All 13 supported languages
// ============================================================================

/**
 * Common entry point naming patterns by language.
 * These patterns indicate functions that are likely feature entry points.
 *
 * Universal patterns are separated from per-language patterns so the per-language
 * table can use `satisfies Record<SupportedLanguages, RegExp[]>` for compile-time
 * exhaustiveness — the compiler catches any missing language entry.
 */
const UNIVERSAL_ENTRY_POINT_PATTERNS: RegExp[] = [
  /^(main|init|bootstrap|start|run|setup|configure)$/i,
  /^handle[A-Z]/, // handleLogin, handleSubmit
  /^on[A-Z]/, // onClick, onSubmit
  /Handler$/, // RequestHandler
  /Controller$/, // UserController
  /^process[A-Z]/, // processPayment
  /^execute[A-Z]/, // executeQuery
  /^perform[A-Z]/, // performAction
  /^dispatch[A-Z]/, // dispatchEvent
  /^trigger[A-Z]/, // triggerAction
  /^fire[A-Z]/, // fireEvent
  /^emit[A-Z]/, // emitEvent
];

export const ENTRY_POINT_PATTERNS = {
  // JavaScript/TypeScript
  [SupportedLanguages.JavaScript]: [
    /^use[A-Z]/, // React hooks (useEffect, etc.)
  ],
  [SupportedLanguages.TypeScript]: [
    /^use[A-Z]/, // React hooks
  ],

  // Python
  [SupportedLanguages.Python]: [
    /^app$/, // Flask/FastAPI app
    /^(get|post|put|delete|patch)_/i, // REST conventions
    /^api_/, // API functions
    /^view_/, // Django views
  ],

  // Java
  [SupportedLanguages.Java]: [
    /^do[A-Z]/, // doGet, doPost (Servlets)
    /^create[A-Z]/, // Factory patterns
    /^build[A-Z]/, // Builder patterns
    /Service$/, // UserService
  ],

  // Kotlin
  [SupportedLanguages.Kotlin]: [
    /^on(Create|Start|Resume|Pause|Stop|Destroy)$/, // Android lifecycle
    /^do[A-Z]/, // doGet, doPost (shared JVM Servlet pattern)
    /^create[A-Z]/, // Factory patterns
    /^build[A-Z]/, // Builder patterns
    /ViewModel$/, // MVVM pattern (Android)
    /^module$/, // Ktor module entry point
    /Service$/, // Service classes
  ],

  // C#
  [SupportedLanguages.CSharp]: [
    /^(Get|Post|Put|Delete|Patch)/, // ASP.NET action methods
    /Action$/, // MVC actions
    /^On[A-Z]/, // Event handlers / Blazor lifecycle
    /Async$/, // Async entry points
    /^Configure$/, // Startup.Configure
    /^ConfigureServices$/, // Startup.ConfigureServices
    /^Handle$/, // MediatR / generic handler
    /^Execute$/, // Command pattern
    /^Invoke$/, // Middleware Invoke
    /^Map[A-Z]/, // Minimal API MapGet, MapPost
    /Service$/, // Service classes
    /^Seed/, // Database seeding
  ],

  // Go
  [SupportedLanguages.Go]: [
    /Handler$/, // http.Handler pattern
    /^Serve/, // ServeHTTP
    /^New[A-Z]/, // Constructor pattern (returns new instance)
    /^Make[A-Z]/, // Make functions
  ],

  // Rust
  [SupportedLanguages.Rust]: [
    /^(get|post|put|delete)_handler$/i,
    /^handle_/, // handle_request
    /^new$/, // Constructor pattern
    /^run$/, // run entry point
    /^spawn/, // Async spawn
  ],

  // C - explicit main() boost plus common C entry point conventions
  [SupportedLanguages.C]: [
    /^main$/, // THE entry point
    /^init_/, // init_server, init_client
    /_init$/, // module_init, server_init
    /^start_/, // start_server
    /_start$/, // thread_start
    /^run_/, // run_loop
    /_run$/, // event_run
    /^stop_/, // stop_server
    /_stop$/, // service_stop
    /^open_/, // open_connection
    /_open$/, // file_open
    /^close_/, // close_connection
    /_close$/, // socket_close
    /^create_/, // create_session
    /_create$/, // object_create
    /^destroy_/, // destroy_session
    /_destroy$/, // object_destroy
    /^handle_/, // handle_request
    /_handler$/, // signal_handler
    /_callback$/, // event_callback
    /^cmd_/, // tmux: cmd_new_window, cmd_attach_session
    /^server_/, // server_start, server_loop
    /^client_/, // client_connect
    /^session_/, // session_create
    /^window_/, // window_resize (tmux)
    /^key_/, // key_press
    /^input_/, // input_parse
    /^output_/, // output_write
    /^notify_/, // notify_client
    /^control_/, // control_start
  ],

  // C++ - same as C plus OOP/template patterns
  [SupportedLanguages.CPlusPlus]: [
    /^main$/, // THE entry point
    /^init_/,
    /_init$/,
    /^Create[A-Z]/, // Factory patterns
    /^create_/,
    /^Run$/, // Run methods
    /^run$/,
    /^Start$/, // Start methods
    /^start$/,
    /^handle_/,
    /_handler$/,
    /_callback$/,
    /^OnEvent/, // Event callbacks
    /^on_/,
    /::Run$/, // Class::Run
    /::Start$/, // Class::Start
    /::Init$/, // Class::Init
    /::Execute$/, // Class::Execute
  ],

  // Swift / iOS
  [SupportedLanguages.Swift]: [
    /^viewDidLoad$/, // UIKit lifecycle
    /^viewWillAppear$/, // UIKit lifecycle
    /^viewDidAppear$/, // UIKit lifecycle
    /^viewWillDisappear$/, // UIKit lifecycle
    /^viewDidDisappear$/, // UIKit lifecycle
    /^application\(/, // AppDelegate methods
    /^scene\(/, // SceneDelegate methods
    /^body$/, // SwiftUI View.body
    /Coordinator$/, // Coordinator pattern
    /^sceneDidBecomeActive$/, // SceneDelegate lifecycle
    /^sceneWillResignActive$/, // SceneDelegate lifecycle
    /^didFinishLaunchingWithOptions$/, // AppDelegate
    /ViewController$/, // ViewController classes
    /^configure[A-Z]/, // Configuration methods
    /^setup[A-Z]/, // Setup methods
    /^makeBody$/, // SwiftUI ViewModifier
  ],

  // PHP / Laravel
  [SupportedLanguages.PHP]: [
    /Controller$/, // UserController (class name convention)
    /^handle$/, // Job::handle(), Listener::handle()
    /^execute$/, // Command::execute()
    /^boot$/, // ServiceProvider::boot()
    /^register$/, // ServiceProvider::register()
    /^__invoke$/, // Invokable controllers/actions
    /^(index|show|store|update|destroy|create|edit)$/, // RESTful resource methods
    /^(get|post|put|delete|patch)[A-Z]/, // Explicit HTTP method actions
    /^run$/, // Command/Job run()
    /^fire$/, // Event fire()
    /^dispatch$/, // Dispatchable jobs
    /Service$/, // UserService (Service layer)
    /Repository$/, // UserRepository (Repository pattern)
    /^find$/, // Repository::find()
    /^findAll$/, // Repository::findAll()
    /^save$/, // Repository::save()
    /^delete$/, // Repository::delete()
  ],

  // Ruby
  [SupportedLanguages.Ruby]: [
    /^call$/, // Service objects (MyService.call)
    /^perform$/, // Background jobs (Sidekiq, ActiveJob)
    /^execute$/, // Command pattern
  ],

  // Dart / Flutter
  [SupportedLanguages.Dart]: [
    /^main$/, // App entry
    /^build$/, // Widget.build — fundamental Flutter render entry point
    /^createState$/, // StatefulWidget.createState
    /^initState$/, // State lifecycle initialization
    /^dispose$/, // State lifecycle teardown
    /^didChangeDependencies$/, // State lifecycle — InheritedWidget changes
    /^didUpdateWidget$/, // State lifecycle — widget rebuild with new config
    /^runApp$/, // App entry point
    /^onEvent$/, // BLoC event handler
    /^mapEventToState$/, // Legacy BLoC pattern
  ],
  [SupportedLanguages.Cobol]: [], // Standalone regex processor — no tree-sitter entry points
} satisfies Record<SupportedLanguages, RegExp[]>;

/** Pre-computed merged patterns (universal + language-specific) to avoid per-call array allocation. */
const MERGED_ENTRY_POINT_PATTERNS = Object.fromEntries(
  Object.values(SupportedLanguages).map((lang) => [
    lang,
    [...UNIVERSAL_ENTRY_POINT_PATTERNS, ...(ENTRY_POINT_PATTERNS[lang] ?? [])],
  ]),
) as Record<SupportedLanguages, RegExp[]>;

// ============================================================================
// UTILITY PATTERNS - Functions that should be penalized
// ============================================================================

/**
 * Patterns that indicate utility/helper functions (NOT entry points)
 * These get penalized in scoring
 */
const UTILITY_PATTERNS: RegExp[] = [
  /^(get|set|is|has|can|should|will|did)[A-Z]/, // Accessors/predicates
  /^_/, // Private by convention
  /^(format|parse|validate|convert|transform)/i, // Transformation utilities
  /^(log|debug|error|warn|info)$/i, // Logging
  /^(to|from)[A-Z]/, // Conversions
  /^(encode|decode)/i, // Encoding utilities
  /^(serialize|deserialize)/i, // Serialization
  /^(clone|copy|deep)/i, // Cloning utilities
  /^(merge|extend|assign)/i, // Object utilities
  /^(filter|map|reduce|sort|find)/i, // Collection utilities (standalone)
  /Helper$/,
  /Util$/,
  /Utils$/,
  /^utils?$/i,
  /^helpers?$/i,
];

// ============================================================================
// TYPES
// ============================================================================

export interface EntryPointScoreResult {
  score: number;
  reasons: string[];
}

// ============================================================================
// MAIN SCORING FUNCTION
// ============================================================================

/**
 * Calculate an entry point score for a function/method
 *
 * Higher scores indicate better entry point candidates.
 * Score = baseScore × exportMultiplier × nameMultiplier
 *
 * @param name - Function/method name
 * @param language - Programming language
 * @param isExported - Whether the function is exported/public
 * @param callerCount - Number of functions that call this function
 * @param calleeCount - Number of functions this function calls
 * @returns Score and array of reasons explaining the score
 */
export function calculateEntryPointScore(
  name: string,
  language: SupportedLanguages,
  isExported: boolean,
  callerCount: number,
  calleeCount: number,
  filePath: string = '', // Optional for backwards compatibility
): EntryPointScoreResult {
  const reasons: string[] = [];

  // Must have outgoing calls to be an entry point (we need to trace forward)
  if (calleeCount === 0) {
    return { score: 0, reasons: ['no-outgoing-calls'] };
  }

  // Base score: call ratio (existing algorithm)
  // High ratio = calls many, called by few = likely entry point
  const baseScore = calleeCount / (callerCount + 1);
  reasons.push(`base:${baseScore.toFixed(2)}`);

  // Export bonus: exported/public functions are more likely entry points
  const exportMultiplier = isExported ? 2.0 : 1.0;
  if (isExported) {
    reasons.push('exported');
  }

  // Name pattern scoring
  let nameMultiplier = 1.0;

  // Check negative patterns first (utilities get penalized)
  if (UTILITY_PATTERNS.some((p) => p.test(name))) {
    nameMultiplier = 0.3; // Significant penalty
    reasons.push('utility-pattern');
  } else {
    // Check positive patterns
    const allPatterns = MERGED_ENTRY_POINT_PATTERNS[language];

    if (allPatterns?.some((p) => p.test(name))) {
      nameMultiplier = 1.5; // Bonus for matching entry point pattern
      reasons.push('entry-pattern');
    }
  }

  // Framework detection bonus (Phase 2)
  let frameworkMultiplier = 1.0;
  if (filePath) {
    const frameworkHint = detectFrameworkFromPath(filePath);
    if (frameworkHint) {
      frameworkMultiplier = frameworkHint.entryPointMultiplier;
      reasons.push(`framework:${frameworkHint.reason}`);
    }
  }

  // Calculate final score
  const finalScore = baseScore * exportMultiplier * nameMultiplier * frameworkMultiplier;

  return {
    score: finalScore,
    reasons,
  };
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Check if a file path is a test file (should be excluded from entry points)
 * Covers common test file patterns across all supported languages
 */
export function isTestFile(filePath: string): boolean {
  const p = filePath.toLowerCase().replace(/\\/g, '/');

  return (
    // JavaScript/TypeScript test patterns
    p.includes('.test.') ||
    p.includes('.spec.') ||
    p.includes('__tests__/') ||
    p.includes('__mocks__/') ||
    // Generic test folders
    p.includes('/test/') ||
    p.includes('/tests/') ||
    p.includes('/testing/') ||
    // Python test patterns
    p.endsWith('_test.py') ||
    p.includes('/test_') ||
    // Go test patterns
    p.endsWith('_test.go') ||
    // Java test patterns
    p.includes('/src/test/') ||
    // Rust test patterns (inline tests are different, but test files)
    p.includes('/tests/') ||
    // Swift/iOS test patterns
    p.endsWith('tests.swift') ||
    p.endsWith('test.swift') ||
    p.includes('uitests/') ||
    // C# test patterns
    p.endsWith('tests.cs') ||
    p.endsWith('test.cs') ||
    p.includes('.tests/') ||
    p.includes('.test/') ||
    p.includes('.integrationtests/') ||
    p.includes('.unittests/') ||
    p.includes('/testproject/') ||
    // PHP/Laravel test patterns
    p.endsWith('test.php') ||
    p.endsWith('spec.php') ||
    p.includes('/tests/feature/') ||
    p.includes('/tests/unit/') ||
    // Ruby test patterns
    p.endsWith('_spec.rb') ||
    p.endsWith('_test.rb') ||
    p.includes('/spec/') ||
    p.includes('/test/fixtures/')
  );
}

/**
 * Check if a file path is likely a utility/helper file
 * These might still have entry points but should be lower priority
 */
export function isUtilityFile(filePath: string): boolean {
  const p = filePath.toLowerCase().replace(/\\/g, '/');

  return (
    p.includes('/utils/') ||
    p.includes('/util/') ||
    p.includes('/helpers/') ||
    p.includes('/helper/') ||
    p.includes('/common/') ||
    p.includes('/shared/') ||
    p.includes('/lib/') ||
    p.endsWith('/utils.ts') ||
    p.endsWith('/utils.js') ||
    p.endsWith('/helpers.ts') ||
    p.endsWith('/helpers.js') ||
    p.endsWith('_utils.py') ||
    p.endsWith('_helpers.py')
  );
}
