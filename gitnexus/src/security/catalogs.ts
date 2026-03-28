/**
 * Source and Sink Catalogs for Structural Security Scanning
 *
 * Sources: functions/patterns that introduce untrusted data into the application
 * Sinks: functions/patterns that perform dangerous operations with data
 *
 * These catalogs are used for BFS reachability analysis over the existing
 * CALLS graph — no CFG or data flow analysis needed.
 *
 * Based on OWASP Top 10 categories:
 * - A03: Injection (SQL, command, code)
 * - A07: XSS (cross-site scripting)
 * - A10: SSRF (server-side request forgery)
 */

export interface SourceEntry {
  /** Pattern to match in function content (regex-compatible string) */
  pattern: string;
  /** Category of the source */
  category: 'user_input' | 'environment' | 'file_read' | 'network';
  /** Languages this source applies to (empty = all) */
  languages?: string[];
  /** Description for reports */
  description: string;
}

export interface SinkEntry {
  /** Pattern to match in function name or content */
  pattern: string;
  /** OWASP category */
  owasp: 'A03-injection' | 'A07-xss' | 'A10-ssrf' | 'A01-access-control';
  /** Risk if reached from untrusted source */
  severity: 'critical' | 'high' | 'medium';
  /** Languages this sink applies to (empty = all) */
  languages?: string[];
  /** Description for reports */
  description: string;
}

// ── Source Catalog ──

