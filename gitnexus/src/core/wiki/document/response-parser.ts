import {
  SECTION_DRAFT_SCHEMA_VERSION,
  validateSectionDraftResponse,
  type ClaimIR,
  type SectionBlock,
  type SectionDraftResponse,
} from './claim.js';

function assertClosedObject(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const unknown = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  if (unknown.length > 0)
    throw new Error(`${label} contains unknown fields: ${unknown.join(', ')}`);
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => string(item, `${label}[${index}]`));
}

function parseClaim(value: unknown, label: string): ClaimIR {
  assertClosedObject(value, ['id', 'text', 'status', 'evidenceIds', 'origin'], label);
  if (!['verified', 'inferred', 'conflicting'].includes(value.status as string)) {
    throw new Error(`${label}.status is invalid`);
  }
  if (!['deterministic', 'llm'].includes(value.origin as string)) {
    throw new Error(`${label}.origin is invalid`);
  }
  return {
    id: string(value.id, `${label}.id`),
    text: string(value.text, `${label}.text`),
    status: value.status as ClaimIR['status'],
    evidenceIds: stringArray(value.evidenceIds, `${label}.evidenceIds`),
    origin: value.origin as ClaimIR['origin'],
  };
}

function parseBlock(value: unknown, index: number): SectionBlock {
  const label = `response.blocks[${index}]`;
  assertClosedObject(
    value,
    ['type', 'claim', 'headers', 'rows', 'syntax', 'source', 'evidenceIds', 'status', 'reason'],
    label,
  );
  if (value.type === 'claim') {
    assertClosedObject(value, ['type', 'claim'], label);
    return { type: 'claim', claim: parseClaim(value.claim, `${label}.claim`) };
  }
  if (value.type === 'table') {
    assertClosedObject(value, ['type', 'headers', 'rows'], label);
    if (!Array.isArray(value.rows)) throw new Error(`${label}.rows must be an array`);
    return {
      type: 'table',
      headers: stringArray(value.headers, `${label}.headers`),
      rows: value.rows.map((row, rowIndex) => {
        const rowLabel = `${label}.rows[${rowIndex}]`;
        assertClosedObject(row, ['cells', 'evidenceIds'], rowLabel);
        return {
          cells: stringArray(row.cells, `${rowLabel}.cells`),
          evidenceIds: stringArray(row.evidenceIds, `${rowLabel}.evidenceIds`),
        };
      }),
    };
  }
  if (value.type === 'diagram') {
    assertClosedObject(value, ['type', 'syntax', 'source', 'evidenceIds'], label);
    if (value.syntax !== 'mermaid') throw new Error(`${label}.syntax is invalid`);
    return {
      type: 'diagram',
      syntax: 'mermaid',
      source: string(value.source, `${label}.source`),
      evidenceIds: stringArray(value.evidenceIds, `${label}.evidenceIds`),
    };
  }
  if (value.type === 'unknown') {
    assertClosedObject(value, ['type', 'status', 'reason', 'evidenceIds'], label);
    if (!['missing', 'needs-human', 'conflicting'].includes(value.status as string)) {
      throw new Error(`${label}.status is invalid`);
    }
    return {
      type: 'unknown',
      status: value.status as 'missing' | 'needs-human' | 'conflicting',
      reason: string(value.reason, `${label}.reason`),
      evidenceIds: stringArray(value.evidenceIds, `${label}.evidenceIds`),
    };
  }
  throw new Error(`${label}.type is invalid`);
}

export function parseSectionDraftResponse(
  raw: string,
  expectedSectionId: string,
  knownEvidenceIds: ReadonlySet<string>,
): SectionDraftResponse {
  const trimmed = raw.trim();
  if (trimmed.startsWith('```') || trimmed.endsWith('```')) {
    throw new Error('Structured section response must be raw JSON without Markdown fences');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Structured section response is not valid JSON: ${(error as Error).message}`);
  }
  assertClosedObject(parsed, ['schemaVersion', 'sectionId', 'blocks'], 'response');
  if (parsed.schemaVersion !== SECTION_DRAFT_SCHEMA_VERSION) {
    throw new Error(`Unsupported section draft schemaVersion: ${String(parsed.schemaVersion)}`);
  }
  if (!Array.isArray(parsed.blocks)) throw new Error('response.blocks must be an array');
  const response: SectionDraftResponse = {
    schemaVersion: SECTION_DRAFT_SCHEMA_VERSION,
    sectionId: string(parsed.sectionId, 'response.sectionId'),
    blocks: parsed.blocks.map(parseBlock),
  };
  validateSectionDraftResponse(response, expectedSectionId, knownEvidenceIds);
  return response;
}
