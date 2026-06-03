/**
 * Direct CLI Tool Commands
 * 
 * Exposes GitNexus tools (query, context, impact, cypher) as direct CLI commands.
 * Bypasses MCP entirely — invokes LocalBackend directly for minimal overhead.
 * 
 * Usage:
 *   gitnexus query "authentication flow"
 *   gitnexus context --name "validateUser"
 *   gitnexus impact --target "AuthService" --direction upstream
 *   gitnexus cypher "MATCH (n:Function) RETURN n.name LIMIT 10"
 * 
 * Note: Output goes to stdout via fs.writeSync(fd 1), bypassing LadybugDB's
 * native module which captures the Node.js process.stdout stream during init.
 * See the output() function for details (#324).
 */

import { writeSync } from 'node:fs';
import fs from 'node:fs';
import path from 'node:path';
import { resolve } from 'path';
import os from 'node:os';
import { LocalBackend } from '../mcp/local/local-backend.js';
import type { DocumentEndpointResult } from '../mcp/local/document-endpoint.js';
import { ensureHeap } from './heap-utils.js';

/**
 * Validates that the user-provided output path is safe to use.
 * Prevents path traversal attacks by ensuring the resolved path
 * stays within allowed directories (cwd, home, /tmp, /var/tmp).
 */
function validateOutputPath(userPath: string): string {
  const resolved = resolve(userPath);

  // Check for path traversal sequences
  if (userPath.includes('..')) {
    console.error('Error: --outputPath cannot contain ".." sequences');
    process.exit(1);
  }

  // Resolve to absolute and verify it's within safe boundaries
  const cwd = process.cwd();
  const home = process.env.HOME || process.env.USERPROFILE;
  const tmpDir = resolve(os.tmpdir());
  const safeRoots = [cwd, home, '/tmp', '/var/tmp', tmpDir].filter(Boolean);

  const isSafe = safeRoots.some(root => resolved.startsWith(resolve(root)));

  if (!isSafe) {
    console.error(`Error: --outputPath must be within current directory, home, or /tmp`);
    process.exit(1);
  }

  return resolved;
}

let _backend: LocalBackend | null = null;

export function resetBackendForTesting(): void {
  _backend = null;
}

async function getBackend(): Promise<LocalBackend> {
  if (_backend) return _backend;
  _backend = new LocalBackend();
  const ok = await _backend.init();
  if (!ok) {
    console.error('GitNexus: No indexed repositories found. Run: gitnexus analyze');
    process.exit(1);
  }
  return _backend;
}

/**
 * Write tool output to stdout using low-level fd write.
 *
 * LadybugDB's native module captures Node.js process.stdout during init,
 * but the underlying OS file descriptor 1 (stdout) remains intact.
 * By using fs.writeSync(1, ...) we bypass the Node.js stream layer
 * and write directly to the real stdout fd (#324).
 *
 * Falls back to stderr if the fd write fails (e.g., broken pipe).
 */

/**
 * JSON replacer that converts Map instances to plain objects.
 * JavaScript's JSON.stringify serializes Map as {} — this replacer
 * preserves nestedSchemas entries (and any other Map-valued fields)
 * in CLI JSON output without modifying in-memory data structures.
 */
/**
 * Deep-clone an object, stripping all undefined values (including nested).
 * Ensures no `undefined` literals leak into JSON output.
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

/**
 * JSON replacer that converts Map instances to plain objects and strips undefined.
 * JavaScript's JSON.stringify serializes Map as {} — this replacer
 * preserves nestedSchemas entries (and any other Map-valued fields)
 * in CLI JSON output without modifying in-memory data structures.
 */
const mapReplacer = (_key: string, value: unknown): unknown => {
  if (value === undefined) return undefined;
  if (value instanceof Map) return Object.fromEntries(value);
  return value;
};

function output(data: any): void {
  const text = typeof data === 'string' ? data : JSON.stringify(stripUndefined(data), mapReplacer, 2);
  try {
    writeSync(1, text + '\n');
  } catch (err: any) {
    if (err?.code === 'EPIPE') {
      // Consumer closed the pipe (e.g., `gitnexus cypher ... | head -1`)
      // Exit cleanly per Unix convention
      process.exit(0);
    }
    // Fallback: stderr (previous behavior, works on all platforms)
    process.stderr.write(text + '\n');
  }
}