export const SOURCE_CATALOG: SourceEntry[] = [
  // HTTP request data (Next.js, Express, Koa, Fastify)
  { pattern: 'request.json', category: 'user_input', description: 'Next.js request body (Request object)' },
  { pattern: 'req.json', category: 'user_input', description: 'Next.js request body (req shorthand)' },
  { pattern: 'req.body', category: 'user_input', description: 'Express request body' },
  { pattern: 'req.query', category: 'user_input', description: 'Express query parameters' },
  { pattern: 'req.params', category: 'user_input', description: 'Express route parameters' },
  { pattern: 'req.headers', category: 'user_input', description: 'HTTP request headers' },
  { pattern: 'request.GET', category: 'user_input', languages: ['python'], description: 'Django GET params' },
  { pattern: 'request.POST', category: 'user_input', languages: ['python'], description: 'Django POST data' },
  { pattern: 'request.data', category: 'user_input', languages: ['python'], description: 'DRF request data' },
  { pattern: '$_GET', category: 'user_input', languages: ['php'], description: 'PHP GET superglobal' },
  { pattern: '$_POST', category: 'user_input', languages: ['php'], description: 'PHP POST superglobal' },
  { pattern: '$_REQUEST', category: 'user_input', languages: ['php'], description: 'PHP REQUEST superglobal' },
  { pattern: 'request.form', category: 'user_input', languages: ['python'], description: 'Flask form data' },
  { pattern: 'request.args', category: 'user_input', languages: ['python'], description: 'Flask query args' },
  { pattern: 'nextUrl.searchParams', category: 'user_input', description: 'Next.js URL search params' },

  // Go (net/http)
  { pattern: 'r.Body', category: 'user_input', languages: ['go'], description: 'Go HTTP request body' },
  { pattern: 'r.URL.Query()', category: 'user_input', languages: ['go'], description: 'Go URL query parameters' },
  { pattern: 'r.FormValue', category: 'user_input', languages: ['go'], description: 'Go form value' },
  { pattern: 'r.Header.Get', category: 'user_input', languages: ['go'], description: 'Go request header' },

  // Rust / Actix-web
  { pattern: 'web::Json', category: 'user_input', languages: ['rust'], description: 'Actix-web JSON extractor' },
  { pattern: 'web::Query', category: 'user_input', languages: ['rust'], description: 'Actix-web query extractor' },
  { pattern: 'web::Path', category: 'user_input', languages: ['rust'], description: 'Actix-web path extractor' },

  // Spring (Java/Kotlin)
  { pattern: '@RequestBody', category: 'user_input', languages: ['java', 'kotlin'], description: 'Spring request body annotation' },
  { pattern: '@RequestParam', category: 'user_input', languages: ['java', 'kotlin'], description: 'Spring request parameter annotation' },
  { pattern: '@PathVariable', category: 'user_input', languages: ['java', 'kotlin'], description: 'Spring path variable annotation' },

  // Rails (Ruby)
  { pattern: 'params[', category: 'user_input', languages: ['ruby'], description: 'Rails params hash access' },
  { pattern: 'request.body', category: 'user_input', languages: ['ruby'], description: 'Rails raw request body' },

  // Kotlin / Ktor
  { pattern: 'call.receive', category: 'user_input', languages: ['kotlin'], description: 'Ktor request body receive' },
  { pattern: 'call.parameters', category: 'user_input', languages: ['kotlin'], description: 'Ktor request parameters' },

  // FastAPI (Python)
  { pattern: 'async def endpoint', category: 'user_input', languages: ['python'], description: 'FastAPI auto-injected endpoint parameter' },

  // Environment
  { pattern: 'process.env', category: 'environment', description: 'Node.js env variable' },
  { pattern: 'os.environ', category: 'environment', languages: ['python'], description: 'Python env variable' },
  { pattern: 'getenv', category: 'environment', languages: ['php'], description: 'PHP env variable' },
  { pattern: 'os.Getenv', category: 'environment', languages: ['go'], description: 'Go env variable' },
  { pattern: 'std::env::var', category: 'environment', languages: ['rust'], description: 'Rust env variable' },
  { pattern: 'System.getenv', category: 'environment', languages: ['java', 'kotlin'], description: 'Java/Kotlin env variable' },
  { pattern: 'ENV[', category: 'environment', languages: ['ruby'], description: 'Ruby env variable' },

  // File reads
  { pattern: 'readFile', category: 'file_read', description: 'File read operation' },
  { pattern: 'readFileSync', category: 'file_read', description: 'Sync file read' },
  { pattern: 'os.ReadFile', category: 'file_read', languages: ['go'], description: 'Go file read' },
  { pattern: 'std::fs::read', category: 'file_read', languages: ['rust'], description: 'Rust file read' },

  // Network input
  { pattern: 'fetch(', category: 'network', description: 'Fetch API response' },
  { pattern: 'axios.get', category: 'network', description: 'Axios HTTP response' },
  { pattern: 'axios.post', category: 'network', description: 'Axios HTTP response' },
  { pattern: 'http.Get', category: 'network', languages: ['go'], description: 'Go HTTP client GET' },
  { pattern: 'reqwest::get', category: 'network', languages: ['rust'], description: 'Rust reqwest HTTP GET' },
];

// ── Sink Catalog ──

