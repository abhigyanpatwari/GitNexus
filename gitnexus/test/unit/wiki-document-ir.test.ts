import { describe, expect, it } from 'vitest';

import {
  validateSectionBlocks,
  validateSectionDraftResponse,
  type SectionBlock,
} from '../../src/core/wiki/document/claim.js';
import { assembleSectionPage } from '../../src/core/wiki/document/assembler.js';
import { createEvidenceRef, type EvidenceBundle } from '../../src/core/wiki/document/evidence.js';
import {
  createEvidencePresentation,
  formatEvidenceLabel,
} from '../../src/core/wiki/document/evidence-presentation.js';
import {
  createOutputManifest,
  hashOutputContent,
  validateOutputManifest,
} from '../../src/core/wiki/document/output-manifest.js';
import { renderDocumentPlan } from '../../src/core/wiki/document/markdown-renderer.js';
import { createDocumentPlan, validateDocumentPlan } from '../../src/core/wiki/document/planner.js';
import { validateProfileCoverage } from '../../src/core/wiki/document/validator.js';
import { DEFAULT_TEMPLATE_PROFILE } from '../../src/core/wiki/profiles/builtins/default.js';
import { resolveLanguage } from '../../src/core/wiki/profiles/locale.js';
import {
  TemplateProfileRegistry,
  resolveTemplateProfile,
} from '../../src/core/wiki/profiles/registry.js';
import type { TemplateProfile } from '../../src/core/wiki/profiles/types.js';

const sourceEvidence = createEvidenceRef({
  kind: 'line',
  status: 'verified',
  filePath: 'src/core.ts',
  lineStart: 42,
  lineEnd: 48,
  summary: 'source evidence',
});

function evidenceBundle(): EvidenceBundle {
  return {
    schemaVersion: 1,
    repoPath: '/repo',
    sourceCommit: 'abc123',
    collectedAt: '2026-08-12T00:00:00.000Z',
    repository: [sourceEvidence],
    modules: { Core: [sourceEvidence] },
    conflicts: [],
    limitations: [],
  };
}

