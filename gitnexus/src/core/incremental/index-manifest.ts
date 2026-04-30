import { createHash } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import type { KnowledgeGraph } from '../graph/types.js';
import type { ScannedFile } from '../ingestion/filesystem-walker.js';
import type { RepoIndexManifest, RepoIndexManifestFile } from '../../storage/repo-manager.js';

const stableSort = (values: string[]): string[] => [...values].sort((a, b) => a.localeCompare(b));

const sha256 = (content: Buffer | string): string =>
  createHash('sha256').update(content).digest('hex');

const readFileHash = async (repoPath: string, relativePath: string): Promise<string | null> => {
  try {
    return sha256(await fs.readFile(path.join(repoPath, relativePath)));
  } catch {
    return null;
  }
};

const filePathForNode = (graph: KnowledgeGraph, nodeId: string): string | undefined => {
  const filePath = graph.getNode(nodeId)?.properties?.filePath;
  return typeof filePath === 'string' && filePath.length > 0 ? filePath : undefined;
};

export interface CreateIndexManifestOptions {
  generatedAt?: string;
  parseDiagnostics?: Record<string, string[]>;
}

export const createIndexManifest = async (
  repoPath: string,
  scannedFiles: ScannedFile[],
  graph: KnowledgeGraph,
  options: CreateIndexManifestOptions = {},
): Promise<RepoIndexManifest> => {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const files: Record<string, RepoIndexManifestFile> = {};
  const scannedByPath = new Map(scannedFiles.map((file) => [file.path, file]));

  for (const file of stableSort(scannedFiles.map((f) => f.path))) {
    const scanned = scannedByPath.get(file);
    if (!scanned) continue;
    files[file] = {
      size: scanned.size,
      mtimeMs: Math.trunc(scanned.mtimeMs ?? 0),
      hash: (await readFileHash(repoPath, file)) ?? '',
      emittedNodes: [],
      emittedEdges: [],
      parseDiagnostics: options.parseDiagnostics?.[file] ?? [],
      dependencies: [],
      dependants: [],
    };
  }

  const ensureFile = (filePath: string): RepoIndexManifestFile | null => {
    const entry = files[filePath];
    return entry ?? null;
  };

  for (const filePath of Object.keys(files)) {
    const entry = files[filePath];
    entry.emittedNodes.push(...graph.iterNodeIdsByFile(filePath));
    entry.emittedEdges.push(...graph.iterRelationshipIdsByFile(filePath));
  }

  for (const relationship of graph.iterRelationships()) {
    if (relationship.type === 'IMPORTS') {
      const sourceFile = filePathForNode(graph, relationship.sourceId);
      const targetFile = filePathForNode(graph, relationship.targetId);
      if (sourceFile && targetFile && sourceFile !== targetFile) {
        const sourceEntry = ensureFile(sourceFile);
        const targetEntry = ensureFile(targetFile);
        sourceEntry?.dependencies.push(targetFile);
        targetEntry?.dependants.push(sourceFile);
      }
    }
  }

  for (const entry of Object.values(files)) {
    entry.emittedNodes = stableSort(Array.from(new Set(entry.emittedNodes)));
    entry.emittedEdges = stableSort(Array.from(new Set(entry.emittedEdges)));
    entry.dependencies = stableSort(Array.from(new Set(entry.dependencies)));
    entry.dependants = stableSort(Array.from(new Set(entry.dependants)));
    entry.parseDiagnostics = stableSort(Array.from(new Set(entry.parseDiagnostics)));
  }

  return {
    version: 1,
    generatedAt,
    files,
    summary: {
      fileCount: Object.keys(files).length,
      nodeCount: graph.nodeCount,
      edgeCount: graph.relationshipCount,
    },
  };
};
