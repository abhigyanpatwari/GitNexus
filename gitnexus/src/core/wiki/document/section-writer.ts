import type { CallLLMOptions, LLMResponse } from '../llm-client.js';
import { renderPrompt } from '../profiles/render-prompt.js';
import type { PromptSpec, TemplateProfileId } from '../profiles/types.js';
import type { SectionDraftResponse } from './claim.js';
import type { SectionBlock } from './claim.js';
import type { SectionPayload } from './planner.js';
import { parseSectionDraftResponse } from './response-parser.js';

export const SECTION_WRITER_VERSION = 6;

const STRUCTURED_RESPONSE_CONTRACT = `Return one raw JSON object with exactly these root fields: schemaVersion, sectionId, blocks. Do not use Markdown fences or add commentary.
Allowed blocks are exactly:
- {"type":"claim","claim":{"id":"unique-id","text":"claim text","status":"verified|inferred|conflicting","evidenceIds":["ev-id"],"origin":"llm"}}
- {"type":"table","headers":["header"],"rows":[{"cells":["cell"],"evidenceIds":["ev-id"]}]}
- {"type":"diagram","syntax":"mermaid","source":"graph TD; A-->B","evidenceIds":["ev-id"]}
- {"type":"unknown","status":"missing|needs-human|conflicting","reason":"reason","evidenceIds":[]}
The blocks array must contain 1 to 12 blocks. Summarize the strongest evidence instead of enumerating every item. Every claim, table row, and diagram needs at least one supplied evidence ID. A conflicting unknown block also needs evidence. Never add fields outside this contract.`;

function parseGeneratedDraft(
  raw: string,
  sectionId: string,
  knownEvidenceIds: ReadonlySet<string>,
): SectionDraftResponse {
  const draft = parseSectionDraftResponse(raw, sectionId, knownEvidenceIds);
  if (draft.blocks.length === 0) {
    throw new Error('Structured section response must contain at least one block');
  }
  if (draft.blocks.length > 12) {
    throw new Error('Structured section response must contain at most 12 blocks');
  }
  return draft;
}

interface PromptEvidenceRecord {
  id: string;
  filePath?: string;
  symbol?: string;
  processId?: string;
  summary?: string;
}

function promptEvidenceRecords(raw: string | undefined): PromptEvidenceRecord[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is PromptEvidenceRecord =>
        item !== null &&
        typeof item === 'object' &&
        typeof (item as PromptEvidenceRecord).id === 'string',
    );
  } catch {
    return [];
  }
}

function normalizeEngineeringDraftOrigin(raw: string): string {
  try {
    const value: unknown = JSON.parse(raw.trim());
    if (value === null || typeof value !== 'object') {
      return raw;
    }
    const response = value as Record<string, unknown>;
    if (!Array.isArray(response.blocks)) return raw;
    for (const block of response.blocks) {
      if (block === null || typeof block !== 'object') continue;
      const blockRecord = block as Record<string, unknown>;
      if (blockRecord.type !== 'claim' || blockRecord.claim === null) continue;
      if (typeof blockRecord.claim !== 'object') continue;
      (blockRecord.claim as Record<string, unknown>).origin = 'llm';
    }
    return JSON.stringify(value);
  } catch {
    return raw;
  }
}

