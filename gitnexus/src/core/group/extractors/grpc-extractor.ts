import * as path from 'node:path';
import { glob } from 'glob';
import Parser from 'tree-sitter';
import type { ContractExtractor, CypherExecutor } from '../contract-extractor.js';
import type { ExtractedContract, RepoHandle } from '../types.js';
import { readSafe } from './fs-utils.js';
import {
  GRPC_SCAN_GLOB,
  getPluginForFile,
  hasProtoPlugin,
  type GrpcDetection,
} from './grpc-patterns/index.js';

/**
 * Language-agnostic orchestrator for gRPC (provider + consumer) contract
 * extraction.
 *
 * Two parts:
 *
 * 1. **`.proto` parsing** — tree-sitter when `tree-sitter-proto` is
 *    installed (optionalDependency vendored in `vendor/tree-sitter-proto/`),
 *    via the `.proto` entry in `grpc-patterns/` and `hasProtoPlugin`.
 *    When the grammar isn't available (platform incompatibility, native
 *    build failure) the orchestrator falls back to the in-process
 *    string-sanitizing parser defined below (`stripProtoCommentsAndStrings`
 *    + `extractServiceBlocks`). The fallback preserves offsets so any
 *    downstream regex scans run against a sanitized copy without
 *    affecting line numbers of the original.
 *
 * 2. **Source-scan providers / consumers** — delegated to per-language
 *    plugins in `./grpc-patterns/`. The orchestrator imports NO
 *    tree-sitter grammars or query strings — each plugin owns its own.
 */

// ─── .proto fallback parser (used only when tree-sitter-proto is absent) ───

function contractId(pkg: string, service: string, method: string): string {
  const prefix = pkg ? `${pkg}.${service}` : service;
  return `grpc::${prefix}/${method}`;
}

function serviceOnlyContractId(serviceName: string): string {
  return `grpc::${serviceName}/*`;
}

/**
 * Replace all .proto comments and string literals with spaces, preserving the
 * original length and character offsets of the input. This lets downstream
 * regex / brace-depth parsers run on a "sanitized" copy without having to
 * understand proto syntax, while any RegExp.exec/index-based lookups that
 * were already positional against `content` continue to work against the
 * original string.
 *
 * Supported comment forms: `// line comment`, `/* block comment * /`.
 * Supported strings: double-quoted ("…") and single-quoted ('…') with `\`
 * escape handling. Raw/unterminated strings are not supported — we stop
 * on a line break for line-style comments and on EOF for unterminated
 * strings/blocks, which matches how most real proto files parse.
 */
function stripProtoCommentsAndStrings(content: string): string {
  const out = new Array<string>(content.length);
  let i = 0;
  while (i < content.length) {
    const ch = content[i];
    const next = content[i + 1];

    // Line comment: // ... \n
    if (ch === '/' && next === '/') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      while (i < content.length && content[i] !== '\n') {
        out[i] = content[i] === '\r' ? '\r' : ' ';
        i++;
      }
      continue;
    }

    // Block comment: /* ... */
    if (ch === '/' && next === '*') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      while (i < content.length) {
        if (content[i] === '*' && content[i + 1] === '/') {
          out[i] = ' ';
          out[i + 1] = ' ';
          i += 2;
          break;
        }
        // Preserve newlines so line numbers stay stable for downstream code.
        out[i] = content[i] === '\n' || content[i] === '\r' ? content[i] : ' ';
        i++;
      }
      continue;
    }

    // String literal: "..." or '...'
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out[i] = ' '; // replace opening quote
      i++;
      while (i < content.length) {
        const c = content[i];
        if (c === '\\' && i + 1 < content.length) {
          // Skip escaped pair (e.g. \" \n \\)
          out[i] = ' ';
          out[i + 1] = ' ';
          i += 2;
          continue;
        }
        if (c === quote) {
          out[i] = ' ';
          i++;
          break;
        }
        // Preserve newlines; proto technically disallows unescaped newlines
        // inside strings, but real files occasionally have them.
        out[i] = c === '\n' || c === '\r' ? c : ' ';
        i++;
      }
      continue;
    }

    out[i] = ch;
    i++;
  }
  return out.join('');
}