export const SINK_CATALOG: SinkEntry[] = [
  // A03: Injection — SQL
  { pattern: 'query', owasp: 'A03-injection', severity: 'critical', description: 'Raw SQL query' },
  { pattern: '$queryRaw', owasp: 'A03-injection', severity: 'critical', description: 'Prisma raw query' },
  { pattern: '$executeRaw', owasp: 'A03-injection', severity: 'critical', description: 'Prisma raw execute' },
  { pattern: 'rawQuery', owasp: 'A03-injection', severity: 'critical', description: 'Sequelize raw query' },

  // A03: Injection — Command
  { pattern: 'exec', owasp: 'A03-injection', severity: 'critical', description: 'Command execution' },
  { pattern: 'execSync', owasp: 'A03-injection', severity: 'critical', description: 'Sync command execution' },
  { pattern: 'spawn', owasp: 'A03-injection', severity: 'high', description: 'Process spawn' },
  { pattern: 'eval', owasp: 'A03-injection', severity: 'critical', description: 'Code evaluation' },
  { pattern: 'Function(', owasp: 'A03-injection', severity: 'critical', description: 'Dynamic function creation' },
  { pattern: 'subprocess.run', owasp: 'A03-injection', severity: 'critical', languages: ['python'], description: 'Python subprocess' },
  { pattern: 'os.system', owasp: 'A03-injection', severity: 'critical', languages: ['python'], description: 'Python system call' },
  { pattern: 'shell_exec', owasp: 'A03-injection', severity: 'critical', languages: ['php'], description: 'PHP shell exec' },

  // A03: Injection — Go
  { pattern: 'os.exec', owasp: 'A03-injection', severity: 'critical', languages: ['go'], description: 'Go command execution' },
  { pattern: 'sql.Query', owasp: 'A03-injection', severity: 'critical', languages: ['go'], description: 'Go raw SQL query' },

  // A03: Injection — Rust
  { pattern: 'Command::new', owasp: 'A03-injection', severity: 'critical', languages: ['rust'], description: 'Rust command execution' },
  { pattern: 'sqlx::query', owasp: 'A03-injection', severity: 'critical', languages: ['rust'], description: 'Rust sqlx raw query' },

  // A03: Injection — Spring (Java/Kotlin)
  { pattern: 'jdbcTemplate.query', owasp: 'A03-injection', severity: 'critical', languages: ['java', 'kotlin'], description: 'Spring JDBC raw query' },
  { pattern: 'Runtime.exec', owasp: 'A03-injection', severity: 'critical', languages: ['java', 'kotlin'], description: 'Java runtime command execution' },

  // A03: Injection — Rails (Ruby)
  { pattern: 'system(', owasp: 'A03-injection', severity: 'critical', languages: ['ruby'], description: 'Ruby system command execution' },
  { pattern: 'ActiveRecord::Base.connection.execute', owasp: 'A03-injection', severity: 'critical', languages: ['ruby'], description: 'Rails raw SQL execution' },

  // A07: XSS
  { pattern: 'innerHTML', owasp: 'A07-xss', severity: 'high', description: 'Direct HTML injection' },
  { pattern: 'dangerouslySetInnerHTML', owasp: 'A07-xss', severity: 'high', description: 'React unsafe HTML' },
  { pattern: 'document.write', owasp: 'A07-xss', severity: 'high', description: 'Document write' },
  { pattern: 'template.HTML', owasp: 'A07-xss', severity: 'high', languages: ['go'], description: 'Go template unescaped HTML' },

  // A10: SSRF
  { pattern: 'fetch(', owasp: 'A10-ssrf', severity: 'high', description: 'Server-side fetch with user URL' },
  { pattern: 'axios(', owasp: 'A10-ssrf', severity: 'high', description: 'Axios with user URL' },
  { pattern: 'http.get', owasp: 'A10-ssrf', severity: 'high', description: 'HTTP client with user URL' },
  { pattern: 'urllib.request', owasp: 'A10-ssrf', severity: 'high', languages: ['python'], description: 'Python URL request' },

  // Database writes (ORM — not injection per se, but data integrity sinks)
  { pattern: 'prisma.', owasp: 'A03-injection', severity: 'medium', description: 'Prisma ORM operation (check for raw queries)' },
  { pattern: '.create(', owasp: 'A03-injection', severity: 'medium', description: 'ORM create operation' },
  { pattern: '.update(', owasp: 'A03-injection', severity: 'medium', description: 'ORM update operation' },
];

// ── User-extensible catalog loading ──

export interface UserSecurityConfig {
  sources?: Array<{
    pattern: string;
    category: string;
    description: string;
    languages?: string[];
  }>;
  sinks?: Array<{
    pattern: string;
    owasp: string;
    severity: string;
    description: string;
    languages?: string[];
  }>;
}

/**
 * Load user-defined security catalog from `.gitnexus/security.json` in the repo root.
 * Returns null if the file doesn't exist or is invalid.
 */
export async function loadUserSecurityConfig(repoPath: string): Promise<UserSecurityConfig | null> {
  try {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const configPath = join(repoPath, '.gitnexus', 'security.json');
    const content = await readFile(configPath, 'utf-8');
    const config = JSON.parse(content) as UserSecurityConfig;
    return config;
  } catch {
    // File doesn't exist or is invalid — that's fine, just use built-in catalogs
    return null;
  }
}

