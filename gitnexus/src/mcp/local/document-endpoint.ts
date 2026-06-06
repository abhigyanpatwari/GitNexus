/**
 * Document Endpoint Tool
 *
 * Generates API documentation JSON from the GitNexus knowledge graph.
 * Supports two modes:
 * - Minimal (default): Schema-valid JSON with TODO_AI_ENRICH placeholders
 * - Context-enriched: Same JSON + _context fields with source snippets
 */

import type { RepoHandle } from './local-backend.js';
import type { FieldInfo } from '../../core/ingestion/workers/parse-worker.js';
import type { CrossRepoContext } from './cross-repo-context.js';
import { executeParameterized } from '../core/lbug-adapter.js';
import { executeTrace, type ChainNode, type BuilderDetail } from './trace-executor.js';
import { queryEndpoints, type EndpointInfo } from './endpoint-query.js';
import { generateId } from '../../lib/utils.js';
import { shouldSkipSchema, extractGenericInnerType, extractPackagePrefix } from '../../core/ingestion/type-extractors/shared.js';
import type { BodySchemaField } from '../../core/openapi/schema-builder.js';
import { parseMethodLevelMapping, parseClassLevelPrefix, combinePaths, METHOD_TO_ANNOTATIONS } from './route-annotation-parser.js';

// ============================================================================
// Constants
// ============================================================================

/** Placeholder for AI enrichment - used throughout for fields requiring manual input */
const TODO_AI_ENRICH = 'TODO_AI_ENRICH';

/**
 * Deep-clone an object, stripping all undefined values (including nested).
 * Used by MCP output to ensure clean JSON without undefined literals.
 */
function stripUndefined<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map(stripUndefined) as T;
  if (typeof obj === 'object' && !(obj instanceof Map)) {
    const result: any = {};
    for (const [key, value] of Object.entries(obj)) {
      if (value !== undefined) {
        result[key] = stripUndefined(value);
      }
    }
    return result;
  }
  return obj;
}

// Re-export for use in tool.ts output path
export { stripUndefined };

/**
 * Bundles all external dependency extraction results.
 * Used by convertToOpenAPIYamlString (in converter.ts) to embed x-extensions.
 */
export interface ExternalDeps {
  downstreamApis: DownstreamApi[];
  messaging: {
    outbound: MessagingOutbound[];
    inbound: MessagingInbound[];
    nestedSchemas: Map<string, BodySchema>;
  };
  persistence: PersistenceInfo[];
  annotations: {
    transaction: string[];
    retry: RetryLogic[];
    security: string[];
  };
  validation: ValidationRule[];
}

/** Return type when mode === 'openapi' — YAML-wrapped result */
export interface OpenApiModeResult {
  yaml: string;
  method: string;
  path: string;
  handlerClass?: string;
  handlerMethod?: string;
}

/** Debug mode flag for conditional logging */
const DEBUG = process.env.GITNEXUS_DEBUG === 'true';

/** Valid HTTP methods for endpoint documentation */
const VALID_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS']);

/** Regex to detect path variable patterns like {id}, {orderId} */
const PATH_VAR_RE = /^\{.+\}$/;

/** Regex to extract all path variables from a route path */
const PATH_VARS_IN_ROUTE_RE = /\{([^}]+)\}/g;

/**
 * Extract path variable names from a route path.
 * E.g., '/e/v5/customers/{tcbsId}/assets/{assetId}' → ['tcbsId', 'assetId']
 */
function extractPathVariablesFromRoute(routePath: string): string[] {
  const vars: string[] = [];
  let match;
  while ((match = PATH_VARS_IN_ROUTE_RE.exec(routePath)) !== null) {
    vars.push(match[1]);
  }
  // Reset regex lastIndex for reuse
  PATH_VARS_IN_ROUTE_RE.lastIndex = 0;
  return vars;
}

/**
 * Extract @PathVariable names from parameterAnnotations JSON string.
 * Returns the set of path variable names that are covered by @PathVariable annotations.
 *
 * @param paramAnnsJson - JSON string like '[{"name":"tcbsId","type":"String","annotations":["@PathVariable(\"tcbsId\")"]}]'
 * @returns Set of path variable names covered by @PathVariable annotations
 */
function extractPathVariableNames(paramAnnsJson: string | undefined): Set<string> {
  const pathVars = new Set<string>();
  if (!paramAnnsJson || typeof paramAnnsJson !== 'string') {
    return pathVars;
  }
  try {
    const params = JSON.parse(paramAnnsJson);
    for (const p of params) {
      const annotations = p.annotations || [];
      for (const ann of annotations) {
        // Match @PathVariable("varName") or @PathVariable
        if (ann.startsWith('@PathVariable')) {
          // Extract argument if present: @PathVariable("tcbsId")
          const argMatch = ann.match(/@PathVariable\s*\(\s*"([^"]+)"\s*\)/);
          if (argMatch) {
            pathVars.add(argMatch[1]);
          } else if (p.name) {
            // No argument: use parameter name
            pathVars.add(p.name);
          }
        }
      }
    }
  } catch { /* ignore parse errors */ }
  return pathVars;
}

/**
 * Check if @PathVariable annotations cover all path variables in the route path.
 * Returns true if all path variables in the route are covered by @PathVariable annotations.
 */
function hasPathVariableCoverage(paramAnnsJson: string | undefined, routePath: string): boolean {
  const requiredVars = extractPathVariablesFromRoute(routePath);
  if (requiredVars.length === 0) {
    return true; // No path variables required
  }
  const coveredVars = extractPathVariableNames(paramAnnsJson);
  return requiredVars.every(v => coveredVars.has(v));
}

/** Spring annotations that map request parameters */
const REQUEST_PARAM_ANNOTATIONS = new Set([
  '@PathVariable', '@RequestParam', '@RequestHeader', '@CookieValue'
]);

/** Event listener annotations for inbound messaging detection */
const EVENT_LISTENER_ANNOTATIONS = new Set([
  '@EventListener', '@TransactionalEventListener', '@RabbitListener', '@KafkaListener'
]);

/** Framework-injected types to skip from parameter extraction */
const FRAMEWORK_INJECTED_TYPES = new Set([
  'HttpServletRequest', 'HttpServletResponse', 'Model', 'ModelMap',
  'Principal', 'Locale', 'BindingResult', 'Errors',
  'RedirectAttributes', 'SessionStatus', 'WebRequest', 'NativeWebRequest',
  'InputStream', 'OutputStream', 'Reader', 'Writer', 'HttpSession',
]);

/** Validation annotation names that indicate required fields */
const REQUIRED_ANNOTATIONS = new Set(['@NotNull', '@NotBlank', '@NotEmpty']);

/** All validation annotation names (excluding @Valid/@Validated which are markers) */
const VALIDATION_ANNOTATIONS = new Set([
  '@NotNull', '@NotBlank', '@NotEmpty',
  '@Size', '@Min', '@Max',
  '@Positive', '@PositiveOrZero', '@Negative', '@NegativeOrZero',
  '@Pattern', '@Email',
  '@Past', '@PastOrPresent', '@Future', '@FutureOrPresent',
  '@Valid', '@Validated',
]);