function extractServiceBlocks(content: string): Array<{ name: string; body: string }> {
  const results: Array<{ name: string; body: string }> = [];
  // Sanitize comments and string literals so braces inside them don't
  // throw off the depth counter. The sanitized copy has the same length
  // and offsets as the original, so we use it ONLY to scan for service
  // headers and braces; the service body we return is sliced from the
  // ORIGINAL content to preserve exact source text for downstream use.
  const sanitized = stripProtoCommentsAndStrings(content);
  const headerRe = /service\s+(\w+)\s*\{/g;
  let headerMatch: RegExpExecArray | null;

  while ((headerMatch = headerRe.exec(sanitized)) !== null) {
    const serviceName = headerMatch[1];
    const bodyStart = headerMatch.index + headerMatch[0].length;
    let depth = 1;
    let pos = bodyStart;

    while (pos < sanitized.length && depth > 0) {
      const ch = sanitized[pos];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      pos++;
    }

    // If EOF before depth returns to 0, skip incomplete service
    if (depth !== 0) continue;

    // body is between opening { (consumed by regex) and closing } (pos is one past it)
    const body = content.slice(bodyStart, pos - 1);
    results.push({ name: serviceName, body });
  }

  return results;
}

function makeContract(
  cid: string,
  role: 'provider' | 'consumer',
  filePath: string,
  symbolName: string,
  confidence: number,
  meta: Record<string, unknown>,
): ExtractedContract {
  return {
    contractId: cid,
    type: 'grpc',
    role,
    symbolUid: '',
    symbolRef: { filePath: filePath.replace(/\\/g, '/'), name: symbolName },
    symbolName,
    confidence,
    meta: { ...meta, extractionStrategy: 'source_scan' },
  };
}

export interface ProtoServiceInfo {
  package: string;
  serviceName: string;
  methods: string[];
  protoPath: string;
}

function normalizeProtoPath(rel: string): string {
  return rel.replace(/\\/g, '/');
}

function extractProtoImports(content: string): string[] {
  const imports: string[] = [];
  const re = /^\s*import\s+"([^"]+)"\s*;/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    imports.push(match[1]);
  }
  return imports;
}

function longestSharedSegmentRun(aPath: string, bPath: string): number {
  const a = aPath.split('/').filter(Boolean);
  const b = bPath.split('/').filter(Boolean);
  let best = 0;

  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let run = 0;
      while (a[i + run] && b[j + run] && a[i + run] === b[j + run]) {
        run++;
      }
      if (run > best) best = run;
    }
  }

  return best;
}

async function buildProtoContext(repoPath: string): Promise<{
  packagesByProto: Map<string, string>;
  servicesByName: Map<string, ProtoServiceInfo[]>;
}> {
  const servicesByName = new Map<string, ProtoServiceInfo[]>();
  const protoFiles = await glob('**/*.proto', {
    cwd: repoPath,
    absolute: false,
    nodir: true,
    ignore: ['**/node_modules/**', '**/.git/**', '**/vendor/**'],
  });
  const contents = new Map<string, string>();

  for (const rel of protoFiles) {
    const content = readSafe(repoPath, rel);
    if (!content) continue;
    contents.set(normalizeProtoPath(rel), content);
  }

  const packagesByProto = new Map<string, string>();

  const resolvePackage = (protoPath: string, seen = new Set<string>()): string => {
    if (packagesByProto.has(protoPath)) return packagesByProto.get(protoPath) ?? '';
    if (seen.has(protoPath)) return '';

    const content = contents.get(protoPath);
    if (!content) return '';

    seen.add(protoPath);
    const pkgMatch = content.match(/^\s*package\s+([\w.]+)\s*;/m);
    if (pkgMatch?.[1]) {
      packagesByProto.set(protoPath, pkgMatch[1]);
      return pkgMatch[1];
    }

    for (const importPath of extractProtoImports(content)) {
      const normalizedImport = normalizeProtoPath(importPath);
      const candidates = [
        normalizeProtoPath(
          path.posix.normalize(path.posix.join(path.posix.dirname(protoPath), normalizedImport)),
        ),
        normalizedImport,
      ];
      for (const candidate of candidates) {
        if (!contents.has(candidate)) continue;
        const inheritedPackage = resolvePackage(candidate, seen);
        if (inheritedPackage) {
          packagesByProto.set(protoPath, inheritedPackage);
          return inheritedPackage;
        }
      }
    }

    packagesByProto.set(protoPath, '');
    return '';
  };

  for (const rel of protoFiles) {
    const normalizedRel = normalizeProtoPath(rel);
    const content = contents.get(normalizedRel);
    if (!content) continue;
    const pkg = resolvePackage(normalizedRel);

    const serviceBlocks = extractServiceBlocks(content);
    for (const block of serviceBlocks) {
      const rpcRe = /rpc\s+(\w+)\s*\(/g;
      const methods: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = rpcRe.exec(block.body)) !== null) {
        methods.push(m[1]);
      }
      const info: ProtoServiceInfo = {
        package: pkg,
        serviceName: block.name,
        methods,
        protoPath: normalizedRel,
      };
      const existing = servicesByName.get(block.name) ?? [];
      existing.push(info);
      servicesByName.set(block.name, existing);
    }
  }

  return { packagesByProto, servicesByName };
}

export async function buildProtoMap(repoPath: string): Promise<Map<string, ProtoServiceInfo[]>> {
  const { servicesByName } = await buildProtoContext(repoPath);
  return servicesByName;
}

