import type { ContractExtractor, CypherExecutor } from '../contract-extractor.js';
import type { ExtractedContract, RepoHandle } from '../types.js';
import { readNpmManifest } from './manifest-reader.js';
import { scanRepoForImports, type ScannedImport } from './import-scanner.js';

const EXPORTED_SYMBOLS_QUERY = `
MATCH (n)
WHERE n.isExported = true AND n.name IS NOT NULL AND n.name <> ''
RETURN n.id AS uid, n.name AS name, n.filePath AS filePath`;

/**
 * Extractor for code-level dependencies between repos in a group.
 *
 * Detects when repo B imports symbols from repo A's npm package by:
 * 1. Querying LadybugDB for exported symbols (providers)
 * 2. Scanning source files for import statements matching sibling packages (consumers)
 *
 * Uses the existing `lib` contract type and matching pipeline.
 */
export class CodeDepExtractor implements ContractExtractor {
  type = 'lib' as const;

  constructor(
    /** Maps npm package name → group path (e.g. '@acme/shared' → 'libs/shared') */
    private readonly packageMap: Map<string, string>,
    /** This repo's own package name (used for provider contracts) */
    private readonly ownPackageName: string | null,
  ) {}

  async canExtract(repo: RepoHandle): Promise<boolean> {
    // Can extract if the repo has a package.json (for providers)
    // or if there are sibling packages to check imports against (for consumers)
    const manifest = readNpmManifest(repo.repoPath);
    return manifest !== null || this.packageMap.size > 0;
  }

  async extract(
    dbExecutor: CypherExecutor | null,
    repoPath: string,
    _repo: RepoHandle,
  ): Promise<ExtractedContract[]> {
    const providers = await this.extractProviders(dbExecutor);
    const consumers = await this.extractConsumers(repoPath);
    return [...providers, ...consumers];
  }

  /**
   * Extract provider contracts: exported symbols from this repo that other repos can import.
   */
  private async extractProviders(dbExecutor: CypherExecutor | null): Promise<ExtractedContract[]> {
    if (!this.ownPackageName || !dbExecutor) return [];

    let rows: Record<string, unknown>[];
    try {
      rows = await dbExecutor(EXPORTED_SYMBOLS_QUERY);
    } catch {
      return [];
    }

    const contracts: ExtractedContract[] = [];
    const seen = new Set<string>();

    for (const row of rows) {
      const name = String(row.name ?? '');
      const uid = String(row.uid ?? '');
      const filePath = String(row.filePath ?? '');

      if (!name) continue;

      const contractId = `lib::${this.ownPackageName}::${name}`;
      if (seen.has(contractId)) continue;
      seen.add(contractId);

      contracts.push({
        contractId,
        type: 'lib',
        role: 'provider',
        symbolUid: uid,
        symbolRef: { filePath, name },
        symbolName: name,
        confidence: 0.9,
        meta: {
          packageName: this.ownPackageName,
          extractionStrategy: 'graph_exported_symbols',
        },
      });
    }

    return contracts;
  }

  /**
   * Extract consumer contracts: imports from sibling packages in this repo's source files.
   */
  private async extractConsumers(repoPath: string): Promise<ExtractedContract[]> {
    // Only scan for packages that are in the packageMap (sibling repos)
    const targetPackages = new Set(this.packageMap.keys());
    if (targetPackages.size === 0) return [];

    const scannedImports = await scanRepoForImports(repoPath, targetPackages);
    return this.importsToContracts(scannedImports);
  }

  /**
   * Convert scanned imports into ExtractedContract entries.
   */
  private importsToContracts(imports: ScannedImport[]): ExtractedContract[] {
    const contracts: ExtractedContract[] = [];
    const seen = new Set<string>();

    for (const imp of imports) {
      if (imp.isNamespaceImport) {
        const contractId = `lib::${imp.packageName}::*`;
        const key = `${contractId}|${imp.filePath}`;
        if (seen.has(key)) continue;
        seen.add(key);

        contracts.push({
          contractId,
          type: 'lib',
          role: 'consumer',
          symbolUid: '',
          symbolRef: { filePath: imp.filePath, name: '*' },
          symbolName: '*',
          confidence: 0.7,
          meta: {
            packageName: imp.packageName,
            subpath: imp.subpath,
            importType: 'namespace',
            extractionStrategy: 'source_scan',
          },
        });
        continue;
      }

      if (imp.importedSymbols.length > 0) {
        for (const symbol of imp.importedSymbols) {
          const contractId = `lib::${imp.packageName}::${symbol}`;
          const key = `${contractId}|${imp.filePath}`;
          if (seen.has(key)) continue;
          seen.add(key);

          contracts.push({
            contractId,
            type: 'lib',
            role: 'consumer',
            symbolUid: '',
            symbolRef: { filePath: imp.filePath, name: symbol },
            symbolName: symbol,
            confidence: 0.9,
            meta: {
              packageName: imp.packageName,
              subpath: imp.subpath,
              importType: 'named',
              extractionStrategy: 'source_scan',
            },
          });
        }
      } else if (imp.isDefaultImport) {
        const contractId = `lib::${imp.packageName}::default`;
        const key = `${contractId}|${imp.filePath}`;
        if (seen.has(key)) continue;
        seen.add(key);

        contracts.push({
          contractId,
          type: 'lib',
          role: 'consumer',
          symbolUid: '',
          symbolRef: { filePath: imp.filePath, name: 'default' },
          symbolName: 'default',
          confidence: 0.8,
          meta: {
            packageName: imp.packageName,
            subpath: imp.subpath,
            importType: 'default',
            extractionStrategy: 'source_scan',
          },
        });
      }
    }

    return contracts;
  }
}
