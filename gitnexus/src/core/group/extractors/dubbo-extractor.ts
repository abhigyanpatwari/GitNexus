import path from 'node:path';
import { glob } from 'glob';
import Parser from 'tree-sitter';
import { createIgnoreFilter } from '../../../config/ignore-service.js';
import { getMaxFileSizeBytes } from '../../ingestion/utils/max-file-size.js';
import { createTreeReleaser } from '../../tree-sitter/native-tree-release.js';
import { parseSourceSafe } from '../../tree-sitter/safe-parse.js';
import type { ContractExtractor, CypherExecutor } from '../contract-extractor.js';
import type { ExtractedContract, RepoHandle } from '../types.js';
import { readSafeBounded } from './fs-utils.js';
import {
  buildSites,
  dubboContractId,
  scanSource,
  type DubboSite,
  type SourceFile,
  DUBBO_LANGUAGE,
  DUBBO_SCAN_GLOB,
} from './dubbo-patterns/index.js';

/** Exact zero-based graph coordinate. LadybugDB label() returns a scalar string. */
export const DUBBO_SYMBOL_QUERY = `
MATCH (n)
WHERE label(n) IN ['Method','Function','Class','Interface']
  AND n.filePath = $filePath AND n.name = $name AND n.startLine = $line AND n.id <> ''
RETURN n.id AS uid
ORDER BY n.id ASC
LIMIT 2`;

/**
 * Source facts are shared across the group: an interface can live in a third,
 * contract-only repository. Each member still resolves its own endpoints using
 * its own leased graph connection. No source AST or database handle is cached.
 */
export class DubboExtractor implements ContractExtractor {
  type = 'dubbo' as const;
  private sites?: Promise<Map<string, DubboSite[]>>;

  constructor(private readonly repoPaths: () => Promise<string[]>) {}

  async canExtract(_repo: RepoHandle): Promise<boolean> {
    return true;
  }

  private async collectSites(): Promise<Map<string, DubboSite[]>> {
    const sources = new Map<SourceFile, string>();
    const parser = new Parser();
    parser.setLanguage(DUBBO_LANGUAGE);
    const releaseTrees = createTreeReleaser();
    for (const repoPath of [...new Set(await this.repoPaths())].sort()) {
      const ignore = await createIgnoreFilter(repoPath);
      const files = await glob(DUBBO_SCAN_GLOB, {
        cwd: repoPath,
        ignore,
        nodir: true,
        follow: false,
      });
      for (const rel of files.sort()) {
        const source = await readSafeBounded(repoPath, rel, getMaxFileSizeBytes());
        if (source === null) continue;
        await releaseTrees();
        const tree = parseSourceSafe(parser, source);
        if (tree.rootNode.hasError) continue;
        sources.set(scanSource(rel.replace(/\\/g, '/'), tree.rootNode), path.resolve(repoPath));
      }
    }
    const sitesByRepo = new Map<string, DubboSite[]>();
    for (const [file, sites] of buildSites([...sources.keys()])) {
      const repoPath = sources.get(file);
      if (!repoPath) continue;
      const list = sitesByRepo.get(repoPath) ?? [];
      for (const site of sites) list.push(site);
      sitesByRepo.set(repoPath, list);
    }
    return sitesByRepo;
  }

  async extract(
    execute: CypherExecutor | null,
    repoPath: string,
    _repo: RepoHandle,
  ): Promise<ExtractedContract[]> {
    if (!execute) return [];
    this.sites ??= this.collectSites();
    const sites = (await this.sites).get(path.resolve(repoPath)) ?? [];
    const symbols = new Map<string, string | null>();
    const contracts = new Map<string, ExtractedContract>();
    for (const site of sites) {
      const coordinate = JSON.stringify([site.filePath, site.name, site.line]);
      if (!symbols.has(coordinate)) {
        const rows = await execute(DUBBO_SYMBOL_QUERY, {
          filePath: site.filePath,
          name: site.name,
          line: site.line,
        });
        symbols.set(
          coordinate,
          rows.length === 1 && typeof rows[0].uid === 'string' ? rows[0].uid : null,
        );
      }
      const symbolUid = symbols.get(coordinate);
      if (!symbolUid) continue;
      const contractId = dubboContractId(site, site.method, site.parameters);
      const contract: ExtractedContract = {
        contractId,
        type: this.type,
        role: site.role,
        symbolUid,
        symbolRef: { filePath: site.filePath, name: site.name },
        symbolName: site.name,
        confidence: 0.9,
        meta: {
          framework: 'dubbo',
          service: site.service,
          group: site.group,
          version: site.version,
          method: site.method,
          parameters: site.parameters,
          extractionStrategy: 'source_scan',
        },
      };
      contracts.set(`${contractId}|${site.role}|${symbolUid}`, contract);
    }
    return [...contracts.values()];
  }
}
