import type { ContractType, CrossLink, GroupManifestLink, StoredContract } from '../types.js';
import type { CypherExecutor } from '../contract-extractor.js';

export interface ManifestExtractResult {
  contracts: StoredContract[];
  crossLinks: CrossLink[];
}

export class ManifestExtractor {
  async extractFromManifest(
    links: GroupManifestLink[],
    dbExecutors?: Map<string, CypherExecutor>,
  ): Promise<ManifestExtractResult> {
    const contracts: StoredContract[] = [];
    const crossLinks: CrossLink[] = [];

    for (const link of links) {
      const contractId = this.buildContractId(link.type, link.contract);

      const providerRepo = link.role === 'provider' ? link.from : link.to;
      const consumerRepo = link.role === 'provider' ? link.to : link.from;

      const providerSymbol = await this.resolveSymbol(providerRepo, link, dbExecutors);
      const consumerSymbol = await this.resolveSymbol(consumerRepo, link, dbExecutors);
      const providerRef = providerSymbol || { filePath: '', name: link.contract };
      const consumerRef = consumerSymbol || { filePath: '', name: link.contract };
      const providerUid = providerSymbol?.uid ?? '';
      const consumerUid = consumerSymbol?.uid ?? '';

      contracts.push({
        contractId,
        type: link.type,
        role: 'provider',
        symbolUid: providerUid,
        symbolRef: providerRef,
        symbolName: link.contract,
        confidence: 1.0,
        meta: { source: 'manifest' },
        repo: providerRepo,
      });

      contracts.push({
        contractId,
        type: link.type,
        role: 'consumer',
        symbolUid: consumerUid,
        symbolRef: consumerRef,
        symbolName: link.contract,
        confidence: 1.0,
        meta: { source: 'manifest' },
        repo: consumerRepo,
      });

      crossLinks.push({
        from: { repo: consumerRepo, symbolUid: consumerUid, symbolRef: consumerRef },
        to: { repo: providerRepo, symbolUid: providerUid, symbolRef: providerRef },
        type: link.type,
        contractId,
        matchType: 'manifest',
        confidence: 1.0,
      });
    }

    return { contracts, crossLinks };
  }

  private async resolveSymbol(
    repoPathKey: string,
    link: GroupManifestLink,
    dbExecutors?: Map<string, CypherExecutor>,
  ): Promise<{ filePath: string; name: string; uid: string } | null> {
    const executor = dbExecutors?.get(repoPathKey);
    if (!executor) return null;

    try {
      let rows: Record<string, unknown>[];
      if (link.type === 'http') {
        rows = await executor(
          `MATCH (handler)-[r:CodeRelation {type: 'HANDLES_ROUTE'}]->(route:Route)
           WHERE route.name CONTAINS $contract
           RETURN handler.id AS uid, handler.name AS name, handler.filePath AS filePath
           LIMIT 1`,
          { contract: link.contract },
        );
      } else if (link.type === 'topic') {
        rows = await executor(
          `MATCH (n) WHERE n.name CONTAINS $contract
           RETURN n.id AS uid, n.name AS name, n.filePath AS filePath
           LIMIT 1`,
          { contract: link.contract },
        );
      } else if (link.type === 'grpc') {
        const [serviceName, methodName = ''] = link.contract.split('/');
        rows = await executor(
          `MATCH (n)
           WHERE n.name CONTAINS $serviceName
              OR n.name CONTAINS $methodName
              OR n.filePath ENDS WITH '.proto'
           RETURN n.id AS uid, n.name AS name, n.filePath AS filePath
           LIMIT 1`,
          { contract: link.contract, serviceName, methodName },
        );
      } else if (link.type === 'lib') {
        const packageName = link.contract.split('/').pop() ?? link.contract;
        rows = await executor(
          `MATCH (n)
           WHERE n.name = $contract
              OR n.name CONTAINS $packageName
              OR n.filePath CONTAINS $packageName
           RETURN n.id AS uid, n.name AS name, n.filePath AS filePath
           LIMIT 1`,
          { contract: link.contract, packageName },
        );
      } else {
        return null;
      }
      if (rows.length > 0) {
        return {
          filePath: rows[0].filePath as string,
          name: rows[0].name as string,
          uid: String(rows[0].uid ?? ''),
        };
      }
    } catch {
      /* fall through */
    }
    return null;
  }

  private buildContractId(type: ContractType, contract: string): string {
    switch (type) {
      case 'http': {
        if (/^[A-Za-z]+::/.test(contract)) return `http::${contract}`;
        return `http::*::${contract}`;
      }
      case 'grpc':
        return `grpc::${contract}`;
      case 'topic':
        return `topic::${contract}`;
      case 'lib':
        return `lib::${contract}`;
      case 'custom':
        return `custom::${contract}`;
    }
  }
}