export async function queryCommand(queryText: string, options?: {
  repo?: string;
  limit?: string;
  content?: boolean;
}): Promise<void> {
  if (!queryText?.trim()) {
    console.error('Usage: gitnexus query <search_query>');
    process.exit(1);
  }

  try {
    const backend = await getBackend();
    const result = await backend.callTool('query', {
      query: queryText,
      limit: options?.limit ? parseInt(options.limit) : undefined,
      include_content: options?.content ?? false,
      repo: options?.repo,
    });
    output(result);
  } catch (err: unknown) {
    // (#47) Catch infrastructure failures (getBackend, callTool
    // transport) — the most common case is the
    // `Multiple repositories indexed` error from resolveRepo. The
    // JSON shape mirrors `impact` for consistency. The user gets
    // a clean message + suggestion instead of a Node.js stack
    // trace.
    const message = (err instanceof Error ? err.message : String(err)) || 'Query failed unexpectedly';
    const isMultiRepo = /Multiple repositories indexed/i.test(message);
    output({
      error: message,
      ...(isMultiRepo && { suggestion: 'Pass --repo <name> to disambiguate' }),
    });
    process.exit(1);
  }
}

export async function contextCommand(name: string, options?: {
  repo?: string;
  file?: string;
  uid?: string;
  content?: boolean;
}): Promise<void> {
  if (!name?.trim() && !options?.uid) {
    console.error('Usage: gitnexus context <symbol_name> [--uid <uid>] [--file <path>]');
    process.exit(1);
  }

  try {
    const backend = await getBackend();
    const result = await backend.callTool('context', {
      name: name || undefined,
      uid: options?.uid,
      file_path: options?.file,
      include_content: options?.content ?? false,
      repo: options?.repo,
    });
    output(result);
  } catch (err: unknown) {
    // (#47) Same multi-repo error handling as queryCommand.
    const message = (err instanceof Error ? err.message : String(err)) || 'Context lookup failed unexpectedly';
    const isMultiRepo = /Multiple repositories indexed/i.test(message);
    output({
      error: message,
      ...(isMultiRepo && { suggestion: 'Pass --repo <name> to disambiguate' }),
    });
    process.exit(1);
  }
}

export async function impactCommand(target: string, options?: {
  direction?: string;
  repo?: string;
  depth?: string;
  includeTests?: boolean;
}): Promise<void> {
  if (ensureHeap()) return;

  if (!target?.trim()) {
    console.error('Usage: gitnexus impact <symbol_name> [--direction upstream|downstream]');
    process.exit(1);
  }

  try {
    const backend = await getBackend();
    const result = await backend.callTool('impact', {
      target,
      direction: options?.direction || 'upstream',
      maxDepth: options?.depth ? parseInt(options.depth, 10) : undefined,
      includeTests: options?.includeTests ?? false,
      repo: options?.repo,
    });
    output(result);
  } catch (err: unknown) {
    // Belt-and-suspenders: catch infrastructure failures (getBackend, callTool transport)
    // The backend's impact() already returns structured errors for graph query failures
    output({
      error: (err instanceof Error ? err.message : String(err)) || 'Impact analysis failed unexpectedly',
      target: { name: target },
      direction: options?.direction || 'upstream',
      suggestion: 'Try reducing --depth or using gitnexus context <symbol> as a fallback',
    });
    process.exit(1);
  }
}

export async function cypherCommand(query: string, options?: {
  repo?: string;
}): Promise<void> {
  if (!query?.trim()) {
    console.error('Usage: gitnexus cypher <cypher_query>');
    process.exit(1);
  }

  const backend = await getBackend();
  const result = await backend.callTool('cypher', {
    query,
    repo: options?.repo,
  });
  output(result);
}

export async function documentEndpointCommand(options?: {
  method?: string;
  path?: string;
  depth?: string;
  mode?: 'openapi' | 'ai_context';
  inputYaml?: string;
  outputPath?: string;
  repo?: string;
  schemaPath?: string;
  strict?: boolean;
  all?: boolean;
  allowPartial?: boolean;
}): Promise<void> {
  if (ensureHeap()) return;

  if (options?.all) return runBatchMode(options);
  if (options?.inputYaml) return runYamlEnrichment(options);
  return runSingleEndpoint(options);
}