/** Pre-compiled regex patterns for imperative validation detection */
const IMPERATIVE_VALIDATION_PATTERNS = [
  // Framework validation methods (global flag for while loop)
  /TcbsValidator\.(validate|doValidate)\s*\(/g,
  /ValidationUtils\.(validate|check)\s*\(/g,
  /\.\s*validate\s*\(/g,
  /Validator\.(validate|check)\s*\(/g,

  // Validation service: validationService.process(), ValidationService.process()
  /\w*[Vv]alidation[Ss]ervice\w*\s*\.\s*process\s*\(/g,

  // Custom validation service fields: suggestionValidationServiceImpl.process()
  /\w*ValidationServiceImpl\s*\.\s*process\s*\(/g,

  // Custom validation methods: .validateJWT(), validateJWT(), .validateRequest()
  /(?:\.\s*)?validate[A-Z]\w*\s*\(/g,

  // Guava Preconditions
  /Preconditions\.(checkArgument|checkNotNull|checkState)\s*\(/g,

  // Spring Assert
  /Assert\.(notNull|hasText|hasLength|isTrue|isInstanceOf|isAssignable)\s*\(/g,

  // Java Objects.requireNonNull
  /Objects\.requireNonNull\s*\(/g,

  // Apache Commons Validate
  /Validate\.(isTrue|isNotNull|notEmpty|notBlank|inclusiveBetween|exclusiveBetween)\s*\(/g,

  // IllegalArgumentException (common validation throw)
  /throw\s+new\s+IllegalArgumentException\s*\(/g,
];

/** Query limits and defaults */
const CANDIDATE_QUERY_LIMIT = 100;
const NESTED_TYPE_MAX_DEPTH = 10;
const NESTED_TYPE_MAX_COUNT = 100;
export const PATH_MATCH_SCORE_BONUS = 200;
export const EXACT_PATH_MATCH_BONUS = 2000;

/** Handler-name hints per HTTP method — hoisted to avoid per-call allocation */
const METHOD_HINTS: Record<string, string[]> = {
  'PUT': ['unhold', 'update', 'put', 'edit', 'modify', 'replace'],
  'POST': ['create', 'add', 'post', 'save', 'insert', 'new'],
  'GET': ['get', 'find', 'list', 'search', 'query', 'fetch', 'read'],
  'DELETE': ['delete', 'remove', 'destroy'],
  'PATCH': ['patch', 'partial'],
};

// ============================================================================
// Types
// ============================================================================

/** Parsed parameter annotation from Java method */
interface RawParamAnnotation {
  name?: string;
  argument?: string;
  parameterName?: string;
  parameterType?: string;
  type?: string;
  annotations?: string[];
}

/**
 * Remove empty arrays from an object at specified paths.
 * Used to clean up JSON output by omitting empty arrays.
 */
function removeEmptyArrays(obj: any, paths: string[][]): void {
  for (const path of paths) {
    let current = obj;
    for (let i = 0; i < path.length - 1; i++) {
      current = current?.[path[i]];
      if (!current) break;
    }
    if (current) {
      const key = path[path.length - 1];
      if (Array.isArray(current[key]) && current[key].length === 0) {
        delete current[key];
      }
    }
  }
}

export interface DocumentEndpointOptions {
  method: string;
  path: string;
  depth?: number;
  /** Output mode: 'openapi' (compact YAML) or 'ai_context' (full JSON with BodySchema) */
  mode?: 'openapi' | 'ai_context';
  /** @deprecated Use mode === 'ai_context' instead */
  include_context?: boolean;
  compact?: boolean;
  repo?: string;
  /** Optional injected query executor for testing */
  executeQuery?: (repoId: string, query: string, params: Record<string, any>) => Promise<any[]>;
  /** Optional cross-repo resolution capabilities */
  crossRepo?: CrossRepoContext;
}

export interface ParamInfo {
  name: string;
  type: string;
  required: boolean;
  description: string;
  location?: 'path' | 'query' | 'header' | 'cookie';
  _context?: string;
}

export interface ValidationRule {
  field: string;
  type: string;
  required: boolean;
  rules: string;
  _context?: string[];
}

export interface ResponseCode {
  code: number;
  description: string;
}

export interface BodySchema {
  typeName: string;
  source: 'indexed' | 'external' | 'primitive' | 'container';
  fields?: BodySchemaField[];
  /** Attribution for cross-repo resolution — repoId where the type was found */
  repoId?: string;
  /** Indicates the original type was a container (List, Set, array, etc.) */
  isContainer?: boolean;
  /** Marks a recursive reference — this type references itself, emit $ref instead of expanding */
  _recursiveRef?: string;
}

export interface DownstreamApi {
  serviceName: string;
  name: string;
  type: string;
  service: string;
  repoId?: string;
  endpoint: string;
  condition: string;
  purpose: string;
  _context?: string;
  resolvedUrl?: string;
  resolvedFrom?: string;
  resolutionDetails?: {
    serviceField?: string;
    serviceValue?: string;
    pathConstants?: { name: string; value: string }[];
  };
}

export interface MessagingOutbound {
  topic: string;
  pattern: string;
  type: string;
  direction: string;
  service?: string;
  payload: string | BodySchema | Record<string, unknown> | Record<string, unknown>[];
  trigger: string;
  _context?: string;
  /** WI-5: RepoId where the payload type was resolved */
  sourceRepo?: string;
}

export interface MessagingInbound {
  topic: string;
  pattern: string;
  type: string;
  direction: string;
  service?: string;
  payload: string | BodySchema | Record<string, unknown> | Record<string, unknown>[];
  consumptionLogic: string;
  _context?: string;
  /** WI-5: RepoId where the payload type was resolved */
  sourceRepo?: string;
}

export interface PersistenceInfo {
  database: string;
  tables: string;
  entity: string;
  operation: string;
  storedProcedures: string;
}

export interface CacheStrategy {
  population: Array<{
    cacheName: string;
    keyPattern: string;
    ttl: string;
    trigger: string;
  }>;
  invalidation: Array<{
    cacheName: string;
    strategy: string;
    trigger: string;
  }>;
  update: Array<{
    cacheName: string;
    strategy: string;
    trigger: string;
  }>;
  flow: string;
}

export interface RetryLogic {
  operation: string;
  maxAttempts: string;
  backoff: string;
  recovery: string;
}

export interface KeyDetails {
  transactionManagement: string[];
  businessRules: string[];
  security: string[];
}

export interface DocumentEndpointResult {
  method: string;
  path: string;
  summary: string;
  specs: {
    request: {
      params: ParamInfo[];
      body: Record<string, unknown> | Record<string, unknown>[] | BodySchema | null;
      validation: ValidationRule[];
    };
    response: {
      body: Record<string, unknown> | Record<string, unknown>[] | BodySchema | null;
      codes: ResponseCode[];
    };
  };
  externalDependencies: {
    downstreamApis: DownstreamApi[];
    messaging: {
      outbound: MessagingOutbound[];
      inbound: MessagingInbound[];
      nestedSchemas?: Map<string, BodySchema>;
    };
    persistence: PersistenceInfo[];
    validation: ValidationRule[];
  };
  logicFlow: string;
  codeDiagram: string;
  cacheStrategy: CacheStrategy;
  retryLogic: RetryLogic[];
  keyDetails: KeyDetails;
  handlerClass?: string;
  handlerMethod?: string;
  nestedSchemas?: Map<string, BodySchema>;
  _context?: {
    summaryContext?: string;
    resolvedProperties?: Record<string, string>;
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Normalizes a path by replacing path variables with placeholders.
 * /e/v1/bonds/{id} → /e/v1/bonds/{}
 * /i/v1/customers/{tcbsId} → /i/v1/customers/{}
 * Used for structural path comparison.
 */
/**
 * Parameter object for buildDocumentation function.
 * Consolidates 9 parameters into a single object for better maintainability.
 */
interface BuildDocumentationParams {
  method: string;
  path: string;
  route: EndpointInfo;
  chain: ChainNode[];
  includeContext: boolean;
  compact: boolean;
  executeQuery: (repoId: string, query: string, params: Record<string, any>) => Promise<any[]>;
  repoId: string;
  crossRepo?: CrossRepoContext;
}

function normalizePathStructure(path: string): string {
  return path.replace(/\{[^}]+\}/g, '{}');
}

/**
 * Checks if two paths match structurally (same segments, ignoring variable names).
 * Normalizes both paths and compares segment by segment.
 * Non-placeholder segments must match exactly (case-insensitive).
 * Placeholder segments match any corresponding segment.
 */
export function pathsMatchStructurally(inputPath: string, annotationPath: string): boolean {
  const normalizedInput = normalizePathStructure(inputPath);
  const normalizedAnnotation = normalizePathStructure(annotationPath);

  const inputSegments = normalizedInput.split('/').filter(s => s.length > 0);
  const annotationSegments = normalizedAnnotation.split('/').filter(s => s.length > 0);

  // Empty path check
  if (inputSegments.length === 0 || annotationSegments.length === 0) {
    return false;
  }

  const inputLen = inputSegments.length;
  const annoLen = annotationSegments.length;

  // Equal segment count: exact matching (existing behavior preserved)
  if (inputLen === annoLen) {
    for (let i = 0; i < inputLen; i++) {
      const inputSeg = inputSegments[i];
      const annoSeg = annotationSegments[i];

      if (inputSeg === '{}' || annoSeg === '{}') continue;

      if (inputSeg.toLowerCase() !== annoSeg.toLowerCase()) {
        return false;
      }
    }
    return true;
  }

  // Suffix matching when counts differ
  // Determine the overlapping length (shorter array)
  const overlapLen = Math.min(inputLen, annoLen);

  // Compare from the END of both arrays
  for (let i = 0; i < overlapLen; i++) {
    // Index from end: last segment is index [len-1], second-to-last is [len-2], etc.
    const inputSeg = inputSegments[inputLen - 1 - i];
    const annoSeg = annotationSegments[annoLen - 1 - i];

    // Placeholders match anything
    if (inputSeg === '{}' || annoSeg === '{}') continue;

    // Non-placeholders must match exactly (case-insensitive)
    if (inputSeg.toLowerCase() !== annoSeg.toLowerCase()) {
      return false;
    }
  }

  return true;
}

/**
 * Fallback handler search when Route nodes don't exist.
 * Searches for Java methods with @XxxMapping annotations matching the path.
 * Combines class-level @RequestMapping prefix with method-level path before validation.
 */
export interface ScoreInput {
  fullPath: string;
  pathPattern: string;
  handlerContent: string;
  queryMethod: string;
  annotationPath?: string;
  classPath?: string;
  annotation: string;
  handlerName: string;
  controllerType?: 'ext' | 'int'; // derived from filePath
}

export function scoreCandidate(input: ScoreInput): number {
  let score = 0;
  const { fullPath, pathPattern, handlerContent, queryMethod, annotationPath, classPath, annotation, handlerName, controllerType } = input;
  const paths = pathPattern.split('/').filter(p => p.length > 0);

  // HTTP method matching
  const upperMethod = queryMethod.toUpperCase();
  const hasSpecificAnnotation = annotation !== 'RequestMapping';
  const hasMethodAttribute = /method\s*=\s*RequestMethod\./i.test(handlerContent);

  if (hasSpecificAnnotation) score += 150;
  else if (hasMethodAttribute) score += 140;
  else if (annotation === 'RequestMapping') score -= 50;

  // Method-match gate: exact-match bonus only when annotation implies correct HTTP method.
  // - @GetMapping etc. are method-specific → gate passes.
  // - @RequestMapping with explicit method=RequestMethod.{X} → extract X and compare.
  // - Bare @RequestMapping (no method attr) → gate fails (ambiguous for all methods).
  let methodMatches = true;
  if (annotation === 'RequestMapping') {
    if (hasMethodAttribute) {
      const methodMatch = /method\s*=\s*RequestMethod\.(\w+)/i.exec(handlerContent);
      if (methodMatch) {
        methodMatches = methodMatch[1].toUpperCase() === upperMethod;
      }
    } else {
      methodMatches = false; // bare RequestMapping → ambiguous
    }
  }

  if (fullPath === pathPattern && methodMatches) {
    score += EXACT_PATH_MATCH_BONUS; // 2000
  } else if (fullPath.length > 1 && pathPattern.startsWith(fullPath)) {
    score += 300; // Path prefix match
  } else if (pathPattern.length > 1 && fullPath.startsWith(pathPattern)) {
    score += 200; // Search is prefix of full path
  }

  // Segment count match bonus (reuses `paths` — already split from pathPattern)
  const candidateSegments = fullPath.split('/').filter(s => s.length > 0);
  if (paths.length === candidateSegments.length) {
    score += 300;
  }

  // Last segment inclusion
  const lastPathSegment = paths[paths.length - 1];
  if (fullPath.includes(lastPathSegment)) score += PATH_MATCH_SCORE_BONUS;

  // Suffix match (annotation path vs search suffix)
  if (annotationPath) {
    const searchSuffix = '/' + paths.slice(-2).join('/');
    if (annotationPath.endsWith(searchSuffix) || annotationPath === '/' + paths[paths.length - 1]) {
      score += 200;
    }
  }

  // Handler name hints at HTTP operation (METHOD_HINTS is module-level)
  const hints = METHOD_HINTS[upperMethod] || [];
  const handlerLower = handlerName.toLowerCase();
  for (const hint of hints) {
    if (handlerLower.includes(hint)) {
      score += 30;
      break;
    }
  }

  // External/internal controller type alignment
  if (controllerType === 'ext') {
    const searchPathLower = pathPattern.toLowerCase();
    if (searchPathLower.includes('/e/') || searchPathLower.includes('/external/') || searchPathLower.startsWith('/e')) {
      score += 80;
    } else if (searchPathLower.includes('/i/') || searchPathLower.includes('/internal/') || searchPathLower.startsWith('/i')) {
      score -= 50;
    }
  } else if (controllerType === 'int') {
    const searchPathLower = pathPattern.toLowerCase();
    if (searchPathLower.includes('/i/') || searchPathLower.includes('/internal/') || searchPathLower.startsWith('/i')) {
      score += 80;
    } else if (searchPathLower.includes('/e/') || searchPathLower.includes('/external/') || searchPathLower.startsWith('/e')) {
      score -= 50;
    }
  }

  return score;
}

export async function findHandlerByPathPattern(
  repo: RepoHandle,
  method: string,
  pathPattern: string,
  classPathCache?: Map<string, string | undefined>
): Promise<EndpointInfo | undefined> {
  // Validate method against known HTTP methods to prevent regex injection
  const upperMethod = method.toUpperCase();
  if (!VALID_METHODS.has(upperMethod)) return undefined;

  // Query for Method nodes with request mapping annotations in content
  // Use larger limit to ensure we find relevant handlers before scoring
  const cypher = `
    MATCH (m:Method)
    WHERE m.filePath CONTAINS 'Controller'
      AND m.content CONTAINS $mappingAnnotation
      AND m.content CONTAINS $pathFragment
    RETURN m.name AS handler,
           m.filePath AS filePath,
           m.startLine AS line,
           m.content AS content
    LIMIT ${CANDIDATE_QUERY_LIMIT}
  `;

  // Try different mapping annotations based on HTTP method
  const annotations = METHOD_TO_ANNOTATIONS[upperMethod] || ['Mapping'];
  const paths = pathPattern.split('/').filter(p => p.length > 0);

  // Collect all candidates with their scores
  interface Candidate {
    handler: string;
    filePath: string;
    line: number;
    content: string;
    score: number;
    annotationPath?: string;  // Method-level path from annotation
    classPath?: string;        // Class-level prefix from @RequestMapping
    fullPath: string;          // Combined class + method path
    isValid: boolean;          // Structural validation passed (on fullPath)
  }
  const candidates: Candidate[] = [];

  // Cache for class-level paths to avoid repeated queries (use provided or create new)
  const cpCache = classPathCache ?? new Map<string, string | undefined>();

  for (const annotation of annotations) {
    // Try each path segment as a fragment
    for (const pathFrag of paths) {
      if (pathFrag.length < 2) continue;

      try {
        const rows = await executeParameterized(repo.id, cypher, {
          mappingAnnotation: annotation,
          pathFragment: pathFrag,
        });

        if (rows && rows.length > 0) {
          for (const row of rows) {
            const handler = row.handler ?? row[0];
            const filePath = row.filePath ?? row[1];
            const line = row.line ?? row[2];
            const content = row.content ?? row[3] ?? '';

            // Extract the method-level path from the annotation using shared parser
            const parsed = parseMethodLevelMapping(content, upperMethod);
            const annotationPath = parsed?.routePath;

            // #81: reject candidates whose CONCRETE HTTP method disagrees with the
            // request. The Method-search Cypher matches any handler whose content
            // contains 'RequestMapping' + the path fragment, so a @GetMapping("/{id}")
            // handler can surface for a DELETE request; parseMethodLevelMapping has
            // already recovered its real verb ('GET'), which the old code discarded.
            // '*' = bare @RequestMapping (genuinely method-ambiguous) → keep and let
            // scoreCandidate's existing ambiguity penalty handle it.
            const parsedMethod = parsed?.httpMethod;
            if (parsedMethod && parsedMethod !== '*' && parsedMethod.toUpperCase() !== upperMethod) {
              continue;
            }

            if (!annotationPath) continue; // Skip if no annotation path found

            // Get class-level prefix (cached)
            let classPath: string | undefined;
            if (cpCache.has(filePath)) {
              classPath = cpCache.get(filePath);
            } else {
              // Query for class-level RequestMapping prefix
              try {
                const classCypher = `
                  MATCH (c:Class)
                  WHERE c.filePath = $filePath
                  RETURN c.content AS classContent
                  LIMIT 1
                `;
                const classRows = await executeParameterized(repo.id, classCypher, { filePath: filePath });

                if (classRows && classRows.length > 0) {
                  const classContent = classRows[0].classContent ?? classRows[0][0] ?? '';

                  // Extract class-level @RequestMapping path using shared parser
                  classPath = parseClassLevelPrefix(classContent) ?? undefined;

                }
              } catch (e) {
                if (DEBUG) console.error('[GitNexus DEBUG] Class path query failed:', e);
                // Continue without class path
              }
              cpCache.set(filePath, classPath);
            }

            // Combine class prefix with method path using shared utility
            const fullPath = combinePaths(classPath, annotationPath);

            // STRUCTURAL VALIDATION: Check if FULL path (class + method) matches input path
            let isValidCandidate = true;
            if (!pathsMatchStructurally(pathPattern, fullPath)) {
              isValidCandidate = false;  // Reject - structure mismatch
            }

            // Determine controller type for scoring
            const filePath_lower = filePath.toLowerCase();
            const controllerType = filePath_lower.includes('ext') || filePath_lower.includes('external') || filePath_lower.includes('pio') ? 'ext' as const
              : filePath_lower.includes('internal') ? 'int' as const
              : undefined;

            const score = scoreCandidate({
              fullPath,
              pathPattern,
              handlerContent: content,
              queryMethod: method,
              annotationPath,
              classPath,
              annotation,
              handlerName: handler,
              controllerType,
            });

            // Deduplicate by handler + filePath
            if (!candidates.some(c => c.handler === handler && c.filePath === filePath)) {
              candidates.push({ handler, filePath, line, content, score, annotationPath, classPath, fullPath, isValid: isValidCandidate });
            }
          }
        }
      } catch (e) {
        if (DEBUG) console.error('[GitNexus DEBUG] Pattern matching error:', e);
        // Continue to next pattern on error
        continue;
      }
    }
  }

  // Filter to only valid candidates (those that passed structural validation)
  const validCandidates = candidates.filter(c => c.isValid === true);

  if (validCandidates.length === 0) return undefined;

  validCandidates.sort((a, b) => b.score - a.score);
  const best = validCandidates[0];

  // Use the full path (already computed during validation)
  // Extract controller name from filePath (e.g., "BookingIConnectExtControllerV2" from path)
  const fileName = best.filePath.split('/').pop() ?? 'Unknown';
  const controller = fileName.replace(/\.[^.]+$/, ''); // Remove file extension

  return {
    method: upperMethod,
    path: best.fullPath,
    handler: best.handler,
    controller,
    filePath: best.filePath,
    line: best.line,
  };
}

// ============================================================================
// Main Function
// ============================================================================

export async function documentEndpoint(
  repo: RepoHandle,
  options: DocumentEndpointOptions
): Promise<{ result?: DocumentEndpointResult; error?: string } | OpenApiModeResult> {
  // (#44) Default depth lowered from 10 → 5. Real Spring Boot endpoints
  // with deeply nested service / repository / utility chains produce
  // 150KB+ outputs at depth=10 (e.g. tcbs-bond-trading's
  // `POST /i/v1/orders` had 85 validation rules, 32 persistence tables,
  // and a 15K-character logic flow). That output is impractical for LLM
  // context consumption. depth=3 already captures the meaningful
  // downstream shape; depth=5 is the new ceiling for the default path.
  // Callers that explicitly pass `depth` are unaffected.
  const { method, path, depth = 5, mode, include_context = false, compact = false, crossRepo } = options;
  // Default mode is 'openapi' when neither mode nor include_context is set.
  // mode takes precedence over include_context; include_context only
  // applies when mode is not explicitly set (undefined).
  const effectiveMode: 'openapi' | 'ai_context' =
    mode === 'openapi' || mode === 'ai_context' ? mode
    : include_context ? 'ai_context'
    : 'openapi';
  const effectiveIncludeContext = effectiveMode === 'ai_context';

  // Validate HTTP method
  const upperMethod = method.toUpperCase();
  if (!VALID_METHODS.has(upperMethod)) {
    return {
      error: `Invalid HTTP method: ${method}`
    };
  }

  // Step 1: Try to find the Route node (may fail if Route table doesn't exist)
  let route: EndpointInfo | undefined;

  try {
    const endpointsResult = await queryEndpoints(repo, { method, path });
    if (endpointsResult.endpoints && endpointsResult.endpoints.length > 0) {
      // Take the first match (most relevant)
      route = endpointsResult.endpoints[0];
    }
  } catch (err: any) {
    if (DEBUG) console.error('[GitNexus DEBUG] Route query failed:', err);
    // Fall back to handler search
  }

  // (#42) When the user provided both method+path and the exact-match Route
  // query returned nothing, the most likely cause is an HTTP-method mismatch
  // (the path exists, but for a different method). Before falling through to
  // the broader handler-pattern search — which may return a sibling route
  // with a similar path and silently mis-document the wrong endpoint — do a
  // path-only sweep to detect the mismatch and surface a "Did you mean X?"
  // error. This is a hard fail: the caller asked for `GET /x` and there is
  // no `GET /x`, only `POST /x`. Silent acceptance generated `get:` and
  // `operationId: get_x` for a POST handler, which is the bug.
  if (!route && method && path) {
    try {
      const pathOnlyResult = await queryEndpoints(repo, { path });
      const mismatched = (pathOnlyResult.endpoints || []).filter(
        (e) => e.method && e.method.toUpperCase() !== upperMethod,
      );
      if (mismatched.length > 0) {
        // Dedupe by method (a path may have multiple Route nodes for the
        // same method from inherited @RequestMapping etc.) and present the
        // distinct alternatives. This is the user-facing "Did you mean?" hint.
        const suggestions = Array.from(
          new Set(mismatched.map((e) => e.method.toUpperCase())),
        ).sort();
        const suggestionList = suggestions.join(', ');
        return {
          error:
            `No ${upperMethod} endpoint found at ${path}. ` +
            `Did you mean ${suggestionList}? ` +
            `Available methods at this path: ${suggestionList}.`,
        };
      }
    } catch (err: any) {
      if (DEBUG) console.error('[GitNexus DEBUG] Path-only sweep failed:', err);
      // Fall through to the handler search
    }
  }

  // Fallback: If no Route nodes exist, search for handler methods directly
  if (!route) {
    const fallbackResult = await findHandlerByPathPattern(repo, method, path);
    if (fallbackResult) {
      route = fallbackResult;
    } else {
      return {
        error: `No endpoint found for ${method} ${path}`,
      };
    }
  }

  // Construct the handler UID from route info
  // Format: Method:filePath:methodName
  const handlerUid = route.handler && route.filePath
    ? generateId('Method', `${route.filePath}:${route.handler}`)
    : undefined;

  if (!handlerUid) {
    return {
      error: `Could not construct handler UID for route at ${route.filePath}:${route.line}`,
    };
  }

  // Step 2: Build the executeQuery function from repo (or use injected one for testing)
  const executeQuery = options.executeQuery ?? (async (_repoId: string, query: string, params: Record<string, any>) => {
    return executeParameterized(repo.id, query, params);
  });

  // Step 2a: Verify Method node exists before tracing
  // If Route node UIDs don't match actual Method nodes, fall back to pattern matching
  // NOTE: Uses executeParameterized directly (not executeQuery) so this verification
  // always works even when tests inject a custom executeQuery that doesn't handle it.
  let validHandlerUid: string | undefined = handlerUid;
  if (handlerUid) {
    try {
      const verifyQuery = `MATCH (m:Method) WHERE m.id = $uid RETURN m.id LIMIT 1`;
      const verifyResult = await executeParameterized(repo.id, verifyQuery, { uid: handlerUid });
      if (!verifyResult || verifyResult.length === 0) {
        validHandlerUid = undefined; // Method node not found, will fall back
      } else if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        // Step 2a-ov-rb: For mutating HTTP methods, check if the resolved handler has @RequestBody.
        // If not, try overload variants (:1, :2, etc.) that may have @RequestBody instead.
        // This handles the case where the ingestion indexed the @RequestParam overload
        // instead of the @RequestBody overload for the same method name.
        const paramQuery = `MATCH (m:Method {id: $uid}) RETURN m.parameterAnnotations AS paramAnns LIMIT 1`;
        const paramResult = await executeParameterized(repo.id, paramQuery, { uid: handlerUid });
        const paramAnns = paramResult?.[0]?.paramAnns ?? paramResult?.[0]?.[0];
        let hasRequestBody = false;
        if (typeof paramAnns === 'string') {
          try {
            const parsed = JSON.parse(paramAnns);
            hasRequestBody = parsed.some((p: any) => p.annotations?.includes('@RequestBody'));
          } catch { /* ignore parse errors */ }
        }
        if (!hasRequestBody) {
          // Try overload variants :1, :2, ... :10
          for (let overloadIdx = 1; overloadIdx <= 10; overloadIdx++) {
            const overloadUid = `${handlerUid}:${overloadIdx}`;
            const overloadResult = await executeParameterized(repo.id,
              `MATCH (m:Method {id: $uid}) RETURN m.parameterAnnotations AS paramAnns LIMIT 1`,
              { uid: overloadUid }
            );
            if (overloadResult && overloadResult.length > 0) {
              const overloadParamAnns = overloadResult[0].paramAnns ?? overloadResult[0][0];
              if (typeof overloadParamAnns === 'string') {
                try {
                  const parsed = JSON.parse(overloadParamAnns);
                  if (parsed.some((p: any) => p.annotations?.includes('@RequestBody'))) {
                    validHandlerUid = overloadUid;
                    // Also update the route path to match the overload's actual URL template.
                    // Without this, the original route.path (from the non-@RequestBody overload)
                    // would be used, causing path-variable mismatches in the output.
                    try {
                      const overloadRouteResult = await executeParameterized(repo.id,
                        `MATCH (r:Route)-[:CodeRelation{CALLS}]->(m:Method {id: $uid}) RETURN r.routePath AS path LIMIT 1`,
                        { uid: overloadUid }
                      );
                      if (overloadRouteResult?.[0]?.path) {
                        route = { ...route, path: overloadRouteResult[0].path };
                        if (DEBUG) console.error(`[GitNexus DEBUG] Updated route.path to ${route.path} for overload ${overloadUid}`);
                      }
                    } catch { /* keep original route on error */ }
                    if (DEBUG) console.error(`[GitNexus DEBUG] Switched to overload variant ${overloadUid} (has @RequestBody)`);
                    break;
                  }
                } catch { /* ignore parse errors */ }
              }
            }
          }
        }
      }

      // Step 2a-ov-pv: For ALL methods, check if the resolved handler has @PathVariable coverage.
      // If the route path has path variables like {tcbsId} but the handler's @PathVariable
      // annotations don't cover them, try overload variants that may have proper @PathVariable.
      if (validHandlerUid) {
        const pathVars = extractPathVariablesFromRoute(route.path);
        if (pathVars.length > 0) {
          const paramQuery = `MATCH (m:Method {id: $uid}) RETURN m.parameterAnnotations AS paramAnns LIMIT 1`;
          const paramResult = await executeParameterized(repo.id, paramQuery, { uid: validHandlerUid });
          const paramAnns = paramResult?.[0]?.paramAnns ?? paramResult?.[0]?.[0];
          const hasPathVarCoverage = hasPathVariableCoverage(paramAnns, route.path);

          if (!hasPathVarCoverage) {
            // Try overload variants :1, :2, ... :10
            for (let overloadIdx = 1; overloadIdx <= 10; overloadIdx++) {
              const overloadUid = `${handlerUid}:${overloadIdx}`;
              const overloadResult = await executeParameterized(repo.id,
                `MATCH (m:Method {id: $uid}) RETURN m.parameterAnnotations AS paramAnns LIMIT 1`,
                { uid: overloadUid }
              );
              if (overloadResult && overloadResult.length > 0) {
                const overloadParamAnns = overloadResult[0].paramAnns ?? overloadResult[0][0];
                if (hasPathVariableCoverage(overloadParamAnns, route.path)) {
                  validHandlerUid = overloadUid;
                  // Also update the route path to match the overload's actual URL template.
                  try {
                    const overloadRouteResult = await executeParameterized(repo.id,
                      `MATCH (r:Route)-[:CodeRelation{CALLS}]->(m:Method {id: $uid}) RETURN r.routePath AS path LIMIT 1`,
                      { uid: overloadUid }
                    );
                    if (overloadRouteResult?.[0]?.path) {
                      route = { ...route, path: overloadRouteResult[0].path };
                      if (DEBUG) console.error(`[GitNexus DEBUG] Updated route.path to ${route.path} for overload ${overloadUid}`);
                    }
                  } catch { /* keep original route on error */ }
                  if (DEBUG) console.error(`[GitNexus DEBUG] Switched to overload variant ${overloadUid} (has @PathVariable coverage for ${pathVars.join(', ')})`);
                  break;
                }
              }
            }
          }
        }
      }
    } catch (err: any) {
      if (DEBUG) console.error('[GitNexus DEBUG] Method verification query failed:', err);
      // Fall through to fallback on error
      validHandlerUid = undefined;
    }
  }

  // Step 2b: If UID verification failed, try CALLS edge target from Route node
  // The Route→CALLS→Method edge is created during ingestion and directly links
  // to the resolved handler Method node, even for inherited/delegated methods.
  if (!validHandlerUid && route.handlerUid) {
    try {
      const edgeVerify = await executeParameterized(repo.id,
        `MATCH (m:Method) WHERE m.id = $uid RETURN m.id LIMIT 1`,
        { uid: route.handlerUid }
      );
      if (edgeVerify && edgeVerify.length > 0) {
        validHandlerUid = route.handlerUid;
        if (DEBUG) console.error(`[GitNexus DEBUG] Resolved handler via CALLS edge: ${validHandlerUid}`);
      }
    } catch (err: any) {
      if (DEBUG) console.error('[GitNexus DEBUG] CALLS edge verification failed:', err);
    }
  }

  // Step 2c: Cross-repo resolution — try dependency repos if handler not found locally
  if (!validHandlerUid && crossRepo && handlerUid) {
    try {
      const depRepoIds = await crossRepo.listDepRepos();
      for (const depRepoId of depRepoIds) {
        const depResults = await crossRepo.queryMultipleRepos(
          [depRepoId],
          `MATCH (m:Method) WHERE m.id = $uid RETURN m.id AS id, m.filePath AS filePath, m.name AS name LIMIT 1`,
          { uid: handlerUid }
        );
        // queryMultipleRepos returns Array<{ repoId: string; results: unknown[] }>
        const found = depResults?.some(r =>
          Array.isArray(r.results) && r.results.length > 0
        );
        if (found) {
          validHandlerUid = handlerUid;
          if (DEBUG) console.error(`[GitNexus DEBUG] Resolved handler in dep repo ${depRepoId}: ${validHandlerUid}`);
          break;
        }
      }
    } catch (err: any) {
      if (DEBUG) console.error('[GitNexus DEBUG] Cross-repo resolution failed:', err);
    }
  }

  // Fall back to pattern matching if all resolution strategies failed
  if (!validHandlerUid) {
    const fallbackResult = await findHandlerByPathPattern(repo, method, path);
    if (fallbackResult) {
      // Construct new handler UID from fallback result
      validHandlerUid = fallbackResult.handler && fallbackResult.filePath
        ? generateId('Method', `${fallbackResult.filePath}:${fallbackResult.handler}`)
        : undefined;

      if (validHandlerUid) {
        // Use fallback route info for documentation
        route = fallbackResult;
      } else {
        return {
          error: `Could not construct handler UID from fallback for ${method} ${path}`,
        };
      }
    } else {
      return {
        error: `No handler found for ${method} ${path} (Route UID had no matching Method)`,
      };
    }
  }

  // Step 3: Trace the handler method
  const traceResult = await executeTrace(
    executeQuery,
    repo.id,
    { uid: validHandlerUid, maxDepth: depth, include_content: true, compact }
  );

  if (traceResult.error) {
    return {
      error: traceResult.error,
    };
  }

  // Step 4: Build the documentation
  // Use route.path (actual endpoint path) instead of input pattern
  const result = await buildDocumentation({
    method,
    path: route.path,
    route,
    chain: traceResult.chain,
    includeContext: effectiveIncludeContext,
    compact,
    executeQuery,
    repoId: repo.id,
    crossRepo,
  });

  // WI-4: Apply ai_context placeholders after buildDocumentation completes
  // Use effectiveIncludeContext to decide return shape (covers both mode='ai_context' and legacy include_context=true)
  if (effectiveIncludeContext) {
    return { result: applyAiContextPlaceholders(result) };
  }

  // WI-3: mode === 'openapi' (default) — return YAML string instead of raw DocumentEndpointResult
  // Build operationId (same logic as convertToOpenAPIPathItem/generateOperationId)
  const normalizedPath = route.path
    .replace(/[{}]/g, '')
    .replace(/[/:-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
  const pathPart = normalizedPath.startsWith('_') ? normalizedPath.slice(1) : normalizedPath;
  const operationId = `${method.toLowerCase()}_${pathPart}`;

  // Collect external dependencies for x-extensions
  const downstreamApis = result.externalDependencies.downstreamApis;
  const messagingOutbound = result.externalDependencies.messaging.outbound;
  const messagingInbound = result.externalDependencies.messaging.inbound;
  const persistence = result.externalDependencies.persistence;
  const { transaction, retry, security } = result.keyDetails
    ? { transaction: result.keyDetails.transactionManagement, retry: result.retryLogic, security: result.keyDetails.security }
    : { transaction: [], retry: [], security: [] };
  const validation = result.specs.request.validation;

  const deps: ExternalDeps = {
    downstreamApis,
    messaging: { outbound: messagingOutbound, inbound: messagingInbound, nestedSchemas: result.nestedSchemas ?? new Map() },
    persistence,
    annotations: { transaction, retry, security },
    validation,
  };

  // Dynamic import to avoid breaking test mocks
  const { convertToOpenAPIYamlString } = await import('../../core/openapi/converter.js');

  const yaml = convertToOpenAPIYamlString(
    [result],
    {},
    new Map([[operationId, deps]])
  );

  return {
    yaml,
    method,
    path: route.path,
    handlerClass: route.controller,
    handlerMethod: route.handler,
  };
}


// ============================================================================
// Helper Functions
// ============================================================================

function createEmptyResult(method: string, path: string): DocumentEndpointResult {
  return {
    method,
    path,
    summary: TODO_AI_ENRICH,
    specs: {
      request: {
        params: [],
        body: null,
        validation: [],
      },
      response: {
        body: null,
        codes: [{ code: 200, description: 'Success' }],
      },
    },
    externalDependencies: {
      downstreamApis: [],
      messaging: { outbound: [], inbound: [] },
      persistence: [],
      validation: [],
    },
    logicFlow: TODO_AI_ENRICH,
    codeDiagram: '',
    cacheStrategy: { population: [], invalidation: [], update: [], flow: '' },
    retryLogic: [],
    keyDetails: { transactionManagement: [], businessRules: [], security: [] },
  };
}


/**
 * Post-processing for ai_context mode: fills empty fields with TODO_AI_ENRICH placeholders
 * and ensures _context is always defined. Does not overwrite existing content.
 */
function applyAiContextPlaceholders(result: DocumentEndpointResult): DocumentEndpointResult {
  // summary → TODO_AI_ENRICH if empty or already a placeholder
  if (!result.summary || result.summary === TODO_AI_ENRICH) {
    result.summary = TODO_AI_ENRICH;
  }

  // logicFlow → TODO_AI_ENRICH if empty or already a placeholder
  if (!result.logicFlow || result.logicFlow === TODO_AI_ENRICH) {
    result.logicFlow = TODO_AI_ENRICH;
  }

  // keyDetails.businessRules → TODO_AI_ENRICH if empty array
  if (!result.keyDetails.businessRules || result.keyDetails.businessRules.length === 0) {
    result.keyDetails.businessRules = [TODO_AI_ENRICH];
  }

  // downstreamApis[].condition and .purpose → TODO_AI_ENRICH if empty
  if (result.externalDependencies.downstreamApis) {
    result.externalDependencies.downstreamApis = result.externalDependencies.downstreamApis.map(api => ({
      ...api,
      condition: api.condition || TODO_AI_ENRICH,
      purpose: api.purpose || TODO_AI_ENRICH,
    }));
  }

  // _context must be defined in ai_context mode
  if (!result._context) {
    result._context = {
      summaryContext: TODO_AI_ENRICH,
      resolvedProperties: {},
    };
  }

  return result;
}


/**
 * Derive a display-friendly service name from the resolved URL value.
 * If the resolved value is an HTTP URL with a meaningful path, extract the first path segment.
 * Otherwise, fall back to the endpoint-derived name or the original name.
 *
 * @param resolvedValue - The actual resolved URL (e.g., "http://apiint.tcbs.com.vn/bond-settlement")
 * @param endpointServiceName - Service name extracted from endpoint path (e.g., "v1" from "/v1/bond-limit/hold-unhold")
 * @param fallbackName - Original service name (typically the config key)
 */
export function deriveDisplayName(
  resolvedValue: string | undefined,
  endpointServiceName: string | null,
  fallbackName: string
): string {
  if (resolvedValue && (resolvedValue.startsWith('http://') || resolvedValue.startsWith('https://'))) {
    try {
      const url = new URL(resolvedValue);
      const segments = url.pathname.split('/').filter(Boolean);
      if (segments.length > 0) {
        return segments[0];
      }
    } catch {
      // Malformed URL — fall through
    }
  }
  return endpointServiceName || fallbackName;
}
async function buildDocumentation(params: BuildDocumentationParams): Promise<DocumentEndpointResult> {
  const { method, path, route, chain, includeContext, compact, executeQuery, repoId, crossRepo } = params;
  const result = createEmptyResult(method, path);

  // Run all four independent async operations in parallel for better performance
  const [downstreamApis, bodyResult, messagingResult, persistence] = await Promise.all([
    extractDownstreamApis(chain, executeQuery, repoId, includeContext, crossRepo, route.controller),
    extractBodySchemas(chain, executeQuery, repoId, crossRepo, method),
    extractMessaging(chain, includeContext, executeQuery, repoId, crossRepo),
    extractPersistence(chain, executeQuery, repoId),
  ]);

  // Destructure results from parallel execution
  const { requestBody, responseBody, nestedSchemas } = bodyResult;
  const { outbound, inbound, nestedSchemas: messagingNestedSchemas } = messagingResult;

  // Filter internal fields for schema compliance when includeContext is false
  if (includeContext) {
    result.externalDependencies.downstreamApis = downstreamApis;
  } else {
    // Remove internal enrichment fields for schema-compliant output
    result.externalDependencies.downstreamApis = downstreamApis.map(api => {
      const normalized = normalizeEndpoint(api.endpoint);
      const resolvedValue = (api as any).resolutionDetails?.resolvedValue;
      return {
        serviceName: api.serviceName,
        name: deriveDisplayName(resolvedValue, normalized.serviceName, api.name),
        type: api.type,
        service: api.service,
        repoId: api.repoId,
        endpoint: normalized.endpoint,
        condition: api.condition,
        purpose: api.purpose,
        resolvedUrl: api.resolvedUrl,
        resolvedFrom: api.resolvedFrom,
      };
    });
  }
  
  // Merge messaging nestedSchemas into main nestedSchemas from body schemas
  for (const [typeName, schema] of messagingNestedSchemas) {
    nestedSchemas.set(typeName, schema);
  }
  
  // Convert payloads for compact mode, keep BodySchema for with-context mode
  if (includeContext) {
    result.externalDependencies.messaging.outbound = outbound;
    result.externalDependencies.messaging.inbound = inbound;
  } else {
    // Compact mode: convert BodySchema payloads to JSON examples
    // For external types (no fields), return just the type name string
    result.externalDependencies.messaging.outbound = outbound.map(msg => {
      if (typeof msg.payload === 'object' && msg.payload !== null) {
        const schema = msg.payload as BodySchema;
        // External types (not indexed) - return type name string
        if (schema.source === 'external' || !schema.fields) {
          return { topic: msg.topic, payload: schema.typeName, pattern: msg.pattern, type: msg.type, direction: msg.direction, service: msg.service, trigger: msg.trigger, sourceRepo: msg.sourceRepo };
        }
        // Indexed types with fields - return JSON example
        return { topic: msg.topic, payload: bodySchemaToJsonExample(schema, nestedSchemas), pattern: msg.pattern, type: msg.type, direction: msg.direction, service: msg.service, trigger: msg.trigger, sourceRepo: msg.sourceRepo };
      }
      return { topic: msg.topic, payload: msg.payload, pattern: msg.pattern, type: msg.type, direction: msg.direction, service: msg.service, trigger: msg.trigger, sourceRepo: msg.sourceRepo };
    });

    result.externalDependencies.messaging.inbound = inbound.map(msg => {
      if (typeof msg.payload === 'object' && msg.payload !== null) {
        const schema = msg.payload as BodySchema;
        // External types (not indexed) - return type name string
        if (schema.source === 'external' || !schema.fields) {
          return { topic: msg.topic, payload: schema.typeName, pattern: msg.pattern, type: msg.type, direction: msg.direction, service: msg.service, consumptionLogic: msg.consumptionLogic, sourceRepo: msg.sourceRepo };
        }
        // Indexed types with fields - return JSON example
        return { topic: msg.topic, payload: bodySchemaToJsonExample(schema, nestedSchemas), pattern: msg.pattern, type: msg.type, direction: msg.direction, service: msg.service, consumptionLogic: msg.consumptionLogic, sourceRepo: msg.sourceRepo };
      }
      return { topic: msg.topic, payload: msg.payload, pattern: msg.pattern, type: msg.type, direction: msg.direction, service: msg.service, consumptionLogic: msg.consumptionLogic, sourceRepo: msg.sourceRepo };
    });
  }

  result.externalDependencies.persistence = persistence;

  // Extract exceptions for response codes
  const exceptionCodes = extractExceptionCodes(chain);
  // (#22) Default success code by HTTP method, following REST conventions:
  //   POST   → 201 Created
  //   DELETE → 204 No Content
  //   PUT/PATCH → 200 OK (resource updated, body returned)
  //   GET/HEAD/OPTIONS → 200 OK
  // Previously all methods defaulted to 200, which produced misleading
  // OpenAPI docs (a POST that should be 201 was documented as 200, etc.).
  const defaultSuccessCode = (() => {
    switch (method.toUpperCase()) {
      case 'POST': return 201;
      case 'DELETE': return 204;
      default: return 200; // GET, PUT, PATCH, HEAD, OPTIONS
    }
  })();
  const defaultSuccessDescription =
    defaultSuccessCode === 201 ? 'Created' :
    defaultSuccessCode === 204 ? 'No Content' : 'Success';
  result.specs.response.codes = [
    { code: defaultSuccessCode, description: defaultSuccessDescription },
    ...exceptionCodes,
  ];

  // Extract annotations for keyDetails
  const { transaction, retry, security } = extractAnnotations(chain);
  result.keyDetails.transactionManagement = transaction;
  result.retryLogic = retry;
  result.keyDetails.security = security;

  // Convert to JSON example for schema-compliant output
  // When includeContext is true, keep full BodySchema for AI enrichment
  // When includeContext is false, output JSON example
  // Note: For request bodies with primitive/container types (e.g., @RequestBody Map<String,Object>),
  // keep the BodySchema object so the OpenAPI converter can generate a proper schema.
  // bodySchemaToJsonExample returns null for primitives, which would drop the requestBody entirely.
  if (includeContext) {
    result.specs.request.body = embedNestedSchemas(requestBody, nestedSchemas);
    result.specs.response.body = embedNestedSchemas(responseBody, nestedSchemas);
  } else {
    // (#16) The request body used to be JSON-serialized via
    // bodySchemaToJsonExample, which collapses the schema to a plain
    // example object. The OpenAPI converter then sees no `fields` and
    // emits `type: object` with the example — even when the DTO was
    // fully resolved with field metadata. The contrast in the issue
    // (`POST /api/users` correctly resolves the response to `User`
    // with fields, but `POST /api/orders` shows the request body as
    // `{_type: 'OrderDto'}`) was because the response path used
    // `embedNestedSchemas` (which preserves the BodySchema) while the
    // request path used the JSON example.
    //
    // The right contract for the converter is the BodySchema itself:
    // it has the field list needed to render `properties`, plus the
    // source/annotations needed to decide whether to extract to
    // `components.schemas`. The example is a derived value. We now
    // mirror the response path.
    result.specs.request.body = embedNestedSchemas(requestBody, nestedSchemas) ?? requestBody;
    // Keep BodySchema for response so the converter can generate properties from fields.
    // Previously bodySchemaToJsonExample was used here, but it produces a plain JSON object
    // that the converter can only represent as `type: object` with an example — no properties.
    result.specs.response.body = embedNestedSchemas(responseBody, nestedSchemas) ?? responseBody;
  }

  // Extract request parameters (PathVariable, RequestParam, RequestHeader, CookieValue)
  const handler = chain.find(n => n.depth === 0);
  if (handler) {
    result.specs.request.params = extractRequestParams(handler, includeContext);
    // Extract validation rules from handler parameters and body schema fields
    result.specs.request.validation = extractValidationRules(handler, requestBody, chain, includeContext);
  }

  // WI-5: Copy validation to externalDependencies for consumer convenience
  result.externalDependencies.validation = result.specs.request.validation;

  // Generate code diagram
  result.codeDiagram = generateCodeDiagram(chain);

  // Generate logic flow from chain
  if (chain.length > 0) {
    // (#38) Collapse consecutive duplicate method names. The chain can
    // include the same name twice in a row when:
    //  - an overload is resolved iteratively (e.g., `getBondById` →
    //    `getBondById` overload that adds @RequestBody), and
    //  - a method calls itself transitively through re-exports.
    // The resulting flow string was misleading: e.g.
    // `getBondById → getBondById → getBondById → getCode` suggests
    // the method calls itself in a loop, which is inaccurate. We
    // collapse only consecutive duplicates — distinct occurrences of
    // the same method separated by other calls are preserved (they
    // are real call-graph paths).
    const names = chain.map(n => n.name);
    const dedupedNames = names.filter((name, i) => i === 0 || name !== names[i - 1]);
    result.logicFlow = dedupedNames.join(' → ');
  } else {
    result.logicFlow = TODO_AI_ENRICH;
  }

  // Populate handler info at top level for easy access
  if (route.controller) {
    result.handlerClass = route.controller;
  }
  if (route.handler) {
    result.handlerMethod = route.handler;
  }

  // Add context if requested
  if (includeContext) {
    result._context = {
      summaryContext: `Handler: ${route.controller ?? 'Unknown'}.${route.handler}() → Chain: ${chain.map(n => n.name).join(' → ')}`,
      resolvedProperties: {},
    };
  }

  // Keep all required arrays even if empty - JSON schema requires them
  // Previously removed empty arrays, but schema validation requires:
  // - externalDependencies.persistence
  // - externalDependencies.messaging.outbound
  // - keyDetails.transactionManagement, businessRules, security
  // - cacheStrategy.population, invalidation, update

  // WI-11: Attach nestedSchemas for OpenAPI converter to add to components.schemas
  result.nestedSchemas = nestedSchemas;

  return result;
}

async function extractDownstreamApis(
  chain: ChainNode[],
  executeQuery: (repoId: string, query: string, params: Record<string, any>) => Promise<any[]>,
  repoId: string,
  includeContext: boolean,
  crossRepo?: CrossRepoContext,
  currentController?: string
): Promise<DownstreamApi[]> {
  const apis: DownstreamApi[] = [];
  const seen = new Set<string>();
  const seenOutput = new Set<string>(); // dedup by final serviceName+type+endpoint

  // Cache for enclosing class lookups to avoid N+1 queries
  const enclosingClassCache = new Map<string, string | undefined>();

  // Cache FeignClient interface metadata for downstream API detection
  const feignClientCache = new Map<string, { serviceName: string; serviceUrl: string }>();
  if (executeQuery && repoId) {
    try {
      const feignQuery = `
        MATCH (c)
        WHERE c.content CONTAINS '@FeignClient'
           OR c.annotations CONTAINS 'FeignClient'
        RETURN c.name AS className, c.content AS classContent, c.annotations AS classAnnotations, c.filePath AS filePath
      `;
      const feignRows = await executeQuery(repoId, feignQuery, {});
      for (const row of feignRows) {
        const className = row.className ?? row[0] ?? '';
        const filePath = row.filePath ?? row[3] ?? '';
        const classContent = row.classContent ?? row[1] ?? '';
        const classAnnotationsRaw = row.classAnnotations ?? row[2] ?? '';
        let serviceName = '';
        let serviceUrl = '';
        // Try parsing structured annotations first
        try {
          const classAnns = typeof classAnnotationsRaw === 'string' ? JSON.parse(classAnnotationsRaw) : classAnnotationsRaw;
          const feignAnn = Array.isArray(classAnns) ? classAnns.find((a: any) => a.name === '@FeignClient') : null;
          if (feignAnn?.attrs) {
            serviceName = feignAnn.attrs.name || '';
            serviceUrl = feignAnn.attrs.url || '';
          }
        } catch {}
        // Fallback: extract from content using regex
        if (!serviceName && !serviceUrl && classContent) {
          const nameMatch = classContent.match(/@FeignClient\s*\([^)]*(?:name|value)\s*=\s*["']([^"']+)["']/);
          const urlMatch = classContent.match(/@FeignClient\s*\([^)]*url\s*=\s*["']([^"']+)["']/);
          if (nameMatch) serviceName = nameMatch[1];
          if (urlMatch) serviceUrl = urlMatch[1];
        }
        if (serviceName || serviceUrl) {
          if (filePath) feignClientCache.set(filePath, { serviceName, serviceUrl });
          if (className) feignClientCache.set(className, { serviceName, serviceUrl });
        }
      }
    } catch (e) {
      // Ignore graph query errors
    }
  }

  // Build reverse lookup: propertyKey → serviceName from FeignClient URL references
  // E.g., @FeignClient(name="product-service", url="${tcbs.bond.product.url}")
  //   → propertyKeyToServiceName("tcbs.bond.product.url") = "product-service"
  const propertyKeyToServiceName = new Map<string, string>();
  for (const [, info] of feignClientCache) {
    if (info.serviceUrl) {
      const propMatches = info.serviceUrl.matchAll(/\$\{([^}:}]+)(?::[^}]*)?\}/g);
      for (const pm of propMatches) {
        propertyKeyToServiceName.set(pm[1], info.serviceName);
      }
    }
  }

  // Build URL path → serviceName mapping from servicePropertyCache URLs
  // E.g., http://apiintsit.tcbs.com.vn/matching-engine/v1/ → /matching-engine/ → matching
  const urlPathToServiceName = new Map<string, string>();
  if (executeQuery && repoId) {
    try {
      const propQuery = `
        MATCH (p:Property)
        WHERE (p.description IS NULL OR p.description = '')
          AND (p.name CONTAINS 'url' OR p.name CONTAINS 'host' OR p.name CONTAINS 'endpoint')
        RETURN p.name AS propKey, p.content AS content
      `;
      const propRows = await executeQuery(repoId, propQuery, {});
      for (const row of propRows) {
        const propKey = (row.propKey ?? row[0] ?? '') as string;
        const content = (row.content ?? row[1] ?? '') as string;
        const urlValue = parsePropertyValueFromContent(propKey, content);
        if (urlValue && urlValue.startsWith('http')) {
          try {
            const url = new URL(urlValue);
            if (url.pathname && url.pathname.length > 1) {
              // Extract first path segment as service path prefix
              const segments = url.pathname.split('/').filter(Boolean);
              if (segments.length > 0) {
                const pathPrefix = '/' + segments[0] + '/';
                const snFromKey = parseServiceNameFromPropertyKey(propKey);
                const snFromPath = segments[0];
                const serviceName = snFromKey || snFromPath;
                if (serviceName && serviceName !== 'unknown-service') {
                  urlPathToServiceName.set(pathPrefix, serviceName);
                  // Also map just the first segment
                  urlPathToServiceName.set('/' + segments[0], serviceName);
                }
              }
            }
          } catch {}
        }
      }
    } catch (e) {
      if (DEBUG) console.error('[GitNexus DEBUG] URL path scan failed:', e);
    }
  }

  // Proactive property scan: build propertyKey → serviceName mapping from Property nodes
  // This resolves cases where @Value resolution finds a property key but no serviceName
  const servicePropertyCache = new Map<string, string>(); // propertyKey → serviceName
  if (executeQuery && repoId) {
    try {
      const propQuery = `
        MATCH (p:Property)
        WHERE (p.description IS NULL OR p.description = '')
          AND (p.name CONTAINS 'url' OR p.name CONTAINS 'host' OR p.name CONTAINS 'endpoint')
        RETURN p.name AS propKey, p.content AS content
      `;
      const propRows = await executeQuery(repoId, propQuery, {});
      for (const row of propRows) {
        const propKey = (row.propKey ?? row[0] ?? '') as string;
        const content = (row.content ?? row[1] ?? '') as string;
        const urlValue = parsePropertyValueFromContent(propKey, content);
        if (urlValue && urlValue.startsWith('http')) {
          try {
            const url = new URL(urlValue);
            if (url.hostname && url.hostname !== 'localhost' && !/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)) {
              const sn = parseServiceNameFromPropertyKey(propKey) || url.pathname.split('/').filter(Boolean)[0] || url.hostname.replace(/\./g, '-');
              if (sn) servicePropertyCache.set(propKey, sn);
            }
          } catch {}
        }
      }
    } catch (e) {
      if (DEBUG) console.error('[GitNexus DEBUG] Property scan failed:', e);
    }
  }

  // Cross-repo FeignClient enrichment: query dep repos for their FeignClient interfaces
  // to map RestTemplate property keys to actual FeignClient service names
  if (crossRepo) {
    try {
      const depRepoIds = await crossRepo.listDepRepos();
      if (depRepoIds.length > 0) {
        const feignQuery = `
          MATCH (c)
          WHERE c.content CONTAINS '@FeignClient'
             OR c.annotations CONTAINS 'FeignClient'
          RETURN c.name AS className, c.content AS classContent, c.annotations AS classAnnotations, c.filePath AS filePath
        `;
        const crossRepoResults = await crossRepo.queryMultipleRepos(depRepoIds, feignQuery, {});
        for (const { results: rows } of crossRepoResults) {
          for (const row of rows as any[]) {
            const classContent = row.classContent ?? row[1] ?? '';
            const classAnnotationsRaw = row.classAnnotations ?? row[2] ?? '';
            let sn = '';
            let su = '';
            try {
              const classAnns = typeof classAnnotationsRaw === 'string' ? JSON.parse(classAnnotationsRaw) : classAnnotationsRaw;
              const feignAnn = Array.isArray(classAnns) ? classAnns.find((a: any) => a.name === '@FeignClient') : null;
              if (feignAnn?.attrs) {
                sn = feignAnn.attrs.name || '';
                su = feignAnn.attrs.url || '';
              }
            } catch {}
            if (!sn && !su && classContent) {
              const nameMatch = classContent.match(/@FeignClient\s*\([^)]*(?:name|value)\s*=\s*["']([^"']+)["']/);
              const urlMatch = classContent.match(/@FeignClient\s*\([^)]*url\s*=\s*["']([^"']+)["']/);
              if (nameMatch) sn = nameMatch[1];
              if (urlMatch) su = urlMatch[1];
            }
            if (su) {
              const propMatches = su.matchAll(/\$\{([^}:}]+)(?::[^}]*)?\}/g);
              for (const pm of propMatches) {
                propertyKeyToServiceName.set(pm[1], sn);
              }
            }
          }
        }
      }
    } catch (e) {
      if (DEBUG) console.error('[GitNexus DEBUG] Cross-repo FeignClient enrichment failed:', e);
    }
  }

  // Proactive @Value field scan: pre-build fieldName → propertyKey map for all URL-related fields
  const fieldNameToPropertyKey = new Map<string, { propertyKey: string; rawValue: string; declaringClass: string }>();
  if (executeQuery && repoId) {
    try {
      const valueFieldQuery = `
        MATCH (c:Class)
        WHERE c.fields CONTAINS '@Value'
        RETURN c.name AS className, c.fields AS fields
      `;
      const valueRows = await executeQuery(repoId, valueFieldQuery, {});
      for (const row of valueRows) {
        const fieldsJson = row.fields || row[1];
        const className = row.className || row[0] || '';
        if (!fieldsJson) continue;
        try {
          const fields = JSON.parse(fieldsJson);
          for (const field of fields) {
            if (field.annotationAttrs) {
              const valueAnn = field.annotationAttrs.find((a: any) => a.name === '@Value');
              if (valueAnn?.attrs) {
                const rawValue = valueAnn.attrs['0'] || valueAnn.attrs['value'] || '';
                if (rawValue && (rawValue.includes('url') || rawValue.includes('host') || rawValue.includes('endpoint') || rawValue.includes('service'))) {
                  const match = rawValue.match(/\$\{([^}:}]+)(?::[^}]*)?\}/);
                  if (match) {
                    fieldNameToPropertyKey.set(field.name, {
                      propertyKey: match[1],
                      rawValue,
                      declaringClass: className,
                    });
                  }
                }
              }
            }
          }
        } catch {}
      }
    } catch (e) {
      if (DEBUG) console.error('[GitNexus DEBUG] Field-to-PropertyKey scan failed:', e);
    }
  }

  for (const node of chain) {
    for (const detail of node.metadata.httpCallDetails) {
      const key = detail.isFeignClient
        ? `feign:${detail.httpMethod}:${detail.urlExpression}`
        : `${detail.httpMethod}:${detail.urlExpression}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // ─── FeignClient shortcut: use @FeignClient annotation for service name + URL ───
      if (detail.isFeignClient) {
        let feignInfo = node.filePath ? feignClientCache.get(node.filePath) : undefined;
        if (!feignInfo && node.filePath) {
          const cacheKey = node.filePath;
          let className: string | undefined;
          if (enclosingClassCache.has(cacheKey)) {
            className = enclosingClassCache.get(cacheKey);
          } else {
            className = await findEnclosingClass(executeQuery, repoId, node.filePath);
            enclosingClassCache.set(cacheKey, className);
          }
          if (className) feignInfo = feignClientCache.get(className);
        }

        if (feignInfo) {
          // Resolve service URL if it contains ${...} property references
          let resolvedUrl = feignInfo.serviceUrl;
          if (resolvedUrl && resolvedUrl.includes('${')) {
            const varMatch = resolvedUrl.match(/\$\{([^}]+)\}/);
            if (varMatch) {
              const propKey = varMatch[1];
              const cacheKey = node.filePath;
              let className: string | undefined;
              if (enclosingClassCache.has(cacheKey)) {
                className = enclosingClassCache.get(cacheKey);
              } else {
                className = await findEnclosingClass(executeQuery, repoId, node.filePath);
                enclosingClassCache.set(cacheKey, className);
              }
              if (className) {
                const resolved = await resolveValueAnnotation(executeQuery, repoId, className, propKey);
                if (resolved.rawValue) resolvedUrl = resolved.rawValue;
              }
            }
          }

          let serviceName = feignInfo.serviceName;
          if (!serviceName && feignInfo.serviceUrl) {
            try {
              const url = new URL(feignInfo.serviceUrl);
              serviceName = url.hostname.replace(/\./g, '-');
            } catch {
              serviceName = 'unknown-service';
            }
          }
          serviceName = serviceName || 'unknown-service';
          apis.push({
            serviceName,
            name: serviceName,
            type: 'REST',
            service: serviceName,
            repoId,
            endpoint: `${detail.httpMethod} ${detail.urlExpression}`,
            condition: TODO_AI_ENRICH,
            purpose: TODO_AI_ENRICH,
            resolvedUrl: resolvedUrl?.startsWith('http') ? resolvedUrl : undefined,
            resolvedFrom: 'feign-client',
            ...(includeContext && {
              _context: `// ${node.filePath}:${node.startLine}-${node.endLine}\n${node.content?.slice(0, 200)}...`,
            }),
          });
          continue;
        }
        // Fall through to standard resolution if FeignClient info not found
      }

      // Parse URL expression to extract components
      const parsed = parseUrlExpression(detail.urlExpression);

      // Find enclosing class for field resolution (cached)
      const cacheKey = node.filePath;
      let className: string | undefined;
      if (enclosingClassCache.has(cacheKey)) {
        className = enclosingClassCache.get(cacheKey);
      } else {
        className = await findEnclosingClass(executeQuery, repoId, node.filePath);
        enclosingClassCache.set(cacheKey, className);
      }

      // Resolve service variable if present
      let serviceValue: string | null = null;
      let propertyKey: string | null = null;
      let resolvedFieldName: string | null = null;
      let resolvedValue: string | null = null;
      // WI-4: Track which resolution pass succeeded for resolvedFrom attribution
      let resolvedFrom: string | undefined;

      // ============================================
      // Pass 1: Current resolution (@Value + static final in same class)
      // ============================================
      if (parsed.serviceName && className) {
        // Try to resolve @Value annotation for the service field
        const resolved = await resolveValueAnnotation(executeQuery, repoId, className, parsed.serviceName + 'Service');
        if (resolved.propertyKey) {
          propertyKey = resolved.propertyKey;
          serviceValue = resolved.rawValue;
          resolvedFrom = 'value-annotation';
        } else {
          // Pass 1b: Cross-class @Value fallback — search ALL classes for field with @Value
          const fieldName = parsed.serviceName + 'Service';
          const crossResolved = await resolveValueAnnotationCrossClass(executeQuery, repoId, fieldName);
          if (crossResolved.propertyKey) {
            propertyKey = crossResolved.propertyKey;
            serviceValue = crossResolved.rawValue;
            resolvedFrom = 'cross-class-value-annotation';
          }
        }
      }

      // ============================================
      // Pass 2: Variable assignment trace (heuristics + cross-class)
      // ============================================

      // WI-4: Check for builder.toUriString() pattern first
      const builderResult = resolveBuilderUrl(detail.urlExpression, node.metadata.builderDetails, node.content);
      if (builderResult && className) {
        // Found builder pattern - resolve the base URL
        let baseField: string | null = null;

        // Check if baseUrlExpression is a method call like "url.toString()"
        // If so, trace the StringBuilder construction to find the actual base field
        const toStringMatch = builderResult.baseUrlExpression.match(/^(\w+)\.toString\(\)$/);
        if (toStringMatch && node.content) {
          const varName = toStringMatch[1];
          baseField = traceStringBuilderConstruction(varName, node.content);
        }

        // If no StringBuilder trace, try direct extraction
        if (!baseField) {
          baseField = extractBaseField(builderResult.baseUrlExpression);
        }

        if (baseField) {
          // Try to resolve the base field
          const resolved = await resolveValueAnnotation(executeQuery, repoId, className, baseField);
          if (resolved.propertyKey) {
            propertyKey = resolved.propertyKey;
            serviceValue = resolved.rawValue;
            resolvedFieldName = baseField;
            resolvedFrom = 'builder-pattern';
          }
        }
        // If base field resolution failed, try the full expression
        if (!propertyKey) {
          const traced = await traceVariableAssignment(executeQuery, repoId, className, baseField || builderResult.baseUrlExpression, node.content);
          if (traced.propertyKey) {
            propertyKey = traced.propertyKey;
            serviceValue = traced.rawValue;
            resolvedFieldName = traced.fieldName;
            resolvedFrom = 'builder-pattern';
          }
        }
      }

      // Regular variable assignment trace if builder pattern didn't resolve
      if (!propertyKey && className && parsed.variableRefs.length > 0) {
        // Try each variable reference with heuristic patterns
        for (const varRef of parsed.variableRefs) {
          const traced = await traceVariableAssignment(executeQuery, repoId, className, varRef, node.content);
          if (traced.propertyKey) {
            propertyKey = traced.propertyKey;
            serviceValue = traced.rawValue;
            resolvedFieldName = traced.fieldName;
            resolvedFrom = 'variable-assignment';
            break;
          }
        }
      }

      // Pass 2a: Bare variable tracing — when urlExpression is a simple variable like "url" or "targetUrl"
      // Try to trace local variable assignments to find the base URL field
      if (!propertyKey && className && /^[a-zA-Z]\w*$/.test(detail.urlExpression) && node.content) {
        const assignments = extractLocalVariableAssignments(node.content);
        const expr = assignments.get(detail.urlExpression);
        if (expr) {
          const baseField = extractBaseField(expr);
          if (baseField && baseField !== detail.urlExpression) {
            // Try @Value resolution for the base field
            const resolved = await resolveValueAnnotation(executeQuery, repoId, className, baseField);
            if (resolved.propertyKey) {
              propertyKey = resolved.propertyKey;
              serviceValue = resolved.rawValue;
              resolvedFieldName = baseField;
              resolvedFrom = 'bare-variable-trace';
            } else {
              // Try cross-class
              const crossResolved = await resolveValueAnnotationCrossClass(executeQuery, repoId, baseField);
              if (crossResolved.propertyKey) {
                propertyKey = crossResolved.propertyKey;
                serviceValue = crossResolved.rawValue;
                resolvedFieldName = baseField;
                resolvedFrom = 'bare-variable-trace+cross-class';
              }
            }
          }
        }
      }

      // Pass 2a2: StringBuilder toString() — when urlExpression is "targetUrl.toString()"
      // Try to trace the StringBuilder construction for the variable
      if (!propertyKey && className && node.content) {
        const toStringMatch = detail.urlExpression.match(/^(\w+)\.toString\(\)$/);
        if (toStringMatch) {
          const varName = toStringMatch[1];
          // Try StringBuilder construction trace
          const sbBase = traceStringBuilderConstruction(varName, node.content);
          if (sbBase) {
            const resolved = await resolveValueAnnotation(executeQuery, repoId, className, sbBase);
            if (resolved.propertyKey) {
              propertyKey = resolved.propertyKey;
              serviceValue = resolved.rawValue;
              resolvedFieldName = sbBase;
              resolvedFrom = 'stringbuilder-tostring-trace';
            }
          }
        }
      }

      // Pass 2b: Fuzzy field name → property key matching using servicePropertyCache
      if (!propertyKey && parsed.serviceName) {
        const fieldName = parsed.serviceName + 'Service';
        const fuzzyKey = findMatchingPropertyKey(fieldName, servicePropertyCache);
        if (fuzzyKey) {
          propertyKey = fuzzyKey;
          resolvedFrom = 'property-fuzzy-match';
          const propValue = await resolvePropertyValue(executeQuery, repoId, propertyKey);
          if (propValue.value) resolvedValue = propValue.value;
        }
      }

      // Pass 2c: Proactive field-to-propertyKey cache lookup
      if (!propertyKey && fieldNameToPropertyKey.size > 0) {
        // Try variable refs and parsed.serviceName-based patterns
        const candidates = [
          ...parsed.variableRefs,
          ...(parsed.serviceName ? [parsed.serviceName + 'Service', parsed.serviceName + 'ServiceUrl', parsed.serviceName] : []),
        ].filter(Boolean);
        for (const candidate of candidates) {
          const cached = fieldNameToPropertyKey.get(candidate);
          if (cached) {
            propertyKey = cached.propertyKey;
            serviceValue = cached.rawValue;
            resolvedFrom = 'field-property-cache';
            break;
          }
        }
      }

      // ============================================
      // Pass 1b: Resolve actual property value from config files
      // ============================================
      if (propertyKey) {
        const propValue = await resolvePropertyValue(executeQuery, repoId, propertyKey);
        if (propValue.value) {
          resolvedValue = propValue.value;
        } else {
          // Try to parse default value from ${key:default} syntax
          if (serviceValue) {
            const parsedPlaceholder = parsePropertyPlaceholder(serviceValue);
            if (parsedPlaceholder.defaultValue) {
              resolvedValue = parsedPlaceholder.defaultValue;
            }
          }
        }
      }

      // Resolve URI constants
      const pathConstants: { name: string; value: string; declaringClass?: string }[] = [];

      // Pass 1: Same-class static final resolution (existing)
      for (const varRef of parsed.variableRefs) {
        if (className) {
          const value = await resolveStaticFieldValue(executeQuery, repoId, className, varRef);
          if (value) {
            pathConstants.push({ name: varRef, value });
            // WI-4: Track static-final resolution
            if (!resolvedFrom) resolvedFrom = 'static-final';
          }
        }
      }

      // Pass 2: Cross-class static final resolution for unresolved constants
      for (const varRef of parsed.variableRefs) {
        if (!pathConstants.find(pc => pc.name === varRef) && className) {
          const resolved = await resolveStaticFieldValueCrossClass(executeQuery, repoId, className, varRef);
          if (resolved.value) {
            pathConstants.push({
              name: varRef,
              value: resolved.value,
              declaringClass: resolved.declaringClass ?? undefined
            });
            // WI-4: Track static-final resolution (cross-repo)
            if (!resolvedFrom) resolvedFrom = 'static-final';
          }
        }
      }

      // Build resolved URL
      let resolvedUrl = detail.urlExpression;
      if (pathConstants.length > 0) {
        // Replace constant references with their values
        for (const pc of pathConstants) {
          resolvedUrl = resolvedUrl.replace(new RegExp(`\\b${pc.name}\\b`, 'g'), pc.value);
        }
      }

      // Determine service name — enhanced with FeignClient reverse lookup + property key parsing
      let serviceName = propertyKey || parsed.serviceName || 'unknown-service';

      if (propertyKey && propertyKeyToServiceName.has(propertyKey)) {
        serviceName = propertyKeyToServiceName.get(propertyKey)!;
        resolvedFrom = resolvedFrom ? `${resolvedFrom}+feign-lookup` : 'feign-lookup';
      } else if (propertyKey && servicePropertyCache.has(propertyKey)) {
        serviceName = servicePropertyCache.get(propertyKey)!;
        resolvedFrom = resolvedFrom ? `${resolvedFrom}+property-scan` : 'property-scan';
      } else if (propertyKey && propertyKey.includes('.')) {
        const parsedKey = parseServiceNameFromPropertyKey(propertyKey);
        if (parsedKey) {
          serviceName = parsedKey;
          resolvedFrom = resolvedFrom ? `${resolvedFrom}+key-parse` : 'key-parse';
        }
      }

      // Try hostname extraction from resolved URL value
      if ((serviceName === 'unknown-service' || serviceName.includes('.')) && resolvedValue) {
        try {
          const url = new URL(resolvedValue);
          if (url.hostname && url.hostname !== 'localhost' && !/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)) {
            serviceName = url.hostname.replace(/\./g, '-');
            resolvedFrom = resolvedFrom ? `${resolvedFrom}+url-hostname` : 'url-hostname';
          }
        } catch {}
      }

      // Final fallback: try to extract from resolvedUrl
      if (serviceName === 'unknown-service' && resolvedUrl) {
        try {
          const url = new URL(resolvedUrl);
          if (url.hostname && url.hostname !== 'localhost' && !/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)) {
            serviceName = url.hostname.replace(/\./g, '-');
            resolvedFrom = resolvedFrom ? `${resolvedFrom}+url-hostname-fallback` : 'url-hostname-fallback';
          }
        } catch {}
      }

      // Build endpoint string - simplified: HTTP_METHOD + /path
      let endpoint: string;
      if (pathConstants.length > 0) {
        // Use resolved path constant
        endpoint = `${detail.httpMethod} ${pathConstants[0].value}`;
      } else if (resolvedValue && (resolvedValue.startsWith('http') || resolvedValue.startsWith('/'))) {
        // Use resolved value when it contains a complete URL or path prefix
        endpoint = `${detail.httpMethod} ${resolvedValue}`;
      } else if (parsed.staticParts.length > 0) {
        // Use static parts if available
        endpoint = `${detail.httpMethod} ${parsed.staticParts.join('')}`;
      } else {
        // Fall back to original expression
        endpoint = `${detail.httpMethod} ${detail.urlExpression}`;
      }

      // WI-4: Cross-repo URL resolution — find which dep repo provides this API
      let resolvedRepoId: string = repoId; // default to current repo
      if (crossRepo) {
        try {
          // Strategy 1: Match by serviceName (Spring property key often contains package prefix)
          if (serviceName && serviceName !== 'unknown-service') {
            const depRepoId = await crossRepo.findDepRepo(serviceName);
            if (depRepoId) {
              resolvedRepoId = depRepoId;
            }
          }

          // Strategy 2: If serviceName didn't match, try URL path segment
          if (resolvedRepoId === repoId && resolvedUrl) {
            try {
              const urlObj = new URL(resolvedUrl);
              const pathSegments = urlObj.pathname.split('/').filter(Boolean);
              if (pathSegments.length > 0) {
                const serviceSegment = pathSegments[0];
                const depRepoId = await crossRepo.findDepRepo(serviceSegment);
                if (depRepoId) {
                  resolvedRepoId = depRepoId;
                }
              }
            } catch {
              // URL parsing may fail for partial URLs — ignore
            }
          }
        } catch (e) {
          if (DEBUG) console.error('[GitNexus DEBUG] Cross-repo URL resolution failed:', e);
        }
      }

      // ============================================
      // Pass 3: Context enrichment for unresolved cases
      // ============================================
      let resolutionDetails: any = undefined;
      if (propertyKey || pathConstants.length > 0) {
        resolutionDetails = {
          serviceField: resolvedFieldName || (parsed.serviceName ? parsed.serviceName + 'Service' : undefined),
          serviceValue: serviceValue || undefined,
          resolvedValue: resolvedValue || undefined,
          pathConstants: pathConstants.length > 0 ? pathConstants.map(pc => ({ name: pc.name, value: pc.value })) : undefined,
        };
      } else if (serviceName === 'unknown-service' && includeContext) {
        // Enhanced context for manual/AI review
        resolutionDetails = {
          attemptedPatterns: parsed.variableRefs,
          enclosingClass: className,
          filePath: node.filePath,
        };
      }

      // Skip EXCHANGE method entries — RestTemplate.exchange() doesn't reveal
      // the actual HTTP method at static analysis time, so these are invalid
      if (detail.httpMethod === 'EXCHANGE') {
        continue;
      }

      // Normalize endpoint — strip domain, extract service name from URL
      // Final fallback: derive service name from endpoint path when all resolution failed
      if (serviceName === 'unknown-service' && endpoint.includes('/')) {
        // Try all path segments (skip {param} segments) against urlPathToServiceName
        const segments = endpoint.match(/^([A-Z]+)\s+(.*)/);
        if (segments) {
          const pathStr = segments[2] || '';
          const pathSegs = pathStr.replace(/^https?:\/\/[^/]*/, '').split('/').filter(Boolean);
          for (const seg of pathSegs) {
            if (seg.startsWith('{') || seg.length <= 1) continue;
            const segWithSlash = '/' + seg;
            const segWithTrailing = segWithSlash + '/';
            if (urlPathToServiceName.has(segWithTrailing)) {
              serviceName = urlPathToServiceName.get(segWithTrailing)!;
              resolvedFrom = resolvedFrom ? `${resolvedFrom}+url-path-map` : 'url-path-map';
              break;
            } else if (urlPathToServiceName.has(segWithSlash)) {
              serviceName = urlPathToServiceName.get(segWithSlash)!;
              resolvedFrom = resolvedFrom ? `${resolvedFrom}+url-path-map` : 'url-path-map';
              break;
            }
          }
          // If urlPathToServiceName didn't match, fall back to first non-param segment
          if (serviceName === 'unknown-service') {
            const pathMatch = pathStr.match(/^(?:https?:\/\/[^/]+)?\/([^/{\s]+)/);
            if (pathMatch && pathMatch[1].length > 1) {
              serviceName = pathMatch[1];
              resolvedFrom = resolvedFrom ? `${resolvedFrom}+endpoint-path` : 'endpoint-path';
            }
          }
        }
      }

      // NEW: Variable name heuristic fallback — derive service name from variable/field names
      if (serviceName === 'unknown-service') {
        for (const varRef of parsed.variableRefs) {
          const derived = serviceNameFromVariableName(varRef);
          if (derived) {
            serviceName = derived;
            resolvedFrom = resolvedFrom ? `${resolvedFrom}+variable-name-heuristic` : 'variable-name-heuristic';
            break;
          }
        }
        // Try builder base expression
        if (serviceName === 'unknown-service' && builderResult) {
          const derived = serviceNameFromVariableName(builderResult.baseUrlExpression);
          if (derived) {
            serviceName = derived;
            resolvedFrom = resolvedFrom ? `${resolvedFrom}+variable-name-heuristic` : 'variable-name-heuristic';
          }
        }
        // Try parsed.serviceName (from xxxService pattern)
        if (serviceName === 'unknown-service' && parsed.serviceName) {
          const derived = serviceNameFromVariableName(parsed.serviceName + 'Service');
          if (derived) {
            serviceName = derived;
            resolvedFrom = resolvedFrom ? `${resolvedFrom}+variable-name-heuristic` : 'variable-name-heuristic';
          }
        }
        // Try urlExpression itself for simple variable patterns
        if (serviceName === 'unknown-service') {
          const derived = serviceNameFromVariableName(detail.urlExpression);
          if (derived) {
            serviceName = derived;
            resolvedFrom = resolvedFrom ? `${resolvedFrom}+variable-name-heuristic` : 'variable-name-heuristic';
          }
        }
        // === CALLS-graph resolver (#93) — INSERTED 2026-06-04 ===
        // Walk the CALLS graph from the call site Method → callee Method →
        // containing Class → Route node. If a Route is found for the callee's
        // class, use that class as the service name. This is more accurate
        // than the class-name heuristic (which derives from the caller's
        // enclosing class) because it identifies the actual target controller
        // of the HTTP call via the call graph. Falls through to the
        // class-name heuristic if the graph returns no rows.
        if (serviceName === 'unknown-service' && node.uid && node.kind === 'Method' && executeQuery) {
          try {
            // Query has a leading comment marker (calls-graph-route #93)
            // — recognised by unit-test mocks. Cypher block comment form.
            const callsGraphQuery = `
              /* calls-graph-route #93 */
              MATCH (caller:Method {id: $callerUid})-[:CodeRelation {type: 'CALLS'}]->(callee:Method)
              MATCH (cls:Class)-[:CodeRelation {type: 'HAS_METHOD'}]->(callee)
              MATCH (r:Route)-[:CodeRelation {type: 'CALLS'}]->(callee)
              WHERE r.controllerName = cls.name
              RETURN cls.name AS className, r.httpMethod AS httpMethod, r.routePath AS routePath
              LIMIT 1
            `;
            const graphRows = await executeQuery(repoId, callsGraphQuery, { callerUid: node.uid });
            if (Array.isArray(graphRows) && graphRows.length > 0) {
              // Narrow the row shape: executeQuery returns Promise<any[]>, so row
              // is implicitly any. The CALLS-graph query aliases columns explicitly
              // (cls.name AS className, r.httpMethod AS httpMethod, r.routePath AS
              // routePath), so we read by alias and validate the type at use site.
              // The previous `row.className ?? row[0]` form silently fell through
              // to the next cell on null and assumed an untyped array shape.
              type CallsGraphRouteRow = { className?: unknown; httpMethod?: unknown; routePath?: unknown };
              const row = graphRows[0] as CallsGraphRouteRow | undefined;
              const resolvedClassName: string | undefined =
                typeof row?.className === 'string' ? row.className : undefined;
              if (resolvedClassName) {
                // Skip if this resolves to the current endpoint's own controller (self-reference)
                const derivedFromResolved = serviceNameFromClassName(resolvedClassName);
                if (currentController && derivedFromResolved && serviceNameFromClassName(currentController) === derivedFromResolved) {
                  // Self-reference: do not resolve via graph; fall through to class-name heuristic
                  if (DEBUG) console.error(`[GitNexus DEBUG] CALLS-graph resolver: skipping self-reference ${resolvedClassName}`);
                } else {
                  serviceName = resolvedClassName;
                  resolvedFrom = resolvedFrom ? `${resolvedFrom}+calls-graph-route` : 'calls-graph-route';
                  // WI-B143 / Issue #143: populate endpoint from the resolved
                  // route's httpMethod + routePath (the query already returns
                  // both). The `endpoint` variable is `let`, so the assignment
                  // is allowed; `normalizeEndpoint` (called later) will pick
                  // up the new value.
                  if (typeof row?.httpMethod === 'string' && typeof row?.routePath === 'string') {
                    endpoint = `${row.httpMethod} ${row.routePath}`;
                  }
                  if (DEBUG) console.error(`[GitNexus DEBUG] CALLS-graph resolver: resolved ${resolvedClassName} for ${node.uid}`);
                }
              }
            }
          } catch (e) {
            if (DEBUG) console.error('[GitNexus DEBUG] CALLS-graph resolver failed:', e);
            // Fall through to class-name heuristic on any error
          }
        }
        // === END CALLS-graph resolver (#93) ===
        // Last-resort: derive from enclosing class name
        if (serviceName === 'unknown-service' && className) {
          const derived = serviceNameFromClassName(className);
          if (derived) {
            // Skip if this is the current endpoint's own controller (self-reference)
            if (currentController && serviceNameFromClassName(currentController) === derived) {
              continue;
            }
            // WI-B45 / Issue #45: route-count gate. The class-name heuristic
            // is a last-resort fallback; it matches the CALLER's enclosing
            // class to derive a service name. When >1 Route node in this repo
            // shares the same controllerName fragment, the heuristic is
            // ambiguous — skip the emit to prevent over-match. The CALLS-
            // graph resolver is unaffected (it has a 1:1 mapping).
            if (executeQuery) {
              try {
                const routeCountResult = await executeQuery(repoId, `
                  MATCH (r:Route) WHERE r.controllerName CONTAINS $className
                  RETURN count(r) AS cnt
                `, { className });
                const routeCount = Number(routeCountResult[0]?.cnt ?? 0);
                if (routeCount > 1) {
                  if (DEBUG) console.error(`[GitNexus DEBUG] WI-B45: skipping class-name-heuristic emit for ${className} (route count=${routeCount})`);
                  continue;
                }
              } catch (e) {
                if (DEBUG) console.error('[GitNexus DEBUG] WI-B45: route-count query failed:', e);
                // On error, fall through and emit (preserve fallback path)
              }
            }
            serviceName = derived;
            resolvedFrom = resolvedFrom ? `${resolvedFrom}+class-name-heuristic` : 'class-name-heuristic';
          }
        }
      }

      const normalized = normalizeEndpoint(endpoint);
      const displayName = deriveDisplayName(resolvedValue, normalized.serviceName, serviceName);

      // WI-B15 / Issue #15: unresolved-expression filter. Drop entries whose
      // endpoint matches a code-expression pattern (e.g. `.toString()`) AND
      // whose `resolvedFrom` is WEAK (i.e. not statically-resolved via
      // static-final, value-annotation, or calls-graph-route). Strongly-
      // resolved entries and clean-path entries are preserved.
      //
      // Concatenations like `value-annotation+calls-graph-route` are STRONG
      // (any strong token makes the whole value strong).
      const STRONG_RESOLVED_FROM_TOKENS = [
        'static-final', 'value-annotation', 'cross-class-value-annotation',
        'calls-graph-route', 'feign-lookup', 'stringbuilder-tostring-trace',
      ];
      const isUnresolvedExpression = (s: string): boolean => /\.\w+\(\)/.test(s);
      const isWeakResolvedFrom = (rf: string | undefined): boolean => {
        if (!rf) return true;
        return !STRONG_RESOLVED_FROM_TOKENS.some(t => rf.includes(t));
      };
      if (isUnresolvedExpression(normalized.endpoint) && isWeakResolvedFrom(resolvedFrom)) {
        if (DEBUG) console.error(`[GitNexus DEBUG] WI-B15: dropping entry with unresolved endpoint ${normalized.endpoint} (resolvedFrom=${resolvedFrom})`);
        continue;
      }

      // Dedup by final service+type+endpoint (different URL expressions may resolve to same endpoint)
      const outputDedupKey = `${serviceName}|REST|${normalized.endpoint}`;
      if (seenOutput.has(outputDedupKey)) continue;
      seenOutput.add(outputDedupKey);

      apis.push({
        serviceName,
        name: displayName,
        type: 'REST',
        service: serviceName,
        repoId: resolvedRepoId,
        endpoint: normalized.endpoint,
        condition: TODO_AI_ENRICH,
        purpose: TODO_AI_ENRICH,
        resolvedUrl: resolvedUrl !== detail.urlExpression ? resolvedUrl : undefined,
        resolvedFrom,
        resolutionDetails,
        ...(includeContext && {
          _context: `// ${node.filePath}:${node.startLine}-${node.endLine}\n${node.content?.slice(0, 200)}...`,
        }),
      });
    }
  }

  return apis;
}

