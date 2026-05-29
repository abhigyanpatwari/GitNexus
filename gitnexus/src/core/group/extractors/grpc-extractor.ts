import * as path from 'node:path';
import { glob } from 'glob';
import Parser from 'tree-sitter';
import { createIgnoreFilter } from '../../../config/ignore-service.js';
import type { ContractExtractor, CypherExecutor } from '../contract-extractor.js';
import type { ExtractedContract, RepoHandle } from '../types.js';
import { readSafe } from './fs-utils.js';
import { parseSourceSafe } from '../../tree-sitter/safe-parse.js';
import { logger } from '../../logger.js';
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
  /**
   * Optional. Value of `option java_package = "..."` declared in the
   * same `.proto` file, when present and different from `package`.
   * Empty string when the option is absent or equals `package`. Used by
   * `detectionToContract()` to translate a Java import path back to the
   * proto package whenever the proto explicitly publishes its generated
   * Java code under a different namespace (a common pattern in
   * Google-style protobuf projects).
   */
  javaPackage: string;
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

/**
 * Extract `option java_package = "..."` from a `.proto` file, if any.
 * The Java code generator places generated `XxxGrpc.java` classes under
 * this package (instead of the proto `package` declaration) when the
 * option is set. Real-world projects (Google Cloud Java APIs, internal
 * shaded SDKs) routinely use this to publish their Java artifacts under
 * a corporate namespace different from the wire-protocol package.
 */
function extractJavaPackageOption(content: string): string {
  const m = content.match(/^\s*option\s+java_package\s*=\s*"([\w.]+)"\s*;/m);
  return m?.[1] ?? '';
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
  /**
   * Reverse index: `option java_package` value → ProtoServiceInfo[]
   * declared in `.proto` files that ship under that Java namespace.
   * Only populated when `java_package` is set AND differs from
   * `package`. Lets `detectionToContract()` translate an import-derived
   * Java package back to its source proto package whenever the proto
   * is in the same repository.
   */
  servicesByJavaPackage: Map<string, ProtoServiceInfo[]>;
}> {
  const servicesByName = new Map<string, ProtoServiceInfo[]>();
  const servicesByJavaPackage = new Map<string, ProtoServiceInfo[]>();
  // `.gitnexusignore` / `.gitignore` honoured via the shared IgnoreService —
  // see `filesystem-walker.ts` for the canonical pattern. Replaces a
  // hardcoded `[node_modules, .git, vendor]` array; those names plus the
  // rest of `DEFAULT_IGNORE_LIST` are still excluded by default (#1185).
  const protoIgnoreFilter = await createIgnoreFilter(repoPath);
  const protoFiles = await glob('**/*.proto', {
    cwd: repoPath,
    absolute: false,
    nodir: true,
    ignore: protoIgnoreFilter,
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
    const javaPkgOption = extractJavaPackageOption(content);
    // Only retain `javaPackage` when it actively diverges from `pkg`.
    // When equal (or absent), the import-derived path produces the
    // same FQN as the proto-derived path, so no translation is needed
    // and we keep the field empty to avoid populating the reverse
    // index with redundant entries.
    const javaPackage = javaPkgOption && javaPkgOption !== pkg ? javaPkgOption : '';

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
        javaPackage,
        serviceName: block.name,
        methods,
        protoPath: normalizedRel,
      };
      const existing = servicesByName.get(block.name) ?? [];
      existing.push(info);
      servicesByName.set(block.name, existing);

      if (javaPackage) {
        const byJava = servicesByJavaPackage.get(javaPackage) ?? [];
        byJava.push(info);
        servicesByJavaPackage.set(javaPackage, byJava);
      }
    }
  }

  return { packagesByProto, servicesByName, servicesByJavaPackage };
}

export async function buildProtoMap(repoPath: string): Promise<Map<string, ProtoServiceInfo[]>> {
  const { servicesByName } = await buildProtoContext(repoPath);
  return servicesByName;
}