export function resolveProtoConflict(
  _serviceName: string,
  sourceFilePath: string,
  candidates: ProtoServiceInfo[],
): ProtoServiceInfo | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const sourceDir = normalizeProtoPath(path.dirname(sourceFilePath));
  let best = candidates[0];
  let bestScore = -1;
  for (const c of candidates) {
    const protoDir = normalizeProtoPath(path.dirname(c.protoPath));
    const sharedRun = longestSharedSegmentRun(sourceDir, protoDir);
    if (sharedRun > bestScore) {
      bestScore = sharedRun;
      best = c;
    }
  }
  return best;
}

export function serviceContractId(pkg: string, serviceName: string): string {
  const prefix = pkg ? `${pkg}.${serviceName}` : serviceName;
  return `grpc::${prefix}/*`;
}

// ─── Orchestrator ────────────────────────────────────────────────────

export class GrpcExtractor implements ContractExtractor {
  type = 'grpc' as const;

  async canExtract(_repo: RepoHandle): Promise<boolean> {
    return true;
  }

  async extract(
    _dbExecutor: CypherExecutor | null,
    repoPath: string,
    _repo: RepoHandle,
  ): Promise<ExtractedContract[]> {
    const out: ExtractedContract[] = [];
    const protoContext = await buildProtoContext(repoPath);
    const protoMap = protoContext.servicesByName;

    // ─── Proto files — definitive provider source ─────────────────
    // When tree-sitter-proto is available, .proto files are handled by
    // the plugin loop below (they're in GRPC_SCAN_GLOB). Otherwise
    // emit provider contracts directly from the proto map that
    // `buildProtoContext` already built — no second glob / parse pass.
    if (!hasProtoPlugin) {
      for (const infos of protoMap.values()) {
        for (const info of infos) {
          for (const methodName of info.methods) {
            const cid = contractId(info.package, info.serviceName, methodName);
            out.push(
              makeContract(
                cid,
                'provider',
                info.protoPath,
                `${info.serviceName}.${methodName}`,
                0.85,
                {
                  package: info.package,
                  service: info.serviceName,
                  method: methodName,
                  source: 'proto',
                },
              ),
            );
          }
        }
      }
    }

    // ─── Source files (+ .proto when plugin available) ────────────
    const sourceFiles = await glob(GRPC_SCAN_GLOB, {
      cwd: repoPath,
      ignore: ['**/node_modules/**', '**/.git/**', '**/vendor/**', '**/dist/**', '**/build/**'],
      nodir: true,
    });

    const parser = new Parser();
    for (const rel of sourceFiles) {
      const plugin = getPluginForFile(rel);
      if (!plugin) continue;
      const content = readSafe(repoPath, rel);
      if (!content) continue;
      let detections: GrpcDetection[] = [];
      try {
        parser.setLanguage(plugin.language);
        const tree = parser.parse(content);
        detections = plugin.scan(tree);
      } catch {
        continue;
      }
      for (const d of detections) {
        out.push(this.detectionToContract(d, rel, protoMap));
      }
    }

    return this.dedupe(out);
  }

  /**
   * Convert a plugin `GrpcDetection` into a concrete `ExtractedContract`
   * by resolving the short service name against the proto map, building
   * either a service-level (`grpc::pkg.Svc/*`) or method-level
   * (`grpc::pkg.Svc/Method`) contract id, and selecting confidence
   * based on whether the proto map had an entry.
   */
  private detectionToContract(
    d: GrpcDetection,
    filePath: string,
    protoMap: Map<string, ProtoServiceInfo[]>,
  ): ExtractedContract {
    const candidates = protoMap.get(d.serviceName);
    const proto = resolveProtoConflict(d.serviceName, filePath, candidates ?? []);
    const pkg = proto?.package ?? '';
    const cid = d.methodName
      ? contractId(pkg, d.serviceName, d.methodName)
      : proto
        ? serviceContractId(pkg, d.serviceName)
        : serviceOnlyContractId(d.serviceName);
    const confidence = proto ? d.confidenceWithProto : d.confidenceWithoutProto;
    const meta: Record<string, unknown> = {
      service: d.serviceName,
      source: d.source,
    };
    if (d.methodName) meta.method = d.methodName;
    return makeContract(cid, d.role, filePath, d.symbolName, confidence, meta);
  }

  private dedupe(items: ExtractedContract[]): ExtractedContract[] {
    const byKey = new Map<string, ExtractedContract>();
    for (const c of items) {
      const k = `${c.contractId}|${c.role}|${c.symbolRef.filePath}`;
      const existing = byKey.get(k);
      if (
        !existing ||
        c.confidence > existing.confidence ||
        (c.confidence === existing.confidence &&
          String(c.meta.source) < String(existing.meta.source))
      ) {
        byKey.set(k, c);
      }
    }
    return Array.from(byKey.values());
  }
}