/**
 * Parse a Spring property key to extract a meaningful service name segment.
 * E.g., "tcbs.bond.product.url" → "product"
 *       "mortgage.service.url" → "mortgage"
 *       "tcbs.profile.service" → "profile"
 */
function parseServiceNameFromPropertyKey(key: string): string | null {
  let stripped = key.replace(/\.(service\.url|base-?url|url|host|endpoint|base-?path|service)$/, '');
  if (stripped === key) return null; // no recognized suffix
  const parts = stripped.split('.');
  const generic = new Set(['service', 'api', 'app', 'spring', 'url', 'config', 'client', 'core', 'tcbs', 'v1', 'v2', 'v3', 'v4', 'v5']);
  const meaningful: string[] = [];
  for (const part of parts) {
    if (!generic.has(part) && part.length > 1) {
      meaningful.push(part);
    }
  }
  if (meaningful.length === 0) {
    return parts[parts.length - 1] || null;
  }
  // Return compound name for multi-segment keys (e.g., "bond.product" → "bond-product")
  if (meaningful.length > 1) {
    return meaningful.join('-');
  }
  return meaningful[0];
}

/**
 * Find a property key that fuzzy-matches a Java field name.
 * Converts camelCase field names to dot-separated property key patterns.
 * E.g., "bondProductService" → looks for keys matching "bond.product.url", "tcbs.bond.product.url", etc.
 */
