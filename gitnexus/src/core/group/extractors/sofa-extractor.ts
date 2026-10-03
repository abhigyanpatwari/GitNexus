import { glob } from 'glob';
import { createIgnoreFilter } from '../../../config/ignore-service.js';
import type { ContractExtractor, CypherExecutor } from '../contract-extractor.js';
import type { ExtractedContract, RepoHandle } from '../types.js';
import { readSafe } from './fs-utils.js';

/**
 * SOFA framework extractor for RPC contract discovery from XML files.
 *
 * SOFA RPC (Alibaba SOFA framework) uses XML declarations:
 *   - `<sofa:service interface="com.xxx.YyyService">` + `<sofa:binding.tr/>` → provider
 *   - `<sofa:reference interface="com.xxx.YyyService">` + `<sofa:binding.tr/>` → consumer
 *
 * SOFAMQ topic extraction is handled by the Java tree-sitter topic extractor
 * (topic-patterns/java.ts), which detects OpenMessaging API calls:
 *   - `consumer.subscribe("topic", "tag", listener)` → topic consumer
 *   - `new Message("topic", "tag", body)` → topic provider
 *
 * XML `sofa:consumer` + `sofa:channel` + `sofa:binding.msg_broker` declarations
 * are NOT extracted because they represent distributed scheduled task dispatching
 * (e.g. `TP_F_SC` channel), not real message pub/sub relationships.
 *
 * Because SOFA XML uses a distinctive namespace prefix, regex extraction is
 * reliable and avoids the need for a full XML tree-sitter grammar.
 */

const SOFA_XML_GLOB = '**/*.xml';

// ─── Regex patterns for SOFA XML elements ───────────────────────────

/**
 * Match <sofa:service interface="...">…</sofa:service> blocks.
 * Captures the interface attribute and the full block content.
 * Note: self-closing <sofa:service …/> is not matched; SOFA XML always
 * uses the closing tag because it contains binding children.
 */
const SOFA_SERVICE_RE = /<sofa:service\s+[^>]*interface="([^"]+)"[^>]*>([\s\S]*?)<\/sofa:service>/g;

/**
 * Match <sofa:reference interface="…" …> (may be self-closing or have body).
 * Captures the interface attribute.
 */
const SOFA_REFERENCE_RE = /<sofa:reference\s+[^>]*interface="([^"]+)"[^>]*\/?>/g;

/**
 * Detect TR (bolt) binding inside a sofa:service block.
 */
const BINDING_TR_RE = /sofa:binding\.tr/;

// ─── Helper: build an ExtractedContract ──────────────────────────────

function makeRpcContract(
  interfaceName: string,
  role: 'provider' | 'consumer',
  filePath: string,
): ExtractedContract {
  return {
    contractId: `custom::${interfaceName}`,
    type: 'custom',
    role,
    symbolUid: '',
    symbolRef: { filePath: filePath.replace(/\\/g, '/'), name: interfaceName },
    symbolName: interfaceName,
    confidence: 0.85,
    meta: {
      framework: 'sofa-rpc',
      interface: interfaceName,
      extractionStrategy: 'regex_xml',
    },
  };
}

// ─── Extractor class ─────────────────────────────────────────────────

export class SofaExtractor implements ContractExtractor {
  type = 'custom' as const;

  async canExtract(_repo: RepoHandle): Promise<boolean> {
    return true;
  }

  async extract(
    _dbExecutor: CypherExecutor | null,
    repoPath: string,
    _repo: RepoHandle,
  ): Promise<ExtractedContract[]> {
    const baseFilter = await createIgnoreFilter(repoPath);
    const files = await glob(SOFA_XML_GLOB, {
      cwd: repoPath,
      ignore: baseFilter,
      nodir: true,
    });

    const out: ExtractedContract[] = [];

    for (const rel of files) {
      const content = readSafe(repoPath, rel);
      if (!content) continue;

      // Skip files that don't contain any SOFA namespace declarations
      if (!content.includes('sofa:')) continue;

      // ── SOFA RPC: sofa:service (provider) ──
      let m: RegExpExecArray | null;
      SOFA_SERVICE_RE.lastIndex = 0;
      while ((m = SOFA_SERVICE_RE.exec(content)) !== null) {
        const interfaceName = m[1];
        const body = m[2];
        if (BINDING_TR_RE.test(body)) {
          out.push(makeRpcContract(interfaceName, 'provider', rel));
        }
      }

      // ── SOFA RPC: sofa:reference (consumer) ──
      SOFA_REFERENCE_RE.lastIndex = 0;
      while ((m = SOFA_REFERENCE_RE.exec(content)) !== null) {
        const interfaceName = m[1];
        out.push(makeRpcContract(interfaceName, 'consumer', rel));
      }
    }

    return this.dedupe(out);
  }

  private dedupe(items: ExtractedContract[]): ExtractedContract[] {
    const seen = new Set<string>();
    const out: ExtractedContract[] = [];
    for (const c of items) {
      const k = `${c.contractId}|${c.role}|${c.symbolRef.filePath}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(c);
    }
    return out;
  }
}
