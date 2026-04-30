import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RegistryEntry } from '../../storage/repo-manager.js';
import { LocalBackend } from '../../mcp/local/local-backend.js';

const execFileAsync = promisify(execFile);

export interface ContextSnapshotOptions {
  maxNodes?: number;
  maxEdges?: number;
  redact?: string[];
  signingHook?: string;
}

export interface ContextSnapshot {
  kind: 'nexusforge.context-snapshot';
  schemaVersion: 1;
  generatedAt: string;
  repo: {
    name: string;
    pathHash: string;
    remoteUrl?: string;
    commit?: string;
    indexedAt?: string;
    stats?: RegistryEntry['stats'];
  };
  manifests: {
    fileManifest?: Record<string, unknown>;
    indexManifest?: Record<string, unknown>;
  };
  contracts: {
    files: Array<{ path: string; checksum: string; bytes: number }>;
  };
  semanticAnchors: {
    format: 'markdown';
    status: 'included' | 'unavailable';
    data?: string;
    message?: string;
  };
  runtime?: Record<string, unknown>;
  graph: {
    nodes: string[];
    edges: string[];
    truncated: boolean;
  };
  redaction: {
    patternsApplied: number;
  };
  checksum?: string;
  signature?: {
    hook: string;
    value: string;
  };
}

const sha256 = (value: string | Buffer): string =>
  createHash('sha256').update(value).digest('hex');

const readJson = async (filePath: string): Promise<any | null> => {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8'));
  } catch {
    return null;
  }
};

const safeRepoName = (value: string): string => value.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 80);

const manifestSummary = (manifest: any, maxFiles: number): Record<string, unknown> | undefined => {
  if (!manifest || typeof manifest !== 'object') return undefined;
  const files = manifest.files && typeof manifest.files === 'object' ? manifest.files : {};
  const fileEntries = Object.entries(files).slice(0, maxFiles);
  const totalBytes = Object.values(files).reduce((sum, entry: any) => {
    const size = typeof entry?.size === 'number' ? entry.size : 0;
    return sum + size;
  }, 0);
  return {
    version: manifest.version,
    generatedAt: manifest.generatedAt,
    summary: manifest.summary,
    fileCount: Object.keys(files).length,
    totalBytes,
    sampleFiles: fileEntries.map(([filePath, entry]) => ({
      path: filePath,
      ...(entry && typeof entry === 'object' ? entry : {}),
    })),
  };
};

const runtimeSummary = (runtime: any): Record<string, unknown> | undefined => {
  if (!runtime || typeof runtime !== 'object') return undefined;
  const count = (key: string) => (Array.isArray(runtime[key]) ? runtime[key].length : 0);
  const hotRoutes = Array.isArray(runtime.routes)
    ? runtime.routes
        .slice()
        .sort((a: any, b: any) => (b.errorCount ?? 0) - (a.errorCount ?? 0))
        .slice(0, 20)
    : [];
  const hotErrors = Array.isArray(runtime.errors)
    ? runtime.errors
        .slice()
        .sort((a: any, b: any) => (b.count ?? b.errorCount ?? 0) - (a.count ?? a.errorCount ?? 0))
        .slice(0, 20)
    : [];
  return {
    generatedAt: runtime.generatedAt,
    sourceFiles: runtime.sourceFiles,
    counts: {
      services: count('services'),
      routes: count('routes'),
      spans: count('spans'),
      errors: count('errors'),
      logPatterns: count('logPatterns'),
      logs: count('logs'),
    },
    hotRoutes,
    hotErrors,
  };
};

const collectContractFiles = async (
  storagePath: string,
): Promise<Array<{ path: string; checksum: string; bytes: number }>> => {
  const candidates = ['contracts.json', 'contract-registry.json'];
  const files: Array<{ path: string; checksum: string; bytes: number }> = [];
  for (const name of candidates) {
    const filePath = path.join(storagePath, name);
    try {
      const bytes = await fs.readFile(filePath);
      files.push({ path: name, checksum: sha256(bytes), bytes: bytes.byteLength });
    } catch {}
  }
  return files;
};

const collectSemanticAnchors = async (
  repoName: string,
  maxNodes: number,
): Promise<ContextSnapshot['semanticAnchors']> => {
  const backend = new LocalBackend();
  try {
    const ok = await backend.init();
    if (!ok) {
      return { format: 'markdown', status: 'unavailable', message: 'No indexed repos available.' };
    }
    const result = await backend.callTool('cypher', {
      repo: repoName,
      query: `
        MATCH (n)
        WHERE n.description IS NOT NULL OR n.summary IS NOT NULL OR n.purpose IS NOT NULL
        RETURN labels(n)[0] AS kind, n.name AS name, n.filePath AS filePath,
               n.description AS description, n.summary AS summary, n.purpose AS purpose,
               n.anchorHash AS anchorHash
        LIMIT ${Math.max(1, Math.min(500, maxNodes))}
      `,
    });
    return { format: 'markdown', status: 'included', data: String(result ?? '') };
  } catch (err) {
    return {
      format: 'markdown',
      status: 'unavailable',
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    await backend.dispose().catch(() => {});
  }
};

const redactValue = (value: unknown, patterns: string[], key = ''): unknown => {
  if (patterns.length === 0) return value;
  const normalizedKey = key.toLowerCase();
  if (patterns.some((pattern) => normalizedKey.includes(pattern.toLowerCase()))) {
    return '[redacted]';
  }
  if (typeof value === 'string') {
    return patterns.reduce(
      (current, pattern) => current.split(pattern).join('[redacted]'),
      value,
    );
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, patterns));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redactValue(childValue, patterns, childKey),
      ]),
    );
  }
  return value;
};