function findMatchingPropertyKey(fieldName: string, propertyCache: Map<string, string>): string | null {
  // Strip common suffixes: Service, Url, URL, ServiceUrl, ServiceURL
  const base = fieldName.replace(/Service(?:Url|URL)?$|Url$|URL$/, '');
  if (!base || base.length < 3) return null;

  // Convert camelCase to dot-separated: bondProduct → bond.product
  const dotSeparated = base.replace(/([a-z])([A-Z])/g, '$1.$2').toLowerCase();
  const segments = dotSeparated.split('.');

  // Try exact and partial matches against propertyCache keys
  for (const propKey of propertyCache.keys()) {
    const propSegments = propKey.split('.');
    // Check if the field segments appear in order in the property key
    let propIdx = 0;
    let allMatched = true;
    for (const seg of segments) {
      const found = propSegments.slice(propIdx).findIndex(p => p === seg);
      if (found === -1) { allMatched = false; break; }
      propIdx += found + 1;
    }
    if (allMatched) return propKey;
  }

  return null;
}

/**
 * Derive a service name from a variable/field name by stripping URL/Service suffixes
 * and converting case format to kebab-case.
 * E.g., "portfolioServiceUrl" → "portfolio", "MATCHING_URL" → "matching",
 *       "hftKremaServiceUrl" → "hft-krema", "notiUrl" → "noti"
 * Returns null for names that are too generic (e.g., "url", "baseUrl", "target").
 */
function serviceNameFromVariableName(varName: string): string | null {
  // Reject names that are too generic to derive a meaningful service name
  const genericNames = new Set([
    'url', 'uri', 'baseUrl', 'baseUri', 'base', 'endpoint', 'address',
    'host', 'server', 'service', 'client', 'connection', 'config',
    'target', 'builder', 'result', 'response', 'request', 'path',
    'id', 'name', 'value', 'key', 'type', 'code', 'data', 'str',
    'obj', 'object', 'map', 'list', 'set', 'val', 'ref', 'tmp',
    // Method call patterns that shouldn't become service names
    'tostring', 'touristring', 'to-uri-string', 'to-string',
    // Common path parameter names that shouldn't become service names
    'tcbsid', 'orderid', 'productcode', 'bondcode', 'assetid',
    'tradingid', 'mechanismtype', 'sectype', 'system',
  ]);
  // Reject expressions containing dots, parentheses, or other non-identifier chars
  if (/[.(){}<>+\-\s]/.test(varName)) return null;

  const lower = varName.toLowerCase();
  if (genericNames.has(lower)) return null;

  // Strip suffixes in specificity order (longest/most-specific first)
  const suffixes = [
    'ServiceUrl', 'ServiceURL', 'ServiceURI',
    '_SERVICE_URL', '_SERVICE_URI',
    '_URL', '_URI',
    'Service', 'Url', 'URL', 'Uri', 'URI',
  ];
  let base = varName;
  for (const suffix of suffixes) {
    if (base.endsWith(suffix)) {
      base = base.slice(0, -suffix.length);
      break;
    }
  }
  if (!base || base.length < 2) return null;

  // Also reject the base if it's a generic term after suffix stripping
  if (genericNames.has(base.toLowerCase())) return null;

  // SCREAMING_SNAKE_CASE → kebab-case
  if (/^[A-Z][A-Z0-9_]*$/.test(base)) {
    return base.toLowerCase().replace(/_/g, '-');
  }
  // camelCase/PascalCase → kebab-case
  return base.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * Derive a service name from a class name as a last-resort heuristic.
 * Strips common suffixes (ServiceImpl, Controller, etc.) and converts to kebab-case.
 * Returns null if the result is too short or too generic.
 */
function serviceNameFromClassName(className: string): string | null {
  const base = className.replace(
    /(ServiceImpl|Service|Controller|Component|Config(?:uration)?|Handler|Provider|Client|Repository|Impl)$/,
    ''
  );
  if (!base || base.length < 3) return null;
  return base.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

function extractServiceName(urlExpression: string): string {
  // Try to extract service name from variable like ${bondSettlementService}
  const varMatch = urlExpression.match(/\$\{?(\w+)Service\}?/);
  if (varMatch) {
    const name = varMatch[1];
    // Convert camelCase to kebab-case
    return name.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
  }
  // Try to extract from URL path
  const pathMatch = urlExpression.match(/:\/\/([^/:]+)/);
  if (pathMatch) {
    return pathMatch[1].replace(/\./g, '-');
  }
  return 'unknown-service';
}

/**
 * Parse a URL expression to extract service references and constants.
 *
 * Examples:
 * - "bondSettlementService.concat(HOLD_UNHOLD_USED_LIMIT_URI)"
 *   -> { serviceName: "bondSettlementService", variableRefs: ["HOLD_UNHOLD_USED_LIMIT_URI"], staticParts: [] }
 * - "${serviceUrl}/api/v1"
 *   -> { serviceName: null, variableRefs: ["serviceUrl"], staticParts: ["/api/v1"] }
 * - "http://api.example.com/v1" + path
 *   -> { serviceName: null, variableRefs: [], staticParts: ["http://api.example.com/v1"] }
 */

/**
 * Normalize a downstream API endpoint string by stripping the domain from full URLs
 * and extracting the service name from the first path segment.
 *
 * @param endpoint - The endpoint string in "METHOD path_or_url" format
 * @returns Object with method, serviceName (from URL path), and normalized endpoint
 */
export function normalizeEndpoint(endpoint: string): {
  method: string;
  serviceName: string | null;
  endpoint: string;
} {
  // Split "METHOD path_or_url"
  const spaceIdx = endpoint.indexOf(' ');
  if (spaceIdx === -1) return { method: '', serviceName: null, endpoint };

  const method = endpoint.slice(0, spaceIdx);
  const rawPath = endpoint.slice(spaceIdx + 1);

  // Not a URL or absolute path — could be a code expression or a relative path
  if (!rawPath.startsWith('http://') && !rawPath.startsWith('https://') && !rawPath.startsWith('/')) {
    // Code expressions contain operators, method calls, or variable patterns that are NOT paths
    const isCodeExpression = /^[a-zA-Z_$]/.test(rawPath) && (
      rawPath.includes(' + ') ||
      rawPath.includes('(') ||
      rawPath.includes(')')
    );
    // If it looks like a relative API path (not a code expression, contains /), normalize it
    if (!isCodeExpression && rawPath.includes('/')) {
      let normalized = rawPath.startsWith('/') ? rawPath : '/' + rawPath;
      // Strip trailing slash (except root path)
      if (normalized.length > 1 && normalized.endsWith('/')) {
        normalized = normalized.slice(0, -1);
      }
      const segments = normalized.split('/').filter(Boolean);
      const serviceName = segments[0] ?? null;
      return { method, serviceName, endpoint: `${method} ${normalized}` };
    }
    // Otherwise it's a code expression like "url" or "builder.toUriString()" — skip normalization
    return { method, serviceName: null, endpoint };
  }

  let cleanPath = rawPath;
  let urlServiceName: string | null = null;

  if (rawPath.startsWith('http://') || rawPath.startsWith('https://')) {
    try {
      const url = new URL(rawPath);
      // Include query params in the path
      const pathPart = url.pathname + url.search; // e.g., "/matching-engine/v1/orders" or "/api?key=val"
      // Decode URL-encoded path parameters ({id} → not %7Bid%7D)
      const decodedPath = decodeURIComponent(pathPart);

      // Mask internal IP addresses to [internal]
      const isInternalIp = /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname);

      if (url.pathname === '/' || url.pathname === '') {
        // Only domain, no meaningful path — use masked endpoint for internal IPs
        const displayEndpoint = isInternalIp ? `${method} [internal]` : `${method} ${rawPath}`;
        return { method, serviceName: isInternalIp ? '[internal]' : url.hostname, endpoint: displayEndpoint };
      }

      cleanPath = decodedPath;
      // First path segment = service name (skip path variable patterns)
      const segments = url.pathname.split('/').filter(Boolean);
      urlServiceName = isInternalIp ? '[internal]' : (segments.find(seg => !PATH_VAR_RE.test(seg)) ?? null);
    } catch {
      // Malformed URL — don't normalize
      return { method, serviceName: null, endpoint };
    }
  } else {
    // Relative path — first non-parameter segment is service name
    const segments = rawPath.split('/').filter(Boolean);
    urlServiceName = segments.find(seg => !PATH_VAR_RE.test(seg)) ?? null;
    // Ensure relative paths start with /
    if (!cleanPath.startsWith('/')) {
      cleanPath = '/' + cleanPath;
    }
  }

  // Reconstruct endpoint as "METHOD /path"
  return { method, serviceName: urlServiceName, endpoint: `${method} ${cleanPath}` };
}

/**
 * Parse a URL expression to extract service references and constants.
 *
 * Examples:
 * - "bondSettlementService.concat(HOLD_UNHOLD_USED_LIMIT_URI)"
 *   -> { serviceName: "bondSettlementService", variableRefs: ["HOLD_UNHOLD_USED_LIMIT_URI"], staticParts: [] }
 * - "${serviceUrl}/api/v1"
 *   -> { serviceName: null, variableRefs: ["serviceUrl"], staticParts: ["/api/v1"] }
 * - "http://api.example.com/v1" + path
 *   -> { serviceName: null, variableRefs: [], staticParts: ["http://api.example.com/v1"] }
 */
function parseUrlExpression(urlExpression: string): {
  serviceName: string | null;
  variableRefs: string[];
  staticParts: string[];
} {
  const result = {
    serviceName: null as string | null,
    variableRefs: [] as string[],
    staticParts: [] as string[],
  };

  // Pattern: xxxService or ${xxx}Service
  const serviceMatch = urlExpression.match(/(\$\{)?(\w+)Service\}?/);
  if (serviceMatch) {
    result.serviceName = serviceMatch[2]; // Just the base name without 'Service'
  }

  // Extract string literals (static parts)
  const stringMatches = urlExpression.matchAll(/"([^"]+)"|'([^']+)'/g);
  for (const match of stringMatches) {
    const str = match[1] || match[2];
    if (str) result.staticParts.push(str);
  }

  // Extract variable references (UPPER_CASE constants or camelCase variables)
  // Exclude keywords and the 'Service' suffix variable
  const keywords = new Set(['if', 'else', 'for', 'while', 'return', 'new', 'null', 'true', 'false']);
  const allRefs = urlExpression.match(/\b[A-Z_][A-Z0-9_]*\b|\b[a-z][a-zA-Z0-9]*\b/g) || [];
  for (const ref of allRefs) {
    if (!keywords.has(ref) && !ref.endsWith('Service') && !result.variableRefs.includes(ref)) {
      result.variableRefs.push(ref);
    }
  }

  return result;
}

