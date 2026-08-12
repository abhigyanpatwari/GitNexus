import type { RegisteredTemplateProfile } from '../profiles/types.js';
import { sanitizeMermaidMarkdown } from '../mermaid-sanitizer.js';
import { getWikiPresentationMessages, localize } from '../profiles/locale.js';
import { assembleSectionPage } from './assembler.js';
import type { EvidenceBundle } from './evidence.js';
import {
  createEvidencePresentation,
  formatEvidenceIds,
  type EvidencePresentation,
} from './evidence-presentation.js';
import { createOutputManifest, type OutputManifest } from './output-manifest.js';
import type { DocumentPlan, SectionIR } from './planner.js';
import type { ProfileCoverageReport } from './validator.js';

export const MARKDOWN_RENDERER_VERSION = 5;

function renderSection(section: SectionIR, evidence: EvidencePresentation): string {
  return sanitizeMermaidMarkdown(assembleSectionPage(section.title, section.payload, { evidence }));
}

export interface RenderedWikiArtifacts {
  files: Readonly<Record<string, string>>;
  manifest: OutputManifest;
}

function renderEntry(
  profile: RegisteredTemplateProfile,
  plan: DocumentPlan,
  sections: readonly SectionIR[],
): string {
  const title = localize(profile.profile.displayName, plan.language);
  const notices = profile.profile.alignments
    .map((alignment) => `> ${localize(alignment.notice, plan.language)}`)
    .join('\n\n');
  const links = sections.map((section) => `- [${section.title}](${section.id}.md)`).join('\n');
  return [`# ${title}`, notices, links].filter(Boolean).join('\n\n');
}

function renderAggregate(
  profile: RegisteredTemplateProfile,
  plan: DocumentPlan,
  sections: readonly SectionIR[],
  evidence: EvidencePresentation,
): string {
  const title = localize(profile.profile.displayName, plan.language);
  const body = sections.map((section) => {
    const rendered = renderSection(section, evidence);
    return rendered.replace(/^# /, '## ');
  });
  return [`# ${title}`, ...body].join('\n\n');
}

interface OrderedSection {
  section: SectionIR;
  parentId?: string;
}

function flattenForRendering(sections: readonly SectionIR[], parentId?: string): OrderedSection[] {
  const result: OrderedSection[] = [];
  for (const section of sections) {
    result.push({ section, ...(parentId ? { parentId } : {}) });
    if (section.children) result.push(...flattenForRendering(section.children, section.id));
  }
  return result;
}

function renderCoverageMarkdown(
  report: ProfileCoverageReport,
  evidence: EvidencePresentation,
): string {
  const messages = getWikiPresentationMessages(report.language);
  const lines = [`# ${messages.coverageTitle}`, '', report.conclusion];
  if (report.language.diagnostics.length > 0) {
    lines.push('', ...report.language.diagnostics.map((diagnostic) => `> ${diagnostic.message}`));
  }
  lines.push(
    '',
    `| ${messages.section} | ${messages.required} | ${messages.status} | ${messages.evidence} |`,
    '| --- | --- | --- | --- |',
  );
  for (const section of report.sections) {
    lines.push(
      `| ${section.id} | ${section.required ? messages.yes : messages.no} | ${messages.statusLabels[section.status]} | ${formatEvidenceIds(section.evidenceIds, evidence)} |`,
    );
  }
  if (report.limitations.length > 0) {
    lines.push('', ...report.limitations.map((limitation) => `- ${limitation}`));
  }
  return lines.join('\n');
}

export function renderDocumentPlan(
  profile: RegisteredTemplateProfile,
  plan: DocumentPlan,
  coverage: ProfileCoverageReport,
  generationId: string,
  generationSemanticsKey: string,
  evidenceBundle: EvidenceBundle,
): RenderedWikiArtifacts {
  if (profile.profile.id !== plan.profile.id || profile.fingerprint !== plan.profile.fingerprint) {
    throw new Error('Renderer Profile identity does not match DocumentPlan');
  }
  if (
    coverage.profile.id !== plan.profile.id ||
    coverage.language.localeFingerprint !== plan.language.localeFingerprint
  ) {
    throw new Error('Renderer coverage identity does not match DocumentPlan');
  }

  const evidence = createEvidencePresentation(evidenceBundle, plan.language.resolvedLocale);
  const orderedSections = flattenForRendering(plan.sections);
  const sections = orderedSections.map(({ section }) => section);
  const entry = renderEntry(profile, plan, sections);
  const files: Record<string, string> = { [profile.profile.output.entryFile]: entry };
  const pages = orderedSections.map(({ section, parentId }, order) => {
    const file = `${section.id}.md`;
    const content = renderSection(section, evidence);
    files[file] = content;
    return {
      id: section.id,
      slug: section.id,
      label: section.title,
      file,
      ...(parentId ? { parentId } : {}),
      order,
      status: section.status,
      content,
    };
  });

  let aggregate: { file: string; content: string } | undefined;
  if (profile.profile.output.aggregateFile) {
    aggregate = {
      file: profile.profile.output.aggregateFile,
      content: renderAggregate(profile, plan, sections, evidence),
    };
    files[aggregate.file] = aggregate.content;
  }

  const coverageJson = `${JSON.stringify(coverage, null, 2)}\n`;
  const coverageMarkdown = renderCoverageMarkdown(coverage, evidence);
  files[profile.profile.output.coverageFile] = coverageJson;
  files['coverage.md'] = coverageMarkdown;

  const manifest = createOutputManifest({
    generationId,
    profile: plan.profile,
    language: plan.language,
    sourceCommit: plan.sourceCommit,
    generationSemanticsKey,
    entry: {
      slug: 'overview',
      label: localize(profile.profile.displayName, plan.language),
      file: profile.profile.output.entryFile,
      content: entry,
    },
    pages: [
      ...pages,
      {
        id: 'profile-coverage-report',
        slug: 'profile-coverage-report',
        label: getWikiPresentationMessages(plan.language).coverageTitle,
        file: 'coverage.md',
        order: pages.length,
        status: coverage.status === 'passed' ? 'verified' : 'missing',
        content: coverageMarkdown,
      },
    ],
    aggregate,
    coverage: { file: profile.profile.output.coverageFile, content: coverageJson },
  });
  return { files, manifest };
}
