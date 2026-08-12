import type { EvidenceStatus } from './evidence.js';

export const SECTION_DRAFT_SCHEMA_VERSION = 1 as const;

export interface ClaimIR {
  id: string;
  text: string;
  status: Extract<EvidenceStatus, 'verified' | 'inferred' | 'conflicting'>;
  evidenceIds: string[];
  origin: 'deterministic' | 'llm';
}

export type SectionBlock =
  | { type: 'claim'; claim: ClaimIR }
  | {
      type: 'table';
      headers: string[];
      rows: Array<{ cells: string[]; evidenceIds: string[] }>;
    }
  | {
      type: 'diagram';
      syntax: 'mermaid';
      source: string;
      evidenceIds: string[];
    }
  | {
      type: 'unknown';
      status: Extract<EvidenceStatus, 'missing' | 'needs-human' | 'conflicting'>;
      reason: string;
      evidenceIds: string[];
    };

export interface SectionDraftResponse {
  schemaVersion: typeof SECTION_DRAFT_SCHEMA_VERSION;
  sectionId: string;
  blocks: SectionBlock[];
}

function requireEvidenceIds(
  evidenceIds: readonly string[],
  label: string,
  knownEvidenceIds?: ReadonlySet<string>,
): void {
  if (evidenceIds.length === 0) throw new Error(`${label} must reference evidence`);
  if (new Set(evidenceIds).size !== evidenceIds.length) {
    throw new Error(`${label} contains duplicate evidence ids`);
  }
  if (knownEvidenceIds) {
    for (const evidenceId of evidenceIds) {
      if (!knownEvidenceIds.has(evidenceId)) {
        throw new Error(`${label} references unknown evidence id: ${evidenceId}`);
      }
    }
  }
}

export function validateSectionBlocks(
  blocks: readonly SectionBlock[],
  knownEvidenceIds?: ReadonlySet<string>,
): void {
  const claimIds = new Set<string>();
  blocks.forEach((block, blockIndex) => {
    const label = `blocks[${blockIndex}]`;
    if (block.type === 'claim') {
      if (claimIds.has(block.claim.id)) throw new Error(`Duplicate claim id: ${block.claim.id}`);
      claimIds.add(block.claim.id);
      if (!['verified', 'inferred', 'conflicting'].includes(block.claim.status)) {
        throw new Error(`${label}.claim.status is invalid`);
      }
      requireEvidenceIds(block.claim.evidenceIds, `${label}.claim`, knownEvidenceIds);
    } else if (block.type === 'table') {
      if (block.headers.length === 0) throw new Error(`${label}.headers must not be empty`);
      block.rows.forEach((row, rowIndex) => {
        if (row.cells.length !== block.headers.length) {
          throw new Error(`${label}.rows[${rowIndex}] cell count does not match headers`);
        }
        requireEvidenceIds(row.evidenceIds, `${label}.rows[${rowIndex}]`, knownEvidenceIds);
      });
    } else if (block.type === 'diagram') {
      if (block.syntax !== 'mermaid') throw new Error(`${label}.syntax is invalid`);
      requireEvidenceIds(block.evidenceIds, label, knownEvidenceIds);
    } else if (block.type === 'unknown') {
      if (!['missing', 'needs-human', 'conflicting'].includes(block.status)) {
        throw new Error(`${label}.status is invalid`);
      }
      if (block.status === 'conflicting') {
        requireEvidenceIds(block.evidenceIds, label, knownEvidenceIds);
      } else if (knownEvidenceIds) {
        for (const evidenceId of block.evidenceIds) {
          if (!knownEvidenceIds.has(evidenceId)) {
            throw new Error(`${label} references unknown evidence id: ${evidenceId}`);
          }
        }
      }
    } else {
      throw new Error(`${label}.type is invalid`);
    }
  });
}

export function validateSectionDraftResponse(
  response: SectionDraftResponse,
  expectedSectionId: string,
  knownEvidenceIds?: ReadonlySet<string>,
): void {
  if (response.schemaVersion !== SECTION_DRAFT_SCHEMA_VERSION) {
    throw new Error(`Unsupported section draft schemaVersion: ${response.schemaVersion}`);
  }
  if (response.sectionId !== expectedSectionId) {
    throw new Error(
      `Section draft id mismatch: expected ${expectedSectionId}, got ${response.sectionId}`,
    );
  }
  if (!Array.isArray(response.blocks)) throw new Error('Section draft blocks must be an array');
  validateSectionBlocks(response.blocks, knownEvidenceIds);
}
