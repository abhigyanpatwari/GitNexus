import { glob } from 'glob';
import Parser from 'tree-sitter';
import type { ContractExtractor, CypherExecutor } from '../contract-extractor.js';
import type { ExtractedContract, RepoHandle } from '../types.js';
import { readSafe } from './fs-utils.js';
import {
  getPluginForFile,
  THRIFT_SCAN_GLOB,
  type ThriftDetection,
} from './thrift-patterns/index.js';

export interface ThriftServiceInfo {
  namespace: string;
  serviceName: string;
  methods: string[];
  thriftPath: string;
}

export interface ThriftContext {
  namespacesByThrift: Map<string, string>;
  servicesByName: Map<string, ThriftServiceInfo[]>;
}

function normalizeThriftPath(rel: string): string {
  return rel.replace(/\\/g, '/');
}

export function thriftMethodContractId(
  namespace: string,
  serviceName: string,
  methodName: string,
): string {
  const prefix = namespace ? `${namespace}.${serviceName}` : serviceName;
  return `thrift::${prefix}/${methodName}`;
}

export function thriftServiceContractId(namespace: string, serviceName: string): string {
  const prefix = namespace ? `${namespace}.${serviceName}` : serviceName;
  return `thrift::${prefix}/*`;
}

/**
 * Replace Thrift comments and string literals with spaces while preserving
 * newlines and character offsets. Service block scanning can then count braces
 * without being confused by examples or comments inside the IDL.
 */