/**
 * Resolve a static final field's value from a class.
 * Returns the literal value if the field is static final, null otherwise.
 */
async function resolveStaticFieldValue(
  executeQuery: (repoId: string, query: string, params: Record<string, any>) => Promise<any[]>,
  repoId: string,
  className: string,
  fieldName: string
): Promise<string | null> {
  const query = `
    MATCH (c:Class)
    WHERE c.name = $className OR c.name ENDS WITH $classNamePattern
    RETURN c.fields AS fields
    LIMIT 1
  `;

  try {
    const rows = await executeQuery(repoId, query, {
      className,
      classNamePattern: '.' + className
    });

    if (rows.length === 0) return null;

    const fieldsJson = rows[0].fields || rows[0][0];
    if (!fieldsJson) return null;

    const fields = JSON.parse(fieldsJson);
    const field = fields.find((f: any) => f.name === fieldName);

    // Check if it's static final and has a value
    if (field?.modifiers?.includes('static') && field?.modifiers?.includes('final')) {
      return field.value || null;
    }

    return null;
  } catch (e) {
    if (DEBUG) console.error('[GitNexus DEBUG] Static final field query failed:', e);
    return null;
  }
}

/**
 * Resolves static final field values, searching across all classes if not found in the enclosing class.
 * This handles cases like PROFILE_URL constants defined in a separate Constants class.
 * 
 * @param executeQuery - Graph query executor
 * @param repoId - Repository ID
 * @param enclosingClassName - Class name where the reference was found
 * @param fieldName - Field name to resolve (e.g., "PROFILE_URL")
 * @returns Field value and declaring class name if found
 */
async function resolveStaticFieldValueCrossClass(
  executeQuery: (repoId: string, query: string, params: Record<string, any>) => Promise<any[]>,
  repoId: string,
  enclosingClassName: string,
  fieldName: string
): Promise<{ value: string | null; declaringClass: string | null }> {
  // 1. Try same class first (existing behavior)
  const sameClassValue = await resolveStaticFieldValue(executeQuery, repoId, enclosingClassName, fieldName);
  if (sameClassValue) {
    return { value: sameClassValue, declaringClass: enclosingClassName };
  }

  // 2. Query for static final field with matching name across ALL classes
  const crossClassQuery = `
    MATCH (c:Class)
    WHERE c.fields CONTAINS $fieldName
    RETURN c.name AS className, c.fields AS fields
    LIMIT 5
  `;

  try {
    const rows = await executeQuery(repoId, crossClassQuery, { fieldName });
    if (rows.length === 0) {
      return { value: null, declaringClass: null };
    }

    const results: Array<{ className: string; value: string }> = [];

    for (const row of rows) {
      try {
        const fieldsJson = row.fields || row[1];
        if (!fieldsJson) continue;

        const fields = JSON.parse(fieldsJson) as FieldInfo[];
        const field = fields.find((f) =>
          f.name === fieldName &&
          f.modifiers?.includes('static') &&
          f.modifiers?.includes('final') &&
          f.value !== undefined
        );

        if (field) {
          results.push({ className: row.className || row[0], value: field.value });
        }
      } catch (e) {
        // Skip malformed JSON
        if (DEBUG) console.error('[GitNexus DEBUG] Failed to parse fields JSON:', e);
      }
    }

    if (results.length === 0) {
      return { value: null, declaringClass: null };
    }

    // Prefer fields with URL-like values
    const urlField = results.find((r) =>
      r.value?.startsWith('http') ||
      r.value?.includes('/api/') ||
      r.value?.includes('/v1/') ||
      r.value?.includes('/v2/')
    );

    if (urlField) {
      return { value: urlField.value, declaringClass: urlField.className };
    }

    // Fall back to first match
    return { value: results[0].value, declaringClass: results[0].className };
  } catch (e) {
    if (DEBUG) console.error('[GitNexus DEBUG] Cross-class static field query failed:', e);
    return { value: null, declaringClass: null };
  }
}

/**
 * Resolve @Value annotation attribute from a field.
 * Returns the property key like "service.url" from @Value("${service.url}").
 * Traverses the inheritance chain to find fields in parent classes.
 */
async function resolveValueAnnotation(
  executeQuery: (repoId: string, query: string, params: Record<string, any>) => Promise<any[]>,
  repoId: string,
  className: string,
  fieldName: string
): Promise<{ propertyKey: string | null; rawValue: string | null; declaringClass: string | null }> {
  // Track visited classes to avoid infinite loops in case of circular inheritance
  const visited = new Set<string>();

  async function findInClass(cls: string): Promise<{ propertyKey: string | null; rawValue: string | null; declaringClass: string | null }> {
    if (visited.has(cls)) return { propertyKey: null, rawValue: null, declaringClass: null };
    visited.add(cls);

    const query = `
      MATCH (c:Class)
      WHERE c.name = $className OR c.name ENDS WITH $classNamePattern
      RETURN c.fields AS fields, c.name AS className
      LIMIT 1
    `;

    try {
      const rows = await executeQuery(repoId, query, {
        className: cls,
        classNamePattern: '.' + cls
      });

      if (rows.length === 0) return { propertyKey: null, rawValue: null, declaringClass: null };

      const fieldsJson = rows[0].fields || rows[0][0];
      const actualClassName = rows[0].className || rows[0][1] || cls;
      if (!fieldsJson) {
        // No fields found, try parent class
        return findInParent(cls);
      }

      const fields = JSON.parse(fieldsJson);
      const field = fields.find((f: any) => f.name === fieldName);

      if (field?.annotationAttrs) {
        const valueAnn = field.annotationAttrs.find((a: any) => a.name === '@Value');
        if (valueAnn?.attrs) {
          // attrs could be { "0": "${service.url}" } or { "value": "${service.url}" }
          const rawValue = valueAnn.attrs['0'] || valueAnn.attrs['value'];
          if (rawValue) {
            // Extract property key from ${...}
            const match = rawValue.match(/\$\{([^}]+)\}/);
            return {
              propertyKey: match ? match[1] : rawValue,
              rawValue,
              declaringClass: actualClassName
            };
          }
        }
      }

      // Field not found in this class, try parent class
      return findInParent(cls);
    } catch (e) {
      if (DEBUG) console.error('[GitNexus DEBUG] @Value annotation resolution failed:', e);
      return { propertyKey: null, rawValue: null, declaringClass: null };
    }
  }

  async function findInParent(cls: string): Promise<{ propertyKey: string | null; rawValue: string | null; declaringClass: string | null }> {
    const parentQuery = `
      MATCH (child:Class)-[:CodeRelation {type: 'EXTENDS'}]->(parent:Class)
      WHERE child.name = $className
      RETURN parent.name AS parentName
      LIMIT 1
    `;

    try {
      const parentRows = await executeQuery(repoId, parentQuery, { className: cls });
      if (parentRows.length === 0) return { propertyKey: null, rawValue: null, declaringClass: null };

      const parentName = parentRows[0].parentName;
      if (!parentName) return { propertyKey: null, rawValue: null, declaringClass: null };

      return findInClass(parentName);
    } catch (e) {
      if (DEBUG) console.error('[GitNexus DEBUG] Parent class lookup failed:', e);
      return { propertyKey: null, rawValue: null, declaringClass: null };
    }
  }

  return findInClass(className);
}

/**
 * Cross-class @Value resolution: search ALL classes for a field with the given name
 * that has an @Value annotation. This catches cases where the handler class doesn't
 * have the @Value field directly (delegates to a service class).
 */
const crossClassValueCache = new Map<string, { propertyKey: string | null; rawValue: string | null; declaringClass: string | null }>();

async function resolveValueAnnotationCrossClass(
  executeQuery: (repoId: string, query: string, params: Record<string, any>) => Promise<any[]>,
  repoId: string,
  fieldName: string
): Promise<{ propertyKey: string | null; rawValue: string | null; declaringClass: string | null }> {
  if (crossClassValueCache.has(fieldName)) {
    return crossClassValueCache.get(fieldName)!;
  }

  // Use CONTAINS filter to find classes with the field name, then parse client-side
  const query = `
    MATCH (c:Class)
    WHERE c.fields IS NOT NULL AND c.fields CONTAINS $fieldName
    RETURN c.fields AS fields, c.name AS className
    LIMIT 50
  `;

  try {
    const rows = await executeQuery(repoId, query, { fieldName: `"name":"${fieldName}"` });
    for (const row of rows) {
      const fieldsJson = row.fields || row[0];
      if (!fieldsJson) continue;
      try {
        const fields = JSON.parse(fieldsJson);
        const field = fields.find((f: any) => f.name === fieldName);
        if (field?.annotationAttrs) {
          const valueAnn = field.annotationAttrs.find((a: any) => a.name === '@Value');
          if (valueAnn?.attrs) {
            const rawValue = valueAnn.attrs['0'] || valueAnn.attrs['value'];
            if (rawValue) {
              const match = rawValue.match(/\$\{([^}]+)\}/);
              const result = {
                propertyKey: match ? match[1] : rawValue,
                rawValue,
                declaringClass: row.className || row[1] || null,
              };
              crossClassValueCache.set(fieldName, result);
              return result;
            }
          }
        }
      } catch {}
    }
    crossClassValueCache.set(fieldName, { propertyKey: null, rawValue: null, declaringClass: null });
  } catch (e) {
    if (DEBUG) console.error('[GitNexus DEBUG] Cross-class @Value resolution failed:', e);
  }

  return { propertyKey: null, rawValue: null, declaringClass: null };
}

/**
 * Resolves the actual value of a property from Property nodes (application.properties/yml).
 * Queries the graph for Property nodes with matching key and returns the actual value.
 * 
 * @param executeQuery - Graph query executor
 * @param repoId - Repository ID
 * @param propertyKey - Property key to look up (e.g., "tcbs.bond.product.url")
 * @returns The actual property value from config files, or null if not found
 */
/**
 * Resolves the actual value of a property from Property nodes (application.properties/yml).
 * Queries the graph for Property nodes with matching key and returns the actual value.
 * 
 * Note: Property nodes store entire config file sections in content, so we need to parse
 * the content to extract individual property values.
 * 
 * @param executeQuery - Graph query executor
 * @param repoId - Repository ID
 * @param propertyKey - Property key to look up (e.g., "tcbs.bond.product.url")
 * @returns The actual property value from config files, or null if not found
 */
/**
 * Parse a property value from Property node content, which may be a single value
 * or a multi-line config block containing the propertyKey=value line.
 */
function parsePropertyValueFromContent(propertyKey: string, content: string): string | null {
  if (!content) return null;
  // Single-line value (no newlines, doesn't contain '=' meaning it's the raw value)
  if (!content.includes('\n') && (content.startsWith('http') || content.startsWith('/') || !content.includes('='))) {
    return content.trim();
  }
  // Multi-line: find the line starting with propertyKey=
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed.startsWith('!') || trimmed === '') continue;
    if (trimmed.startsWith(propertyKey + '=') || trimmed.startsWith(propertyKey + ':')) {
      const sepIdx = trimmed.indexOf('=') !== -1 ? trimmed.indexOf('=') : trimmed.indexOf(':');
      if (sepIdx > 0) {
        const value = trimmed.substring(sepIdx + 1).trim();
        if (value) return value;
      }
    }
  }
  return null;
}

async function resolvePropertyValue(
  executeQuery: (repoId: string, query: string, params: Record<string, any>) => Promise<any[]>,
  repoId: string,
  propertyKey: string
): Promise<{ value: string | null; filePath: string | null }> {
  // Query for Property nodes with matching key
  // Note: Property nodes don't have repoId - they use filePath for identification
  // Only query default profile (description IS NULL or empty) to avoid profile-specific values
  const query = `
    MATCH (p:Property)
    WHERE p.name = $propertyKey 
      AND (p.description IS NULL OR p.description = '')
    RETURN p.content AS content, p.filePath AS filePath
    LIMIT 5
  `;

  try {
    const rows = await executeQuery(repoId, query, {
      propertyKey,
    });

    if (rows.length === 0) {
      return { value: null, filePath: null };
    }

    // Property node content may contain entire config sections or just the value
    // Parse line by line to extract the specific property value
    for (const row of rows) {
      const content = row.content || '';
      
      // Check if content is just a single-line value (no newlines, starts with http or other URL patterns)
      if (!content.includes('\n') && (content.startsWith('http') || content.startsWith('/') || !content.includes('='))) {
        // Content is just the value directly
        return { value: content.trim(), filePath: row.filePath || null };
      }
      
      // Content contains multiple lines - parse to find the specific key
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        // Skip comments and empty lines
        if (trimmed.startsWith('#') || trimmed.startsWith('!') || trimmed === '') {
          continue;
        }
        // Check if line starts with propertyKey=
        if (trimmed.startsWith(propertyKey + '=') || trimmed.startsWith(propertyKey + ':')) {
          const separatorIndex = trimmed.indexOf('=') !== -1 ? trimmed.indexOf('=') : trimmed.indexOf(':');
          if (separatorIndex > 0) {
            const value = trimmed.substring(separatorIndex + 1).trim();
            if (value) {
              return { value, filePath: row.filePath || null };
            }
          }
        }
      }
    }

    return { value: null, filePath: null };
  } catch (e) {
    if (DEBUG) console.error('[GitNexus DEBUG] Property resolution failed:', e);
    return { value: null, filePath: null };
  }
}

/**
 * Parses ${key:default} syntax and extracts key and default value.
 * Returns { key, defaultValue } where defaultValue may be null if no default specified.
 */
function parsePropertyPlaceholder(placeholder: string): { key: string; defaultValue: string | null } {
  // Match ${key} or ${key:default}
  const match = placeholder.match(/^\$\{([^}:]+)(?::([^}]*))?\}$/);
  if (!match) {
    return { key: placeholder, defaultValue: null };
  }
  return {
    key: match[1],
    defaultValue: match[2] ?? null,
  };
}

/**
 * Tries variable name patterns to find @Value annotation for service URLs.
 * This handles cases where the variable name doesn't match the field name directly.
 * 
 * @param executeQuery - Graph query executor
 * @param repoId - Repository ID
 * @param className - Enclosing class name
 * @param variableName - Variable name from URL expression (e.g., "matchingUrl")
 * @returns Resolved property key, raw value, and field name if found
 */
async function traceVariableAssignment(
  executeQuery: (repoId: string, query: string, params: Record<string, any>) => Promise<any[]>,
  repoId: string,
  className: string,
  variableName: string,
  content?: string
): Promise<{ propertyKey: string | null; rawValue: string | null; fieldName: string | null }> {
  // Step 1: Try to resolve from local variable assignments if content is available
  if (content) {
    const assignments = extractLocalVariableAssignments(content);
    const expression = assignments.get(variableName);
    if (expression) {
      // Extract base field from expression like "matchingUrl + pathSuggestion"
      const baseField = extractBaseField(expression);
      if (baseField) {
        // Step 1a: Check if it's a static constant (UPPER_CASE pattern)
        if (/^[A-Z][A-Z0-9_]*$/.test(baseField)) {
          const staticResult = await resolveStaticFieldValueCrossClass(executeQuery, repoId, className, baseField);
          if (staticResult.value) {
            // Extract service name from URL if possible
            const serviceName = extractServiceName(staticResult.value);
            return {
              propertyKey: staticResult.value,
              rawValue: staticResult.value,
              fieldName: baseField,
            };
          }
        }
        
        // Step 1b: Try to resolve string concatenation like "baseUrl + path"
        if (!baseField) {
          const concatMatch = expression.match(/^["']([^"']+)["']\s*\+\s*(\w+)$/);
          if (concatMatch) {
            const literalPart = concatMatch[1];
            const varPart = concatMatch[2];
            const resolved = await resolveValueAnnotation(executeQuery, repoId, className, varPart);
            if (resolved.propertyKey) {
              return { propertyKey: literalPart + resolved.rawValue, rawValue: literalPart + resolved.rawValue, fieldName: varPart };
            }
            return { propertyKey: literalPart, rawValue: literalPart, fieldName: varPart };
          }
        }

        // Step 1c: Try @Value annotation resolution for regular fields
        const resolved = await resolveValueAnnotation(executeQuery, repoId, className, baseField);
        if (resolved.propertyKey) {
          return { propertyKey: resolved.propertyKey, rawValue: resolved.rawValue, fieldName: baseField };
        }
      }
    }
  }
  
  // Step 2: Fall back to heuristic patterns
  // Heuristic patterns to try in order of specificity:
  // 1. Exact match: matchingUrl → field named "matchingUrl"
  // 2. Strip suffix: matchingUrl → "matching" → field "matchingService"
  // 3. Add suffix: matchingUrl → "matchingUrlService" (less common)
  // 4. Strip "Url" suffix and add "Service": matchingUrl → "matching" → "matchingService"
  
  const patterns = [
    variableName,                              // matchingUrl
    variableName.replace(/Url$/i, ''),        // matchingUrl → matching
    variableName + 'Service',                  // matchingUrl → matchingUrlService
    variableName.replace(/Url$/i, '') + 'Service', // matchingUrl → matchingService
    variableName.replace(/Url$/i, 'ServiceUrl'), // matchingUrl → matchingServiceUrl
  ];

  // Remove duplicates
  const uniquePatterns = [...new Set(patterns)];

  for (const pattern of uniquePatterns) {
    const resolved = await resolveValueAnnotation(executeQuery, repoId, className, pattern);
    if (resolved.propertyKey) {
      return {
        propertyKey: resolved.propertyKey,
        rawValue: resolved.rawValue,
        fieldName: pattern,
      };
    }
  }

  return { propertyKey: null, rawValue: null, fieldName: null };
}

/**
 * Detect if URL expression is a builder.toUriString() pattern and resolve it.
 * Handles both:
 * 1. String url = builder.toUriString(); restTemplate.getForObject(url, ...)
 * 2. restTemplate.getForObject(builder.toUriString(), ...)
 */
/**
 * Detect if URL expression is a builder.toUriString() pattern and resolve it.
 * Handles both:
 * 1. String url = builder.toUriString(); restTemplate.getForObject(url, ...)
 * 2. restTemplate.getForObject(builder.toUriString(), ...)
 */
function resolveBuilderUrl(
  urlExpression: string,
  builderDetails: BuilderDetail[],
  content?: string
): { baseUrlExpression: string; builderVar: string } | null {
  if (!builderDetails || builderDetails.length === 0) {
    return null;
  }

  // Pattern 1: Direct builder.toUriString() in URL expression
  const directBuilderMatch = urlExpression.match(/^(\w+)\.toUriString\(\)$/);
  if (directBuilderMatch) {
    const builderVar = directBuilderMatch[1];
    const builder = builderDetails.find(b => b.builderVar === builderVar);
    if (builder) {
      return {
        baseUrlExpression: builder.baseUrlExpression,
        builderVar: builder.builderVar,
      };
    }
  }

  // Pattern 2: Variable assigned from builder.toUriString()
  // Look for: String url = builder.toUriString();
  if (content) {
    const toUriStringMatch = content.match(/(\w+)\s*=\s*(\w+)\.toUriString\s*\(\s*\)/);
    if (toUriStringMatch) {
      const variableName = toUriStringMatch[1];
      const builderVar = toUriStringMatch[2];
      
      // Check if the URL expression matches this variable
      if (urlExpression === variableName || urlExpression.includes(variableName)) {
        const builder = builderDetails.find(b => b.builderVar === builderVar);
        if (builder) {
          return {
            baseUrlExpression: builder.baseUrlExpression,
            builderVar: builder.builderVar,
          };
        }
      }
    }
  }

  // Pattern 3: Direct UriComponentsBuilder call in URL expression
  // e.g., UriComponentsBuilder.fromHttpUrl(baseUrl).path(segment)
  const directUriBuilderMatch = urlExpression.match(
    /UriComponentsBuilder\.(fromHttpUrl|fromUriString)\(([^)]+)\)/
  );
  if (directUriBuilderMatch) {
    return {
      baseUrlExpression: directUriBuilderMatch[2].trim(),
      builderVar: 'UriComponentsBuilder',
    };
  }

  // Pattern 4: UriComponentsBuilder with concatenation
  // e.g., UriComponentsBuilder.fromUriString(cashBridgeUrl + PATH_BOND_HOLD)
  const fromUriConcatMatch = urlExpression.match(
    /UriComponentsBuilder\.(fromHttpUrl|fromUriString)\((\w+)\s*\+/
  );
  if (fromUriConcatMatch) {
    return {
      baseUrlExpression: fromUriConcatMatch[2].trim(),
      builderVar: 'UriComponentsBuilder',
    };
  }

  // Pattern 5: Direct builder reference without .toUriString()
  // e.g., just "builder" when the builderDetails have the base URL
  if (/^[a-zA-Z]\w*$/.test(urlExpression)) {
    const builder = builderDetails.find(b => b.builderVar === urlExpression);
    if (builder) {
      return {
        baseUrlExpression: builder.baseUrlExpression,
        builderVar: builder.builderVar,
      };
    }
  }

  return null;
}

/**
 * Trace StringBuilder construction to find the base URL field.
 * Pattern: StringBuilder var = new StringBuilder(baseUrl + path);
 * Returns the base field name (e.g., "pricingServiceBaseUrl") if found.
 */
function traceStringBuilderConstruction(
  varName: string,
  content: string
): string | null {
  // Pattern: StringBuilder var = new StringBuilder(expr);
  // Also handles: StringBuilder var = new StringBuilder(); var.append(expr);
  const sbPattern = new RegExp(
    `StringBuilder\\s+${varName}\\s*=\\s*new\\s+StringBuilder\\s*\\(\\s*([^)]+)\\s*\\)`,
    'g'
  );
  
  let match;
  while ((match = sbPattern.exec(content)) !== null) {
    const constructorArg = match[1].trim();
    // The argument could be:
    // 1. A simple field: pricingServiceBaseUrl
    // 2. A concatenation: pricingServiceBaseUrl + PATH_CONSTANT
    // 3. A string literal: "http://..."
    
    // Remove trailing .toString() if present
    const cleanArg = constructorArg.replace(/\.toString\(\)$/, '');
    
    // Extract the base field from the expression
    const baseField = extractBaseField(cleanArg);
    if (baseField) {
      return baseField;
    }
    
    // If it's a complex expression, try to find the first identifier
    const identifierMatch = cleanArg.match(/^([a-zA-Z_][a-zA-Z0-9_]*)/);
    if (identifierMatch) {
      return identifierMatch[1];
    }
  }
  
  return null;
}

