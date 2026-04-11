import * as fs from 'node:fs';
import * as path from 'node:path';
import { glob } from 'glob';
import type { ContractExtractor, CypherExecutor } from '../contract-extractor.js';
import type { ExtractedContract, RepoHandle } from '../types.js';

const HANDLES_ROUTE_QUERY = `
MATCH (handlerFile:File)-[r:CodeRelation {type: 'HANDLES_ROUTE'}]->(route:Route)
RETURN handlerFile.id AS fileId, handlerFile.filePath AS filePath,
       route.name AS routePath, route.id AS routeId,
       route.responseKeys AS responseKeys,
       r.reason AS routeSource`;

const FETCHES_QUERY = `
MATCH (callerFile:File)-[r:CodeRelation {type: 'FETCHES'}]->(route:Route)
RETURN callerFile.id AS fileId, callerFile.filePath AS filePath,
       route.name AS routePath, route.id AS routeId,
       r.reason AS fetchReason`;

const CONTAINS_QUERY = `
MATCH (file:File {id: $fileId})<-[:CodeRelation {type: 'CONTAINS'}]-(sym)
WHERE sym.startLine IS NOT NULL
RETURN sym.id AS uid, sym.name AS name, sym.filePath AS filePath, labels(sym) AS labels
ORDER BY sym.startLine`;

export function normalizeHttpPath(p: string): string {
  let s = p.trim().split('?')[0].toLowerCase().replace(/\/+$/, '');
  s = s.replace(/:\w+/g, '{param}');
  s = s.replace(/\{[^}]+\}/g, '{param}');
  s = s.replace(/\[[^\]]+\]/g, '{param}');
  return s;
}

function methodFromRouteReason(reason: string): string | null {
  const r = reason || '';
  if (/GetMapping|decorator-Get/i.test(r)) return 'GET';
  if (/PostMapping|decorator-Post/i.test(r)) return 'POST';
  if (/PutMapping|decorator-Put/i.test(r)) return 'PUT';
  if (/DeleteMapping|decorator-Delete/i.test(r)) return 'DELETE';
  if (/PatchMapping|decorator-Patch/i.test(r)) return 'PATCH';
  return null;
}

function contractIdFor(method: string, pathNorm: string): string {
  return `http::${method.toUpperCase()}::${pathNorm}`;
}

function readSafe(repoPath: string, rel: string): string | null {
  const abs = path.resolve(repoPath, rel);
  const base = path.resolve(repoPath);
  const relToBase = path.relative(base, abs);
  if (relToBase.startsWith('..') || path.isAbsolute(relToBase)) return null;
  try {
    return fs.readFileSync(abs, 'utf-8');
  } catch {
    return null;
  }
}

function pickJavaHandlerName(
  content: string,
  routePath: string,
  httpMethod: string,
): string | null {
  const tail = routePath.split('/').filter(Boolean).pop() || '';
  const mapNames: Record<string, string> = {
    GET: 'GetMapping',
    POST: 'PostMapping',
    PUT: 'PutMapping',
    DELETE: 'DeleteMapping',
    PATCH: 'PatchMapping',
  };
  const ann = mapNames[httpMethod] || 'GetMapping';
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes(`@${ann}`)) continue;
    if (!line.includes(`"${tail}"`) && !line.includes(`'${tail}'`) && tail && !line.includes(tail))
      continue;
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
      const m = lines[j].match(/(?:public|protected|private)\s+[\w<>,\s\[\]]+\s+(\w+)\s*\(/);
      if (m) return m[1];
    }
  }
  return null;
}

function pickSymbolUid(
  rows: Record<string, unknown>[],
  preferredName: string | null,
): { uid: string; name: string; filePath: string } {
  const norm = (x: unknown) => String(x ?? '');
  const labeled = rows.filter((r) => {
    const labels = r.labels ?? r[3];
    const s = JSON.stringify(labels);
    return s.includes('Method') || s.includes('Function');
  });
  const pool = labeled.length > 0 ? labeled : rows;
  if (preferredName) {
    const hit = pool.find((r) => norm(r.name ?? r[1]) === preferredName);
    if (hit) {
      return {
        uid: norm(hit.uid ?? hit[0]),
        name: norm(hit.name ?? hit[1]),
        filePath: norm(hit.filePath ?? hit[2]),
      };
    }
  }
  const first = pool[0] || rows[0];
  return {
    uid: norm(first?.uid ?? first?.[0]),
    name: norm(first?.name ?? first?.[1]),
    filePath: norm(first?.filePath ?? first?.[2]),
  };
}