describe('wiki ClaimIR contract', () => {
  it('accepts evidence-backed claims, tables, diagrams, and explicit unknown blocks', () => {
    const blocks: SectionBlock[] = [
      {
        type: 'claim',
        claim: {
          id: 'claim-core',
          text: 'Core is defined in src/core.ts.',
          status: 'verified',
          evidenceIds: [sourceEvidence.id],
          origin: 'deterministic',
        },
      },
      {
        type: 'table',
        headers: ['Component'],
        rows: [{ cells: ['Core'], evidenceIds: [sourceEvidence.id] }],
      },
      {
        type: 'diagram',
        syntax: 'mermaid',
        source: 'flowchart LR\nA --> B',
        evidenceIds: [sourceEvidence.id],
      },
      {
        type: 'unknown',
        status: 'needs-human',
        reason: 'Deployment target is not present in repository evidence.',
        evidenceIds: [],
      },
    ];

    expect(() => validateSectionBlocks(blocks, new Set([sourceEvidence.id]))).not.toThrow();
    expect(() =>
      validateSectionDraftResponse(
        { schemaVersion: 1, sectionId: 'core', blocks },
        'core',
        new Set([sourceEvidence.id]),
      ),
    ).not.toThrow();
  });

  it('renders Mermaid closing fences before evidence comments', () => {
    const presentation = createEvidencePresentation(evidenceBundle(), 'zh-CN');
    const page = assembleSectionPage(
      'Design',
      {
        mode: 'structured',
        traceability: 'claim-level',
        blocks: [
          {
            type: 'diagram',
            syntax: 'mermaid',
            source: 'graph TD; A --> B;',
            evidenceIds: [sourceEvidence.id],
          },
        ],
      },
      { evidence: presentation },
    );

    expect(page).toContain(
      `\`\`\`mermaid\ngraph TD; A --> B;\n\`\`\`\n> 来源：src/core.ts:42-48\n<!-- evidence: ${sourceEvidence.id} -->`,
    );
    expect(page).not.toContain('\`\`\` <!-- evidence:');
  });

  it('formats repository-relative file, relation, and process evidence without exposing ids', () => {
    const relation = createEvidenceRef({
      kind: 'relation',
      status: 'verified',
      filePath: 'src/cli.ts',
      symbol: 'wikiCommand',
      relation: 'outgoing:calls:src/core/wiki/generator.ts:WikiGenerator.run',
      summary: 'wikiCommand calls WikiGenerator.run',
    });
    const process = createEvidenceRef({
      kind: 'process',
      status: 'verified',
      processId: 'wiki-generation',
      summary: 'CLI → WikiGenerator → Renderer',
    });

    expect(formatEvidenceLabel(sourceEvidence, 'zh-CN')).toBe('src/core.ts:42-48');
    expect(formatEvidenceLabel(relation, 'zh-CN')).toBe(
      'src/cli.ts · wikiCommand → src/core/wiki/generator.ts · WikiGenerator.run',
    );
    expect(formatEvidenceLabel(process, 'zh-CN')).toBe('流程 · CLI → WikiGenerator → Renderer');
  });

  it('fails safe for missing or unsafe evidence presentation paths', () => {
    const unsafe = createEvidenceRef({
      kind: 'file',
      status: 'verified',
      filePath: '/Users/private/project/secret.ts',
      summary: '/Users/private/project/secret.ts',
    });
    expect(formatEvidenceLabel(unsafe, 'zh-CN')).toBe('证据不可用');
    expect(
      formatEvidenceLabel(
        { ...unsafe, filePath: '..\\private\\secret.ts', summary: 'unsafe path' },
        'en',
      ),
    ).toBe('Evidence unavailable');
  });

  it('neutralizes Markdown and HTML syntax in repository-derived labels', () => {
    const hostile = createEvidenceRef({
      kind: 'symbol',
      status: 'verified',
      filePath: 'src/a|b[link].ts',
      symbol: '<img src=x onerror=alert(1)> `code`',
      summary: 'hostile repository label',
    });
    const label = formatEvidenceLabel(hostile, 'zh-CN');

    expect(label).toBe('src/a¦b［link］.ts · ‹img src=x onerror=alert(1)› ˋcodeˋ');
    expect(label).not.toMatch(/[<>|`\[\]]/);
  });

  it('keeps legacy Markdown byte-compatible when evidence presentation is provided', () => {
    const payload = {
      mode: 'legacy-markdown' as const,
      markdown: 'Legacy body.\n\n## Details\nUnchanged.',
      sectionEvidenceIds: [sourceEvidence.id],
      traceability: 'section-level' as const,
    };
    expect(
      assembleSectionPage('Core', payload, {
        evidence: createEvidencePresentation(evidenceBundle(), 'zh-CN'),
      }),
    ).toBe('# Core\n\nLegacy body.\n\n## Details\nUnchanged.');
  });

  it('replaces model-authored machine evidence columns and preserves explicit source tables', () => {
    const evidence = createEvidencePresentation(evidenceBundle(), 'zh-CN');
    const page = assembleSectionPage(
      'Design',
      {
        mode: 'structured',
        traceability: 'claim-level',
        blocks: [
          {
            type: 'table',
            headers: ['Component', 'Evidence'],
            rows: [
              {
                cells: [`Core references ${sourceEvidence.id}`, sourceEvidence.id],
                evidenceIds: [sourceEvidence.id],
              },
            ],
          },
          {
            type: 'table',
            headers: ['Source / 来源', 'Anchor / 锚点', 'Supports / 支持内容'],
            rows: [
              {
                cells: ['src/core.ts', 'Core', 'Core implementation'],
                evidenceIds: [sourceEvidence.id],
              },
            ],
          },
        ],
      },
      { evidence },
    );
    const visible = page.replace(/<!-- evidence:.*?-->/g, '');

    expect(page).toContain('| Component | 来源 |');
    expect(page).not.toContain('| Component | Evidence | 来源 |');
    expect(page).toContain('| Source / 来源 | Anchor / 锚点 | Supports / 支持内容 |');
    expect(page).not.toContain('| Source / 来源 | Anchor / 锚点 | Supports / 支持内容 | 来源 |');
    expect(visible).toContain('Core references src/core.ts:42-48');
    expect(visible).not.toContain(sourceEvidence.id);
    expect(page).toContain(`<!-- evidence: ${sourceEvidence.id} -->`);
  });

  it('rejects unreferenced factual claims, duplicate claim ids, and unknown evidence ids', () => {
    const claim = {
      type: 'claim' as const,
      claim: {
        id: 'claim-core',
        text: 'A fact',
        status: 'verified' as const,
        evidenceIds: [] as string[],
        origin: 'llm' as const,
      },
    };
    expect(() => validateSectionBlocks([claim])).toThrow('blocks[0].claim must reference evidence');

    claim.claim.evidenceIds = [sourceEvidence.id];
    expect(() => validateSectionBlocks([claim, claim])).toThrow('Duplicate claim id: claim-core');

    claim.claim.evidenceIds = ['ev-unknown'];
    expect(() => validateSectionBlocks([claim], new Set([sourceEvidence.id]))).toThrow(
      'blocks[0].claim references unknown evidence id: ev-unknown',
    );
  });
});

describe('wiki DocumentPlan', () => {
  it('snapshots localized titles and stable identity for the default legacy adapter', () => {
    const profile = resolveTemplateProfile('default');
    const language = resolveLanguage('zh-CN', profile.profile);
    const plan = createDocumentPlan({
      profile,
      language,
      sourceCommit: 'abc123',
      moduleTree: [{ name: 'Core', slug: 'core', files: ['src/core.ts'] }],
      evidence: evidenceBundle(),
    });

    expect(plan).toMatchObject({
      schemaVersion: 1,
      profile: { id: 'default', revision: 1, fingerprint: profile.fingerprint },
      language: { requestedLanguage: 'zh-CN', resolvedLocale: 'zh-CN' },
      sourceCommit: 'abc123',
      dependencyOrder: ['overview', 'module'],
      status: 'planned',
    });
    expect(plan.sections.map((section) => section.title)).toEqual(['概览', '模块']);
    expect(plan.sections[0].payload).toMatchObject({
      mode: 'legacy-markdown',
      traceability: 'section-level',
    });
  });

  it('orders child sections before parents and marks missing required evidence explicitly', () => {
    const profile = structuredClone(DEFAULT_TEMPLATE_PROFILE) as TemplateProfile;
    profile.id = 'arc42';
    profile.displayName = { en: 'arc42', 'zh-CN': 'arc42' };
    profile.sections = [
      {
        id: 'parent',
        title: { en: 'Parent', 'zh-CN': '父章节' },
        required: true,
        concerns: ['architecture'],
        evidenceRequirements: [
          {
            id: 'required-config',
            kind: 'config',
            required: true,
            description: { en: 'Configuration', 'zh-CN': '配置' },
          },
        ],
        unknownPolicy: 'emit-status',
        children: [
          {
            id: 'child',
            title: { en: 'Child', 'zh-CN': '子章节' },
            required: true,
            concerns: ['detail'],
            evidenceRequirements: [],
            unknownPolicy: 'emit-status',
          },
        ],
      },
    ];
    const registry = new TemplateProfileRegistry();
    const registered = registry.register(profile);
    const plan = createDocumentPlan({
      profile: registered,
      language: resolveLanguage('english', registered.profile),
      sourceCommit: 'abc123',
      moduleTree: [],
      evidence: evidenceBundle(),
    });

    expect(plan.dependencyOrder).toEqual(['child', 'parent']);
    expect(plan.sections[0]).toMatchObject({
      id: 'parent',
      status: 'missing',
      payload: { mode: 'structured', blocks: [] },
      diagnostics: [{ code: 'required-evidence-missing' }],
    });
    expect(() => validateDocumentPlan(plan)).not.toThrow();

    plan.dependencyOrder = ['parent', 'child'];
    expect(() => validateDocumentPlan(plan)).toThrow(
      'DocumentPlan dependency order must place child before parent',
    );
  });

  it('uses module-level graph evidence when planning required call-graph sections', () => {
    const relationEvidence = createEvidenceRef({
      kind: 'relation',
      status: 'verified',
      relation: 'Core -> Storage',
      summary: 'Core calls Storage',
    });
    const profile = structuredClone(DEFAULT_TEMPLATE_PROFILE) as TemplateProfile;
    profile.id = 'ieee-1016-sdd';
    profile.sections = [
      {
        id: 'dependencies',
        title: { en: 'Dependencies', 'zh-CN': '依赖' },
        required: true,
        concerns: ['dependencies'],
        evidenceRequirements: [
          {
            id: 'required-calls',
            kind: 'call-graph',
            required: true,
            description: { en: 'Calls', 'zh-CN': '调用' },
          },
        ],
        unknownPolicy: 'emit-status',
      },
    ];
    const registry = new TemplateProfileRegistry();
    const registered = registry.register(profile);
    const evidence = evidenceBundle();
    const plan = createDocumentPlan({
      profile: registered,
      language: resolveLanguage('chinese', registered.profile),
      sourceCommit: 'abc123',
      moduleTree: [],
      evidence: {
        ...evidence,
        modules: { Core: [relationEvidence] },
      },
    });

    expect(plan.sections[0]).toMatchObject({
      id: 'dependencies',
      status: 'verified',
      diagnostics: [],
    });
  });
});

describe('wiki OutputManifest', () => {
  function manifest() {
    const profile = resolveTemplateProfile('default');
    return createOutputManifest({
      generationId: 'generation-1',
      profile: { id: 'default', revision: 1, fingerprint: profile.fingerprint },
      language: resolveLanguage('english', profile.profile),
      sourceCommit: 'abc123',
      generationSemanticsKey: 'a'.repeat(64),
      entry: { slug: 'overview', label: 'Overview', file: 'overview.md', content: '# Wiki' },
      pages: [
        {
          id: 'core',
          slug: 'core',
          label: 'Core',
          file: 'core.md',
          order: 0,
          status: 'verified',
          content: '# Core',
        },
      ],
      aggregate: { file: 'all.md', content: '# All' },
      coverage: { file: 'coverage.json', content: '{}' },
      supportingArtifacts: [{ role: 'document-plan', file: 'document_plan.json', content: '{}' }],
    });
  }

  it('hashes entry, pages, aggregate, and coverage deterministically', () => {
    const output = manifest();
    expect(output.entry.contentHash).toBe(hashOutputContent('# Wiki'));
    expect(output.pages[0].contentHash).toBe(hashOutputContent('# Core'));
    expect(output.aggregate?.contentHash).toBe(hashOutputContent('# All'));
    expect(output.coverage.contentHash).toBe(hashOutputContent('{}'));
    expect(output.supportingArtifacts?.[0].contentHash).toBe(hashOutputContent('{}'));
    expect(() => validateOutputManifest(output)).not.toThrow();
  });

  it('rejects traversal, duplicate slugs/files/order, and unknown parents', () => {
    const traversal = manifest();
    traversal.pages[0].file = '../core.md';
    expect(() => validateOutputManifest(traversal)).toThrow(
      'page core.file must be a safe relative file name',
    );

    const duplicate = manifest();
    duplicate.pages.push({ ...duplicate.pages[0], id: 'other' });
    expect(() => validateOutputManifest(duplicate)).toThrow('Duplicate manifest slug: core');

    const unknownParent = manifest();
    unknownParent.pages[0].parentId = 'missing';
    expect(() => validateOutputManifest(unknownParent)).toThrow(
      'Manifest page core has unknown parent missing',
    );

    const duplicateRootFile = manifest();
    duplicateRootFile.coverage.file = 'overview.md';
    expect(() => validateOutputManifest(duplicateRootFile)).toThrow(
      'Entry, aggregate, and coverage files must be unique',
    );

    const tamperedHash = manifest();
    tamperedHash.pages[0].contentHash = 'not-a-hash';
    expect(() => validateOutputManifest(tamperedHash)).toThrow(
      'OutputManifest content hashes must be SHA-256 digests',
    );

    const nestedPath = manifest();
    nestedPath.pages[0].file = 'nested/core.md';
    expect(() => validateOutputManifest(nestedPath)).toThrow(
      'page core.file must be a safe relative file name',
    );

    const reservedName = manifest();
    reservedName.pages[0].file = 'CON.md';
    expect(() => validateOutputManifest(reservedName)).toThrow(
      'page core.file must be a safe relative file name',
    );
  });
});

describe('wiki Markdown renderer', () => {
  function renderNested(languageName: string) {
    const profileDefinition = structuredClone(DEFAULT_TEMPLATE_PROFILE) as TemplateProfile;
    profileDefinition.id = 'arc42';
    profileDefinition.displayName = { en: 'Architecture', 'zh-CN': '架构文档' };
    profileDefinition.output = {
      topology: 'standard-document',
      entryFile: 'architecture.md',
      aggregateFile: 'architecture-all.md',
      coverageFile: 'coverage.json',
    };
    profileDefinition.sections = [
      {
        id: 'parent',
        title: { en: 'Parent', 'zh-CN': '父章节' },
        required: true,
        concerns: ['architecture'],
        evidenceRequirements: [],
        unknownPolicy: 'emit-status',
        children: [
          {
            id: 'child',
            title: { en: 'Child', 'zh-CN': '子章节' },
            required: true,
            concerns: ['detail'],
            evidenceRequirements: [],
            unknownPolicy: 'emit-status',
          },
        ],
      },
    ];
    const registry = new TemplateProfileRegistry();
    const profile = registry.register(profileDefinition);
    const language = resolveLanguage(languageName, profile.profile);
    const evidence = evidenceBundle();
    const plan = createDocumentPlan({
      profile,
      language,
      sourceCommit: evidence.sourceCommit,
      moduleTree: [],
      evidence,
    });
    for (const section of [plan.sections[0], plan.sections[0].children![0]]) {
      section.payload = {
        mode: 'structured',
        blocks: [
          {
            type: 'claim',
            claim: {
              id: `claim-${section.id}`,
              text: 'Safe fact <script>alert(1)</script> [bad](javascript:alert(1))',
              status: 'verified',
              evidenceIds: [sourceEvidence.id],
              origin: 'deterministic',
            },
          },
        ],
      };
    }
    const coverage = validateProfileCoverage(profile, plan, evidence);
    return renderDocumentPlan(profile, plan, coverage, 'generation-1', 'a'.repeat(64), evidence);
  }

  it('renders nested pages, aggregate, navigation, and coverage from one IR', () => {
    const rendered = renderNested('english');
    expect(Object.keys(rendered.files).sort()).toEqual([
      'architecture-all.md',
      'architecture.md',
      'child.md',
      'coverage.json',
      'coverage.md',
      'parent.md',
    ]);
    expect(
      rendered.manifest.pages.map(({ id, parentId, order }) => ({ id, parentId, order })),
    ).toEqual([
      { id: 'parent', parentId: undefined, order: 0 },
      { id: 'child', parentId: 'parent', order: 1 },
      { id: 'profile-coverage-report', parentId: undefined, order: 2 },
    ]);
    expect(rendered.files['architecture-all.md']).toContain('## Parent');
    expect(rendered.files['architecture-all.md']).toContain('## Child');
    expect(rendered.files['parent.md']).not.toContain('<script>');
    expect(rendered.files['parent.md']).not.toContain('javascript:');
    expect(rendered.files['parent.md']).toContain('Source: src/core.ts:42-48');
    expect(rendered.files['coverage.md']).toContain('src/core.ts:42-48');
    expect(rendered.files['coverage.md']).not.toContain(sourceEvidence.id);
    const coverageJson = JSON.parse(rendered.files['coverage.json']);
    expect(coverageJson).toMatchObject({
      status: 'passed',
      standardsConformanceAssessed: false,
      sections: [
        { id: 'parent', status: 'verified' },
        { id: 'child', status: 'verified' },
      ],
    });
    expect(JSON.stringify(coverageJson)).toContain(sourceEvidence.id);
  });

  it('keeps IDs, slugs, files, and status enums stable while localizing labels', () => {
    const english = renderNested('english');
    const chinese = renderNested('chinese');
    expect(
      chinese.manifest.pages.map(({ id, slug, file, status }) => ({ id, slug, file, status })),
    ).toEqual(
      english.manifest.pages.map(({ id, slug, file, status }) => ({ id, slug, file, status })),
    );
    expect(chinese.files['architecture.md']).toContain('# 架构文档');
    expect(chinese.files['coverage.md']).toContain('| 章节 | 必需 | 状态 | 证据 |');
    expect(chinese.manifest.pages[0].label).toBe('父章节');
  });

  it('writes unsupported-locale fallback diagnostics into coverage artifacts', () => {
    const rendered = renderNested('Japanese');
    expect(rendered.files['coverage.md']).toContain(
      'Built-in text is unavailable for Japanese; deterministic content uses English.',
    );
    expect(JSON.parse(rendered.files['coverage.json']).language).toMatchObject({
      requestedLanguage: 'Japanese',
      resolvedLocale: 'en',
      fallbackFrom: 'Japanese',
    });
  });

  it('normalizes Mermaid blocks in standard page and aggregate artifacts', () => {
    const profileDefinition = structuredClone(DEFAULT_TEMPLATE_PROFILE) as TemplateProfile;
    profileDefinition.id = 'ieee-1016-sdd';
    profileDefinition.output = {
      topology: 'standard-document',
      entryFile: 'sdd.md',
      aggregateFile: 'sdd-all.md',
      coverageFile: 'coverage.json',
    };
    profileDefinition.sections = [
      {
        id: 'runtime',
        title: { en: 'Runtime', 'zh-CN': '运行时' },
        required: true,
        concerns: ['runtime'],
        evidenceRequirements: [],
        unknownPolicy: 'emit-status',
      },
    ];
    const registry = new TemplateProfileRegistry();
    const profile = registry.register(profileDefinition);
    const language = resolveLanguage('chinese', profile.profile);
    const evidence = evidenceBundle();
    const plan = createDocumentPlan({
      profile,
      language,
      sourceCommit: evidence.sourceCommit,
      moduleTree: [],
      evidence,
    });
    plan.sections[0].payload = {
      mode: 'structured',
      blocks: [
        {
          type: 'diagram',
          syntax: 'mermaid',
          source: 'graph TD; A[入口] --> B[处理]; B --> C[结果];',
          evidenceIds: [sourceEvidence.id],
        },
      ],
    };

    const coverage = validateProfileCoverage(profile, plan, evidence);
    const rendered = renderDocumentPlan(
      profile,
      plan,
      coverage,
      'generation-mermaid',
      'a'.repeat(64),
      evidence,
    );
    for (const file of ['runtime.md', 'sdd-all.md']) {
      expect(rendered.files[file]).toContain('graph TD\nA[入口] --> B[处理]\nB --> C[结果]\n');
      expect(rendered.files[file]).not.toContain('graph TD;');
    }
  });
});
