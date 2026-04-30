import { createRequire } from 'node:module';
import { glob } from 'glob';
import type { ContractExtractor, CypherExecutor } from '../contract-extractor.js';
import type { ContractRole, ExtractedContract, RepoHandle } from '../types.js';
import { readSafe } from './fs-utils.js';
import { normalizeHttpPath } from './http-route-extractor.js';

const _require = createRequire(import.meta.url);
const yaml = _require('js-yaml') as typeof import('js-yaml');

const OPENAPI_SCAN_GLOBS = [
  '**/{openapi,swagger,api-docs}.{json,yaml,yml}',
  '**/{openapi,swagger,api-docs}/**/*.{json,yaml,yml}',
  '**/*.{openapi,swagger}.{json,yaml,yml}',
];

const OPENAPI_IGNORE = [
  '**/node_modules/**',
  '**/.git/**',
  '**/vendor/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
];

const HTTP_METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const ROLE_KEYS = [
  'x-gitnexus-role',
  'x-gitnexus-contract-role',
  'x-gitnexus-contractRole',
  'x-contract-role',
];

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readRole(value: unknown): ContractRole | null {
  if (!isRecord(value)) return null;
  for (const key of ROLE_KEYS) {
    const raw = value[key];
    if (typeof raw !== 'string') continue;
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'provider' || normalized === 'consumer') return normalized;
  }
  return null;
}

function parseSpec(content: string, rel: string): unknown {
  if (/\.(json)$/i.test(rel)) return JSON.parse(content);
  return yaml.load(content, { schema: yaml.JSON_SCHEMA });
}

function isOpenApiDocument(value: unknown): value is JsonObject {
  if (!isRecord(value)) return false;
  if (!isRecord(value.paths)) return false;
  return typeof value.openapi === 'string' || typeof value.swagger === 'string';
}

function normalizeBasePath(raw: string): string {
  const withoutQuery = raw.trim().split(/[?#]/)[0] ?? '';
  if (!withoutQuery || withoutQuery === '/') return '';
  return normalizeHttpPath(withoutQuery);
}

function serverBasePath(doc: JsonObject): string {
  if (typeof doc.basePath === 'string') return normalizeBasePath(doc.basePath);

  const servers = doc.servers;
  if (!Array.isArray(servers)) return '';
  const first = servers.find((entry) => isRecord(entry) && typeof entry.url === 'string');
  if (!isRecord(first) || typeof first.url !== 'string') return '';

  const url = first.url.trim();
  if (!url || url.includes('{')) return '';
  if (/^https?:\/\//i.test(url)) {
    try {
      return normalizeBasePath(new URL(url).pathname);
    } catch {
      return '';
    }
  }
  return url.startsWith('/') ? normalizeBasePath(url) : '';
}

function joinPaths(base: string, routePath: string): string {
  const cleanBase = base.replace(/^\/+|\/+$/g, '');
  const cleanRoute = routePath.replace(/^\/+/, '');
  if (!cleanBase) return `/${cleanRoute}`;
  if (!cleanRoute) return `/${cleanBase}`;
  return `/${cleanBase}/${cleanRoute}`;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === 'string');
  return strings.length > 0 ? strings : undefined;
}

function operationName(method: string, pathNorm: string, operation: JsonObject): string {
  const operationId = operation.operationId;
  if (typeof operationId === 'string' && operationId.trim()) return operationId.trim();
  return `${method.toUpperCase()} ${pathNorm}`;
}

function makeSymbolUid(
  role: ContractRole,
  filePath: string,
  method: string,
  pathNorm: string,
): string {
  return `openapi::${role}::${filePath}::${method.toUpperCase()}::${pathNorm}`;
}

export class OpenApiExtractor implements ContractExtractor {
  type = 'http' as const;

  async canExtract(_repo: RepoHandle): Promise<boolean> {
    return true;
  }

  async extract(
    _dbExecutor: CypherExecutor | null,
    repoPath: string,
    _repo: RepoHandle,
  ): Promise<ExtractedContract[]> {
    const files = await this.scanFiles(repoPath);
    const out: ExtractedContract[] = [];

    for (const rel of files) {
      const content = readSafe(repoPath, rel);
      if (!content) continue;

      let doc: unknown;
      try {
        doc = parseSpec(content, rel);
      } catch {
        continue;
      }
      if (!isOpenApiDocument(doc)) continue;

      out.push(...this.extractDocument(doc, rel.replace(/\\/g, '/')));
    }

    return this.dedupe(out);
  }

  private async scanFiles(repoPath: string): Promise<string[]> {
    const found = new Set<string>();
    for (const pattern of OPENAPI_SCAN_GLOBS) {
      const matches = await glob(pattern, {
        cwd: repoPath,
        ignore: OPENAPI_IGNORE,
        nodir: true,
      });
      for (const rel of matches) found.add(rel);
    }
    return [...found].sort();
  }

  private extractDocument(doc: JsonObject, filePath: string): ExtractedContract[] {
    const out: ExtractedContract[] = [];
    const paths = doc.paths;
    if (!isRecord(paths)) return out;

    const docRole = readRole(doc) ?? 'provider';
    const basePath = serverBasePath(doc);
    const specVersion =
      typeof doc.openapi === 'string'
        ? doc.openapi
        : typeof doc.swagger === 'string'
          ? doc.swagger
          : '';

    for (const [rawPath, pathItem] of Object.entries(paths)) {
      if (!isRecord(pathItem)) continue;
      const pathRole = readRole(pathItem);

      for (const [rawMethod, operation] of Object.entries(pathItem)) {
        const methodKey = rawMethod.toLowerCase();
        if (!HTTP_METHODS.has(methodKey)) continue;
        if (!isRecord(operation)) continue;
        if (operation['x-gitnexus-ignore'] === true) continue;

        const method = methodKey.toUpperCase();
        const pathNorm = normalizeHttpPath(joinPaths(basePath, rawPath));
        const role = readRole(operation) ?? pathRole ?? docRole;
        const name = operationName(method, pathNorm, operation);
        const tags = asStringArray(operation.tags);

        out.push({
          contractId: `http::${method}::${pathNorm}`,
          type: 'http',
          role,
          symbolUid: makeSymbolUid(role, filePath, method, pathNorm),
          symbolRef: { filePath, name },
          symbolName: name,
          confidence: role === docRole ? 0.92 : 0.95,
          meta: {
            source: 'openapi',
            extractionStrategy: 'openapi',
            method,
            path: pathNorm,
            pathSegments: pathNorm.split('/').filter(Boolean),
            specFile: filePath,
            specVersion,
            operationId:
              typeof operation.operationId === 'string' ? operation.operationId : undefined,
            summary: typeof operation.summary === 'string' ? operation.summary : undefined,
            tags,
          },
        });
      }
    }

    return out;
  }

  private dedupe(items: ExtractedContract[]): ExtractedContract[] {
    const seen = new Set<string>();
    const out: ExtractedContract[] = [];
    for (const c of items) {
      const key = `${c.contractId}|${c.role}|${c.symbolRef.filePath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(c);
    }
    return out;
  }
}