export function resolveProtoConflict(
  serviceName: string,
  sourceFilePath: string,
  candidates: ProtoServiceInfo[],
): ProtoServiceInfo | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const sourceDir = normalizeProtoPath(path.dirname(sourceFilePath));
  const scored = candidates.map((c) => {
    const protoDir = normalizeProtoPath(path.dirname(c.protoPath));
    return { candidate: c, score: longestSharedSegmentRun(sourceDir, protoDir) };
  });

  let maxScore = -1;
  for (const s of scored) {
    if (s.score > maxScore) maxScore = s.score;
  }
  const winners = scored.filter((s) => s.score === maxScore);

  // Path heuristic cannot uniquely identify a winner — refuse to guess.
  // Ties (including all-zero ties) would otherwise silently merge unrelated
  // services under a fabricated package-qualified contract id.
  if (winners.length !== 1) {
    const paths = candidates.map((c) => c.protoPath).join(', ');
    logger.warn(
      `[grpc-extractor] Ambiguous proto resolution for service "${serviceName}" from ${sourceFilePath}: ${winners.length} candidates tied at score ${maxScore} among [${paths}] — skipping canonical contract`,
    );
    return null;
  }

  return winners[0].candidate;
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
    const javaPackageMap = protoContext.servicesByJavaPackage;

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
    // Honour `.gitnexusignore` / `.gitignore` via the shared IgnoreService —
    // mirrors `filesystem-walker.ts`. Replaces a hardcoded
    // `[node_modules, .git, vendor, dist, build]` array; those names are all
    // in `DEFAULT_IGNORE_LIST`, so default behaviour is preserved (#1185).
    const sourceIgnoreFilter = await createIgnoreFilter(repoPath);
    const sourceFiles = await glob(GRPC_SCAN_GLOB, {
      cwd: repoPath,
      ignore: sourceIgnoreFilter,
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
        const tree = parseSourceSafe(parser, content);
        detections = plugin.scan(tree);
      } catch {
        continue;
      }
      for (const d of detections) {
        const contract = this.detectionToContract(d, rel, protoMap, javaPackageMap);
        if (contract) out.push(contract);
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
   *
   * Resolution order for the package prefix:
   *
   *   1. **Java-package translation** (when detection
   *      supplied a `protoPackage` from a Java import).
   *      A `.proto` in the SAME repo may set `option
   *      java_package = "..."` to publish its generated
   *      Java classes under a namespace different from
   *      the proto `package`. Real-world projects (e.g.
   *      Google Cloud Java APIs) routinely do this.
   *      When the import-derived package matches that
   *      `java_package` value, translate back to the
   *      proto `package` so the resulting contract id
   *      is wire-correct rather than Java-namespace.
   *
   *   2. **Per-repo proto map check** (when the same
   *      service name has `.proto` candidates in this
   *      repo). The proto file is the authoritative
   *      source. If the proto's `package` agrees with
   *      the import's `protoPackage`, both paths produce
   *      the same FQN — emit it. If they DISAGREE (e.g.
   *      a typo'd Java import, or a mismatched
   *      java_package the reverse index didn't catch),
   *      trust the proto map and warn — the import
   *      MUST NOT silently overwrite an authoritative
   *      proto package.
   *
   *   3. **Import-derived FQN fallback** (when neither
   *      a `java_package` translation nor a proto map
   *      candidate exists in this repo). Typical for the
   *      "client-jar" pattern, where a consumer repo
   *      depends on a published stub jar and never
   *      carries the originating `.proto`. Use the
   *      import path verbatim as the proto package. Note
   *      the known limitation: when the published proto
   *      sets `option java_package` differing from
   *      `package`, the resulting FQN reflects the Java
   *      namespace rather than the proto namespace and
   *      will not match a provider repo's contract id —
   *      we cannot translate without sight of the proto.
   *
   *   4. **Per-repo proto map (no import)** — the legacy
   *      path. Used when the plugin didn't supply
   *      `protoPackage` (no import statement, wildcard
   *      import only, or non-Java languages that haven't
   *      been retrofitted yet).
   *
   *   5. **Short-name fallback** — when none of the
   *      above resolves a package, emit a service-only
   *      short-name contract id (`grpc::Svc/*`),
   *      preserving the pre-fix behaviour.
   */
  private detectionToContract(
    d: GrpcDetection,
    filePath: string,
    protoMap: Map<string, ProtoServiceInfo[]>,
    javaPackageMap: Map<string, ProtoServiceInfo[]>,
  ): ExtractedContract | null {
    if (d.protoPackage) {
      // Step 1: java_package translation. The import-derived package
      // may be the `option java_package` value of a `.proto` in the
      // SAME repo. Look it up and, if found for the same service name,
      // use the underlying proto `package` to build a wire-correct
      // contract id.
      const javaCandidates = javaPackageMap.get(d.protoPackage) ?? [];
      const javaTranslated = javaCandidates.find((p) => p.serviceName === d.serviceName);
      if (javaTranslated) {
        const cid = d.methodName
          ? contractId(javaTranslated.package, d.serviceName, d.methodName)
          : serviceContractId(javaTranslated.package, d.serviceName);
        const meta: Record<string, unknown> = {
          service: d.serviceName,
          source: d.source,
          package: javaTranslated.package,
          protoPackageSource: 'import-translated',
        };
        if (d.methodName) meta.method = d.methodName;
        return makeContract(cid, d.role, filePath, d.symbolName, d.confidenceWithProto, meta);
      }

      // Step 2: proto map cross-check. When this repo also carries a
      // `.proto` defining the same short service name, the proto is
      // authoritative and decides the package. The import is only used
      // to disambiguate among same-short-name candidates when the
      // resolution heuristic can't pick a unique winner on path alone.
      const candidates = protoMap.get(d.serviceName) ?? [];
      if (candidates.length > 0) {
        const proto = resolveProtoConflict(d.serviceName, filePath, candidates);
        if (proto === null) {
          // Ambiguous proto resolution; resolveProtoConflict already warned.
          return null;
        }
        const protoPkg = proto.package;
        if (protoPkg === d.protoPackage) {
          // Both paths agree.
          const cid = d.methodName
            ? contractId(protoPkg, d.serviceName, d.methodName)
            : serviceContractId(protoPkg, d.serviceName);
          const meta: Record<string, unknown> = {
            service: d.serviceName,
            source: d.source,
            package: protoPkg,
            protoPackageSource: 'import',
          };
          if (d.methodName) meta.method = d.methodName;
          return makeContract(cid, d.role, filePath, d.symbolName, d.confidenceWithProto, meta);
        }
        // Disagreement. Trust the proto file and emit a warning so
        // operators can investigate the import. This protects against
        // the symmetric Finding 2 case: a stale or typo'd Java import
        // silently corrupting the contract id of a service whose
        // `.proto` lives in the same repo.
        logger.warn(
          `[grpc-extractor] Java import package "${d.protoPackage}" for service ` +
            `"${d.serviceName}" disagrees with local proto package "${protoPkg}" at ` +
            `${filePath}; using proto package as authoritative source`,
        );
        const cid = d.methodName
          ? contractId(protoPkg, d.serviceName, d.methodName)
          : serviceContractId(protoPkg, d.serviceName);
        const meta: Record<string, unknown> = {
          service: d.serviceName,
          source: d.source,
          package: protoPkg,
          protoPackageSource: 'proto-override',
          importPackage: d.protoPackage,
        };
        if (d.methodName) meta.method = d.methodName;
        return makeContract(cid, d.role, filePath, d.symbolName, d.confidenceWithProto, meta);
      }

      // Step 3: import-derived fallback. No `.proto` in this repo
      // names the service, and no `java_package` reverse-lookup
      // matched. Emit the FQN with the import-derived package. This
      // is the typical client-jar consumer path.
      //
      // Known limitation: when the published proto sets
      // `option java_package` to a value that differs from
      // `package`, this path produces a contract id that reflects
      // the Java namespace, not the proto namespace, and will not
      // match a provider repo. Resolving that case requires
      // group-level proto knowledge, which is intentionally out of
      // scope for this fix.
      const cid = d.methodName
        ? contractId(d.protoPackage, d.serviceName, d.methodName)
        : serviceContractId(d.protoPackage, d.serviceName);
      const meta: Record<string, unknown> = {
        service: d.serviceName,
        source: d.source,
        package: d.protoPackage,
        protoPackageSource: 'import',
      };
      if (d.methodName) meta.method = d.methodName;
      return makeContract(cid, d.role, filePath, d.symbolName, d.confidenceWithProto, meta);
    }

    // Steps 4 + 5: legacy per-repo proto map resolution (no import).
    const candidates = protoMap.get(d.serviceName) ?? [];
    const proto = resolveProtoConflict(d.serviceName, filePath, candidates);
    // If there were proto candidates but resolution was ambiguous, skip
    // contract emission rather than fabricating a package-qualified id from
    // an arbitrary candidate. resolveProtoConflict already warned.
    if (candidates.length > 0 && proto === null) return null;
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