function countMermaidNodes(source: string): number {
  const nodes = new Set<string>();
  const nodePattern = /(?:^|[;\s])([A-Za-z][A-Za-z0-9_-]*)(?=\s*(?:\[|\(|\{|--|==|-\.|$))/gm;
  const targetPattern = /(?:--+>|==+>|-\.->)\s*([A-Za-z][A-Za-z0-9_-]*)/g;
  for (const match of source.matchAll(nodePattern)) {
    if (
      !['graph', 'flowchart', 'subgraph', 'end', 'TB', 'TD', 'BT', 'RL', 'LR'].includes(match[1])
    ) {
      nodes.add(match[1]);
    }
  }
  for (const match of source.matchAll(targetPattern)) nodes.add(match[1]);
  return nodes.size;
}

function validateEngineeringDiagram(sectionId: string, blocks: readonly SectionBlock[]): void {
  if (sectionId !== 'overall-architecture') return;
  const diagrams = blocks.filter((block) => block.type === 'diagram');
  if (diagrams.length === 0) {
    // 证据不足以绘制架构图时,prompt 允许输出 unknown block 作为诚实降级;
    // 此处放行该降级路径,仅当既无 diagram 也无 unknown 标记时才视为非法。
    const hasUnknown = blocks.some((block) => block.type === 'unknown');
    if (!hasUnknown) {
      throw new Error(
        'engineering-wiki overall-architecture must contain a Mermaid diagram (or an unknown block when relationship evidence is insufficient)',
      );
    }
    return;
  }
  for (const diagram of diagrams) {
    const nodeCount = countMermaidNodes(diagram.source);
    if (nodeCount === 0 || nodeCount > 15) {
      throw new Error(
        `engineering-wiki overall-architecture diagram must contain 1 to 15 nodes; got ${nodeCount}`,
      );
    }
  }
}

function appendEngineeringSourceTable(
  blocks: readonly SectionBlock[],
  records: readonly PromptEvidenceRecord[],
): SectionBlock[] {
  const citedEvidenceIds = Array.from(
    new Set(
      blocks.flatMap((block) => {
        if (block.type === 'claim') return block.claim.evidenceIds;
        if (block.type === 'table') return block.rows.flatMap((row) => row.evidenceIds);
        return block.evidenceIds;
      }),
    ),
  );
  const recordById = new Map(records.map((record) => [record.id, record]));
  const citedRecords = citedEvidenceIds
    .map((id) => recordById.get(id))
    .filter((record): record is PromptEvidenceRecord => record !== undefined);
  const orderedRecords = [
    ...citedRecords,
    ...records.filter((record) => !citedEvidenceIds.includes(record.id)),
  ];
  const sources = orderedRecords
    .filter(
      (record) =>
        (record.filePath !== undefined &&
          !record.filePath.startsWith('/') &&
          !record.filePath.includes('..') &&
          !/^[A-Za-z]:[\\/]/.test(record.filePath)) ||
        record.processId,
    )
    .slice(0, 6)
    .map((record) => ({
      cells: [
        record.filePath ?? `process:${record.processId}`,
        record.symbol ?? record.processId ?? '-',
        record.summary ?? '-',
      ],
      evidenceIds: [record.id],
    }));
  const prefix =
    blocks.length <= 11
      ? [...blocks]
      : [
          ...blocks.filter((block) => block.type === 'diagram'),
          ...blocks.filter((block) => block.type !== 'diagram'),
        ].slice(0, 11);
  if (sources.length === 0) {
    return [
      ...prefix,
      {
        type: 'unknown',
        status: 'needs-human',
        reason: 'No repository-relative file or process source is available for this section.',
        evidenceIds: [],
      },
    ];
  }
  return [
    ...prefix,
    {
      type: 'table',
      headers: ['Source / 来源', 'Anchor / 锚点', 'Supports / 支持内容'],
      rows: sources,
    },
  ];
}

export type SectionLLMInvoker = (
  prompt: string,
  systemPrompt: string,
  options?: CallLLMOptions,
) => Promise<LLMResponse>;

export interface WriteSectionRequest {
  profileId: TemplateProfileId;
  sectionId: string;
  prompt: PromptSpec;
  variables: Record<string, string>;
  evidenceIds: readonly string[];
  invokeLLM: SectionLLMInvoker;
  transformSystemPrompt?: (systemPrompt: string) => string;
  llmOptions?: CallLLMOptions;
}

export class SectionWriter {
  async write(request: WriteSectionRequest): Promise<SectionPayload> {
    const rendered = renderPrompt(request.prompt, request.variables);
    const systemPrompt = request.transformSystemPrompt
      ? request.transformSystemPrompt(rendered.system)
      : rendered.system;
    if (request.profileId === 'default') {
      const response = await request.invokeLLM(rendered.user, systemPrompt, request.llmOptions);
      return {
        mode: 'legacy-markdown',
        markdown: response.content,
        sectionEvidenceIds: [...request.evidenceIds],
        traceability: 'section-level',
      };
    }

    const structuredSystemPrompt = `${systemPrompt}\n\n${STRUCTURED_RESPONSE_CONTRACT}`;
    const knownEvidenceIds = new Set(request.evidenceIds);
    const response = await request.invokeLLM(
      rendered.user,
      structuredSystemPrompt,
      request.llmOptions,
    );
    let content = response.content;
    let draft: SectionDraftResponse | undefined;
    let validationError: Error | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const candidate =
          request.profileId === 'engineering-wiki'
            ? normalizeEngineeringDraftOrigin(content)
            : content;
        draft = parseGeneratedDraft(candidate, request.sectionId, knownEvidenceIds);
        if (request.profileId === 'engineering-wiki') {
          validateEngineeringDiagram(request.sectionId, draft.blocks);
        }
        break;
      } catch (error) {
        validationError = error as Error;
        if (attempt === 2) throw validationError;
      }
      const engineeringRepair =
        request.profileId === 'engineering-wiki' && request.sectionId === 'overall-architecture'
          ? 'The replacement must include one Mermaid flowchart diagram block with 1 to 15 nodes and may include claim or table blocks.'
          : 'Do not return tables or diagrams.';
      const repairPrompt = `${rendered.user}

Your previous response failed strict validation: ${validationError.message}
Regenerate a compact replacement using only 1 to 12 valid blocks. Every claim must include origin "llm" and cite only supplied Evidence IDs. ${engineeringRepair} Do not return Markdown fences, commentary, or the previous response. Return raw JSON only.`;
      const repaired = await request.invokeLLM(
        repairPrompt,
        structuredSystemPrompt,
        request.llmOptions,
      );
      content = repaired.content;
    }
    const blocks =
      request.profileId === 'engineering-wiki'
        ? appendEngineeringSourceTable(
            draft!.blocks,
            promptEvidenceRecords(request.variables.EVIDENCE_BUNDLE),
          )
        : draft!.blocks;
    return { mode: 'structured', blocks };
  }
}
