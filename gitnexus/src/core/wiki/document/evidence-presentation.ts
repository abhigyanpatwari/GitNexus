import type { BuiltinLocale } from '../profiles/types.js';
import type { EvidenceBundle, EvidenceRef } from './evidence.js';

const MAX_LABEL_LENGTH = 180;

function neutralizePresentationMarkup(value: string): string {
  return value
    .replace(/</g, '‹')
    .replace(/>/g, '›')
    .replace(/\|/g, '¦')
    .replace(/`/g, 'ˋ')
    .replace(/\[/g, '［')
    .replace(/\]/g, '］');
}

export interface EvidencePresentation {
  locale: BuiltinLocale;
  byId: ReadonlyMap<string, EvidenceRef>;
}

function unavailableLabel(locale: BuiltinLocale): string {
  return locale === 'zh-CN' ? '证据不可用' : 'Evidence unavailable';
}

function normalizeRelativePath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().replace(/\\/g, '/');
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    /^[a-zA-Z]:\//.test(normalized) ||
    normalized.split('/').some((segment) => segment === '..') ||
    /[\x00-\x1f\x7f]/.test(normalized)
  ) {
    return undefined;
  }
  return neutralizePresentationMarkup(normalized.replace(/^\.\//, '')).slice(0, MAX_LABEL_LENGTH);
}

function normalizePlainText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (
    normalized.length === 0 ||
    /(?:^|\s)\/(?:Users|home|private|var|tmp)\//i.test(normalized) ||
    /[a-zA-Z]:[\\/]/.test(normalized) ||
    /(?:^|[\s(])\.\.[\\/]/.test(normalized)
  ) {
    return undefined;
  }
  return neutralizePresentationMarkup(normalized).slice(0, MAX_LABEL_LENGTH);
}

function lineAnchor(ref: EvidenceRef): string {
  if (!Number.isInteger(ref.lineStart) || (ref.lineStart ?? 0) < 1) return '';
  if (
    Number.isInteger(ref.lineEnd) &&
    (ref.lineEnd ?? 0) >= (ref.lineStart ?? 0) &&
    ref.lineEnd !== ref.lineStart
  ) {
    return `:${ref.lineStart}-${ref.lineEnd}`;
  }
  return `:${ref.lineStart}`;
}

function fileLabel(ref: EvidenceRef): string | undefined {
  const filePath = normalizeRelativePath(ref.filePath);
  const symbol = normalizePlainText(ref.symbol);
  if (filePath) return `${filePath}${lineAnchor(ref)}${symbol ? ` · ${symbol}` : ''}`;
  return symbol;
}

function relationLabel(ref: EvidenceRef): string | undefined {
  const source = fileLabel(ref);
  const relation = ref.relation?.replace(/^(?:internal|incoming|outgoing):calls:/, '');
  if (!relation) return source;

  for (let index = relation.indexOf(':'); index >= 0; index = relation.indexOf(':', index + 1)) {
    const targetPath = normalizeRelativePath(relation.slice(0, index));
    const targetSymbol = normalizePlainText(relation.slice(index + 1));
    if (targetPath && targetSymbol) {
      const target = `${targetPath} · ${targetSymbol}`;
      return source ? `${source} → ${target}` : target;
    }
  }
  return source;
}

export function formatEvidenceLabel(ref: EvidenceRef, locale: BuiltinLocale): string {
  if (ref.kind === 'relation') {
    return relationLabel(ref) ?? unavailableLabel(locale);
  }
  if (ref.kind === 'process') {
    const summary = normalizePlainText(ref.summary);
    const processId = normalizePlainText(ref.processId);
    const value = summary ?? processId;
    if (!value) return unavailableLabel(locale);
    return `${locale === 'zh-CN' ? '流程' : 'Process'} · ${value}`;
  }
  return fileLabel(ref) ?? unavailableLabel(locale);
}

export function createEvidencePresentation(
  bundle: EvidenceBundle,
  locale: BuiltinLocale,
): EvidencePresentation {
  const byId = new Map<string, EvidenceRef>();
  for (const ref of [...bundle.repository, ...Object.values(bundle.modules).flat()]) {
    if (!byId.has(ref.id)) byId.set(ref.id, ref);
  }
  return { locale, byId };
}

export function formatEvidenceIds(
  evidenceIds: readonly string[],
  presentation: EvidencePresentation | undefined,
  limit = 3,
): string {
  const locale = presentation?.locale ?? 'en';
  const labels: string[] = [];
  for (const id of evidenceIds) {
    const ref = presentation?.byId.get(id);
    const label = ref ? formatEvidenceLabel(ref, locale) : unavailableLabel(locale);
    if (!labels.includes(label)) labels.push(label);
  }
  const visible = labels.slice(0, Math.max(1, limit));
  const remaining = labels.length - visible.length;
  if (remaining > 0) {
    visible.push(locale === 'zh-CN' ? `等 ${remaining} 项` : `${remaining} more`);
  }
  return visible.join(locale === 'zh-CN' ? '；' : '; ');
}

export function evidenceSourceLabel(presentation: EvidencePresentation | undefined): string {
  return presentation?.locale === 'zh-CN' ? '来源' : 'Source';
}