async function runBatchMode(options: Parameters<typeof documentEndpointCommand>[0]): Promise<void> {
  // Validate mutual exclusion
  if (options.method || options.path) {
    console.error('Error: --all cannot be used with --method or --path');
    process.exit(1);
  }

  if (!options.outputPath) {
    console.error('Error: --all requires --outputPath');
    process.exit(1);
  }

  if (options.inputYaml) {
    console.error('Error: --all is incompatible with --input-yaml (use single-endpoint mode for YAML enrichment)');
    process.exit(1);
  }

  const backend = await getBackend();
  const repoHandle = await backend.resolveRepo(options.repo);

  if (!repoHandle) {
    console.error(`Error: Repository "${options.repo ?? 'default'}" not found. Run 'gitnexus index' first.`);
    process.exit(1);
  }

  const safeOutputPath = validateOutputPath(options.outputPath);
  fs.mkdirSync(safeOutputPath, { recursive: true });

  const endpointsResult = await backend.callTool<{ endpoints: Array<{ method: string; path: string }> }>('endpoints', { repo: options.repo });
  const endpoints = endpointsResult.endpoints ?? [];

  if (endpoints.length === 0) {
    console.error('Warning: No endpoints found in repository');
    process.exit(0);
  }

  console.error(`Processing ${endpoints.length} endpoints...`);

  let successCount = 0;
  const errors: Array<{ method: string; path: string; error: string }> = [];

  for (let i = 0; i < endpoints.length; i++) {
    const endpoint = endpoints[i];
    const progress = `${i + 1}/${endpoints.length}`;

    try {
      const response = await backend.callTool<{ yaml: string; method: string; path: string } | { result: { yaml: string; method: string; path: string }; error?: string }>('document-endpoint', {
        method: endpoint.method,
        path: endpoint.path,
        depth: options.depth ? parseInt(options.depth, 10) : 10,
        mode: 'openapi',
        repo: options.repo,
      });

      if (response && typeof response === 'object' && 'error' in response && response.error) {
        const errVal = response.error;
        throw new Error(typeof errVal === 'string' ? errVal : JSON.stringify(errVal));
      }

      const result = 'result' in response ? response.result : response;
      if (!('yaml' in result) || typeof result.yaml !== 'string') {
        throw new Error('Expected OpenAPI YAML output from documentEndpoint');
      }

      const sanitizedPath = endpoint.path
        .replace(/^\//, '')
        .replace(/[{}]/g, '')
        .replace(/[\/:.-]/g, '_')
        .replace(/_+/g, '_')
        .replace(/_$/, '');

      const baseName = `${(endpoint.method ?? 'UNKNOWN').toUpperCase()}_${sanitizedPath}`;
      const yamlPath = path.join(safeOutputPath, `${baseName}.openapi.yaml`);

      fs.writeFileSync(yamlPath, result.yaml, 'utf-8');
      console.error(`Written: ${yamlPath}`);
      successCount++;

    } catch (err: any) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`ERROR (${progress}): ${endpoint.method.toUpperCase()} ${endpoint.path}: ${errMsg}`);
      errors.push({ method: endpoint.method, path: endpoint.path, error: errMsg });
    }
  }

  console.error(`\nDocumented ${successCount}/${endpoints.length} endpoints successfully`);

  if (errors.length > 0) {
    console.error('\nFailed endpoints:');
    for (const { method, path, error } of errors) {
      console.error(`  ${method.toUpperCase()} ${path}: ${error}`);
    }
    if (!options?.allowPartial) {
      process.exit(1);
    }
    if (successCount > 0) {
      process.exit(0);
    }
    process.exit(1);
  }

  process.exit(0);
}

async function runYamlEnrichment(options: Parameters<typeof documentEndpointCommand>[0]): Promise<void> {
  let yamlContent: string;
  try {
    yamlContent = fs.readFileSync(options.inputYaml!, 'utf-8');
  } catch (err) {
    console.error(`Error: Cannot read file "${options.inputYaml!}": ${(err as NodeJS.ErrnoException).message}`);
    process.exit(1);
  }

  const backend = await getBackend();
  const repoHandle = await backend.resolveRepo(options.repo);

  if (!repoHandle) {
    console.error(`Error: Repository "${options.repo ?? 'default'}" not found. Run 'gitnexus index' first.`);
    process.exit(1);
  }

  const { enrichExistingYaml } = await import('../core/openapi/enricher.js');

  const enrichOptions = {
    method: options.method,
    path: options.path,
    maxDepth: options.depth ? parseInt(options.depth, 10) : 10,
  };

  try {
    const enriched = await enrichExistingYaml(yamlContent, repoHandle, enrichOptions);
    const safeInputPath = validateOutputPath(options.inputYaml!);
    const outputPath = options.outputPath
      ? validateOutputPath(path.join(options.outputPath,
          path.basename(safeInputPath).replace(/\.ya?ml$/, '.enriched.openapi.yaml')))
      : safeInputPath.replace(/\.ya?ml$/, '.enriched.openapi.yaml');

    fs.writeFileSync(outputPath, enriched, 'utf-8');
    console.error(`Enriched YAML written: ${outputPath}`);
  } catch (err) {
    console.error(`Error during YAML enrichment: ${(err as Error).message}`);
    process.exit(1);
  }
}