/**
 * Extracts local variable assignments from source content.
 * Parses patterns like: Type varName = expression;
 * @param content - Source code content
 * @returns Map of variable name to its assigned expression
 */
export function extractLocalVariableAssignments(content: string): Map<string, string> {
  const assignments = new Map<string, string>();
  
  // Pattern 1: Java style - Type varName = expression; (e.g., String url = matchingUrl + path;)
  // Pattern 2: TypeScript style - const/let/var varName[: Type] = expression; (e.g., const apiUrl: string = baseUrl + "/api";)
  const patterns = [
    /(?:\w+(?:<[^>]+>)?)\s+(\w+)\s*=\s*([^;]+);/g,           // Java: Type varName = expr;
    /(?:const|let|var)\s+(\w+)(?::\s*\w+(?:<[^>]+>)?)?\s*=\s*([^;]+);/g  // TS: const varName[: Type] = expr;
  ];
  
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const varName = match[1];
      const expression = match[2].trim();
      assignments.set(varName, expression);
    }
  }
  return assignments;
}

/**
 * Extracts the base field name from an expression.
 * E.g., "matchingUrl + pathSuggestion" → "matchingUrl"
 * E.g., "baseUrl + '/api'" → "baseUrl"
 * Returns null for method calls or non-field expressions.
 */
function extractBaseField(expression: string): string | null {
  // Split by concatenation operators
  const parts = expression.split(/\s*[+&|]\s*/);
  if (parts.length > 0) {
    const firstPart = parts[0].trim();
    // Return if it's a simple field reference (alphanumeric, may include underscores)
    // Accepts both lowercase fields (matchingUrl) and uppercase constants (PROFILE_URL)
    // Excludes method calls (contains parentheses) and string literals
    if (/^[a-zA-Z][a-zA-Z0-9_]*$/.test(firstPart) && !firstPart.includes('(')) {
      return firstPart;
    }
  }
  return null;
}

/**
 * Find the class that contains a method at a given file path.
 */
async function findEnclosingClass(
  executeQuery: (repoId: string, query: string, params: Record<string, any>) => Promise<any[]>,
  repoId: string,
  filePath: string
): Promise<string | null> {
  const query = `
    MATCH (c:Class)
    WHERE c.filePath = $filePath
    RETURN c.name AS name
    LIMIT 1
  `;

  try {
    const rows = await executeQuery(repoId, query, { filePath });
    if (rows.length === 0) return null;
    return rows[0].name || rows[0][0];
  } catch (e) {
    if (DEBUG) console.error('[GitNexus DEBUG] Enclosing class lookup failed:', e);
    return null;
  }
}

/**
 * Extract request and response body schemas from the handler method's parameters and return type.
 */
async function extractBodySchemas(
  chain: ChainNode[],
  executeQuery: (repoId: string, query: string, params: Record<string, any>) => Promise<any[]>,
  repoId: string,
  crossRepo?: CrossRepoContext,
  httpMethod?: string
): Promise<{ requestBody: BodySchema | null; responseBody: BodySchema | null; nestedSchemas: Map<string, BodySchema> }> {
  // Find handler node (depth 0)
  const handler = chain.find(n => n.depth === 0);
  if (!handler) {
    return { requestBody: null, responseBody: null, nestedSchemas: new Map() };
  }

  let requestBody: BodySchema | null = null;
  let responseBody: BodySchema | null = null;

  // Use separate visited sets for request and response body resolution
  // This allows the same type to be resolved for both request and response
  let requestVisited = new Set<string>();
  let responseVisited = new Set<string>();

  // Resolve @RequestBody parameter
  // First try primary handler's parameterAnnotations
  let bodyParamType: string | null = null;
  if (handler.parameterAnnotations) {
    try {
      const rawParams = JSON.parse(handler.parameterAnnotations);
      const params = transformParameterAnnotations(rawParams);
      const bodyParam = params.find((p: any) => p.annotations?.includes('@RequestBody'));
      if (bodyParam?.type) {
        bodyParamType = bodyParam.type;
      }
    } catch (e) {
      if (DEBUG) console.error('[GitNexus DEBUG] Request body resolution failed:', e);
      // Ignore parse errors
    }
  }

  // Fallback: Try overload variants for POST/PUT/PATCH when primary handler has no @RequestBody
  // This handles cases where the graph DB Method node for the non-@RequestBody overload
  // was returned but the actual handler has @RequestBody (e.g., same method name with different params)
  if (!bodyParamType && httpMethod && ['POST', 'PUT', 'PATCH'].includes(httpMethod.toUpperCase())) {
    const baseUid = handler.uid;
    for (let overloadIdx = 1; overloadIdx <= 10; overloadIdx++) {
      const overloadUid = `${baseUid}:${overloadIdx}`;
      try {
        const overloadResult = await executeQuery(repoId,
          `MATCH (m:Method {id: $uid}) RETURN m.parameterAnnotations AS paramAnns LIMIT 1`,
          { uid: overloadUid }
        );
        if (overloadResult && overloadResult.length > 0) {
          const overloadParamAnns = overloadResult[0].paramAnns ?? overloadResult[0][0];
          if (typeof overloadParamAnns === 'string' && overloadParamAnns) {
            try {
              const parsed = JSON.parse(overloadParamAnns);
              const params = transformParameterAnnotations(parsed);
              const bodyParam = params.find((p: any) => p.annotations?.includes('@RequestBody'));
              if (bodyParam?.type) {
                bodyParamType = bodyParam.type;
                if (DEBUG) console.error(`[GitNexus DEBUG] Found @RequestBody in overload variant ${overloadUid}`);
                break;
              }
            } catch { /* ignore parse errors */ }
          }
        }
      } catch (e) {
        if (DEBUG) console.error(`[GitNexus DEBUG] Overload variant query failed for ${overloadUid}:`, e);
      }
    }
  }

  // Resolve the body type if found
  if (bodyParamType) {
    requestBody = await resolveTypeSchema(bodyParamType, executeQuery, repoId, requestVisited, crossRepo);
  }

  // Resolve return type
  if (handler.returnType) {
    let returnType = handler.returnType;

    // Unwrap wrapper types like ResponseEntity<XXX>
    const wrapperMatch = returnType.match(/^(ResponseEntity|Result|Optional|Mono|Flux)<(.+)>$/);
    if (wrapperMatch) {
      returnType = wrapperMatch[2];
    }

    responseBody = await resolveTypeSchema(returnType, executeQuery, repoId, responseVisited, crossRepo);
  }

  // Resolve all nested types for both request and response bodies
  const nestedSchemas = new Map<string, BodySchema>();
  
  // Use shared visited set for nested types to avoid redundant resolution
  const allVisited = new Set<string>();
  
  // Resolve nested types from request body
  if (requestBody) {
    const requestNested = await resolveAllNestedTypes(requestBody, executeQuery, repoId, allVisited, crossRepo);
    for (const [typeName, schema] of requestNested) {
      nestedSchemas.set(typeName, schema);
    }
  }
  
  // Resolve nested types from response body
  if (responseBody) {
    const responseNested = await resolveAllNestedTypes(responseBody, executeQuery, repoId, allVisited, crossRepo);
    for (const [typeName, schema] of responseNested) {
      nestedSchemas.set(typeName, schema);
    }
  }

  return { requestBody, responseBody, nestedSchemas };
}

/**
 * Resolve a type name to its field schema.
 */
async function resolveTypeSchema(
  typeName: string,
  executeQuery: (repoId: string, query: string, params: Record<string, any>) => Promise<any[]>,
  repoId: string,
  visited: Set<string> = new Set(),
  crossRepo?: CrossRepoContext
): Promise<BodySchema> {
  // Check for primitive and container types
  if (shouldSkipSchema(typeName)) {
    return { typeName, source: 'primitive', fields: undefined };
  }

  // Prevent circular references
  if (visited.has(typeName)) {
    return { typeName, source: 'external', fields: undefined };
  }
  visited.add(typeName);

  // Extract generic inner type if applicable
  const innerType = extractGenericInnerType(typeName);
  if (innerType) {
    const baseType = typeName.split('<')[0].trim();

    // Known collection/container types: resolve inner type only, mark as container
    const COLLECTION_TYPES = new Set([
      'List', 'ArrayList', 'LinkedList', 'Vector', 'Stack',
      'Set', 'HashSet', 'TreeSet', 'LinkedHashSet',
      'Collection', 'Iterable',
      'Map', 'HashMap', 'TreeMap', 'LinkedHashMap', 'SortedMap',
      'Optional', 'Mono', 'Flux',
      'Stream',
    ]);

    if (COLLECTION_TYPES.has(baseType)) {
      const innerSchema = await resolveTypeSchema(innerType, executeQuery, repoId, visited, crossRepo);
      // Preserve the original generic type name (e.g., 'Map<String, Object>')
      // so the OpenAPI converter can distinguish Map from List.
      // (#39) The outer source must reflect "container" — not inherit
      // the inner type's source. `Map<String, Object>` was being
      // reported as `source: 'primitive'` because the inner Object is
      // in SKIP_SCHEMA_TYPES, and we used to spread `innerSchema`
      // verbatim, so the inner's `source: 'primitive'` clobbered the
      // outer container status. A Map is not a primitive — it's a
      // key-value container that wraps whatever the inner type is.
      return {
        ...innerSchema,
        typeName,
        isContainer: true,
        source: 'container',
      };
    }

    // Generic DTOs (e.g., PageDataDto<TransactionViewDto>): resolve the outer type
    // as a class and substitute generic type parameters in fields
    // Fall through to the class query below, which will resolve fields
    // and handle the generic type parameter substitution
  }

  // For generic types (e.g., PageDataDto<?>), extract the base type name for class lookup
  // and record generic parameters for field type substitution
  const baseTypeName = typeName.includes('<') ? typeName.split('<')[0].trim() : typeName;
  let genericParams: Map<string, string> | undefined;
  if (typeName.includes('<') && innerType) {
    // Parse type arguments from the generic type
    const angleStart = typeName.indexOf('<');
    const angleEnd = typeName.lastIndexOf('>');
    if (angleStart !== -1 && angleEnd !== -1) {
      const argsStr = typeName.slice(angleStart + 1, angleEnd);
      // Split on commas at depth 0 to get all type arguments
      const typeArgs: string[] = [];
      let depth = 0;
      let segStart = 0;
      for (let i = 0; i < argsStr.length; i++) {
        if (argsStr[i] === '<') depth++;
        else if (argsStr[i] === '>') depth--;
        else if (argsStr[i] === ',' && depth === 0) {
          typeArgs.push(argsStr.slice(segStart, i).trim());
          segStart = i + 1;
        }
      }
      typeArgs.push(argsStr.slice(segStart).trim());
      // Map generic parameter names to actual type arguments.
      // Convention: 1-arg → T→arg; 2-args → K→arg0, V→arg1; 3+ → T0→arg0, T1→arg1, …
      genericParams = new Map();
      const normalizeArg = (arg: string) => (arg === '?' || arg === '*') ? 'Object' : arg;
      if (typeArgs.length === 1) {
        genericParams.set('T', normalizeArg(typeArgs[0]));
      } else if (typeArgs.length === 2) {
        // Map<K, V> convention
        genericParams.set('K', normalizeArg(typeArgs[0]));
        genericParams.set('V', normalizeArg(typeArgs[1]));
        // Also map T for classes that use T for the value type (e.g., ResponseEntity<T>)
        genericParams.set('T', normalizeArg(typeArgs[1]));
      } else {
        // Positional: T0, T1, T2, …
        for (let i = 0; i < typeArgs.length; i++) {
          genericParams.set(`T${i}`, normalizeArg(typeArgs[i]));
        }
        // Also map T to first arg as fallback
        genericParams.set('T', normalizeArg(typeArgs[0]));
      }
    }
  }

  // Query for class fields — use base type name (without generics) for lookup
  const lookupName = baseTypeName;

  // Handle inner class syntax: OuterClass.InnerClass → search by inner class name, scoped to parent
  const isInnerClass = lookupName.includes('.') && !lookupName.startsWith('java');
  const innerClassName = isInnerClass ? lookupName.split('.').pop()! : lookupName;
  const parentClassName = isInnerClass ? lookupName.slice(0, lookupName.lastIndexOf('.')) : undefined;

  const query = isInnerClass
    ? `MATCH (c:Class) WHERE c.name = $innerName AND c.id CONTAINS $parentFile RETURN c.name AS name, c.fields AS fields LIMIT 1`
    : `MATCH (c:Class) WHERE c.name = $typeName OR c.name ENDS WITH $typePattern RETURN c.name AS name, c.fields AS fields LIMIT 1`;

  /**
   * Substitute generic type parameters in field types.
   * E.g., List<T> → List<TransactionViewDto> when T→TransactionViewDto
   */
  function substituteGenerics(fieldType: string, params: Map<string, string>): string {
    if (!params || params.size === 0) return fieldType;
    let result = fieldType;
    for (const [param, replacement] of params) {
      // Replace standalone generic param (e.g., T in "List<T>" or just "T")
      // Match T when it's a word boundary (not part of another identifier)
      result = result.replace(new RegExp(`\\b${param}\\b`, 'g'), replacement);
    }
    return result;
  }

  try {
    const queryParams = isInnerClass
      ? { innerName: innerClassName, parentFile: parentClassName + '.java' }
      : { typeName: lookupName, typePattern: '.' + lookupName };
    const rows = await executeQuery(repoId, query, queryParams);

    if (!rows || rows.length === 0) {
      // Try cross-repo resolution if type not found locally
      if (crossRepo) {
        // For inner classes, use parent class name for package prefix lookup
        const packagePrefix = extractPackagePrefix(isInnerClass ? parentClassName! : lookupName);

        if (DEBUG) {
          console.error(`[GitNexus DEBUG] resolveTypeSchema: typeName=${typeName}, packagePrefix=${packagePrefix || 'none'}`);
        }

        // Determine which repos to search
        let depRepoIds: string[] = [];

        if (packagePrefix) {
          // Try to find the specific repo by package prefix
          const depRepoId = await crossRepo.findDepRepo(packagePrefix);
          if (DEBUG) {
            console.error(`[GitNexus DEBUG] findDepRepo(${packagePrefix}) -> ${depRepoId || 'null'}`);
          }
          if (depRepoId && depRepoId !== repoId) {
            depRepoIds = [depRepoId];
          } else {
            // FALLBACK: Package prefix not found in registry, search all dependency repos
            // This handles cases where fully qualified names aren't mapped but simple names work
            depRepoIds = await crossRepo.listDepRepos();
            if (DEBUG) {
              console.error(`[GitNexus DEBUG] listDepRepos() fallback -> [${depRepoIds.join(', ')}]`);
            }
          }
        } else {
          // For simple class names, search all dependency repos
          depRepoIds = await crossRepo.listDepRepos();
          if (DEBUG) {
            console.error(`[GitNexus DEBUG] listDepRepos() (no packagePrefix) -> [${depRepoIds.join(', ')}]`);
          }
        }
        
        if (depRepoIds.length > 0) {
          if (DEBUG) {
            console.error(`[GitNexus DEBUG] Querying repos: [${depRepoIds.join(', ')}] for type: ${typeName}`);
          }

          const depResults = await crossRepo.queryMultipleRepos(
            depRepoIds,
            query,
            isInnerClass
              ? { innerName: innerClassName, parentFile: parentClassName! + '.java' }
              : { typeName: lookupName, typePattern: '.' + lookupName }
          );

          if (DEBUG) {
            for (const r of depResults) {
              console.error(`[GitNexus DEBUG] Result from ${r.repoId}: ${r.results?.length || 0} rows, error=${(r as any)._error || 'none'}`);
            }
          }

          // Find first result that matches
          for (const result of depResults) {
            if (result.results?.length > 0) {
              const found = result.results[0] as { name: string; fields: string };
              const fieldsJson = found.fields;
              if (fieldsJson) {
                try {
                  // WI-2: Filter out serialVersionUID from fields
                  const fields = JSON.parse(fieldsJson);
                  const filteredFields = fields.filter((f: any) => f.name !== 'serialVersionUID');
                  return {
                    typeName: typeName, // Keep original generic type name (e.g., PageDataDto<?>)
                    source: 'indexed',
                    fields: filteredFields.map((f: any) => ({
                      name: f.name,
                      type: genericParams ? substituteGenerics(f.type, genericParams) : f.type,
                      annotations: f.annotations || []
                    })),
                    repoId: result.repoId
                  };
                } catch (e) {
                  if (DEBUG) console.error('[GitNexus DEBUG] Indexed type field parse error:', e);
                  // Continue to next result
                }
              }
              return { typeName: found.name || typeName, source: 'indexed', fields: undefined, repoId: result.repoId };
            }
          }
        }
      }
      return { typeName, source: 'external', fields: undefined };
    }

    const fieldsJson = rows[0].fields || rows[0][1];
    if (!fieldsJson) {
      return { typeName, source: 'indexed', fields: undefined };
    }

    // WI-2: Filter out serialVersionUID from fields
    const fields = JSON.parse(fieldsJson);
    const filteredFields = fields.filter((f: any) => f.name !== 'serialVersionUID');
    return {
      typeName: typeName, // Keep original generic type name (e.g., PageDataDto<?>)
      source: 'indexed',
      fields: filteredFields.map((f: any) => ({
        name: f.name,
        type: genericParams ? substituteGenerics(f.type, genericParams) : f.type,
        annotations: f.annotations || []
      }))
    };
  } catch (e) {
    if (DEBUG) console.error('[GitNexus DEBUG] Type schema resolution failed:', e);
    return { typeName, source: 'external', fields: undefined };
  }
}

/**
 * Recursively resolves all nested types using BFS traversal.
 * Returns a Map of typeName → BodySchema for all resolved nested types.
 */
async function resolveAllNestedTypes(
  rootSchema: BodySchema | null,
  executeQuery: (repoId: string, query: string, params: Record<string, any>) => Promise<any[]>,
  repoId: string,
  visited: Set<string>,
  crossRepo?: CrossRepoContext,
  options?: { maxDepth?: number; maxTypes?: number }
): Promise<Map<string, BodySchema>> {
  const nestedSchemas = new Map<string, BodySchema>();
  
  // Skip if no root schema or if it's not indexed
  if (!rootSchema || rootSchema.source !== 'indexed' || !rootSchema.fields) {
    return nestedSchemas;
  }

  const maxDepth = options?.maxDepth ?? NESTED_TYPE_MAX_DEPTH;
  const maxTypes = options?.maxTypes ?? NESTED_TYPE_MAX_COUNT;

  // BFS queue: { typeName, depth }
  const queue: Array<{ typeName: string; depth: number }> = [];
  
  // Initialize queue with field types from root schema
  for (const field of rootSchema.fields) {
    if (!shouldSkipSchema(field.type)) {
      queue.push({ typeName: field.type, depth: 1 });
    }
  }

  while (queue.length > 0 && nestedSchemas.size < maxTypes) {
    const { typeName, depth } = queue.shift()!;
    
    // Skip if already visited (cycle detection)
    if (visited.has(typeName)) {
      continue;
    }
    
    // Skip if depth exceeded
    if (depth > maxDepth) {
      continue;
    }
    
    // Skip primitives
    if (shouldSkipSchema(typeName)) {
      continue;
    }
    
    // Extract generic inner type if applicable (List<X>, Optional<X>, X[])
    const innerType = extractGenericInnerType(typeName);
    if (innerType) {
      if (!shouldSkipSchema(innerType) && !visited.has(innerType)) {
        queue.push({ typeName: innerType, depth: depth + 1 });
      }
      continue;
    }
    
    // Resolve the type schema first (pass a copy of visited set without current type)
    const schema = await resolveTypeSchema(typeName, executeQuery, repoId, new Set(visited), crossRepo);
    
    // Mark as visited after resolution (prevents cycles in BFS, not in the resolution itself)
    visited.add(typeName);
    
    // If indexed and has fields, add to nested schemas
    if (schema.source === 'indexed' && schema.fields && schema.fields.length > 0) {
      nestedSchemas.set(typeName, schema);
      // Queue field types for further resolution
      for (const field of schema.fields) {
        if (!shouldSkipSchema(field.type) && !visited.has(field.type)) {
          queue.push({ typeName: field.type, depth: depth + 1 });
        }
      }
    }
  }

  return nestedSchemas;
}

/**
 * Recursively embeds nested schemas into field objects for with-context mode.
 * Transforms:
 *   { name: "data", type: "FooDto" }
 * Into:
 *   { name: "data", type: "FooDto", fields: [...], source: "indexed" }
 */
function embedNestedSchemas(
  schema: BodySchema | null,
  nestedSchemas: Map<string, BodySchema>,
  visited: Set<string> = new Set()
): BodySchema | null {
  // Handle null schema (no body)
  if (!schema) {
    return null;
  }

  // No fields to embed
  if (!schema.fields) {
    return schema;
  }

  // Prevent circular references — emit a $ref marker for recursive types
  if (visited.has(schema.typeName)) {
    return { ...schema, fields: schema.fields, _recursiveRef: schema.typeName };
  }

  const newVisited = new Set(visited);
  newVisited.add(schema.typeName);

  const expandedFields = schema.fields.map(field => {
    // Extract inner type for generics/arrays
    const innerType = extractGenericInnerType(field.type);
    const fieldType = innerType || field.type;

    // Skip primitives and already-visited types
    if (shouldSkipSchema(fieldType)) {
      return field;
    }

    // Look up the nested schema
    const nestedSchema = nestedSchemas.get(fieldType);
    if (!nestedSchema) {
      return field;
    }

    // Recursively embed
    const embedded = embedNestedSchemas(nestedSchema, nestedSchemas, newVisited);

    // Return field with embedded nested data
    return {
      ...field,
      fields: embedded.fields,
      source: embedded.source,
      ...(embedded.isContainer !== undefined && { isContainer: embedded.isContainer }),
      ...(embedded.repoId && { repoId: embedded.repoId })
    };
  });

  return {
    ...schema,
    fields: expandedFields
  };
}

/**
 * Transform stored parameterAnnotations format to the expected format.
 *
 * Stored format (from ingestion):
 *   [{"name":"PathVariable","argument":"productCode","parameterName":"productCode","parameterType":"String"}]
 *
 * Expected format (for extractRequestParams):
 *   [{"name":"productCode","type":"String","annotations":["@PathVariable(\"productCode\")"]}]
 */
function transformParameterAnnotations(
  stored: Array<{
    name?: string;
    argument?: string;
    parameterName?: string;
    parameterType?: string;
    type?: string;
    annotations?: string[];
  }>
): Array<{ name: string; type: string; annotations: string[] }> {
  return stored.map(p => {
    // Check if already in expected format (has annotations array)
    if (p.annotations && Array.isArray(p.annotations)) {
      // Normalize annotations to include @ prefix
      const normalizedAnnotations = p.annotations.map(a =>
        a.startsWith('@') ? a : `@${a}`
      );
      return {
        name: p.name || p.parameterName || '',
        type: p.type || p.parameterType || '',
        annotations: normalizedAnnotations
      };
    }

    // Transform from stored format
    const annotationName = p.name || '';
    const annotationArg = p.argument || '';
    const paramName = p.parameterName || '';
    const paramType = p.parameterType || '';

    // Build annotation string: @AnnotationName("argument") or @AnnotationName
    const annotationStr = annotationArg
      ? `@${annotationName}("${annotationArg}")`
      : `@${annotationName}`;

    return {
      name: paramName,
      type: paramType,
      annotations: [annotationStr]
    };
  });
}

/**
 * Extract request parameters from a handler method.
 * Filters for @PathVariable, @RequestParam, @RequestHeader, @CookieValue annotations.
 * Skips @RequestBody parameters (handled by body schema) and framework-injected types.
 */
function extractRequestParams(
  handler: ChainNode,
  includeContext: boolean
): ParamInfo[] {
  // No parameterAnnotations JSON available
  if (!handler.parameterAnnotations) {
    return [];
  }

  // Parse parameterAnnotations JSON
  let rawParams: RawParamAnnotation[];
  try {
    rawParams = JSON.parse(handler.parameterAnnotations);
  } catch (e) {
    if (DEBUG) console.error('[GitNexus DEBUG] Parameter annotations parse failed:', e);
    return [];
  }

  // Transform from stored format to expected format
  const params = transformParameterAnnotations(rawParams);

  const result: ParamInfo[] = [];

  for (const param of params) {
    // Skip framework-injected types
    if (FRAMEWORK_INJECTED_TYPES.has(param.type)) {
      continue;
    }

    // Skip if no annotations
    if (!param.annotations || param.annotations.length === 0) {
      continue;
    }

    // Find the relevant annotation
    const annotation = param.annotations.find((ann: string) =>
      [...REQUEST_PARAM_ANNOTATIONS].some(t => ann.startsWith(t))
    );

    if (!annotation) {
      continue;
    }

    // Skip @RequestBody parameters (handled by body schema)
    if (param.annotations.includes('@RequestBody')) {
      continue;
    }

    // Determine the annotation type
    const annType = [...REQUEST_PARAM_ANNOTATIONS].find(t => annotation.startsWith(t))!;

    // Determine required flag
    let required = true; // Default is true for all

    if (annType === '@PathVariable') {
      // @PathVariable is always required
      required = true;
    } else {
      // @RequestParam, @RequestHeader, @CookieValue - check required attribute
      // Parse annotation to check for required=false
      const requiredMatch = annotation.match(/required\s*=\s*(true|false)/i);
      if (requiredMatch) {
        required = requiredMatch[1].toLowerCase() === 'true';
      }
    }

    // Determine parameter location
    const ANNOTATION_TO_LOCATION: Record<string, 'path' | 'query' | 'header' | 'cookie'> = {
      '@PathVariable': 'path',
      '@RequestParam': 'query',
      '@RequestHeader': 'header',
      '@CookieValue': 'cookie',
    };
    const location = ANNOTATION_TO_LOCATION[annType] ?? 'query';

    // For binding annotations with an explicit argument (e.g., @PathVariable("bondProductCode")),
    // Spring uses the argument to bind to the path/query variable — not the Java parameter name.
    // Use the annotation argument when present, falling back to the Java parameter name.
    // This matches Spring's resolution: @PathVariable("x") takes "x"; @PathVariable alone defaults to param name.
    const annArgMatch = annotation.match(/@(PathVariable|RequestParam|RequestHeader|CookieValue|RequestBody)\("([^"]+)"\)/);
    const paramName = annArgMatch ? annArgMatch[2] : param.name;

    // Build the ParamInfo
    const paramInfo: ParamInfo = {
      name: paramName,
      type: param.type,
      required,
      location,
      description: '',
    };

    // Add _context if includeContext is true
    if (includeContext && handler.filePath && handler.startLine) {
      paramInfo._context = `// ${handler.filePath}:${handler.startLine}\n${annotation}`;
    }

    result.push(paramInfo);
  }

  return result;
}