export class HttpRouteExtractor implements ContractExtractor {
  type = 'http' as const;

  async canExtract(_repo: RepoHandle): Promise<boolean> {
    return true;
  }

  async extract(
    dbExecutor: CypherExecutor | null,
    repoPath: string,
    repo: RepoHandle,
  ): Promise<ExtractedContract[]> {
    const graphP = dbExecutor != null ? await this.extractProvidersGraph(dbExecutor, repoPath) : [];
    const providers = graphP.length > 0 ? graphP : await this.extractProvidersSourceScan(repoPath);

    const graphC = dbExecutor != null ? await this.extractConsumersGraph(dbExecutor, repoPath) : [];
    const consumers = graphC.length > 0 ? graphC : await this.extractConsumersSourceScan(repoPath);

    return [...providers, ...consumers];
  }

  private async extractProvidersGraph(
    db: CypherExecutor,
    repoPath: string,
  ): Promise<ExtractedContract[]> {
    const out: ExtractedContract[] = [];
    let rows: Record<string, unknown>[];
    try {
      rows = await db(HANDLES_ROUTE_QUERY);
    } catch {
      return [];
    }

    for (const row of rows) {
      const filePath = String(row.filePath ?? '');
      const routePath = String(row.routePath ?? '');
      const routeSource = String(row.routeSource ?? row.routeReason ?? '');
      let method = methodFromRouteReason(routeSource);
      const content = readSafe(repoPath, filePath);
      if (!method && content) {
        method = this.inferMethodFromFileScan(content, routePath, 'provider');
      }
      if (!method) method = 'GET';

      const pathNorm = normalizeHttpPath(routePath);
      const cid = contractIdFor(method, pathNorm);
      const handlerName =
        content && routePath ? pickJavaHandlerName(content, routePath, method) : null;

      let symbolUid = '';
      let symbolName = path.basename(filePath) || 'handler';
      let symPath = filePath;
      const fileId = row.fileId ?? row[0];
      if (fileId) {
        try {
          const syms = await db(CONTAINS_QUERY, { fileId });
          if (syms.length > 0) {
            const picked = pickSymbolUid(syms, handlerName);
            symbolUid = picked.uid;
            symbolName = picked.name;
            symPath = picked.filePath || filePath;
          }
        } catch {
          /* ignore */
        }
      }

      out.push({
        contractId: cid,
        type: 'http',
        role: 'provider',
        symbolUid,
        symbolRef: { filePath: symPath, name: symbolName },
        symbolName,
        confidence: 0.9,
        meta: {
          method,
          path: pathNorm,
          pathSegments: pathNorm.split('/').filter(Boolean),
          extractionStrategy: 'graph_assisted',
          routeSource,
        },
      });
    }
    return out;
  }

