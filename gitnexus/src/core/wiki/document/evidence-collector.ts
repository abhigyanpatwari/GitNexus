import fs from 'node:fs/promises';
import path from 'node:path';
import {
  getAllFiles,
  getAllProcesses,
  getFilesWithExports,
  getInterModuleCallEdges,
  getIntraModuleCallEdges,
  getProcessesForFiles,
  type CallEdge,
  type FileWithExports,
  type ProcessInfo,
} from '../graph-queries.js';
import {
  createEvidenceRef,
  deduplicateEvidence,
  type EvidenceBundle,
  type EvidenceRef,
  type EvidenceRefKind,
} from './evidence.js';

export const EVIDENCE_COLLECTOR_VERSION = 1;

export interface EvidenceGraphReader {
  getAllFiles(): Promise<string[]>;
  getFilesWithExports(): Promise<FileWithExports[]>;
  getIntraModuleCallEdges(filePaths: string[]): Promise<CallEdge[]>;
  getInterModuleCallEdges(filePaths: string[]): Promise<{
    incoming: CallEdge[];
    outgoing: CallEdge[];
  }>;
  getProcessesForFiles(filePaths: string[], limit?: number): Promise<ProcessInfo[]>;
  getAllProcesses(limit?: number): Promise<ProcessInfo[]>;
}

export interface EvidenceCollectorOptions {
  maxRepositoryItems?: number;
  maxModuleItems?: number;
  maxExcerptChars?: number;
  processLimit?: number;
}

export interface CollectEvidenceInput {
  sourceCommit: string;
  moduleFiles: Readonly<Record<string, readonly string[]>>;
  limitations?: readonly string[];
}

const DEFAULT_GRAPH_READER: EvidenceGraphReader = {
  getAllFiles,
  getFilesWithExports,
  getIntraModuleCallEdges,
  getInterModuleCallEdges,
  getProcessesForFiles,
  getAllProcesses,
};

