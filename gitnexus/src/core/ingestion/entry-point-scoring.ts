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
import { providers } from './languages/index.js';
import { isTestFilePath } from './utils/test-file-path.js';

// ============================================================================
// NAME PATTERNS
// ============================================================================

/**
 * Universal entry point naming patterns shared across all languages.
 * Per-language patterns live on each LanguageProvider.entryPointPatterns.
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

/** Pre-computed merged patterns (universal + language-specific) from providers. */
const MERGED_ENTRY_POINT_PATTERNS = Object.fromEntries(
  Object.entries(providers).map(([lang, provider]) => [
    lang,
    [...UNIVERSAL_ENTRY_POINT_PATTERNS, ...(provider.entryPointPatterns ?? [])],
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
 * Check if a file path is a test file (should be excluded from entry points).
 *
 * Delegates to the shared predicate in `utils/test-file-path.ts`. This used to be
 * a second, hand-maintained copy that had drifted from the one backing the MCP
 * `includeTests` flag — see that module's header. Re-exported under this name so
 * existing importers are unaffected.
 */
export function isTestFile(filePath: string): boolean {
  return isTestFilePath(filePath);
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