function stripThriftCommentsAndStrings(content: string): string {
  const out = new Array<string>(content.length);
  let i = 0;

  while (i < content.length) {
    const ch = content[i];
    const next = content[i + 1];

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

    if (ch === '#') {
      out[i] = ' ';
      i++;
      while (i < content.length && content[i] !== '\n') {
        out[i] = content[i] === '\r' ? '\r' : ' ';
        i++;
      }
      continue;
    }

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
        out[i] = content[i] === '\n' || content[i] === '\r' ? content[i] : ' ';
        i++;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      const quote = ch;
      out[i] = ' ';
      i++;
      while (i < content.length) {
        const c = content[i];
        if (c === '\\' && i + 1 < content.length) {
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

function extractNamespace(sanitizedContent: string): string {
  const namespaces: Array<{ language: string; namespace: string }> = [];
  const namespaceRe = /^\s*namespace\s+([A-Za-z_*][\w.*-]*)\s+([A-Za-z_][\w.]*)\s*$/gm;
  let match: RegExpExecArray | null;

  while ((match = namespaceRe.exec(sanitizedContent)) !== null) {
    namespaces.push({ language: match[1], namespace: match[2] });
  }

  return (
    namespaces.find((entry) => entry.language === 'java')?.namespace ??
    namespaces[0]?.namespace ??
    ''
  );
}

function extractServiceBlocks(sanitizedContent: string): Array<{ name: string; body: string }> {
  const results: Array<{ name: string; body: string }> = [];
  const headerRe = /service\s+([A-Za-z_]\w*)\s*(?:extends\s+[A-Za-z_][\w.]*)?\s*\{/g;
  let headerMatch: RegExpExecArray | null;

  while ((headerMatch = headerRe.exec(sanitizedContent)) !== null) {
    const serviceName = headerMatch[1];
    const bodyStart = headerMatch.index + headerMatch[0].length;
    let depth = 1;
    let pos = bodyStart;

    while (pos < sanitizedContent.length && depth > 0) {
      const ch = sanitizedContent[pos];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      pos++;
    }

    if (depth !== 0) continue;

    results.push({
      name: serviceName,
      body: sanitizedContent.slice(bodyStart, pos - 1),
    });
  }

  return results;
}

function extractMethods(sanitizedServiceBody: string): string[] {
  const methods: string[] = [];
  const methodRe =
    /(?:^|[;,\n\r])\s*(?:oneway\s+)?[A-Za-z_][\w.]*(?:\s*<[^(){};]*>)?\s+([A-Za-z_]\w*)\s*\(/g;
  let match: RegExpExecArray | null;

  while ((match = methodRe.exec(sanitizedServiceBody)) !== null) {
    methods.push(match[1]);
  }

  return methods;
}

function thriftSourceScanSymbolUid(
  contractId: string,
  role: 'provider' | 'consumer',
  filePath: string,
  symbolName: string,
): string {
  const contractKey = contractId.startsWith('thrift::')
    ? contractId.slice('thrift::'.length)
    : contractId;
  return ['source-scan::thrift', role, contractKey, normalizeThriftPath(filePath), symbolName].join(
    '::',
  );
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
    type: 'thrift',
    role,
    symbolUid: thriftSourceScanSymbolUid(cid, role, filePath, symbolName),
    symbolRef: { filePath: normalizeThriftPath(filePath), name: symbolName },
    symbolName,
    confidence,
    meta: { ...meta, extractionStrategy: 'source_scan' },
  };
}

export async function buildThriftContext(repoPath: string): Promise<ThriftContext> {
  const thriftFiles = await glob('**/*.thrift', {
    cwd: repoPath,
    absolute: false,
    nodir: true,
    ignore: ['**/node_modules/**', '**/.git/**', '**/vendor/**', '**/dist/**', '**/build/**'],
  });
  const namespacesByThrift = new Map<string, string>();
  const servicesByName = new Map<string, ThriftServiceInfo[]>();

  for (const rel of thriftFiles) {
    const thriftPath = normalizeThriftPath(rel);
    const content = readSafe(repoPath, rel);
    if (!content) continue;

    const sanitized = stripThriftCommentsAndStrings(content);
    const namespace = extractNamespace(sanitized);
    namespacesByThrift.set(thriftPath, namespace);

    for (const block of extractServiceBlocks(sanitized)) {
      const methods = extractMethods(block.body);
      const info: ThriftServiceInfo = {
        namespace,
        serviceName: block.name,
        methods,
        thriftPath,
      };
      const existing = servicesByName.get(block.name) ?? [];
      existing.push(info);
      servicesByName.set(block.name, existing);
    }
  }

  return { namespacesByThrift, servicesByName };
}

export class ThriftExtractor implements ContractExtractor {
  type = 'thrift' as const;

  async canExtract(_repo: RepoHandle): Promise<boolean> {
    return true;
  }

  async extract(
    _dbExecutor: CypherExecutor | null,
    repoPath: string,
    _repo: RepoHandle,
  ): Promise<ExtractedContract[]> {
    const out: ExtractedContract[] = [];
    const context = await buildThriftContext(repoPath);

    for (const infos of context.servicesByName.values()) {
      for (const info of infos) {
        for (const methodName of info.methods) {
          const symbolName = `${info.serviceName}.${methodName}`;
          out.push(
            makeContract(
              thriftMethodContractId(info.namespace, info.serviceName, methodName),
              'provider',
              info.thriftPath,
              symbolName,
              0.85,
              {
                namespace: info.namespace,
                service: info.serviceName,
                method: methodName,
                source: 'thrift_idl',
              },
            ),
          );
        }
      }
    }

    const sourceFiles = await glob(THRIFT_SCAN_GLOB, {
      cwd: repoPath,
      absolute: false,
      nodir: true,
      ignore: ['**/node_modules/**', '**/.git/**', '**/vendor/**', '**/dist/**', '**/build/**'],
    });

    const parser = new Parser();
    for (const rel of sourceFiles) {
      const plugin = getPluginForFile(rel);
      if (!plugin) continue;
      const content = readSafe(repoPath, rel);
      if (!content) continue;

      let detections: ThriftDetection[] = [];
      try {
        parser.setLanguage(plugin.language);
        const tree = parser.parse(content);
        detections = plugin.scan(tree);
      } catch {
        continue;
      }

      for (const detection of detections) {
        const contract = this.detectionToContract(detection, rel, context);
        if (contract) out.push(contract);
      }
    }

    return this.dedupe(out);
  }

  private detectionToContract(
    detection: ThriftDetection,
    filePath: string,
    context: ThriftContext,
  ): ExtractedContract | null {
    const candidates = context.servicesByName.get(detection.serviceName) ?? [];
    if (candidates.length > 1) return null;

    const info = candidates[0];
    if (info) {
      if (!info.methods.includes(detection.methodName)) return null;
      return makeContract(
        thriftMethodContractId(info.namespace, info.serviceName, detection.methodName),
        detection.role,
        filePath,
        detection.symbolName,
        detection.confidenceWithIdl,
        {
          namespace: info.namespace,
          service: info.serviceName,
          method: detection.methodName,
          source: detection.source,
        },
      );
    }

    if (
      detection.role !== 'consumer' ||
      !detection.methodName ||
      !detection.usesGeneratedServiceMember
    ) {
      return null;
    }
    return makeContract(
      thriftMethodContractId('', detection.serviceName, detection.methodName),
      detection.role,
      filePath,
      detection.symbolName,
      detection.confidenceWithoutIdl,
      {
        service: detection.serviceName,
        method: detection.methodName,
        source: 'java_thrift_consumer_weak',
      },
    );
  }

  private dedupe(items: ExtractedContract[]): ExtractedContract[] {
    const byKey = new Map<string, ExtractedContract>();
    for (const c of items) {
      const key = `${c.contractId}|${c.role}|${c.symbolRef.filePath}|${c.symbolName}`;
      const existing = byKey.get(key);
      if (!existing || c.confidence > existing.confidence) {
        byKey.set(key, c);
      }
    }
    return Array.from(byKey.values());
  }
}