function normalizeFilePath(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

function classifyFile(filePath: string): EvidenceRefKind {
  const normalized = filePath.toLowerCase();
  const base = path.posix.basename(normalized);
  if (
    /(^|\/)(__tests__|test|tests|spec|specs)(\/|$)/.test(normalized) ||
    /\.(test|spec)\.[^.]+$/.test(normalized)
  ) {
    return 'test';
  }
  if (
    /(^|\/)(docs?|wiki)(\/|$)/.test(normalized) ||
    /^(readme|changelog|contributing|architecture)(\.|$)/.test(base) ||
    /\.(md|mdx|adoc|rst)$/.test(normalized)
  ) {
    return 'existing-doc';
  }
  if (
    /(^|\/)(config|configs)(\/|$)/.test(normalized) ||
    /(^|\.)(json|ya?ml|toml|ini|properties)$/.test(normalized) ||
    /^(package\.json|tsconfig.*\.json|dockerfile|compose.*\.ya?ml)$/.test(base)
  ) {
    return 'config';
  }
  return 'file';
}

function edgeEvidence(
  edge: CallEdge,
  direction: 'internal' | 'incoming' | 'outgoing',
): EvidenceRef {
  const relation = `${direction}:calls`;
  return createEvidenceRef({
    kind: 'relation',
    status: 'verified',
    filePath: normalizeFilePath(edge.fromFile),
    symbol: edge.fromName,
    relation: `${relation}:${normalizeFilePath(edge.toFile)}:${edge.toName}`,
    summary: `${edge.fromName} (${normalizeFilePath(edge.fromFile)}) calls ${edge.toName} (${normalizeFilePath(edge.toFile)})`,
  });
}

function processEvidence(process: ProcessInfo): EvidenceRef {
  return createEvidenceRef({
    kind: 'process',
    status: 'verified',
    processId: process.id,
    summary: `${process.label} (${process.type}, ${process.stepCount} steps)`,
    excerpt: process.steps
      .map((step) => `${step.step}. ${step.name} (${normalizeFilePath(step.filePath)})`)
      .join('\n'),
  });
}

export class EvidenceCollector {
  private readonly graph: EvidenceGraphReader;
  private readonly maxRepositoryItems: number;
  private readonly maxModuleItems: number;
  private readonly maxExcerptChars: number;
  private readonly processLimit: number;

  constructor(
    private readonly repoPath: string,
    graph: EvidenceGraphReader = DEFAULT_GRAPH_READER,
    options: EvidenceCollectorOptions = {},
  ) {
    this.graph = graph;
    this.maxRepositoryItems = options.maxRepositoryItems ?? 500;
    this.maxModuleItems = options.maxModuleItems ?? 200;
    this.maxExcerptChars = options.maxExcerptChars ?? 2000;
    this.processLimit = options.processLimit ?? 20;
  }

  async collect(input: CollectEvidenceInput): Promise<EvidenceBundle> {
    const [allFiles, filesWithExports, allProcesses] = await Promise.all([
      this.graph.getAllFiles(),
      this.graph.getFilesWithExports(),
      this.graph.getAllProcesses(this.processLimit),
    ]);

    const repository: EvidenceRef[] = [];
    for (const filePath of [...allFiles].map(normalizeFilePath).sort()) {
      repository.push(await this.collectFile(filePath));
    }
    for (const file of [...filesWithExports].sort((a, b) => a.filePath.localeCompare(b.filePath))) {
      for (const symbol of [...file.symbols].sort((a, b) => a.name.localeCompare(b.name))) {
        repository.push(
          createEvidenceRef({
            kind: 'symbol',
            status: 'verified',
            filePath: normalizeFilePath(file.filePath),
            symbol: symbol.name,
            summary: `${symbol.type} ${symbol.name} is exported from ${normalizeFilePath(file.filePath)}`,
          }),
        );
      }
    }
    repository.push(...allProcesses.map(processEvidence));

    const modules: Record<string, readonly EvidenceRef[]> = {};
    for (const moduleName of Object.keys(input.moduleFiles).sort()) {
      const files = [...input.moduleFiles[moduleName]].map(normalizeFilePath).sort();
      const [internal, inter, processes] = await Promise.all([
        this.graph.getIntraModuleCallEdges(files),
        this.graph.getInterModuleCallEdges(files),
        this.graph.getProcessesForFiles(files, this.processLimit),
      ]);
      const fileSet = new Set(files);
      const fileEvidence = repository.filter(
        (item) => item.filePath !== undefined && fileSet.has(item.filePath),
      );
      modules[moduleName] = deduplicateEvidence([
        ...fileEvidence,
        ...internal.map((edge) => edgeEvidence(edge, 'internal')),
        ...inter.incoming.map((edge) => edgeEvidence(edge, 'incoming')),
        ...inter.outgoing.map((edge) => edgeEvidence(edge, 'outgoing')),
        ...processes.map(processEvidence),
      ]).slice(0, this.maxModuleItems);
    }

    return {
      schemaVersion: 1,
      repoPath: this.repoPath,
      sourceCommit: input.sourceCommit,
      collectedAt: new Date().toISOString(),
      repository: deduplicateEvidence(repository).slice(0, this.maxRepositoryItems),
      modules,
      conflicts: [],
      limitations: [...(input.limitations ?? [])],
    };
  }

  private async collectFile(filePath: string): Promise<EvidenceRef> {
    const kind = classifyFile(filePath);
    const absolutePath = path.resolve(this.repoPath, filePath);
    const relativePath = path.relative(this.repoPath, absolutePath);
    let excerpt: string | undefined;
    let status: EvidenceRef['status'] = 'verified';

    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      status = 'missing';
    } else {
      try {
        excerpt = (await fs.readFile(absolutePath, 'utf8')).slice(0, this.maxExcerptChars);
      } catch {
        status = 'missing';
      }
    }

    return createEvidenceRef({
      kind,
      status,
      filePath,
      summary:
        status === 'verified'
          ? `${kind} evidence from ${filePath}`
          : `Graph referenced ${filePath}, but the file could not be read safely`,
      ...(excerpt !== undefined ? { excerpt } : {}),
    });
  }
}