async function runSingleEndpoint(options: Parameters<typeof documentEndpointCommand>[0]): Promise<void> {
  if (!options?.method || !options?.path) {
    console.error('Usage: gitnexus document-endpoint --method <METHOD> --path <path-pattern>');
    console.error('  Or:  gitnexus document-endpoint --all --outputPath <dir>');
    console.error('  --all                   Document all endpoints (YAML only, requires --outputPath)');
    console.error('  --allow-partial         Exit 0 if >=1 endpoint succeeds (default: exit 1 on any failure)');
    console.error('  --method <METHOD>       HTTP method (GET, POST, PUT, DELETE, PATCH)');
    console.error('  --path <pattern>        Path pattern to match (e.g., "suggest", "/bookings/{id}")');
    console.error('  --depth <n>             Max trace depth (default: 10)');
    console.error('  --mode <mode>          Output mode: openapi (default) or ai_context');
    console.error('  --input-yaml <path>    CLI-only: path to existing YAML to enrich');
    console.error('  --outputPath <path>    Output directory for JSON and OpenAPI YAML files');
    console.error('  --schema-path <path>   Path to custom JSON schema file (default: bundled schema)');
    console.error('  --strict               Fail on schema validation errors (default: warn)');
    console.error('  --repo <name>          Target repository');
    process.exit(1);
  }

  const backend = await getBackend();
  // Union: OpenAPI mode returns yaml+method+path; ai_context returns full DocumentEndpointResult
  const response = await backend.callTool<{ yaml?: string; method: string; path: string; handlerClass?: string; handlerMethod?: string; summary?: string; specs?: unknown; [key: string]: unknown }>('document-endpoint', {
    method: options.method,
    path: options.path,
    depth: options.depth ? parseInt(options.depth, 10) : undefined,
    mode: options.mode ?? 'openapi',
    repo: options.repo,
  });

  const result = response;

  if (options.schemaPath || options.strict) {
    const { validateAgainstSchema, formatValidationErrors } = await import('../utils/schema-validator.js');
    const validation = validateAgainstSchema(result, undefined, options.schemaPath);

    if (!validation.valid) {
      const errorMsg = `Schema validation failed:\n${formatValidationErrors(validation)}`;
      if (options.strict) {
        console.error(errorMsg);
        process.exit(1);
      } else {
        console.error(`Warning: ${errorMsg}`);
      }
    }
  }

  if (options.outputPath) {
    const yamlMod = await import('js-yaml');
    const safeOutputPath = validateOutputPath(options.outputPath);
    fs.mkdirSync(safeOutputPath, { recursive: true });

    const sanitizedPath = result.path
      .replace(/^\//, '')
      .replace(/[{}]/g, '')
      .replace(/[\/:.-]/g, '_')
      .replace(/_+/g, '_')
      .replace(/_$/, '');
    const baseName = `${result.method.toUpperCase()}_${sanitizedPath}`;

    if ('yaml' in result && typeof result.yaml === 'string') {
      const yamlPath = path.join(safeOutputPath, `${baseName}.openapi.yaml`);
      fs.writeFileSync(yamlPath, result.yaml, 'utf-8');
      console.error(`Written: ${yamlPath}`);

      const metadata: Record<string, unknown> = { method: result.method, path: result.path };
      if (result.handlerClass) metadata.handlerClass = result.handlerClass;
      if (result.handlerMethod) metadata.handlerMethod = result.handlerMethod;
      const jsonPath = path.join(safeOutputPath, `${baseName}.json`);
      fs.writeFileSync(jsonPath, JSON.stringify(metadata, null, 2), 'utf-8');
      console.error(`Written: ${jsonPath}`);
    } else {
      const cleanResult = stripUndefined(result);

      const jsonPath = path.join(safeOutputPath, `${baseName}.json`);
      fs.writeFileSync(jsonPath, JSON.stringify(cleanResult, mapReplacer, 2), 'utf-8');

      const { convertToOpenAPIDocument } = await import('../core/openapi/converter.js');
      const openApiDoc = convertToOpenAPIDocument([cleanResult as unknown as DocumentEndpointResult], {
        title: `API - ${result.path}`,
        version: '1.0.0',
        nestedSchemas: (cleanResult as unknown as DocumentEndpointResult).nestedSchemas,
      });
      const yamlPath = path.join(safeOutputPath, `${baseName}.openapi.yaml`);
      fs.writeFileSync(yamlPath, yamlMod.dump(openApiDoc, { lineWidth: -1, noRefs: true }), 'utf-8');

      console.error(`Written: ${jsonPath}`);
      console.error(`Written: ${yamlPath}`);
    }
  } else {
    output(result);
  }
}
