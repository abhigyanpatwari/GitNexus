/**
 * Unit tests for route extractors, tool detection patterns, and response shape parsing.
 */
import { describe, it, expect } from 'vitest';
import { nextjsFileToRouteURL, normalizeFetchURL, routeMatches } from '../../src/core/ingestion/route-extractors/nextjs.js';
import { phpFileToRouteURL } from '../../src/core/ingestion/route-extractors/php.js';
import { extractMiddlewareChain } from '../../src/core/ingestion/route-extractors/middleware.js';
import { detectStatusCode, extractResponseShapes, extractPHPResponseShapes } from '../../src/core/ingestion/route-extractors/response-shapes.js';

// ---------------------------------------------------------------------------
// Next.js route extractor
// ---------------------------------------------------------------------------

describe('nextjsFileToRouteURL', () => {
  it('extracts App Router API routes', () => {
    expect(nextjsFileToRouteURL('app/api/grants/route.ts')).toBe('/api/grants');
    expect(nextjsFileToRouteURL('app/api/users/route.js')).toBe('/api/users');
    expect(nextjsFileToRouteURL('app/api/auth/login/route.tsx')).toBe('/api/auth/login');
  });

  it('handles dynamic segments', () => {
    expect(nextjsFileToRouteURL('app/api/organizations/[slug]/grants/route.ts'))
      .toBe('/api/organizations/[slug]/grants');
    expect(nextjsFileToRouteURL('app/api/users/[id]/route.ts'))
      .toBe('/api/users/[id]');
  });

  it('only matches api/ routes in App Router', () => {
    // Non-API App Router routes should be excluded
    expect(nextjsFileToRouteURL('app/dashboard/route.ts')).toBeNull();
    expect(nextjsFileToRouteURL('app/(marketing)/about/route.ts')).toBeNull();
  });

  it('strips route groups from App Router paths', () => {
    expect(nextjsFileToRouteURL('app/(admin)/api/users/route.ts')).toBe('/api/users');
    expect(nextjsFileToRouteURL('app/(marketing)/api/newsletter/route.ts')).toBe('/api/newsletter');
  });

  it('extracts Pages Router API routes', () => {
    expect(nextjsFileToRouteURL('pages/api/auth/login.ts')).toBe('/api/auth/login');
    expect(nextjsFileToRouteURL('pages/api/users.ts')).toBe('/api/users');
  });

  it('strips /index suffix from Pages Router', () => {
    expect(nextjsFileToRouteURL('pages/api/index.ts')).toBe('/api');
  });

  it('returns null for non-route files', () => {
    expect(nextjsFileToRouteURL('src/components/Button.tsx')).toBeNull();
    expect(nextjsFileToRouteURL('src/lib/utils.ts')).toBeNull();
    expect(nextjsFileToRouteURL('app/page.tsx')).toBeNull();
  });

  it('handles Windows-style backslash paths', () => {
    expect(nextjsFileToRouteURL('app\\api\\grants\\route.ts')).toBe('/api/grants');
  });
});

// ---------------------------------------------------------------------------
// PHP route extractor
// ---------------------------------------------------------------------------