const attachChecksumAndSignature = async (
  snapshot: ContextSnapshot,
  signingHook?: string,
): Promise<ContextSnapshot> => {
  const unsigned = { ...snapshot, checksum: undefined, signature: undefined };
  const checksum = sha256(JSON.stringify(unsigned));
  const next: ContextSnapshot = { ...snapshot, checksum };
  if (signingHook) {
    const tmpPath = path.join(os.tmpdir(), `nexusforge-snapshot-${checksum}.json`);
    await fs.writeFile(tmpPath, JSON.stringify(next, null, 2), 'utf-8');
    const { stdout } = await execFileAsync(signingHook, [tmpPath]);
    next.signature = { hook: signingHook, value: stdout.trim() };
    await fs.rm(tmpPath, { force: true }).catch(() => {});
  }
  return next;
};

export const createContextSnapshot = async (
  repo: RegistryEntry,
  options: ContextSnapshotOptions = {},
): Promise<ContextSnapshot> => {
  const maxNodes = Math.max(1, Math.min(1000, options.maxNodes ?? 250));
  const maxEdges = Math.max(1, Math.min(2000, options.maxEdges ?? 500));
  const fileManifest = await readJson(path.join(repo.storagePath, 'file-manifest.json'));
  const indexManifest = await readJson(path.join(repo.storagePath, 'index-manifest.json'));
  const runtime = await readJson(path.join(repo.storagePath, 'runtime-signals.json'));
  const contracts = await collectContractFiles(repo.storagePath);
  const semanticAnchors = await collectSemanticAnchors(repo.name, maxNodes);

  const emittedNodes = indexManifest?.files
    ? Object.values(indexManifest.files).flatMap((entry: any) =>
        Array.isArray(entry?.emittedNodes) ? entry.emittedNodes : [],
      )
    : [];
  const emittedEdges = indexManifest?.files
    ? Object.values(indexManifest.files).flatMap((entry: any) =>
        Array.isArray(entry?.emittedEdges) ? entry.emittedEdges : [],
      )
    : [];

  const base: ContextSnapshot = {
    kind: 'nexusforge.context-snapshot',
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    repo: {
      name: repo.name,
      pathHash: sha256(path.resolve(repo.path)),
      remoteUrl: repo.remoteUrl,
      commit: repo.lastCommit,
      indexedAt: repo.indexedAt,
      stats: repo.stats,
    },
    manifests: {
      fileManifest: manifestSummary(fileManifest, 60),
      indexManifest: manifestSummary(indexManifest, 60),
    },
    contracts: { files: contracts },
    semanticAnchors,
    runtime: runtimeSummary(runtime),
    graph: {
      nodes: emittedNodes.slice(0, maxNodes).map(String),
      edges: emittedEdges.slice(0, maxEdges).map(String),
      truncated: emittedNodes.length > maxNodes || emittedEdges.length > maxEdges,
    },
    redaction: { patternsApplied: options.redact?.length ?? 0 },
  };

  const redacted = redactValue(base, options.redact ?? []) as ContextSnapshot;
  return attachChecksumAndSignature(redacted, options.signingHook);
};

export const verifyContextSnapshot = (snapshot: ContextSnapshot): boolean => {
  if (!snapshot.checksum) return false;
  const unsigned = { ...snapshot, checksum: undefined, signature: undefined };
  return sha256(JSON.stringify(unsigned)) === snapshot.checksum;
};

export const defaultContextLakeDir = (): string => path.join(os.homedir(), '.gitnexus', 'context-lake');

export const snapshotFileName = (snapshot: ContextSnapshot): string => {
  const commit = snapshot.repo.commit ? snapshot.repo.commit.slice(0, 12) : 'no-commit';
  const stamp = snapshot.generatedAt.replace(/[:.]/g, '-');
  return `${safeRepoName(snapshot.repo.name)}-${commit}-${stamp}.context.json`;
};

export const writeLocalSnapshot = async (
  destination: string,
  snapshot: ContextSnapshot,
): Promise<string> => {
  const resolved = path.resolve(destination);
  const isJsonFile = resolved.toLowerCase().endsWith('.json');
  const filePath = isJsonFile ? resolved : path.join(resolved, snapshotFileName(snapshot));
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf-8');
  return filePath;
};

export const readLocalSnapshot = async (source: string): Promise<{ path: string; snapshot: ContextSnapshot }> => {
  const resolved = path.resolve(source);
  const stat = await fs.stat(resolved);
  let filePath = resolved;
  if (stat.isDirectory()) {
    const entries = await fs.readdir(resolved);
    const snapshots = entries
      .filter((entry) => entry.endsWith('.context.json'))
      .map((entry) => path.join(resolved, entry));
    if (snapshots.length === 0) throw new Error(`No .context.json snapshots found in ${resolved}`);
    const withStats = await Promise.all(
      snapshots.map(async (snapshotPath) => ({ path: snapshotPath, stat: await fs.stat(snapshotPath) })),
    );
    withStats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    filePath = withStats[0].path;
  }
  const snapshot = JSON.parse(await fs.readFile(filePath, 'utf-8')) as ContextSnapshot;
  return { path: filePath, snapshot };
};

export const copyWithAwsCli = async (
  source: string,
  destination: string,
  endpointUrl?: string,
): Promise<void> => {
  const args = ['s3', 'cp', source, destination];
  if (endpointUrl) args.push('--endpoint-url', endpointUrl);
  await execFileAsync('aws', args);
};