/**
 * Format a validation annotation to a human-readable rule string.
 * E.g., "@Size(min=1, max=100)" → "Size: min=1, max=100"
 */
function formatValidationRule(annotation: string): string {
  // Remove @ prefix
  const withoutAt = annotation.startsWith('@') ? annotation.slice(1) : annotation;

  // Extract annotation name and value
  const match = withoutAt.match(/^(\w+)(?:\((.+)\))?$/);
  if (!match) return withoutAt;

  const name = match[1];
  const value = match[2];

  if (!value) {
    // No value, just return the name (e.g., "@NotNull" → "NotNull")
    return name;
  }

  // Format based on annotation type
  if (name === 'Size') {
    return `Size: ${value}`;
  }
  if (name === 'Min' || name === 'Max') {
    return `${name}: ${value}`;
  }
  if (name === 'Pattern') {
    // Extract regexp value
    const regexpMatch = value.match(/regexp\s*=\s*"([^"]+)"/);
    if (regexpMatch) {
      return `Pattern: ${regexpMatch[1]}`;
    }
    return `Pattern: ${value}`;
  }

  // Default: return name with value
  return `${name}: ${value}`;
}

/**
 * Extract ValidationRule from a list of annotations.
 * Returns empty array if no validation annotations found.
 */
function extractValidationFromAnnotations(
  annotations: string[],
  fieldName: string,
  fieldType: string,
  includeContext: boolean,
  filePath?: string,
  startLine?: number
): ValidationRule[] {
  // Filter validation annotations
  const validationAnns = annotations.filter((ann: string) => {
    const name = ann.startsWith('@') ? ann.slice(1) : ann;
    const baseName = name.split('(')[0];
    return VALIDATION_ANNOTATIONS.has(`@${baseName}`);
  });

  if (validationAnns.length === 0) {
    return [];
  }

  // Determine if required
  const required = validationAnns.some((ann: string) => {
    const baseName = ann.split('(')[0];
    return REQUIRED_ANNOTATIONS.has(baseName);
  });

  // Format rules
  const formattedRules = validationAnns
    .map(formatValidationRule)
    .join(', ');

  const rule: ValidationRule = {
    field: fieldName,
    type: fieldType,
    required,
    rules: formattedRules,
  };

  // Add _context if includeContext is true (as array for grouping)
  if (includeContext && filePath && startLine) {
    const annText = validationAnns.join(' ');
    rule._context = [`// ${filePath}:${startLine}\n${annText}`];
  }

  return [rule];
}

/**
 * Find fields from Class nodes in the chain for a given type.
 */
function findFieldsInChain(
  chain: ChainNode[],
  typeName: string
): Array<{ name: string; type: string; annotations: string[] }> | null {
  // Find Class node matching the type name
  const classNode = chain.find(n => n.name === typeName && n.kind === 'Class');
  if (!classNode || !classNode.fields) {
    return null;
  }

  try {
    return JSON.parse(classNode.fields);
  } catch (e) {
    if (DEBUG) console.error('[GitNexus DEBUG] Class fields parse failed:', e);
    return null;
  }
}

/**
 * Split arguments string by comma, respecting nested parentheses and strings.
 */
function splitArguments(argsStr: string): string[] {
  const args: string[] = [];
  let current = '';
  let depth = 0;
  let inString = false;
  let stringChar = '';

  for (let i = 0; i < argsStr.length; i++) {
    const char = argsStr[i];

    if (inString) {
      current += char;
      if (char === stringChar && argsStr[i - 1] !== '\\') {
        inString = false;
      }
    } else if (char === '"' || char === "'") {
      inString = true;
      stringChar = char;
      current += char;
    } else if (char === '(') {
      depth++;
      current += char;
    } else if (char === ')') {
      depth--;
      current += char;
    } else if (char === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  if (current.trim()) {
    args.push(current.trim());
  }

  return args;
}

/**
 * Check if an argument is a complex expression (method calls, operators, etc.)
 */
function isComplexExpression(arg: string): boolean {
  // Skip if it contains method calls with arguments (e.g., "obj.getMethod()")
  if (/\.\w+\([^)]*\)/.test(arg)) return true;

  // Skip if it contains operators (e.g., "a + b", "a * b")
  if (/[+\-*\/]/.test(arg) && !arg.startsWith('-')) return true;

  // Skip if it contains nested method calls
  if (/\w+\([^)]*\([^)]*\)/.test(arg)) return true;

  // Skip if it's a lambda or anonymous class
  if (/->\s*|new\s+\w+\s*\(/.test(arg)) return true;

  // Skip if it's a ternary expression
  if (arg.includes("?") && arg.includes(":")) return true;

  return false;
}

/**
 * Extract a field name from an argument.
 * Handles: simple names, getter calls, type+name patterns.
 * Skips: null, primitive types, literals, and complex expressions.
 */
function extractFieldName(
  arg: string,
  params: Array<{ name: string; type: string; annotations?: string[] }>,
  requestBody: BodySchema | null
): string {
  // Skip null and empty
  if (arg === 'null' || arg === '') {
    return TODO_AI_ENRICH;
  }

  // Skip literal values
  if (arg === 'true' || arg === 'false') {
    return TODO_AI_ENRICH;
  }

  // Skip primitive types and common Java keywords
  const primitives = ['String', 'Integer', 'Double', 'Float', 'Long', 'Boolean', 'Date', 'Object', 'void', 'boolean', 'int', 'long', 'double'];
  if (primitives.includes(arg)) {
    return TODO_AI_ENRICH;
  }

  // Skip DTO type names (PascalCase types like CaptchaReqDto, not camelCase like savingMarketDto)
  if (/^[A-Z]\w*(Dto|Request|Response|Entity|Model)$/.test(arg)) {
    return TODO_AI_ENRICH;
  }

  // Handle "Type name" pattern (e.g., "SavingTradingDto dto")
  const typeAndName = arg.match(/^(\w+(?:<[^>]+>)?)\s+(\w+)$/);
  if (typeAndName) {
    const typeName = typeAndName[1];
    const varName = typeAndName[2];

    // Check if this type matches the request body
    if (requestBody?.typeName && typeName === requestBody.typeName) {
      return 'body';
    }

    // Check if this matches a handler parameter
    const param = params.find(p => p.name === varName);
    if (param) {
      return varName;
    }

    // Variable not in handler params - return type name instead
    // When a type is explicitly specified (e.g., "TcbsJWT jwt"), use the type
    return typeName;
  }

  // Handle getter calls (e.g., "dto.getTradingDate()")
  const getterMatch = arg.match(/^(\w+)\.get(\w+)\(\)$/);
  if (getterMatch) {
    const varName = getterMatch[1];
    const fieldName = getterMatch[2].charAt(0).toLowerCase() + getterMatch[2].slice(1);

    // Check if this variable is a handler parameter
    const param = params.find(p => p.name === varName);
    if (param) {
      return `${varName}.${fieldName}`;
    }

    return fieldName;
  }

  // Handle simple variable names
  if (/^\w+$/.test(arg)) {
    // Skip primitives again
    if (primitives.includes(arg)) {
      return TODO_AI_ENRICH;
    }

    // Check if it's a handler parameter
    const param = params.find(p => p.name === arg);
    if (param) {
      return arg;
    }

    // Could be a type name if it starts with uppercase
    if (arg[0] === arg[0].toUpperCase()) {
      return arg;
    }

    return arg;
  }

  // Handle qualified type names with dots (e.g., com.example.OrderDTO) — preserve as-is
  if (/^[a-zA-Z][\w.]*(?:\.[A-Z])\w*$/.test(arg)) {
    return arg;
  }

  // For anything else, return TODO_AI_ENRICH
  return TODO_AI_ENRICH;
}

/**
 * Extract validation rules from handler parameters and body schema fields.
 */
function extractValidationRules(
  handler: ChainNode,
  requestBody: BodySchema | null,
  chain: ChainNode[],
  includeContext: boolean
): ValidationRule[] {
  const rules: ValidationRule[] = [];

  // Parse parameterAnnotations JSON
  let rawParams: RawParamAnnotation[] = [];
  if (handler.parameterAnnotations) {
    try {
      rawParams = JSON.parse(handler.parameterAnnotations);
    } catch (e) {
      if (DEBUG) console.error('[GitNexus DEBUG] Validation parameter annotations parse failed:', e);
    }
  }

  // Transform from stored format to expected format
  const params = transformParameterAnnotations(rawParams);

    for (const param of params) {
    if (!param.annotations || param.annotations.length === 0) {
      continue;
    }

    // Extract validation rules using helper
    const paramRules = extractValidationFromAnnotations(
      param.annotations,
      param.name,
      param.type,
      includeContext,
      handler.filePath,
      handler.startLine
    );
    rules.push(...paramRules);
  }

  // Part 1b: @RequestParam(required=true) as validation rule
  for (const param of params) {
    if (!param.annotations || param.annotations.length === 0) continue;

    const requestParamAnn = param.annotations.find((a: string) => a.startsWith('@RequestParam'));
    if (!requestParamAnn) continue;

    // Default for @RequestParam is required=true unless explicitly set to false
    const requiredMatch = requestParamAnn.match(/required\s*=\s*(true|false)/i);
    const isRequired = !requiredMatch || requiredMatch[1].toLowerCase() === 'true';

    if (isRequired) {
      if (!rules.some(r => r.field === param.name && r.rules === 'Required')) {
        rules.push({
          field: param.name,
          type: param.type || 'query',
          required: true,
          rules: 'Required',
        });
      }
    }
  }

  // Include field-level validation rules from BodySchema or chain nodes
  // Find the @RequestBody parameter to get the param name prefix
  const bodyParam = params.find((p: { name: string; type: string; annotations: string[] }) =>
    p.annotations?.includes('@RequestBody')
  );

  if (bodyParam) {
    // First try requestBody.fields (from database query)
    // Then fall back to finding Class nodes in the chain with fields
    const fields = requestBody?.fields || findFieldsInChain(chain, bodyParam.type);

    if (fields && fields.length > 0) {
      const prefix = `${bodyParam.name}.`;

      // Find the Class node for context (once, before the loop)
      const classNode = chain.find(n => n.name === bodyParam.type && n.kind === 'Class');

      for (const field of fields) {
        if (!field.annotations || field.annotations.length === 0) {
          continue;
        }

        // Extract validation rules using helper
        const fieldRules = extractValidationFromAnnotations(
          field.annotations,
          `${prefix}${field.name}`,
          field.type,
          includeContext,
          classNode?.filePath,
          classNode?.startLine
        );
        rules.push(...fieldRules);
      }
    }
  }

  // Part 3: Imperative validation detection
  // Always run this - it's the primary validation source for Java codebases
  // (which use imperative validation via method calls, not annotation-based validation)
  const seenValidations = new Set<string>();  // Dedup by (filePath, line, match.index)

  for (const node of chain) {
    if (!node.content) continue;
    for (const pattern of IMPERATIVE_VALIDATION_PATTERNS) {
      pattern.lastIndex = 0;  // Reset regex state for reuse
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(node.content)) !== null) {
        // WI-3: Extract meaningful field and rules from validation calls
        const matchedText = match[0];

        // Extract method name/path (e.g., "TcbsValidator.validate" or "process")
        // Strip leading dot if present (from patterns like .validateJWT)
        const methodMatch = matchedText.match(/([\w.]+)\s*\(/);
        const rawPath = methodMatch?.[1] || TODO_AI_ENRICH;
        const methodPath = rawPath.startsWith('.') ? rawPath.slice(1) : rawPath;

        // Dedup by (file, line, method name) to prevent overlapping patterns from creating duplicates
        const key = `${node.filePath}:${node.startLine}:${methodPath}`;
        if (seenValidations.has(key)) continue;
        seenValidations.add(key);

        // Extract arguments from the validation call
        // Need to handle nested parentheses properly
        const afterMatch = node.content.slice(match.index);
        // Find the opening parenthesis and match balanced parentheses
        const openParen = afterMatch.indexOf('(');
        let closeParen = -1;
        let depth = 0;
        for (let i = openParen; i < afterMatch.length; i++) {
          if (afterMatch[i] === '(') depth++;
          else if (afterMatch[i] === ')') {
            depth--;
            if (depth === 0) {
              closeParen = i;
              break;
            }
          }
        }

        let fieldName = TODO_AI_ENRICH;
        let paramType: string | undefined;

        if (openParen !== -1 && closeParen !== -1) {
          const argsStr = afterMatch.slice(openParen + 1, closeParen);
          // Split by comma, but handle nested parentheses, strings, and method calls
          const args = splitArguments(argsStr);

          if (args.length > 0) {
            const lastArg = args[args.length - 1].trim();

            // Skip if it's a complex expression (contains operators, nested calls, etc.)
            if (isComplexExpression(lastArg)) {
              // Try to find a simpler argument, or skip field extraction
              const simpleArg = args.find(arg => !isComplexExpression(arg.trim()));
              if (simpleArg) {
                fieldName = extractFieldName(simpleArg.trim(), params, requestBody);
              } else {
                // Skip this validation - no usable field name
                continue;
              }
            } else {
              fieldName = extractFieldName(lastArg, params, requestBody);
            }

            // If fieldName is a type name (simple capitalized identifier), set paramType for later type matching.
            // Qualified type names (with dots) are preserved as-is - they represent specific type arguments.
            if (fieldName && fieldName[0] === fieldName[0].toUpperCase() && !fieldName.includes('.')) {
              paramType = fieldName;
            } else {
              // Qualified type name (contains dots) or lowercase — no paramType needed
            }
          }
        }

        // If we have a fieldName but no paramType, look it up in handler parameters
        if (fieldName !== TODO_AI_ENRICH && !paramType) {
          const param = params.find((p: { name: string; type: string }) => p.name === fieldName);
          if (param) {
            paramType = param.type;
          }
        }

        // WI-3: Capitalized type names are never valid field names — fall back to 'body'.
        // Qualified type names (with dots like com.example.OrderDTO) are preserved as specific type arguments.
        // Simple capitalized identifiers (like TcbsJWT, OrderDTO) always fall back to 'body'.
        if (fieldName !== TODO_AI_ENRICH && paramType && fieldName[0] === fieldName[0].toUpperCase() && !fieldName.includes('.')) {
          // FieldName itself is a Java type name → falls back to 'body'
          fieldName = 'body';
        } else if (fieldName === TODO_AI_ENRICH && paramType) {
          // No field name extracted — decide based on paramType
          if (paramType === TODO_AI_ENRICH || (paramType[0] === paramType[0].toUpperCase() && !paramType.includes('.'))) {
            fieldName = 'body';
          } else {
            // Qualified type name (with dots) — preserve as field name
            fieldName = paramType;
          }
        }
        // else: keep fieldName as extracted (includes dotted qualified names, or regular field names)
        // else: keep fieldName as extracted or TODO_AI_ENRICH

        // Build rule object conditionally
        const rule: ValidationRule = {
          field: fieldName,
          type: 'Custom',
          required: false,
          rules: methodPath,
        };
        if (includeContext) {
          rule._context = [`// ${node.filePath}:${node.startLine}-${node.endLine}\n${node.content.slice(match.index, match.index + 200)}...`];
        }
        rules.push(rule);
      }
    }
  }

  // WI-2: Group validations by (field, rules) - collect contexts as array
  const grouped = new Map<string, ValidationRule>();
  for (const rule of rules) {
    const key = `${rule.field}|${rule.rules}`;
    if (grouped.has(key)) {
      const existing = grouped.get(key)!;
      // Append context to array if present
      if (rule._context) {
        if (!existing._context) {
          existing._context = [];
        }
        existing._context.push(...(Array.isArray(rule._context) ? rule._context : [rule._context]));
      }
    } else {
      grouped.set(key, { ...rule });
    }
  }
  return Array.from(grouped.values());
}

export async function extractMessaging(
  chain: ChainNode[],
  includeContext: boolean,
  executeQuery?: (repoId: string, query: string, params: Record<string, any>) => Promise<any[]>,
  repoId?: string,
  crossRepo?: CrossRepoContext
): Promise<{
  outbound: MessagingOutbound[];
  inbound: MessagingInbound[];
  nestedSchemas: Map<string, BodySchema>;
}> {
  const outbound: MessagingOutbound[] = [];
  const inbound: MessagingInbound[] = [];
  const seenOutbound = new Set<string>();
  const seenInbound = new Set<string>();
  const visited = new Set<string>();
  const nestedSchemas = new Map<string, BodySchema>();

  // Helper to resolve payload type to BodySchema and track resolution source repo
  // Returns { payload, sourceRepo } where sourceRepo is the repoId from resolved BodySchema
  const resolvePayload = async (typeName: string): Promise<{ payload: string | BodySchema; sourceRepo?: string }> => {
    if (typeName === TODO_AI_ENRICH) {
      return { payload: TODO_AI_ENRICH };
    }
    if (!executeQuery || !repoId) {
      return { payload: typeName };
    }
    const resolved = await resolveTypeSchema(typeName, executeQuery, repoId, visited, crossRepo);
    return { payload: resolved, sourceRepo: resolved.repoId };
  };

  for (const node of chain) {
    // Extract outbound messaging
    for (const detail of node.metadata.messagingDetails) {
      const trigger = node.name || 'TODO_AI_ENRICH';
      const dedupKey = `${detail.topic}:${trigger}`;
      if (detail.topic && !seenOutbound.has(dedupKey)) {
        seenOutbound.add(dedupKey);
        const payloadTypeName = detail.payload || TODO_AI_ENRICH;
        // Always resolve payload to BodySchema when executeQuery available
        const resolvedPayload = executeQuery && repoId && payloadTypeName !== TODO_AI_ENRICH
          ? await resolvePayload(payloadTypeName)
          : { payload: payloadTypeName };

        outbound.push({
          topic: detail.topic,
          pattern: 'publish/subscribe',
          type: 'event',
          direction: 'outbound',
          service: resolvedPayload.sourceRepo,
          payload: resolvedPayload.payload,
          sourceRepo: resolvedPayload.sourceRepo,
          trigger: trigger,
          ...(includeContext && {
            _context: `// ${node.filePath}:${node.startLine}-${node.endLine}\\n${node.content?.slice(0, 200)}...`,
          }),
        });
      }
    }

    // Extract inbound messaging from annotations
    if (node.annotations) {
      try {
        const annotations = JSON.parse(node.annotations);
        for (const ann of annotations) {
          const annName = ann.name;
          if (EVENT_LISTENER_ANNOTATIONS.has(annName)) {
            // Determine topic
            let topic: string;
            if (annName === '@EventListener' || annName === '@TransactionalEventListener') {
              topic = TODO_AI_ENRICH;
            } else if (annName === '@RabbitListener') {
              topic = ann.attrs?.queues || TODO_AI_ENRICH;
            } else if (annName === '@KafkaListener') {
              topic = ann.attrs?.topics || TODO_AI_ENRICH;
            } else {
              continue;
            }

            const payloadTypeName = extractPayloadFromParameters(node.parameterAnnotations);
            const consumptionLogic = buildConsumptionLogic(node.filePath!, node.name!);

            // Deduplicate by topic + consumptionLogic
            const key = `${topic}:${consumptionLogic}`;
            if (seenInbound.has(key)) continue;
            seenInbound.add(key);

            // Always resolve payload to BodySchema when executeQuery available
            const resolvedPayload = executeQuery && repoId
              ? await resolvePayload(payloadTypeName)
              : { payload: payloadTypeName };

            inbound.push({
              topic,
              pattern: 'publish/subscribe',
              type: 'event',
              direction: 'inbound',
              service: resolvedPayload.sourceRepo,
              payload: resolvedPayload.payload,
              sourceRepo: resolvedPayload.sourceRepo,
              consumptionLogic,
              ...(includeContext && {
                _context: `// ${node.filePath}:${node.startLine}-${node.endLine}\\n${node.content?.slice(0, 200)}...`,
              }),
            });
          }
        }
      } catch (e) {
        if (DEBUG) console.error('[GitNexus DEBUG] Annotation parse error:', e);
        // Ignore parse errors for annotations
      }
    }
  }

  // Part 2: Graph query for broker listeners (when executeQuery provided)
  // This must run even in compact mode (includeContext=false) to detect inbound events
  // that aren't in the call chain (e.g., @RabbitListener/@KafkaListener methods)
  if (executeQuery && repoId) {
    // Query using content since annotations may not be stored
    // RabbitListener pattern: @RabbitListener(queues = { "topic" })
    // KafkaListener pattern: @KafkaListener(topics = { "topic" })
    const cypher = `
      MATCH (m:Method)
      WHERE m.content CONTAINS '@RabbitListener'
         OR m.content CONTAINS '@KafkaListener'
      RETURN m.id, m.name, m.content, m.filePath, m.parameterAnnotations
    `;
    try {
      const results = await executeQuery(repoId, cypher, {});
      for (const row of results) {
        // Extract values - supports multiple result formats:
        // 1. Cypher named columns: row['m.name'], row['m.content'], row['m.parameterAnnotations']
        // 2. Object with m.annotations format: row['m.name'], row['m.annotations'], row['m.parameters']
        // 3. LadybugDB array format: row[0]=name, row[1]=annotations, row[2]=filePath, row[3]=parameters
        const name = row['m.name'] ?? row.name ?? row[0];
        const rawContent = row['m.content'] ?? row.content ?? '';
        const filePath = row['m.filePath'] ?? row.filePath ?? row[2] ?? '';
        // Parameters can be in m.parameterAnnotations or m.parameters (different formats)
        const parameterAnnotations = row['m.parameterAnnotations'] ?? row['m.parameters'] ?? row.parameterAnnotations ?? row.parameters ?? row[3];

        // For LadybugDB/array formats, construct content from annotations JSON
        // Cypher format returns source code in m.content, but other formats return annotations array
        let content = rawContent;
        if (!content) {
          // Try to construct from annotations - supports both array format and object format
          // Array format: row[1] contains JSON like [{name: '@RabbitListener', attrs: {queues: '...'}}]
          // Object format: row['m.annotations'] contains JSON like [{name: '@RabbitListener', attrs: {...}}]
          const annotationsRaw = row['m.annotations'] ?? row[1];
          if (annotationsRaw && typeof annotationsRaw === 'string') {
            try {
              const annotations = JSON.parse(annotationsRaw);
              if (Array.isArray(annotations) && annotations.length > 0) {
                // Construct annotation string for topic extraction
                const ann = annotations[0];
                const attrKey = ann.name === '@RabbitListener' ? 'queues' : 'topics';
                const attrValue = ann.attrs?.[attrKey] ?? ann.attrs?.queues ?? ann.attrs?.topics ?? '';
                content = `${ann.name}(${attrKey} = "${attrValue}")`;
              }
            } catch {
              // Ignore parse errors
            }
          }
        }

        // Determine listener type from content
        const listenerType = content.includes('@RabbitListener') ? 'RabbitListener' as const
          : content.includes('@KafkaListener') ? 'KafkaListener' as const
          : null;

        if (!listenerType) continue;

        // Extract topic from content
        // RabbitListener: @RabbitListener(queues = { "topic" }) or queues = "topic"
        // KafkaListener: @KafkaListener(topics = { "topic" }) or topics = "topic"
        const topic = extractListenerTopicFromContent(content, listenerType);
        const payloadTypeName = extractPayloadFromParameters(parameterAnnotations);
        const consumptionLogic = buildConsumptionLogic(filePath, name);

        // Deduplicate
        const key = `${topic}:${consumptionLogic}`;
        if (seenInbound.has(key)) continue;
        seenInbound.add(key);

        // Always resolve payload to BodySchema when executeQuery available
        const resolvedPayload = executeQuery && repoId
          ? await resolvePayload(payloadTypeName)
          : { payload: payloadTypeName };

        inbound.push({
          topic,
          pattern: 'publish/subscribe',
          type: 'event',
          direction: 'inbound',
          service: resolvedPayload.sourceRepo,
          payload: resolvedPayload.payload,
          sourceRepo: resolvedPayload.sourceRepo,
          consumptionLogic,
          ...(includeContext && {
            _context: `// Graph query result\\n// ${filePath}\\n@${listenerType} detected`,
          }),
        });
      }
    } catch (e) {
      if (DEBUG) console.error('[GitNexus DEBUG] Broker listener graph query failed:', e);
      // Ignore graph query errors
    }
  }

  // Resolve nested types for all payloads when executeQuery available
  // This ensures messaging payloads have full type resolution like request/response bodies
  if (executeQuery && repoId) {
    const allVisited = new Set<string>();

    // Collect all BodySchema payloads from outbound
    for (const msg of outbound) {
      if (typeof msg.payload === 'object' && msg.payload !== null && 'fields' in msg.payload) {
        const nested = await resolveAllNestedTypes(msg.payload as BodySchema, executeQuery, repoId, allVisited, crossRepo);
        for (const [typeName, schema] of nested) {
          nestedSchemas.set(typeName, schema);
        }
      }
    }

    // Collect all BodySchema payloads from inbound
    for (const msg of inbound) {
      if (typeof msg.payload === 'object' && msg.payload !== null && 'fields' in msg.payload) {
        const nested = await resolveAllNestedTypes(msg.payload as BodySchema, executeQuery, repoId, allVisited, crossRepo);
        for (const [typeName, schema] of nested) {
          nestedSchemas.set(typeName, schema);
        }
      }
    }

    // Embed nested schemas into payload fields when includeContext
    if (includeContext) {
      for (const msg of outbound) {
        if (typeof msg.payload === 'object' && msg.payload !== null && 'fields' in msg.payload) {
          msg.payload = embedNestedSchemas(msg.payload as BodySchema, nestedSchemas);
        }
      }
      for (const msg of inbound) {
        if (typeof msg.payload === 'object' && msg.payload !== null && 'fields' in msg.payload) {
          msg.payload = embedNestedSchemas(msg.payload as BodySchema, nestedSchemas);
        }
      }
    }
  }

  return { outbound, inbound, nestedSchemas };
}

