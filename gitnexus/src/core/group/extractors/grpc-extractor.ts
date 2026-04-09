import * as fs from 'node:fs';
import * as path from 'node:path';
import { glob } from 'glob';
import type { ContractExtractor, CypherExecutor } from '../contract-extractor.js';
import type { ExtractedContract, RepoHandle } from '../types.js';

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

function contractId(pkg: string, service: string, method: string): string {
  const prefix = pkg ? `${pkg}.${service}` : service;
  return `grpc::${prefix}/${method}`;
}

function serviceOnlyContractId(serviceName: string): string {
  return `grpc::${serviceName}/*`;
}

function extractServiceBlocks(content: string): Array<{ name: string; body: string }> {
  const results: Array<{ name: string; body: string }> = [];
  // v1: brace-depth only — braces inside comments or string literals are not filtered (see spec Fix 2)
  const headerRe = /service\s+(\w+)\s*\{/g;
  let headerMatch: RegExpExecArray | null;

  while ((headerMatch = headerRe.exec(content)) !== null) {
    const serviceName = headerMatch[1];
    const bodyStart = headerMatch.index + headerMatch[0].length;
    let depth = 1;
    let pos = bodyStart;

    while (pos < content.length && depth > 0) {
      const ch = content[pos];
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

    // Proto files — definitive provider source
    const protoFiles = await glob('**/*.proto', {
      cwd: repoPath,
      ignore: ['**/node_modules/**', '**/.git/**', '**/vendor/**'],
      nodir: true,
    });
    for (const rel of protoFiles) {
      const content = readSafe(repoPath, rel);
      if (content) {
        out.push(
          ...this.parseProtoFile(
            content,
            rel,
            protoContext.packagesByProto.get(normalizeProtoPath(rel)) ?? '',
          ),
        );
      }
    }
    const protoMap = protoContext.servicesByName;

    // Source files — server/client detection
    const sourceFiles = await glob('**/*.{go,java,py,ts,tsx,js,jsx}', {
      cwd: repoPath,
      ignore: ['**/node_modules/**', '**/.git/**', '**/vendor/**', '**/dist/**', '**/build/**'],
      nodir: true,
    });
    for (const rel of sourceFiles) {
      const content = readSafe(repoPath, rel);
      if (!content) continue;
      const ext = path.extname(rel).toLowerCase();

      if (ext === '.go') {
        out.push(...this.scanGoProviders(content, rel, protoMap));
        out.push(...this.scanGoConsumers(content, rel, protoMap));
      } else if (ext === '.java') {
        out.push(...this.scanJavaProviders(content, rel, protoMap));
        out.push(...this.scanJavaConsumers(content, rel, protoMap));
      } else if (ext === '.py') {
        out.push(...this.scanPythonProviders(content, rel, protoMap));
        out.push(...this.scanPythonConsumers(content, rel, protoMap));
      } else if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
        out.push(...this.scanTsProviders(content, rel, protoMap));
        out.push(...this.scanTsConsumers(content, rel, protoMap));
      }
    }

    return this.dedupe(out);
  }

  private parseProtoFile(content: string, filePath: string, pkg: string): ExtractedContract[] {
    const out: ExtractedContract[] = [];

    for (const { name: serviceName, body } of extractServiceBlocks(content)) {
      const rpcRe = /rpc\s+(\w+)\s*\(/g;
      let rpcMatch: RegExpExecArray | null;
      while ((rpcMatch = rpcRe.exec(body)) !== null) {
        const methodName = rpcMatch[1];
        const cid = contractId(pkg, serviceName, methodName);
        out.push(
          makeContract(cid, 'provider', filePath, `${serviceName}.${methodName}`, 0.85, {
            package: pkg,
            service: serviceName,
            method: methodName,
            source: 'proto',
          }),
        );
      }
    }

    return out;
  }

  private scanGoProviders(
    content: string,
    filePath: string,
    protoMap: Map<string, ProtoServiceInfo[]>,
  ): ExtractedContract[] {
    const out: ExtractedContract[] = [];

    // pb.RegisterXxxServer(
    const registerRe = /\w+\.Register(\w+)Server\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = registerRe.exec(content)) !== null) {
      const serviceName = m[1];
      const candidates = protoMap.get(serviceName);
      const proto = resolveProtoConflict(serviceName, filePath, candidates ?? []);
      const cid = proto
        ? serviceContractId(proto.package, proto.serviceName)
        : serviceOnlyContractId(serviceName);
      const conf = proto ? 0.8 : 0.65;
      out.push(
        makeContract(cid, 'provider', filePath, `Register${serviceName}Server`, conf, {
          service: serviceName,
          source: 'go_register',
        }),
      );
    }

    // pb.UnimplementedXxxServer
    const unimplRe = /\w+\.Unimplemented(\w+)Server\b/g;
    while ((m = unimplRe.exec(content)) !== null) {
      const serviceName = m[1];
      const candidates = protoMap.get(serviceName);
      const proto = resolveProtoConflict(serviceName, filePath, candidates ?? []);
      const cid = proto
        ? serviceContractId(proto.package, proto.serviceName)
        : serviceOnlyContractId(serviceName);
      const conf = proto ? 0.8 : 0.65;
      out.push(
        makeContract(cid, 'provider', filePath, `Unimplemented${serviceName}Server`, conf, {
          service: serviceName,
          source: 'go_unimplemented',
        }),
      );
    }

    return out;
  }

  private scanGoConsumers(
    content: string,
    filePath: string,
    protoMap: Map<string, ProtoServiceInfo[]>,
  ): ExtractedContract[] {
    const out: ExtractedContract[] = [];
    const re = /\w+\.New(\w+)Client\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const serviceName = m[1];
      const candidates = protoMap.get(serviceName);
      const proto = resolveProtoConflict(serviceName, filePath, candidates ?? []);
      const cid = proto
        ? serviceContractId(proto.package, proto.serviceName)
        : serviceOnlyContractId(serviceName);
      const conf = proto ? 0.75 : 0.55;
      out.push(
        makeContract(cid, 'consumer', filePath, `New${serviceName}Client`, conf, {
          service: serviceName,
          source: 'go_client',
        }),
      );
    }
    return out;
  }

  private scanJavaProviders(
    content: string,
    filePath: string,
    protoMap: Map<string, ProtoServiceInfo[]>,
  ): ExtractedContract[] {
    const out: ExtractedContract[] = [];

    const resolveJava = (svcName: string): { cid: string; conf: number } => {
      const candidates = protoMap.get(svcName);
      const proto = resolveProtoConflict(svcName, filePath, candidates ?? []);
      const cid = proto
        ? serviceContractId(proto.package, proto.serviceName)
        : serviceOnlyContractId(svcName);
      const conf = proto ? 0.8 : 0.65;
      return { cid, conf };
    };

    // @GrpcService
    if (content.includes('@GrpcService')) {
      const implBaseRe = /extends\s+(\w+)Grpc\.(\w+)ImplBase/;
      const m = content.match(implBaseRe);
      if (m) {
        const { cid, conf } = resolveJava(m[1]);
        out.push(
          makeContract(cid, 'provider', filePath, m[2], conf, {
            service: m[1],
            source: 'java_grpc_service',
          }),
        );
      } else {
        // Try extracting service name from class name
        const classRe =
          /class\s+(\w*?)(?:Grpc)?(?:Service)?\s+extends\s+(\w+)(?:Grpc\.(\w+))?ImplBase/;
        const cm = content.match(classRe);
        if (cm) {
          const svcName = cm[2].replace(/Grpc$/, '');
          const { cid, conf } = resolveJava(svcName);
          out.push(
            makeContract(cid, 'provider', filePath, cm[1], conf, {
              service: svcName,
              source: 'java_grpc_service',
            }),
          );
        }
      }
    }

    // extends XxxImplBase (without @GrpcService)
    if (!content.includes('@GrpcService')) {
      const implRe = /extends\s+(\w+?)(?:Grpc\.(\w+))?ImplBase/;
      const m = content.match(implRe);
      if (m) {
        const svcName = m[2] || m[1].replace(/Grpc$/, '');
        const { cid, conf } = resolveJava(svcName);
        out.push(
          makeContract(cid, 'provider', filePath, svcName, conf, {
            service: svcName,
            source: 'java_impl_base',
          }),
        );
      }
    }

    return out;
  }

  private scanJavaConsumers(
    content: string,
    filePath: string,
    protoMap: Map<string, ProtoServiceInfo[]>,
  ): ExtractedContract[] {
    const out: ExtractedContract[] = [];
    // XxxGrpc.newBlockingStub( or XxxGrpc.newStub(
    const re = /(\w+)Grpc\.new(?:Blocking)?Stub\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const serviceName = m[1];
      const candidates = protoMap.get(serviceName);
      const proto = resolveProtoConflict(serviceName, filePath, candidates ?? []);
      const cid = proto
        ? serviceContractId(proto.package, proto.serviceName)
        : serviceOnlyContractId(serviceName);
      const conf = proto ? 0.75 : 0.55;
      out.push(
        makeContract(cid, 'consumer', filePath, `${serviceName}Stub`, conf, {
          service: serviceName,
          source: 'java_stub',
        }),
      );
    }
    return out;
  }

  private scanPythonProviders(
    content: string,
    filePath: string,
    protoMap: Map<string, ProtoServiceInfo[]>,
  ): ExtractedContract[] {
    const out: ExtractedContract[] = [];
    // add_XxxServicer_to_server(
    const re = /add_(\w+?)Servicer_to_server\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const serviceName = m[1];
      const candidates = protoMap.get(serviceName);
      const proto = resolveProtoConflict(serviceName, filePath, candidates ?? []);
      const cid = proto
        ? serviceContractId(proto.package, proto.serviceName)
        : serviceOnlyContractId(serviceName);
      const conf = proto ? 0.8 : 0.65;
      out.push(
        makeContract(cid, 'provider', filePath, `add_${serviceName}Servicer_to_server`, conf, {
          service: serviceName,
          source: 'python_servicer',
        }),
      );
    }
    return out;
  }

  private scanPythonConsumers(
    content: string,
    filePath: string,
    protoMap: Map<string, ProtoServiceInfo[]>,
  ): ExtractedContract[] {
    const out: ExtractedContract[] = [];
    // XxxStub(
    const re = /(\w+)Stub\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const name = m[1];
      // Filter out common false positives
      if (['Mock', 'Test', 'Fake', 'Stub'].includes(name)) continue;
      const candidates = protoMap.get(name);
      const proto = resolveProtoConflict(name, filePath, candidates ?? []);
      const cid = proto
        ? serviceContractId(proto.package, proto.serviceName)
        : serviceOnlyContractId(name);
      const conf = proto ? 0.75 : 0.55;
      out.push(
        makeContract(cid, 'consumer', filePath, `${name}Stub`, conf, {
          service: name,
          source: 'python_stub',
        }),
      );
    }
    return out;
  }

  private scanTsProviders(
    content: string,
    filePath: string,
    protoMap: Map<string, ProtoServiceInfo[]>,
  ): ExtractedContract[] {
    const out: ExtractedContract[] = [];
    // @GrpcMethod('ServiceName', 'MethodName')
    const re = /@GrpcMethod\s*\(\s*['"](\w+)['"]\s*,\s*['"](\w+)['"]\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const serviceName = m[1];
      const methodName = m[2];
      const candidates = protoMap.get(serviceName);
      const proto = resolveProtoConflict(serviceName, filePath, candidates ?? []);
      const pkg = proto?.package ?? '';
      const cid = contractId(pkg, serviceName, methodName);
      out.push(
        makeContract(cid, 'provider', filePath, `${serviceName}.${methodName}`, 0.8, {
          service: serviceName,
          method: methodName,
          source: 'ts_grpc_method',
        }),
      );
    }
    return out;
  }

  private scanTsConsumers(
    content: string,
    filePath: string,
    protoMap: Map<string, ProtoServiceInfo[]>,
  ): ExtractedContract[] {
    const out: ExtractedContract[] = [];
    const pushConsumer = (
      serviceName: string,
      symbolName: string,
      source: string,
      confidenceWithProto = 0.75,
      confidenceWithoutProto = 0.55,
    ): void => {
      const candidates = protoMap.get(serviceName);
      const proto = resolveProtoConflict(serviceName, filePath, candidates ?? []);
      const cid = proto
        ? serviceContractId(proto.package, proto.serviceName)
        : serviceOnlyContractId(serviceName);
      const conf = proto ? confidenceWithProto : confidenceWithoutProto;
      out.push(
        makeContract(cid, 'consumer', filePath, symbolName, conf, {
          service: serviceName,
          source,
        }),
      );
    };

    const getServiceRe = /\.getService(?:<[^>]+>)?\s*\(\s*['"](\w+)['"]\s*\)/g;
    let match: RegExpExecArray | null;
    while ((match = getServiceRe.exec(content)) !== null) {
      pushConsumer(match[1], `${match[1]}Client`, 'ts_client_grpc_get_service');
    }

    const clientCtorRe = /new\s+(\w+)Client\s*\(/g;
    while ((match = clientCtorRe.exec(content)) !== null) {
      pushConsumer(match[1], `${match[1]}Client`, 'ts_generated_client');
    }

    if (content.includes('loadPackageDefinition')) {
      const packageCtorRe = /new\s+[\w$.]*\.([A-Z]\w+)\s*\(/g;
      while ((match = packageCtorRe.exec(content)) !== null) {
        pushConsumer(match[1], `${match[1]}Client`, 'ts_load_package_definition');
      }
    }

    return out;
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