/**
 * Merge user-defined entries with the built-in catalogs.
 * User entries are appended after built-in entries.
 */
export function mergeCatalogs(userConfig: UserSecurityConfig | null): {
  sources: SourceEntry[];
  sinks: SinkEntry[];
} {
  const sources = [...SOURCE_CATALOG];
  const sinks = [...SINK_CATALOG];

  if (userConfig?.sources) {
    for (const s of userConfig.sources) {
      sources.push({
        pattern: s.pattern,
        category: s.category as SourceEntry['category'],
        description: s.description,
        ...(s.languages ? { languages: s.languages } : {}),
      });
    }
  }

  if (userConfig?.sinks) {
    for (const s of userConfig.sinks) {
      sinks.push({
        pattern: s.pattern,
        owasp: s.owasp as SinkEntry['owasp'],
        severity: s.severity as SinkEntry['severity'],
        description: s.description,
        ...(s.languages ? { languages: s.languages } : {}),
      });
    }
  }

  return { sources, sinks };
}

/**
 * Compile an array of catalog entries into regex patterns for matching.
 */
export function compilePatterns<T extends { pattern: string }>(entries: T[]): CompiledPattern<T>[] {
  return entries.map(entry => ({
    regex: new RegExp(escapeRegex(entry.pattern), 'i'),
    entry,
  }));
}

// Compiled regex patterns for matching
interface CompiledPattern<T> {
  regex: RegExp;
  entry: T;
}

const SOURCE_REGEXES: CompiledPattern<SourceEntry>[] = compilePatterns(SOURCE_CATALOG);

const SINK_REGEXES: CompiledPattern<SinkEntry>[] = compilePatterns(SINK_CATALOG);

/** Check if a compiled pattern applies given the language and content. */
function patternMatches<T extends { languages?: string[] }>(
  { regex, entry }: CompiledPattern<T>,
  content: string,
  language?: string,
): boolean {
  if (entry.languages && language && !entry.languages.includes(language)) return false;
  return regex.test(content);
}

/** Filter compiled patterns by language applicability and content match. */
function matchPatterns<T extends { languages?: string[] }>(
  patterns: CompiledPattern<T>[],
  content: string,
  language?: string,
): T[] {
  return patterns
    .filter(p => patternMatches(p, content, language))
    .map(({ entry }) => entry);
}

/**
 * Check if a function's content contains source patterns (user input reads).
 * Optionally accepts custom compiled patterns (e.g. merged with user config).
 */
export function isSourceAdjacent(_functionName: string, content: string, language?: string, customPatterns?: CompiledPattern<SourceEntry>[]): boolean {
  return (customPatterns ?? SOURCE_REGEXES).some(p => patternMatches(p, content, language));
}

/**
 * Check if a function's content contains sink patterns (dangerous operations).
 * Optionally accepts custom compiled patterns (e.g. merged with user config).
 */
export function isSinkAdjacent(_functionName: string, content: string, language?: string, customPatterns?: CompiledPattern<SinkEntry>[]): boolean {
  return (customPatterns ?? SINK_REGEXES).some(p => patternMatches(p, content, language));
}

/**
 * Get matching sink entries for a function's content (for reporting).
 * Optionally accepts custom compiled patterns (e.g. merged with user config).
 */
export function getMatchingSinks(content: string, language?: string, customPatterns?: CompiledPattern<SinkEntry>[]): SinkEntry[] {
  return matchPatterns(customPatterns ?? SINK_REGEXES, content, language);
}

/**
 * Get matching source entries for a function's content (for reporting).
 * Optionally accepts custom compiled patterns (e.g. merged with user config).
 */
export function getMatchingSources(content: string, language?: string, customPatterns?: CompiledPattern<SourceEntry>[]): SourceEntry[] {
  return matchPatterns(customPatterns ?? SOURCE_REGEXES, content, language);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
