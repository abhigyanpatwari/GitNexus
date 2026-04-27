import { glob } from 'glob';
import type { ContractExtractor, CypherExecutor } from '../contract-extractor.js';
import type { ExtractedContract, RepoHandle } from '../types.js';
import { readSafe } from './fs-utils.js';

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

function makeContract(
  cid: string,
  filePath: string,
  symbolName: string,
  meta: Record<string, unknown>,
): ExtractedContract {
  return {
    contractId: cid,
    type: 'thrift',
    role: 'provider',
    symbolUid: '',
    symbolRef: { filePath: normalizeThriftPath(filePath), name: symbolName },
    symbolName,
    confidence: 0.85,
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
              info.thriftPath,
              symbolName,
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

    return this.dedupe(out);
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