/**
 * Extract class name from a file path.
 * Example: "src/listeners/RabbitConsumer.java" -> "RabbitConsumer"
 */
function extractClassNameFromPath(filePath: string): string | null {
  const fileName = filePath.split('/').pop() || '';
  const match = fileName.match(/^(.+)\.(java|ts|js|kt|py|php)$/);
  return match ? match[1] : null;
}

/**
 * Extract topic from RabbitListener or KafkaListener annotation string.
 */
function extractListenerTopic(annotations: string, listenerType: 'RabbitListener' | 'KafkaListener'): string {
  const attr = listenerType === 'RabbitListener' ? 'queues' : 'topics';
  
  // Try JSON format first: [{ name: '@RabbitListener', attrs: { queues: 'value' } }]
  try {
    const parsed = JSON.parse(annotations);
    if (Array.isArray(parsed)) {
      for (const ann of parsed) {
        if (ann.name === `@${listenerType}` && ann.attrs?.[attr]) {
          return ann.attrs[attr];
        }
      }
    }
  } catch (e) {
    if (DEBUG) console.error('[GitNexus DEBUG] Annotation JSON parse failed:', e);
    // Not JSON, try regex format
  }
  
  // Regex format: queues="value" or queues={value}
  const match1 = annotations.match(new RegExp(`${attr}\\\\s*=\\\\s*"([^"]+)"`));
  if (match1) return match1[1];
  const match2 = annotations.match(new RegExp(`${attr}\\\\s*=\\\\s*\\{([^}]+)\\}`));
  if (match2) return match2[1].trim();

  return TODO_AI_ENRICH;
}

/**
 * Extract topic from method content containing @RabbitListener or @KafkaListener.
 * Handles formats like:
 * - @RabbitListener(queues = { "topic1", "topic2" })
 * - @RabbitListener(queues = "topic")
 * - @KafkaListener(topics = { "topic1", "topic2" })
 * - @KafkaListener(topics = "${kafka.topic}")
 */
function extractListenerTopicFromContent(content: string, listenerType: 'RabbitListener' | 'KafkaListener'): string {
  const attr = listenerType === 'RabbitListener' ? 'queues' : 'topics';

  // Pattern: @RabbitListener(queues = { "topic" }) or @KafkaListener(topics = { "topic" })
  // Also handles: queues = "topic", topics = "${property}"
  const arrayPattern = new RegExp(`@${listenerType}[^)]*${attr}\\s*=\\s*\\{\\s*"([^"]+)"`);
  const stringPattern = new RegExp(`@${listenerType}[^)]*${attr}\\s*=\\s*"([^"]+)"`);
  const placeholderPattern = new RegExp(`@${listenerType}[^)]*${attr}\\s*=\\s*\\{\\s*\\$\\{([^}]+)\\}\\s*\\}`);
  const placeholderStringPattern = new RegExp(`@${listenerType}[^)]*${attr}\\s*=\\s*"\\$\\{([^}]+)\\}"`);

  // Try array format first: { "topic" }
  const arrayMatch = content.match(arrayPattern);
  if (arrayMatch) return arrayMatch[1];

  // Try string format: "topic"
  const stringMatch = content.match(stringPattern);
  if (stringMatch) return stringMatch[1];

  // Try placeholder in array: { "${property}" }
  const placeholderMatch = content.match(placeholderPattern);
  if (placeholderMatch) return `\${${placeholderMatch[1]}}`;

  // Try placeholder in string: "${property}"
  const placeholderStringMatch = content.match(placeholderStringPattern);
  if (placeholderStringMatch) return `\${${placeholderStringMatch[1]}}`;

  return TODO_AI_ENRICH;
}

/**
 * Extract payload type from parameters (string or parsed JSON).
 */
function extractPayloadFromParameters(parameters: string | unknown): string {
  if (!parameters) return TODO_AI_ENRICH;
  try {
    const params = typeof parameters === 'string' ? JSON.parse(parameters) : parameters;
    if (Array.isArray(params) && params.length > 0 && params[0].type) {
      return params[0].type;
    }
  } catch (e) { 
    if (DEBUG) console.error('[GitNexus DEBUG] Parameter JSON parse failed:', e);
    /* ignore parse errors */ 
  }
  return TODO_AI_ENRICH;
}

/**
 * Build consumptionLogic string from filePath and methodName.
 */
function buildConsumptionLogic(filePath: string, methodName: string): string {
  const className = extractClassNameFromPath(filePath);
  return className && methodName ? `${className}.${methodName}()` : methodName || TODO_AI_ENRICH;
}

/**
 * WI-6: Heuristic-based persistence database extraction.
 * Tries to resolve database type from @Table(schema=...) or @Entity annotations.
 * Falls back to TODO_AI_ENRICH if no annotations are found.
 */
export async function extractPersistence(
  chain: ChainNode[],
  executeQuery?: (repoId: string, query: string, params: Record<string, any>) => Promise<any[]>,
  repoId?: string
): Promise<PersistenceInfo[]> {
  const tables = new Set<string>();
  const operations = new Set<string>();
  const repos = new Set<string>();

  // WI-6: Strip Repository/Dao/Repo suffix and capitalize to derive entity name
  const stripRepositorySuffix = (repoVar: string): string => {
    const stripped = repoVar
      .replace(/Repository$/, '')
      .replace(/Dao$/, '')
      .replace(/Repo$/, '');
    // Capitalize first letter (e.g. userRepository → User)
    return stripped.charAt(0).toUpperCase() + stripped.slice(1);
  };

  // Bug C fix: Generate entity name variants to handle different naming conventions
  // e.g., userRepository → User, UserEntity, Users, TblUser, user, etc.
  const generateEntityVariants = (entityName: string): string[] => {
    const variants = new Set<string>();
    // Original: User
    variants.add(entityName);
    // With Entity suffix: UserEntity
    variants.add(entityName + 'Entity');
    // Plural: Users
    variants.add(entityName + 's');
    // With Tbl prefix: TblUser
    variants.add('Tbl' + entityName);
    // Lowercase: user
    variants.add(entityName.toLowerCase());
    // snake_case: user (for table names like user_account)
    const snakeCase = entityName.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
    variants.add(snakeCase);
    // All uppercase: USER
    variants.add(entityName.toUpperCase());
    // Camel to underscore plural: users
    variants.add(snakeCase + 's');
    return Array.from(variants);
  };

  // WI-3: Derive CRUD operation from repository method name
  const deriveOperation = (methodName: string): string => {
    const lower = methodName.toLowerCase();
    if (/^(save|insert|add|create)/.test(lower)) return 'CREATE';
    if (/^(delete|remove)/.test(lower)) return 'DELETE';
    if (/^(update|modify|set)/.test(lower)) return 'UPDATE';
    return 'READ'; // default for find*/get*/query*/read*
  };

  for (const node of chain) {
    for (const call of node.metadata.repositoryCalls) {
      repos.add(call);
      // Extract repository variable name and strip suffix to get entity name
      const match = call.match(/(\w+)(?:Repository|Dao|Repo)\.(\w+)/);
      if (match) {
        const entityName = stripRepositorySuffix(match[1]);
        tables.add(entityName);
        operations.add(deriveOperation(match[2]));
      }
    }
  }

  if (tables.size === 0 && repos.size === 0) {
    return [];
  }

  // WI-6: Resolve database from @Table(schema=...) or @Entity annotations
  let database: string = TODO_AI_ENRICH;

  if (executeQuery && repoId) {
    // Bug C fix: Query using entity name variants for better matching
    // Single query per table with all variants to reduce DB hits
    const entityQuery = `
      MATCH (c:Class)
      WHERE c.name IN $entityVariants
         OR ANY(v IN $entityVariants WHERE c.name CONTAINS v)
         OR ANY(v IN $entityVariants WHERE c.name ENDS WITH v)
      RETURN c.name AS name, c.annotations AS annotations
      LIMIT 10
    `;

    try {
      for (const tableName of tables) {
        const entityVariants = generateEntityVariants(tableName);
        const results = await executeQuery(repoId, entityQuery, { entityVariants });

        if (DEBUG && results.length === 0) {
          console.error(`[GitNexus DEBUG] No entity class found for variants: ${entityVariants.join(', ')}`);
        }

        for (const row of results) {
          const annotationsRaw = row.annotations;
          if (!annotationsRaw) continue;

          let annotations: Array<{ name: string; attrs?: Record<string, any> }>;
          try {
            annotations = typeof annotationsRaw === 'string' ? JSON.parse(annotationsRaw) : annotationsRaw;
          } catch {
            // Bug C fix: Try parsing raw annotation text for @Table schema
            if (typeof annotationsRaw === 'string' && annotationsRaw.includes('@Table')) {
              const schemaMatch = annotationsRaw.match(/@Table\([^)]*schema\s*=\s*"([^"]+)"/i);
              if (schemaMatch) {
                database = schemaMatch[1];
                if (DEBUG) console.error(`[GitNexus DEBUG] Extracted schema from raw @Table: ${database}`);
                break;
              }
              // Also try @Schema annotation
              const schemaAttrMatch = annotationsRaw.match(/@Schema\s*\(\s*[^)]*name\s*=\s*"([^"]+)"/i);
              if (schemaAttrMatch) {
                database = schemaAttrMatch[1];
                if (DEBUG) console.error(`[GitNexus DEBUG] Extracted schema from raw @Schema: ${database}`);
                break;
              }
            }
            continue;
          }

          // WI-6: Check @Table first (wins over @Entity)
          const tableAnn = annotations.find(a => a.name === '@Table');
          if (tableAnn?.attrs?.schema) {
            database = tableAnn.attrs.schema;
            break;
          }

          // Bug C fix: @Table with name but no schema - check @Schema annotation
          if (tableAnn?.attrs?.name && !tableAnn.attrs.schema) {
            const schemaAnn = annotations.find(a => a.name === '@Schema');
            if (schemaAnn?.attrs?.name) {
              database = schemaAnn.attrs.name;
              break;
            }
          }

          // WI-6: Fall back to @Entity presence (JPA-managed entity)
          const entityAnn = annotations.find(a => a.name === '@Entity');
          if (entityAnn && database === TODO_AI_ENRICH) {
            // @Entity found but no schema info — use JPA default
            database = 'JPA';
          }
        }
        if (database !== TODO_AI_ENRICH) break;
      }
    } catch (e) {
      if (DEBUG) console.error('[GitNexus DEBUG] Persistence database heuristic failed:', e);
      // Fall through to TODO_AI_ENRICH
    }

    // Broader fallback: search for @Entity annotation on any class matching entity variants
    if (database === TODO_AI_ENRICH) {
      try {
        for (const tableName of tables) {
          const entityVariants = generateEntityVariants(tableName);
          const entityResult = await executeQuery(
            repoId,
            `MATCH (c:Class) WHERE c.annotations IS NOT NULL AND c.annotations CONTAINS '@Entity' AND (c.name IN $entityVariants OR ANY(v IN $entityVariants WHERE c.name ENDS WITH v)) RETURN c.name AS name, c.annotations AS annotations LIMIT 1`,
            { entityVariants }
          );
          if (entityResult.length > 0) {
            database = 'JPA';
            break;
          }
        }
      } catch (e) {
        if (DEBUG) console.error('[GitNexus DEBUG] Broader @Entity search failed:', e);
      }
    }

    // Bug C fix: Last resort - check if any @Entity exists in the project (most Spring apps use single DB)
    if (database === TODO_AI_ENRICH && tables.size > 0) {
      try {
        const anyEntityResult = await executeQuery(
          repoId,
          `MATCH (c:Class) WHERE c.annotations IS NOT NULL AND c.annotations CONTAINS '@Entity' RETURN c.name AS name LIMIT 1`,
          {}
        );
        if (anyEntityResult.length > 0) {
          database = 'JPA';
          if (DEBUG) console.error(`[GitNexus DEBUG] Found @Entity in project, defaulting to JPA`);
        }
      } catch (e) {
        if (DEBUG) console.error('[GitNexus DEBUG] Any @Entity search failed:', e);
      }
    }
  }

  return [{
    database,
    tables: Array.from(tables).join(', ') || 'None detected',
    entity: Array.from(tables).join(', ') || 'None detected',
    operation: Array.from(operations).join(', ') || 'READ',
    storedProcedures: 'None detected',
  }];
}

function extractExceptionCodes(chain: ChainNode[]): ResponseCode[] {
  const codes: ResponseCode[] = [];
  const seen = new Set<string>();

  for (const node of chain) {
    for (const exc of node.metadata.exceptions) {
      const key = `${exc.exceptionClass}:${exc.errorCode}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const description = exc.errorCode
        ? `${exc.exceptionClass}: ${exc.errorCode}`
        : exc.exceptionClass;

      codes.push({
        code: 400, // Default to 400 for business exceptions
        description,
      });
    }
  }

  return codes;
}

function extractAnnotations(chain: ChainNode[]): {
  transaction: string[];
  retry: RetryLogic[];
  security: string[];
} {
  const transaction: string[] = [];
  const retry: RetryLogic[] = [];
  const security: string[] = [];
  const seenTransaction = new Set<string>();
  const seenRetry = new Set<string>();

  for (const node of chain) {
    // From node.annotations JSON
    if (node.annotations) {
      try {
        const anns = JSON.parse(node.annotations);
        for (const ann of anns) {
          if (ann.name === '@Transactional') {
            const timeout = ann.attrs?.timeout;
            const key = `@Transactional${timeout ? `(timeout=${timeout})` : ''} on ${node.name}`;
            if (!seenTransaction.has(key)) {
              seenTransaction.add(key);
              transaction.push(key);
            }
          }
          if (ann.name === '@Retryable') {
            const maxAttempts = ann.attrs?.maxAttempts || '3';
            const backoff = ann.attrs?.backoff || '@Backoff(delay=1000)';
            const key = `${node.name}:${maxAttempts}`;
            if (!seenRetry.has(key)) {
              seenRetry.add(key);
              retry.push({
                operation: node.name,
                maxAttempts: String(maxAttempts),
                backoff: String(backoff),
                recovery: TODO_AI_ENRICH,
              });
            }
          }
          if (ann.name === '@PreAuthorize' || ann.name === '@Secured' || ann.name === '@RolesAllowed') {
            const key = `${ann.name} on ${node.name}`;
            if (!security.includes(key)) {
              security.push(key);
            }
          }
        }
      } catch (e) {
        if (DEBUG) console.error('[GitNexus DEBUG] Transaction annotation parse failed:', e);
        // Ignore parse errors
      }
    }

    // From metadata.annotations (legacy format)
    for (const ann of node.metadata.annotations) {
      if (ann.startsWith('@Transactional')) {
        const key = `${ann} on ${node.name}`;
        if (!seenTransaction.has(key)) {
          seenTransaction.add(key);
          transaction.push(key);
        }
      }
    }
  }

  return { transaction, retry, security };
}

/**
 * Extracts all external dependencies from a call chain.
 * Wrapper over the individual extractors, returning a flat ExternalDeps object
 * suitable for embedding into OpenAPI x-extension fields.
 *
 * @param chain       Call chain returned by executeTrace
 * @param _path       OpenAPI path (unused but kept for signature compatibility)
 * @param _method     HTTP method (unused but kept for signature compatibility)
 * @param executeQuery  Graph query function
 * @param repoId      Repository ID
 */
export async function extractAllDependencies(
  chain: import('../../mcp/local/trace-executor.js').ChainNode[],
  _path: string,
  _method: string,
  executeQuery: (repoId: string, query: string, params: Record<string, unknown>) => Promise<unknown[]>,
  repoId: string,
): Promise<ExternalDeps> {
  const [messagingResult, persistence] = await Promise.all([
    extractMessaging(chain, false, executeQuery, repoId),
    extractPersistence(chain, executeQuery, repoId),
  ]);

  const annotations = extractAnnotations(chain);

  return {
    downstreamApis: [],
    messaging: {
      outbound: messagingResult.outbound,
      inbound: messagingResult.inbound,
      nestedSchemas: messagingResult.nestedSchemas,
    },
    persistence,
    annotations,
    validation: [],  // Enricher does not compute validation — use documentEndpoint for full results
  };
}

/**
 * Get example value for a type.
 */
function getExampleValue(type: string, annotations: string[]): unknown {
  // Handle primitive types
  if (type === 'String' || type === 'string') {
    return 'string';
  }
  if (type === 'Integer' || type === 'int' || type === 'Long' || type === 'long') {
    return 0;
  }
  if (type === 'Double' || type === 'double' || type === 'Float' || type === 'float' || type === 'BigDecimal') {
    return 0.0;
  }
  if (type === 'Boolean' || type === 'boolean') {
    return false;
  }
  if (type === 'BigInteger') {
    return 0;
  }
  if (type === 'LocalDate' || type === 'Date' || type === 'Instant') {
    return '2024-01-01';
  }
  if (type === 'LocalDateTime' || type === 'ZonedDateTime' || type === 'Timestamp') {
    return '2024-01-01T00:00:00';
  }
  if (type === 'List' || type === 'Set' || type.endsWith('[]')) {
    return [];
  }
  if (type === 'Map' || type === 'Object') {
    return {};
  }
  if (type === 'void' || type === 'Void') {
    return null;
  }

  // For custom types, return type name as placeholder
  return { _type: type };
}

/**
 * Generate a JSON example object from field definitions.
 */
/**
 * Recursively unwrap nested generics to find the innermost type.
 * Returns { innermostType, depth } where depth is the number of wrapper levels.
 * e.g., 'Optional<List<String>>' → { innermostType: 'String', depth: 2 }
 * e.g., 'List<ItemDto>' → { innermostType: 'ItemDto', depth: 1 }
 */
function unwrapNestedGenerics(typeName: string): { innermostType: string; depth: number } {
  let currentType = typeName;
  let depth = 0;
  
  while (true) {
    const innerType = extractGenericInnerType(currentType);
    if (!innerType) {
      // No more generic wrappers
      break;
    }
    currentType = innerType;
    depth++;
  }
  
  return { innermostType: currentType, depth };
}

function generateJsonExample(
  fields: BodySchemaField[],
  nestedSchemas?: Map<string, BodySchema>,
  visited: Set<string> = new Set()
): Record<string, unknown> {
  const example: Record<string, unknown> = {};

  for (const field of fields) {
    // Check for embedded nested fields (from embedNestedSchemas) — only when fields array is non-empty
    if (field.fields && Array.isArray(field.fields) && field.fields.length > 0) {
      // Prevent circular reference in embedded fields — use type placeholder if already visited
      if (visited.has(field.type)) {
        example[field.name] = { _type: field.type };
        continue;
      }
      // Recursively generate example from embedded nested fields
      const nestedExample = generateJsonExample(field.fields, nestedSchemas, new Set(visited).add(field.type));
      if (field.isContainer) {
        example[field.name] = [nestedExample];
      } else {
        example[field.name] = nestedExample;
      }
      continue;
    }

    // Check if this field has a nested schema directly
    if (nestedSchemas?.has(field.type)) {
      // Prevent circular reference - if type already visited, use placeholder
      if (visited.has(field.type)) {
        example[field.name] = { _type: field.type };
        continue;
      }
      const nestedSchema = nestedSchemas.get(field.type)!;
      example[field.name] = generateJsonExample(nestedSchema.fields, nestedSchemas, new Set(visited).add(field.type));
      continue;
    }

    // Check for generic container types (List<X>, Optional<X>, Set<X>, X[])
    // Also handle nested generics like Optional<List<String>>
    // unwrapNestedGenerics returns depth=0 for non-generic types
    const { innermostType, depth } = unwrapNestedGenerics(field.type);
    if (depth > 0) {
      
      // Check if innermost type has a nested schema
      if (nestedSchemas?.has(innermostType)) {
        // Prevent circular reference in generic containers
        if (visited.has(innermostType)) {
          // Create nested array wrappers matching depth
          let result: unknown = { _type: innermostType };
          for (let i = 0; i < depth; i++) {
            result = [result];
          }
          example[field.name] = result;
          continue;
        }
        const nestedSchema = nestedSchemas.get(innermostType)!;
        const nestedFields = nestedSchema.fields || [];
        let innerExample: unknown = generateJsonExample(nestedFields, nestedSchemas, new Set(visited).add(innermostType));
        // Wrap in array for each generic level
        for (let i = 0; i < depth; i++) {
          innerExample = [innerExample];
        }
        example[field.name] = innerExample;
      } else if (shouldSkipSchema(innermostType)) {
        // Innermost type is primitive - wrap in arrays matching generic depth
        let result: unknown = getExampleValue(innermostType, field.annotations || []);
        for (let i = 0; i < depth; i++) {
          result = [result];
        }
        example[field.name] = result;
      } else {
        // Innermost type is external/unknown - return placeholder with proper nesting
        let result: unknown = { _type: innermostType };
        for (let i = 0; i < depth; i++) {
          result = [result];
        }
        example[field.name] = result;
      }
      continue;
    }

    // Fallback to getExampleValue for primitives and unknown types
    example[field.name] = getExampleValue(field.type, field.annotations || []);
  }

  return example;
}

/**
 * Convert BodySchema to JSON example object or null.
 */
export function bodySchemaToJsonExample(
  schema: BodySchema | null,
  nestedSchemas?: Map<string, BodySchema>
): Record<string, unknown> | Record<string, unknown>[] | null {
  if (!schema) return null;

  // External types - return type placeholder
  if (schema.source === 'external') {
    return { _type: schema.typeName };
  }

  // Primitive types - return null (no body)
  if (schema.source === 'primitive') {
    return null;
  }

  // Container types wrapping a primitive/skip-schema inner (e.g.,
  // `Map<String, Object>`): return an empty-map/object placeholder so
  // the example is still visible in the generated docs. (#39) Before
  // this fix, the source was incorrectly 'primitive' so this branch
  // never executed and the whole response body came out as null.
  if (schema.source === 'container') {
    if (schema.typeName.startsWith('Map') || schema.typeName.startsWith('HashMap') || schema.typeName.startsWith('TreeMap') || schema.typeName.startsWith('LinkedHashMap')) {
      return { _type: schema.typeName, _example: {} };
    }
    return [{}];
  }

  // Indexed type with fields - generate example
  if (schema.fields && schema.fields.length > 0) {
    const example = generateJsonExample(schema.fields, nestedSchemas);
    // If it was a container type, wrap in array
    if (schema.isContainer) {
      return [example];
    }
    return example;
  }

  // Indexed type without fields - return type placeholder
  return { _type: schema.typeName };
}

function generateCodeDiagram(chain: ChainNode[]): string {
  if (chain.length === 0) return '';

  // Group nodes by depth to create layers
  const layers: Map<number, ChainNode[]> = new Map();
  for (const node of chain) {
    const depth = node.depth;
    if (!layers.has(depth)) {
      layers.set(depth, []);
    }
    layers.get(depth)!.push(node);
  }

  const lines: string[] = ['graph TB'];

  // Create subgraphs for each logical layer
  const depth0 = layers.get(0) || [];
  if (depth0.length > 0) {
    lines.push('  subgraph Controller');
    for (const node of depth0) {
      lines.push(`    A[${node.name}]`);
    }
    lines.push('  end');
  }

  const depth1 = layers.get(1) || [];
  const depth2 = layers.get(2) || [];
  const services = [...depth1, ...depth2];
  if (services.length > 0) {
    lines.push('  subgraph Service');
    services.forEach((node, i) => {
      lines.push(`    ${String.fromCharCode(66 + i)}[${node.name}]`);
    });
    lines.push('  end');
  }

  // Add edges
  // Controller -> Service
  if (depth0.length > 0 && depth1.length > 0) {
    lines.push(`  A --> ${String.fromCharCode(66)}`);
  }

  // Service -> Service/External
  if (depth1.length > 0 && depth2.length > 0) {
    lines.push(`  ${String.fromCharCode(66)} --> ${String.fromCharCode(67)}`);
  }

  return lines.join('\n');
}