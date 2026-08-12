import { createHash } from 'node:crypto';

export const EVIDENCE_SCHEMA_VERSION = 1 as const;

export type EvidenceStatus = 'verified' | 'inferred' | 'missing' | 'conflicting' | 'needs-human';

export type EvidenceRefKind =
  | 'file'
  | 'symbol'
  | 'line'
  | 'process'
  | 'relation'
  | 'config'
  | 'test'
  | 'existing-doc'
  | 'user-input';

export interface EvidenceRef {
  id: string;
  kind: EvidenceRefKind;
  status: EvidenceStatus;
  filePath?: string;
  symbol?: string;
  lineStart?: number;
  lineEnd?: number;
  relation?: string;
  processId?: string;
  summary: string;
  excerpt?: string;
  confidence?: number;
}

export interface EvidenceConflict {
  id: string;
  evidenceIds: readonly string[];
  summary: string;
}

export interface EvidenceBundle {
  schemaVersion: typeof EVIDENCE_SCHEMA_VERSION;
  repoPath: string;
  sourceCommit: string;
  collectedAt: string;
  repository: readonly EvidenceRef[];
  modules: Readonly<Record<string, readonly EvidenceRef[]>>;
  conflicts: readonly EvidenceConflict[];
  limitations: readonly string[];
}

export interface EvidenceIdentityInput {
  kind: EvidenceRefKind;
  filePath?: string;
  symbol?: string;
  lineStart?: number;
  lineEnd?: number;
  relation?: string;
  processId?: string;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function createEvidenceId(input: EvidenceIdentityInput): string {
  const digest = createHash('sha256').update(stableSerialize(input)).digest('hex').slice(0, 20);
  return `ev-${digest}`;
}

export function createEvidenceRef(
  input: EvidenceIdentityInput & Omit<EvidenceRef, 'id' | keyof EvidenceIdentityInput>,
): EvidenceRef {
  const identity: EvidenceIdentityInput = {
    kind: input.kind,
    ...(input.filePath !== undefined ? { filePath: input.filePath } : {}),
    ...(input.symbol !== undefined ? { symbol: input.symbol } : {}),
    ...(input.lineStart !== undefined ? { lineStart: input.lineStart } : {}),
    ...(input.lineEnd !== undefined ? { lineEnd: input.lineEnd } : {}),
    ...(input.relation !== undefined ? { relation: input.relation } : {}),
    ...(input.processId !== undefined ? { processId: input.processId } : {}),
  };
  return {
    id: createEvidenceId(identity),
    ...input,
  };
}

export function deduplicateEvidence(evidence: readonly EvidenceRef[]): EvidenceRef[] {
  const byId = new Map<string, EvidenceRef>();
  for (const item of evidence) {
    if (!byId.has(item.id)) byId.set(item.id, item);
  }
  return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}