  private inferMethodFromFileScan(
    content: string,
    routePath: string,
    _role: string,
  ): string | null {
    const tail = routePath.split('/').filter(Boolean).pop() || '';
    for (const m of ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] as const) {
      const mapNames: Record<string, string> = {
        GET: 'GetMapping',
        POST: 'PostMapping',
        PUT: 'PutMapping',
        DELETE: 'DeleteMapping',
        PATCH: 'PatchMapping',
      };
      if (
        content.includes(`@${mapNames[m]}`) &&
        (content.includes(tail) || routePath.includes(tail))
      ) {
        return m;
      }
    }
    return null;
  }

  private async extractProvidersSourceScan(repoPath: string): Promise<ExtractedContract[]> {
    const files = await glob('**/*.{ts,tsx,js,jsx,java,vue,svelte,php,py}', {
      cwd: repoPath,
      ignore: ['**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**'],
      nodir: true,
    });
    const out: ExtractedContract[] = [];
    for (const rel of files) {
      const content = readSafe(repoPath, rel);
      if (!content) continue;
      out.push(...this.scanSpringProviders(content, rel));
      out.push(...this.scanExpressProviders(content, rel));
      out.push(...this.scanLaravelProviders(content, rel));
      out.push(...this.scanFastApiProviders(content, rel));
    }
    return this.dedupeContracts(out);
  }

  private dedupeContracts(items: ExtractedContract[]): ExtractedContract[] {
    const seen = new Set<string>();
    const out: ExtractedContract[] = [];
    for (const c of items) {
      const k = `${c.contractId}|${c.symbolRef.filePath}|${c.symbolRef.name}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(c);
    }
    return out;
  }

  private scanSpringProviders(content: string, filePath: string): ExtractedContract[] {
    const out: ExtractedContract[] = [];

    // Skip Feign/client interfaces — annotated methods in interfaces are
    // consumers (Feign, JAX-RS proxies), not provider endpoints.
    // Anchored to line start (with optional access modifier) so we do not
    // match "interface" inside comments or string literals.
    if (
      /^\s*(?:public\s+)?interface\s+\w+/m.test(content) &&
      !/@(?:Rest)?Controller\b/.test(content)
    ) {
      return out;
    }

    let classPrefix = '';
    const classRm = content.match(/@RequestMapping\s*\(\s*"([^"]+)"/);
    if (classRm) classPrefix = classRm[1].replace(/\/+$/, '');

    const re = /@(Get|Post|Put|Delete|Patch)Mapping\s*\(\s*"([^"]+)"/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const method = m[1].toUpperCase();
      let p = m[2];
      if (classPrefix) p = `${classPrefix}/${p.replace(/^\//, '')}`;
      const pathNorm = normalizeHttpPath(p);
      const sub = content.slice(m.index);
      const nameM = sub.match(/(?:public|protected|private)\s+[\w<>,\s\[\]]+\s+(\w+)\s*\(/);
      const name = nameM ? nameM[1] : m[0];
      out.push(this.makeProvider(filePath, method, pathNorm, name, 0.8));
    }
    return out;
  }

  private scanExpressProviders(content: string, filePath: string): ExtractedContract[] {
    const out: ExtractedContract[] = [];
    const re = /(?:router|app)\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const method = m[1].toUpperCase();
      const pathNorm = normalizeHttpPath(m[2]);
      out.push(this.makeProvider(filePath, method, pathNorm, 'handler', 0.8));
    }
    return out;
  }

  private scanLaravelProviders(content: string, filePath: string): ExtractedContract[] {
    const out: ExtractedContract[] = [];
    const re = /Route::(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const method = m[1].toUpperCase();
      const pathNorm = normalizeHttpPath(m[2]);
      out.push(this.makeProvider(filePath, method, pathNorm, 'route', 0.8));
    }
    return out;
  }

  private scanFastApiProviders(content: string, filePath: string): ExtractedContract[] {
    const out: ExtractedContract[] = [];
    const re = /@app\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const method = m[1].toUpperCase();
      const pathNorm = normalizeHttpPath(m[2]);
      out.push(this.makeProvider(filePath, method, pathNorm, 'handler', 0.8));
    }
    return out;
  }

  private makeProvider(
    filePath: string,
    method: string,
    pathNorm: string,
    name: string,
    confidence: number,
  ): ExtractedContract {
    const cid = contractIdFor(method, pathNorm);
    return {
      contractId: cid,
      type: 'http',
      role: 'provider',
      symbolUid: '',
      symbolRef: { filePath, name },
      symbolName: name,
      confidence,
      meta: {
        method,
        path: pathNorm,
        pathSegments: pathNorm.split('/').filter(Boolean),
        extractionStrategy: 'source_scan',
      },
    };
  }

  private async extractConsumersGraph(
    db: CypherExecutor,
    repoPath: string,
  ): Promise<ExtractedContract[]> {
    const out: ExtractedContract[] = [];
    let rows: Record<string, unknown>[];
    try {
      rows = await db(FETCHES_QUERY);
    } catch {
      return [];
    }
    for (const row of rows) {
      const filePath = String(row.filePath ?? '');
      const routePath = String(row.routePath ?? '');
      const pathNorm = normalizeHttpPath(routePath);
      let method = 'GET';
      const content = readSafe(repoPath, filePath);
      if (content) {
        const inferred = this.inferFetchMethod(content, pathNorm);
        if (inferred) method = inferred;
      }
      const cid = contractIdFor(method, pathNorm);
      let symbolUid = '';
      let symbolName = 'fetch';
      let symPath = filePath;
      const fileId = row.fileId ?? row[0];
      if (fileId) {
        try {
          const syms = await db(CONTAINS_QUERY, { fileId });
          if (syms.length > 0) {
            const picked = pickSymbolUid(syms, null);
            symbolUid = picked.uid;
            symbolName = picked.name;
            symPath = picked.filePath || filePath;
          }
        } catch {
          /* ignore */
        }
      }
      out.push({
        contractId: cid,
        type: 'http',
        role: 'consumer',
        symbolUid,
        symbolRef: { filePath: symPath, name: symbolName },
        symbolName,
        confidence: 0.9,
        meta: {
          method,
          path: pathNorm,
          extractionStrategy: 'graph_assisted',
          fetchReason: String(row.fetchReason ?? ''),
        },
      });
    }
    return out;
  }

  private inferFetchMethod(content: string, pathNorm: string): string | null {
    const esc = pathNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const fetchRe = new RegExp(
      `fetch\\s*\\(\\s*['"\`]([^'"\`]*${esc}[^'"\`]*)['"\`]\\s*,\\s*\\{[^}]*method:\\s*['"](\\w+)['"]`,
      'i',
    );
    const m = content.match(fetchRe);
    if (m) return m[2].toUpperCase();
    return null;
  }

  private async extractConsumersSourceScan(repoPath: string): Promise<ExtractedContract[]> {
    const files = await glob('**/*.{ts,tsx,js,jsx,vue,svelte}', {
      cwd: repoPath,
      ignore: ['**/node_modules/**', '**/.git/**'],
      nodir: true,
    });
    const out: ExtractedContract[] = [];
    for (const rel of files) {
      const content = readSafe(repoPath, rel);
      if (!content) continue;
      out.push(...this.scanFetchConsumers(content, rel));
      out.push(...this.scanAxiosConsumers(content, rel));
    }
    return this.dedupeContracts(out);
  }

  private scanFetchConsumers(content: string, filePath: string): ExtractedContract[] {
    const out: ExtractedContract[] = [];
    const re =
      /fetch\s*\(\s*['"`]([^'"`]+)['"`](?:\s*,\s*\{[^}]*method:\s*['"](\w+)['"][^}]*\})?\s*\)/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const pathNorm = normalizeHttpPath(this.templateToPattern(m[1]));
      const method = (m[2] || 'GET').toUpperCase();
      out.push(this.makeConsumer(filePath, method, pathNorm, 0.7));
    }
    return out;
  }

  private templateToPattern(url: string): string {
    return url.replace(/\$\{[^}]+\}/g, '{param}');
  }

  private scanAxiosConsumers(content: string, filePath: string): ExtractedContract[] {
    const out: ExtractedContract[] = [];
    const re = /axios\.(get|post|put|delete|patch)\s*\(\s*[`'"]([^`'"]+)[`'"]/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const method = m[1].toUpperCase();
      const pathNorm = normalizeHttpPath(this.templateToPattern(m[2]));
      out.push(this.makeConsumer(filePath, method, pathNorm, 0.7));
    }
    return out;
  }

  private makeConsumer(
    filePath: string,
    method: string,
    pathNorm: string,
    confidence: number,
  ): ExtractedContract {
    return {
      contractId: contractIdFor(method, pathNorm),
      type: 'http',
      role: 'consumer',
      symbolUid: '',
      symbolRef: { filePath, name: 'fetch' },
      symbolName: 'fetch',
      confidence,
      meta: {
        method,
        path: pathNorm,
        extractionStrategy: 'source_scan',
      },
    };
  }
}