describe('phpFileToRouteURL', () => {
  it('extracts routes from api/ directory', () => {
    expect(phpFileToRouteURL('api/upload.php')).toBe('/api/upload');
    expect(phpFileToRouteURL('api/next_sign.php')).toBe('/api/next_sign');
    expect(phpFileToRouteURL('api/auth.php')).toBe('/api/auth');
  });

  it('handles nested api directories', () => {
    expect(phpFileToRouteURL('api/v2/users.php')).toBe('/api/v2/users');
  });

  it('returns null for non-api PHP files', () => {
    expect(phpFileToRouteURL('index.php')).toBeNull();
    expect(phpFileToRouteURL('includes/database.php')).toBeNull();
    expect(phpFileToRouteURL('vendor/lib/api/config.php')).toBeNull();
  });

  it('filters out non-handler files in api/', () => {
    expect(phpFileToRouteURL('api/_helpers.php')).toBeNull();
    expect(phpFileToRouteURL('api/helper_utils.php')).toBeNull();
    expect(phpFileToRouteURL('api/test_upload.php')).toBeNull();
    expect(phpFileToRouteURL('api/fixture_data.php')).toBeNull();
  });

  it('does not false-filter legitimate endpoints with substring matches', () => {
    // "contest" contains "test", "attestation" contains "test" — should NOT be filtered
    // Word-boundary regex only matches _test_ not substrings
    expect(phpFileToRouteURL('api/contest.php')).toBe('/api/contest');
    expect(phpFileToRouteURL('api/attestation.php')).toBe('/api/attestation');
    expect(phpFileToRouteURL('api/latest.php')).toBe('/api/latest');
    expect(phpFileToRouteURL('api/base64_encode.php')).toBe('/api/base64_encode');
  });

  it('returns null for non-PHP files', () => {
    expect(phpFileToRouteURL('api/readme.md')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Fetch URL normalization
// ---------------------------------------------------------------------------

describe('normalizeFetchURL', () => {
  it('passes through clean API URLs', () => {
    expect(normalizeFetchURL('/api/grants')).toBe('/api/grants');
    expect(normalizeFetchURL('/api/users/123')).toBe('/api/users/123');
  });

  it('strips query strings', () => {
    expect(normalizeFetchURL('/api/grants?page=1&limit=10')).toBe('/api/grants');
  });

  it('replaces template expressions with [param]', () => {
    expect(normalizeFetchURL('/api/organizations/${slug}/grants'))
      .toBe('/api/organizations/[param]/grants');
  });

  it('strips backticks from template literals', () => {
    expect(normalizeFetchURL('`/api/grants`')).toBe('/api/grants');
  });

  it('accepts non-/api/ absolute paths', () => {
    expect(normalizeFetchURL('/v1/users')).toBe('/v1/users');
    expect(normalizeFetchURL('/graphql')).toBe('/graphql');
    expect(normalizeFetchURL('/dashboard')).toBe('/dashboard');
  });

  it('returns null for unresolvable patterns', () => {
    // String concatenation in source code: '/api/' + endpoint
    expect(normalizeFetchURL('/api/+endpoint')).toBeNull();
    // Function call wrapper
    expect(normalizeFetchURL('getApiUrl()')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

describe('routeMatches', () => {
  it('matches exact routes', () => {
    expect(routeMatches('/api/grants', '/api/grants')).toBe(true);
  });

  it('does not match different routes', () => {
    expect(routeMatches('/api/grants', '/api/users')).toBe(false);
  });

  it('does not match different segment counts', () => {
    expect(routeMatches('/api/grants', '/api/grants/123')).toBe(false);
  });

  it('matches dynamic segments on either side', () => {
    expect(routeMatches('/api/orgs/[param]', '/api/orgs/[slug]')).toBe(true);
    expect(routeMatches('/api/orgs/acme', '/api/orgs/[slug]')).toBe(true);
    expect(routeMatches('/api/orgs/[param]/grants', '/api/orgs/[slug]/grants')).toBe(true);
  });

  it('matches catch-all routes against longer paths', () => {
    expect(routeMatches('/api/docs/a/b/c', '/api/[...slug]')).toBe(true);
    expect(routeMatches('/api/proxy/x', '/api/[...slug]')).toBe(true);
    expect(routeMatches('/api/proxy/x/y/z', '/api/[...slug]')).toBe(true);
  });

  it('does not match catch-all when prefix segments differ', () => {
    expect(routeMatches('/v1/docs/a', '/api/[...slug]')).toBe(false);
  });

  it('does not match catch-all with too few segments', () => {
    expect(routeMatches('/', '/api/[...slug]')).toBe(false);
  });

  it('matches optional catch-all routes [[...slug]]', () => {
    expect(routeMatches('/api/docs/a/b', '/api/[[...slug]]')).toBe(true);
    expect(routeMatches('/api/proxy/x', '/api/[[...slug]]')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Response shape extraction (brace-depth parser edge cases)
// ---------------------------------------------------------------------------

describe('response shape extraction edge cases', () => {
  // Helper that simulates the pipeline's brace-depth parser
  function extractKeysFromContent(content: string): string[] {
    const keys: string[] = [];
    const jsonPattern = /\.json\s*\(/g;
    let jsonMatch;
    while ((jsonMatch = jsonPattern.exec(content)) !== null) {
      const startIdx = jsonMatch.index + jsonMatch[0].length;
      let i = startIdx;
      while (i < content.length && content[i] !== '{' && content[i] !== ')') i++;
      if (i >= content.length || content[i] !== '{') continue;
      let depth = 0;
      let keyStart = -1;
      let inString: string | null = null;
      for (let j = i; j < content.length; j++) {
        const ch = content[j];
        if (inString) {
          if (ch === '\\') { j++; continue; }
          if (ch === inString) inString = null;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
        if (ch === '{') { depth++; continue; }
        if (ch === '}') { depth--; if (depth === 0) break; continue; }
        if (depth !== 1) continue;
        if (keyStart === -1 && /[a-zA-Z_$]/.test(ch)) {
          keyStart = j;
        } else if (keyStart !== -1 && !/[a-zA-Z0-9_$]/.test(ch)) {
          const key = content.slice(keyStart, j);
          const rest = content.slice(j).trimStart();
          if (rest[0] === ':' || rest[0] === ',' || rest[0] === '}') {
            keys.push(key);
          }
          keyStart = -1;
        }
      }
    }
    return [...new Set(keys)];
  }

  it('extracts simple shorthand properties', () => {
    const keys = extractKeysFromContent('res.json({ data, total })');
    expect(keys).toEqual(['data', 'total']);
  });

  it('extracts key-value properties (values that look like identifiers are also captured)', () => {
    // Limitation: the text-based parser can't distinguish `data: grants` (key-value)
    // from `grants` (shorthand). Identifier values followed by , are captured as keys.
    // This is acceptable — false positive keys are better than missed keys.
    const keys = extractKeysFromContent('res.json({ data: grants, count: 5 })');
    expect(keys).toContain('data');
    expect(keys).toContain('count');
  });

  it('handles nested objects without extracting inner keys', () => {
    const keys = extractKeysFromContent(
      'res.json({ data: grants, pagination: { page: 1, total: 10 }, meta: "ok" })'
    );
    expect(keys).toContain('data');
    expect(keys).toContain('pagination');
    expect(keys).toContain('meta');
    expect(keys).not.toContain('page');
    expect(keys).not.toContain('total');
  });

  it('handles braces inside string literals', () => {
    const keys = extractKeysFromContent(
      'res.json({ message: "Use { and } carefully", count: 5 })'
    );
    expect(keys).toContain('message');
    expect(keys).toContain('count');
    expect(keys).not.toContain('and');
    expect(keys).not.toContain('carefully');
  });

  it('handles escaped quotes in strings', () => {
    const keys = extractKeysFromContent(
      'res.json({ msg: "He said \\"hello\\"", ok: true })'
    );
    expect(keys).toContain('msg');
    expect(keys).toContain('ok');
  });

  it('handles NextResponse.json pattern', () => {
    const keys = extractKeysFromContent(
      'return NextResponse.json({ data: grants, pagination: { page: 1 } })'
    );
    expect(keys).toContain('data');
    expect(keys).toContain('pagination');
    expect(keys).not.toContain('page');
  });

  it('returns empty for non-object arguments', () => {
    const keys = extractKeysFromContent('res.json("error")');
    expect(keys).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Middleware chain extraction
// ---------------------------------------------------------------------------

describe('middleware chain extraction', () => {
  it('extracts triple-nested middleware chain', () => {
    const content = `export const POST = withRateLimit(withCSRF(withAuth(async (req) => { return NextResponse.json({ ok: true }); })));`;
    expect(extractMiddlewareChain(content)).toEqual({ chain: ['withRateLimit', 'withCSRF', 'withAuth'], method: 'POST' });
  });

  it('extracts double-nested middleware chain', () => {
    const content = `export const GET = withAuth(withCache(handler));`;
    expect(extractMiddlewareChain(content)).toEqual({ chain: ['withAuth', 'withCache'], method: 'GET' });
  });

  it('extracts single withX wrapper', () => {
    const content = `export const POST = withAuth(handler);`;
    expect(extractMiddlewareChain(content)).toEqual({ chain: ['withAuth'], method: 'POST' });
  });

  it('extracts from export default', () => {
    const content = `export default withAuth(handler);`;
    expect(extractMiddlewareChain(content)).toEqual({ chain: ['withAuth'], method: 'default' });
  });

  it('extracts from export default with nesting', () => {
    const content = `export default withRateLimit(withAuth(handler));`;
    expect(extractMiddlewareChain(content)).toEqual({ chain: ['withRateLimit', 'withAuth'], method: 'default' });
  });

  it('stops at async keyword (arrow function body)', () => {
    const content = `export const POST = withAuth(async (req) => { return res.json({}); });`;
    expect(extractMiddlewareChain(content)).toEqual({ chain: ['withAuth'], method: 'POST' });
  });

  it('returns undefined for plain handler without wrappers', () => {
    const content = `export const POST = handler;`;
    expect(extractMiddlewareChain(content)).toBeUndefined();
  });

  it('returns undefined for non-middleware single wrapper', () => {
    // createHandler is not a withX pattern and chain length is 1
    const content = `export const POST = createHandler(config);`;
    expect(extractMiddlewareChain(content)).toBeUndefined();
  });

  it('handles multiple HTTP methods — uses first match', () => {
    const content = `
      export const GET = withCache(handler);
      export const POST = withAuth(withCSRF(handler));
    `;
    expect(extractMiddlewareChain(content)).toEqual({ chain: ['withCache'], method: 'GET' });
  });

  it('handles whitespace and newlines in chain', () => {
    const content = `export const POST = withRateLimit(\n  withAuth(\n    async (req) => {}\n  )\n);`;
    expect(extractMiddlewareChain(content)).toEqual({ chain: ['withRateLimit', 'withAuth'], method: 'POST' });
  });

  it('handles DELETE method', () => {
    const content = `export const DELETE = withAuth(withAdmin(handler));`;
    expect(extractMiddlewareChain(content)).toEqual({ chain: ['withAuth', 'withAdmin'], method: 'DELETE' });
  });

  it('returns undefined when no export pattern exists', () => {
    const content = `const handler = withAuth(doSomething);`;
    expect(extractMiddlewareChain(content)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Error response shape detection (detectStatusCode + separation logic)
// ---------------------------------------------------------------------------

describe('detectStatusCode', () => {
  it('detects Express .status(N).json() pattern', () => {
    const content = 'return res.status(400).json({ error: "bad request" })';
    const jsonPos = content.indexOf('.json');
    expect(detectStatusCode(content, jsonPos, -1)).toBe(400);
  });

  it('detects NextResponse.json({...}, { status: 400 }) pattern', () => {
    const content = 'return NextResponse.json({ error: "not found" }, { status: 404 })';
    const jsonPos = content.indexOf('.json');
    // Simulate closingBracePos at the end of first arg object
    const firstArgClose = content.indexOf('}');
    expect(detectStatusCode(content, jsonPos, firstArgClose)).toBe(404);
  });

  it('detects NextResponse.json({...}, { status: 200 }) as success', () => {
    const content = 'return NextResponse.json({ data: results }, { status: 200 })';
    const jsonPos = content.indexOf('.json');
    const firstArgClose = content.indexOf('}');
    expect(detectStatusCode(content, jsonPos, firstArgClose)).toBe(200);
  });

  it('returns undefined when no status code present', () => {
    const content = 'return NextResponse.json({ data: results })';
    const jsonPos = content.indexOf('.json');
    const firstArgClose = content.indexOf('}');
    expect(detectStatusCode(content, jsonPos, firstArgClose)).toBeUndefined();
  });

  it('detects .status(500).json() for server error', () => {
    const content = 'res.status(500).json({ error: "Internal server error", code: "SERVER_ERROR" })';
    const jsonPos = content.indexOf('.json');
    expect(detectStatusCode(content, jsonPos, -1)).toBe(500);
  });

  it('detects status in second arg with extra properties', () => {
    const content = 'return NextResponse.json({ error: "fail" }, { status: 422, headers: {} })';
    const jsonPos = content.indexOf('.json');
    const firstArgClose = content.indexOf('}');
    expect(detectStatusCode(content, jsonPos, firstArgClose)).toBe(422);
  });
});

describe('error response shape separation', () => {
  it('separates success and error responses in NextResponse pattern', () => {
    const content = `
      export async function GET() {
        try {
          const data = await fetchData();
          return NextResponse.json({ data, pagination: { page: 1 } });
        } catch (e) {
          return NextResponse.json({ error: "Failed", message: e.message }, { status: 500 });
        }
      }
    `;
    const shapes = extractResponseShapes(content);
    expect(shapes.responseKeys).toEqual(['data', 'pagination']);
    expect(shapes.errorKeys).toEqual(['error', 'message']);
  });

  it('separates success and error responses in Express pattern', () => {
    const content = `
      app.get('/api/users', (req, res) => {
        try {
          const users = getUsers();
          res.json({ users, total });
        } catch (e) {
          res.status(500).json({ error: "Server error", code: "INTERNAL" });
        }
      });
    `;
    const shapes = extractResponseShapes(content);
    expect(shapes.responseKeys).toEqual(['users', 'total']);
    expect(shapes.errorKeys).toEqual(['error', 'code']);
  });

  it('handles multiple error status codes', () => {
    const content = `
      export async function POST(req) {
        if (!req.body) return NextResponse.json({ error: "No body" }, { status: 400 });
        if (!authorized) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        return NextResponse.json({ data, id });
      }
    `;
    const shapes = extractResponseShapes(content);
    expect(shapes.responseKeys).toEqual(['data', 'id']);
    expect(shapes.errorKeys).toEqual(['error']);
  });

  it('falls back to all keys as responseKeys when no status codes present', () => {
    const content = `
      export async function GET() {
        return NextResponse.json({ data, count });
      }
    `;
    const shapes = extractResponseShapes(content);
    expect(shapes.responseKeys).toEqual(['data', 'count']);
    expect(shapes.errorKeys).toBeUndefined();
  });

  it('treats status 200 as success', () => {
    const content = `return NextResponse.json({ ok }, { status: 200 })`;
    const shapes = extractResponseShapes(content);
    expect(shapes.responseKeys).toEqual(['ok']);
    expect(shapes.errorKeys).toBeUndefined();
  });

  it('treats status 201 as success', () => {
    const content = `return NextResponse.json({ created, id }, { status: 201 })`;
    const shapes = extractResponseShapes(content);
    expect(shapes.responseKeys).toEqual(['created', 'id']);
    expect(shapes.errorKeys).toBeUndefined();
  });
});

describe('PHP response shape extraction', () => {
  it('extracts keys from short array syntax', () => {
    const content = `echo json_encode(['success' => true, 'data' => $items], JSON_UNESCAPED_UNICODE);`;
    const shapes = extractPHPResponseShapes(content);
    expect(shapes.responseKeys).toEqual(['success', 'data']);
    expect(shapes.errorKeys).toBeUndefined();
  });

  it('extracts keys from long array syntax', () => {
    const content = `echo json_encode(array('ok' => true, 'count' => $n));`;
    const shapes = extractPHPResponseShapes(content);
    expect(shapes.responseKeys).toEqual(['ok', 'count']);
  });

  it('classifies error responses by http_response_code', () => {
    const content = `
      http_response_code(401);
      echo json_encode(['error' => 'Unauthorized'], JSON_UNESCAPED_UNICODE);
    `;
    const shapes = extractPHPResponseShapes(content);
    expect(shapes.responseKeys).toBeUndefined();
    expect(shapes.errorKeys).toEqual(['error']);
  });

  it('separates success and error responses', () => {
    const content = `
      header('Content-Type: application/json');
      if (!is_logged_in()) {
        http_response_code(401);
        echo json_encode(['error' => 'Not logged in'], JSON_UNESCAPED_UNICODE);
        exit;
      }
      echo json_encode(['ok' => true, 'new_status' => $status], JSON_UNESCAPED_UNICODE);
    `;
    const shapes = extractPHPResponseShapes(content);
    expect(shapes.responseKeys).toEqual(['ok', 'new_status']);
    expect(shapes.errorKeys).toEqual(['error']);
  });

  it('handles multiple error status codes with exit boundaries', () => {
    const content = `
      if (!$user) {
        http_response_code(401);
        echo json_encode(['error' => 'Unauthorized'], JSON_UNESCAPED_UNICODE);
        exit;
      }
      if (!$valid) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid data', 'field' => 'name'], JSON_UNESCAPED_UNICODE);
        exit;
      }
      echo json_encode(['ok' => true, 'id' => $id], JSON_UNESCAPED_UNICODE);
    `;
    const shapes = extractPHPResponseShapes(content);
    expect(shapes.responseKeys).toEqual(['ok', 'id']);
    expect(shapes.errorKeys).toEqual(['error', 'field']);
  });

  it('detects status from header() pattern', () => {
    const content = `
      header('HTTP/1.1 403 Forbidden');
      echo json_encode(['error' => 'Forbidden', 'message' => 'Access denied']);
    `;
    const shapes = extractPHPResponseShapes(content);
    expect(shapes.errorKeys).toEqual(['error', 'message']);
  });

  it('skips json_encode with variable argument', () => {
    const content = `echo json_encode($data, JSON_UNESCAPED_UNICODE);`;
    const shapes = extractPHPResponseShapes(content);
    expect(shapes.responseKeys).toBeUndefined();
    expect(shapes.errorKeys).toBeUndefined();
  });

  it('extracts only top-level keys from nested arrays', () => {
    const content = `echo json_encode(['data' => ['nested' => true], 'total' => $count]);`;
    const shapes = extractPHPResponseShapes(content);
    expect(shapes.responseKeys).toEqual(['data', 'total']);
  });

  it('handles json_encode with flags after array', () => {
    const content = `echo json_encode(['export' => $data], JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);`;
    const shapes = extractPHPResponseShapes(content);
    expect(shapes.responseKeys).toEqual(['export']);
  });

  it('recognizes exit(N) as a boundary', () => {
    const content = `
      http_response_code(401);
      echo json_encode(['error' => 'Unauthorized']);
      exit(0);
      echo json_encode(['ok' => true, 'data' => $result]);
    `;
    const shapes = extractPHPResponseShapes(content);
    expect(shapes.responseKeys).toEqual(['ok', 'data']);
    expect(shapes.errorKeys).toEqual(['error']);
  });

  it('recognizes die("msg") as a boundary', () => {
    const content = `
      http_response_code(500);
      echo json_encode(['error' => 'DB error']);
      die('Fatal');
      echo json_encode(['items' => $list]);
    `;
    const shapes = extractPHPResponseShapes(content);
    expect(shapes.responseKeys).toEqual(['items']);
    expect(shapes.errorKeys).toEqual(['error']);
  });

  it('detects CGI Status header format', () => {
    const content = `
      header('Status: 404 Not Found');
      echo json_encode(['error' => 'Not found', 'code' => 'MISSING']);
    `;
    const shapes = extractPHPResponseShapes(content);
    expect(shapes.errorKeys).toEqual(['error', 'code']);
    expect(shapes.responseKeys).toBeUndefined();
  });
});
