import type { SectionBlock } from './claim.js';
import {
  evidenceSourceLabel,
  formatEvidenceIds,
  type EvidencePresentation,
} from './evidence-presentation.js';
import type { SectionPayload } from './planner.js';

function evidenceSuffix(evidenceIds: readonly string[]): string {
  return evidenceIds.length > 0 ? ` <!-- evidence: ${evidenceIds.join(', ')} -->` : '';
}

// HTML 特殊字符实体映射：单次遍历统一转义，避免链式替换的顺序与覆盖问题
const HTML_ENTITY_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
  '\\': '&#x5c;',
};

function sanitizeStructuredMarkdown(value: string): string {
  return (
    value
      // 单次遍历转义所有 HTML 特殊字符，防止注入
      .replace(/[&<>"'\\]/g, (ch) => HTML_ENTITY_MAP[ch])
      // 阻断危险协议的 Markdown 链接
      .replace(/\]\(\s*(?:javascript|vbscript|file|data)\s*:/gi, '](')
  );
}

function presentEvidenceTokens(
  value: string,
  presentation: EvidencePresentation | undefined,
): string {
  return value.replace(/\bev-[a-f0-9]{20}\b/gi, (id) =>
    formatEvidenceIds([id.toLowerCase()], presentation),
  );
}

function visibleStructuredText(
  value: string,
  presentation: EvidencePresentation | undefined,
): string {
  return sanitizeStructuredMarkdown(presentEvidenceTokens(value, presentation));
}

function tableCell(value: string, presentation?: EvidencePresentation): string {
  // Markdown 表格单元格：先转义反斜杠本身，再转义竖线，避免 \ 与 | 组合产生转义歧义
  return visibleStructuredText(value, presentation)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>');
}

function visibleEvidence(
  evidenceIds: readonly string[],
  presentation: EvidencePresentation | undefined,
): string {
  return tableCell(formatEvidenceIds(evidenceIds, presentation), presentation);
}

function evidenceLine(
  evidenceIds: readonly string[],
  presentation: EvidencePresentation | undefined,
): string {
  if (evidenceIds.length === 0) return '';
  const separator = presentation?.locale === 'zh-CN' ? '：' : ': ';
  return `> ${evidenceSourceLabel(presentation)}${separator}${visibleStructuredText(formatEvidenceIds(evidenceIds, presentation), presentation)}\n${evidenceSuffix(evidenceIds).trimStart()}`;
}

function isExplicitSourceTable(headers: readonly string[]): boolean {
  return headers.some((header) => /^\s*(?:Source\s*\/\s*来源|Source|来源)\s*$/i.test(header));
}

function machineEvidenceColumn(
  headers: readonly string[],
  rows: Extract<SectionBlock, { type: 'table' }>['rows'],
): number {
  const index = headers.findIndex((header) => /^\s*(?:Evidence|证据)\s*$/i.test(header));
  if (index < 0 || rows.length === 0) return -1;
  const machineIdList = /^\s*ev-[a-f0-9]+(?:\s*,\s*ev-[a-f0-9]+)*\s*$/i;
  return rows.every((row) => machineIdList.test(row.cells[index] ?? '')) ? index : -1;
}

function renderStructuredBlocks(
  blocks: readonly SectionBlock[],
  presentation: EvidencePresentation | undefined,
): string {
  const rendered: string[] = [];
  for (const block of blocks) {
    if (block.type === 'claim') {
      rendered.push(visibleStructuredText(block.claim.text, presentation));
      const source = evidenceLine(block.claim.evidenceIds, presentation);
      if (source) rendered.push(source);
    } else if (block.type === 'table') {
      const machineColumn = machineEvidenceColumn(block.headers, block.rows);
      const explicitSourceTable = isExplicitSourceTable(block.headers);
      const sourceHeader = evidenceSourceLabel(presentation);
      const headers = block.headers
        .filter((_, index) => index !== machineColumn)
        .map((header) => tableCell(header, presentation));
      if (!explicitSourceTable) headers.push(sourceHeader);
      rendered.push(`| ${headers.join(' | ')} |`);
      rendered.push(`| ${headers.map(() => '---').join(' | ')} |`);
      for (const row of block.rows) {
        const cells = row.cells
          .filter((_, index) => index !== machineColumn)
          .map((cell) => tableCell(cell, presentation));
        if (!explicitSourceTable) cells.push(visibleEvidence(row.evidenceIds, presentation));
        rendered.push(`| ${cells.join(' | ')} |`);
      }
      const tableEvidenceIds = Array.from(new Set(block.rows.flatMap((row) => row.evidenceIds)));
      if (tableEvidenceIds.length > 0) rendered.push(evidenceSuffix(tableEvidenceIds).trimStart());
    } else if (block.type === 'diagram') {
      const diagram = block.source.replace(/```/g, '');
      // CommonMark 要求结束围栏独占一行，否则 Viewer 会把证据注释继续当作 Mermaid 源码。
      rendered.push(`\`\`\`mermaid\n${diagram}\n\`\`\``);
      const source = evidenceLine(block.evidenceIds, presentation);
      if (source) rendered.push(source);
    } else {
      rendered.push(`> **${block.status}**: ${visibleStructuredText(block.reason, presentation)}`);
      const source = evidenceLine(block.evidenceIds, presentation);
      if (source) rendered.push(source);
    }
    rendered.push('');
  }
  return rendered.join('\n').trimEnd();
}

export interface AssembleSectionOptions {
  evidence?: EvidencePresentation;
}

export function assembleSectionPage(
  title: string,
  payload: SectionPayload,
  options: AssembleSectionOptions = {},
): string {
  const body =
    payload.mode === 'legacy-markdown'
      ? payload.markdown
      : renderStructuredBlocks(payload.blocks, options.evidence);
  return `# ${title}\n\n${body}`;
}
