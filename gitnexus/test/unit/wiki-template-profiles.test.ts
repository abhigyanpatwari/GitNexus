import { describe, expect, it } from 'vitest';

import { WikiGenerator, type WikiMeta } from '../../src/core/wiki/generator.js';
import {
  MODULE_SYSTEM_PROMPT,
  MODULE_USER_PROMPT,
  OVERVIEW_SYSTEM_PROMPT,
  OVERVIEW_USER_PROMPT,
  PARENT_SYSTEM_PROMPT,
  PARENT_USER_PROMPT,
} from '../../src/core/wiki/prompts.js';
import { DEFAULT_TEMPLATE_PROFILE } from '../../src/core/wiki/profiles/builtins/default.js';
import {
  TemplateProfileRegistry,
  fingerprintTemplateProfile,
  listTemplateProfiles,
  resolveTemplateProfile,
  validateTemplateProfile,
} from '../../src/core/wiki/profiles/registry.js';
import { renderPrompt } from '../../src/core/wiki/profiles/render-prompt.js';
import { resolveLanguage } from '../../src/core/wiki/profiles/locale.js';
import { createDocumentPlan } from '../../src/core/wiki/document/planner.js';
import type { PromptSpec, TemplateProfile } from '../../src/core/wiki/profiles/types.js';

function cloneDefault(): TemplateProfile {
  return structuredClone(DEFAULT_TEMPLATE_PROFILE);
}

describe('wiki template profile registry', () => {
  it('registers default through an explicit built-in registry', () => {
    expect(listTemplateProfiles().map((entry) => entry.profile.id)).toEqual([
      'arc42',
      'default',
      'engineering-wiki',
      'ieee-1016-sdd',
      'iso-42010-ad',
    ]);
    const resolved = resolveTemplateProfile();
    expect(resolved.profile).toBe(DEFAULT_TEMPLATE_PROFILE);
    expect(resolved.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('statically registers all built-in structured Profiles with stable section outlines', () => {
    expect(resolveTemplateProfile('arc42').profile.sections.map((section) => section.id)).toEqual([
      'introduction-goals',
      'constraints',
      'context-scope',
      'solution-strategy',
      'building-block-view',
      'runtime-view',
      'deployment-view',
      'crosscutting-concepts',
      'architectural-decisions',
      'quality-requirements',
      'risks-technical-debt',
      'glossary',
    ]);
    expect(
      resolveTemplateProfile('engineering-wiki').profile.sections.map((section) => section.id),
    ).toEqual([
      'project-overview',
      'architecture-design',
      'core-module-details',
      'frontend-architecture',
      'data-storage-design',
      'api-interface-docs',
      'plugin-extension-development',
      'deployment-operations',
      'security-design',
      'development-extension',
      'quality-governance',
    ]);
    expect(
      resolveTemplateProfile('ieee-1016-sdd').profile.sections.map((section) => section.id),
    ).toEqual([
      'document-identity',
      'references-change-history',
      'system-context',
      'composition-design',
      'logical-design',
      'dependency-design',
      'information-data-design',
      'patterns-crosscutting-design',
      'interface-design',
      'interaction-runtime-design',
      'state-design',
      'algorithm-design',
      'resource-deployment-design',
      'decisions-rationale',
      'traceability-matrix',
      'risks-open-issues',
    ]);
    expect(
      resolveTemplateProfile('iso-42010-ad').profile.sections.map((section) => section.id),
    ).toEqual([
      'architecture-description-identity',
      'entity-scope',
      'stakeholders-concerns',
      'environment-external-entities',
      'viewpoint-catalog',
      'architecture-views',
      'correspondences-rules',
      'decisions-rationale',
      'quality-scenarios',
      'risks-assumptions-issues',
      'evidence-traceability',
      'profile-coverage',
    ]);
  });

  it('defines the engineering Wiki as a 27-page two-level information architecture', () => {
    const profile = resolveTemplateProfile('engineering-wiki').profile;
    const flatten = (sections: readonly (typeof profile.sections)[number][]): string[] =>
      sections.flatMap((section) => [
        section.id,
        ...(section.children ? flatten(section.children) : []),
      ]);

    expect(flatten(profile.sections)).toHaveLength(27);
    expect(profile.sections[0].children?.map((section) => section.id)).toEqual([
      'project-introduction',
      'core-capabilities',
      'technology-stack',
      'quick-start',
      'repository-structure',
    ]);
    expect(profile.sections[1].children?.map((section) => section.id)).toEqual([
      'overall-architecture',
      'system-context',
      'technical-architecture',
      'logical-architecture',
      'runtime-architecture',
      'deployment-architecture',
    ]);
    expect(profile.sections[2].children?.map((section) => section.id)).toEqual([
      'module-responsibilities',
      'module-dependencies',
      'core-execution-flows',
    ]);
    expect(
      profile.sections[profile.sections.length - 1]?.children?.map((section) => section.id),
    ).toEqual(['architecture-decisions', 'risks-technical-debt']);
    expect(profile.output).toMatchObject({
      topology: 'standard-document',
      entryFile: 'engineering-wiki.md',
      aggregateFile: 'engineering-wiki-all.md',
    });
    expect(
      profile.sections.filter((section) => !section.required).map((section) => section.id),
    ).toEqual([
      'frontend-architecture',
      'data-storage-design',
      'api-interface-docs',
      'plugin-extension-development',
      'deployment-operations',
      'security-design',
      'quality-governance',
    ]);
  });

  it('plans engineering Wiki children before their category parents', () => {
    const profile = resolveTemplateProfile('engineering-wiki');
    const plan = createDocumentPlan({
      profile,
      language: resolveLanguage('chinese', profile.profile),
      sourceCommit: 'abc123',
      moduleTree: [],
      evidence: {
        schemaVersion: 1,
        repoPath: '/repo',
        sourceCommit: 'abc123',
        collectedAt: '2026-08-12T00:00:00.000Z',
        repository: [],
        modules: {},
        conflicts: [],
        limitations: [],
      },
    });

    expect(plan.dependencyOrder.indexOf('overall-architecture')).toBeLessThan(
      plan.dependencyOrder.indexOf('architecture-design'),
    );
    expect(plan.dependencyOrder.indexOf('architecture-decisions')).toBeLessThan(
      plan.dependencyOrder.indexOf('quality-governance'),
    );
    expect(plan.sections[1].title).toBe('架构设计');
    expect(plan.sections[1].children?.[0].title).toBe('系统总体架构');
  });

  it('uses independently worded conservative standards notices in en and zh-CN', () => {
    const ieee = resolveTemplateProfile('ieee-1016-sdd').profile.alignments[0];
    expect(ieee.officialTitle).toBe('IEEE 1016-2009');
    expect(ieee.notice).toEqual({
      en: 'Inspired by IEEE 1016-2009; conformance not assessed.',
      'zh-CN': '设计结构参考 IEEE 1016-2009 的公开概念；未进行标准符合性评估。',
    });

    const iso = resolveTemplateProfile('iso-42010-ad').profile.alignments[0];
    expect(iso.officialTitle).toBe('ISO/IEC/IEEE 42010:2022');
    expect(iso.notice).toEqual({
      en: 'Aligned with ISO/IEC/IEEE 42010:2022 concepts; conformance not assessed.',
      'zh-CN': '架构描述结构映射 ISO/IEC/IEEE 42010:2022 的公开概念；未进行标准符合性评估。',
    });
    expect(ieee.licenseNote).toContain('does not reproduce');
    expect(iso.licenseNote).toContain('does not reproduce');

    const unsafe = structuredClone(resolveTemplateProfile('ieee-1016-sdd').profile);
    unsafe.alignments[0].notice.en = 'Compliant with IEEE 1016-2009.';
    expect(() => validateTemplateProfile(unsafe)).toThrow(
      'profile.alignments[0].notice.en must state that conformance was not assessed',
    );
  });

  it('keeps default prompts byte-identical by referencing the legacy constants', () => {
    expect(DEFAULT_TEMPLATE_PROFILE.prompts.module.system).toBe(MODULE_SYSTEM_PROMPT);
    expect(DEFAULT_TEMPLATE_PROFILE.prompts.module.user).toBe(MODULE_USER_PROMPT);
    expect(DEFAULT_TEMPLATE_PROFILE.prompts.parent.system).toBe(PARENT_SYSTEM_PROMPT);
    expect(DEFAULT_TEMPLATE_PROFILE.prompts.parent.user).toBe(PARENT_USER_PROMPT);
    expect(DEFAULT_TEMPLATE_PROFILE.prompts.overview.system).toBe(OVERVIEW_SYSTEM_PROMPT);
    expect(DEFAULT_TEMPLATE_PROFILE.prompts.overview.user).toBe(OVERVIEW_USER_PROMPT);
  });

  it('rejects duplicate profile ids and reports available profiles for unknown ids', () => {
    const registry = new TemplateProfileRegistry();
    registry.register(cloneDefault());
    expect(() => registry.register(cloneDefault())).toThrow('Duplicate profile id: default');
    expect(() => registry.resolve('missing')).toThrow(
      'Unknown wiki profile "missing". Available profiles: default',
    );
  });

  it('freezes registered profiles so the content cannot drift away from its fingerprint', () => {
    const registry = new TemplateProfileRegistry();
    const registered = registry.register(cloneDefault());
    expect(Object.isFrozen(registered.profile.sections)).toBe(true);
    expect(() => {
      (registered.profile.displayName as any).en = 'Changed after registration';
    }).toThrow();
    expect(registry.resolve('default').fingerprint).toBe(registered.fingerprint);
  });

  it('rejects unknown fields, unsupported schema versions, and invalid revisions', () => {
    const unknownField = { ...cloneDefault(), extra: true } as unknown as TemplateProfile;
    expect(() => validateTemplateProfile(unknownField)).toThrow(
      'profile contains unknown fields: extra',
    );

    const wrongSchema = cloneDefault();
    (wrongSchema as any).schemaVersion = 2;
    expect(() => validateTemplateProfile(wrongSchema)).toThrow(
      'Unsupported profile schemaVersion: 2',
    );

    const wrongRevision = cloneDefault();
    wrongRevision.revision = 0;
    expect(() => validateTemplateProfile(wrongRevision)).toThrow(
      'profile.revision must be a positive integer',
    );
  });

  it('requires complete en and zh-CN fixed text', () => {
    const profile = cloneDefault();
    delete (profile.displayName as any)['zh-CN'];
    expect(() => validateTemplateProfile(profile)).toThrow(
      'profile.displayName.zh-CN must be a non-empty string',
    );
  });

  it('rejects duplicate section ids and unsafe output file names', () => {
    const duplicateSection = cloneDefault();
    duplicateSection.sections = [
      duplicateSection.sections[0],
      { ...duplicateSection.sections[1], id: duplicateSection.sections[0].id },
    ];
    expect(() => validateTemplateProfile(duplicateSection)).toThrow(
      'Duplicate section id: overview',
    );

    const unsafeOutput = cloneDefault();
    unsafeOutput.output.entryFile = '../overview.md';
    expect(() => validateTemplateProfile(unsafeOutput)).toThrow(
      'profile.output.entryFile must be a safe relative file name',
    );
  });

  it('rejects output file names containing slashes', () => {
    const slashOutput = cloneDefault();
    slashOutput.output.entryFile = 'docs/overview.md';
    expect(() => validateTemplateProfile(slashOutput)).toThrow(
      'profile.output.entryFile must be a safe relative file name',
    );
  });

  it('rejects unknown prompt placeholders and required variables outside the allowlist', () => {
    const unknownPlaceholder = cloneDefault();
    unknownPlaceholder.prompts.module.user += '\n{{UNDECLARED}}';
    expect(() => validateTemplateProfile(unknownPlaceholder)).toThrow(
      'profile.prompts.module: template references unknown variable UNDECLARED',
    );

    const missingAllowed = cloneDefault();
    missingAllowed.prompts.module.allowedVariables =
      missingAllowed.prompts.module.allowedVariables.filter((name) => name !== 'MODULE_NAME');
    expect(() => validateTemplateProfile(missingAllowed)).toThrow(
      'profile.prompts.module: required variable MODULE_NAME is not allowed',
    );
  });

  it('produces a stable fingerprint while preserving meaningful array order', () => {
    const profile = cloneDefault();
    const reorderedObject = {
      output: profile.output,
      diagramPolicy: profile.diagramPolicy,
      prompts: profile.prompts,
      sections: profile.sections,
      grouping: profile.grouping,
      alignments: profile.alignments,
      displayName: profile.displayName,
      revision: profile.revision,
      id: profile.id,
      schemaVersion: profile.schemaVersion,
    } as TemplateProfile;
    expect(fingerprintTemplateProfile(reorderedObject)).toBe(fingerprintTemplateProfile(profile));

    const reorderedSections = cloneDefault();
    reorderedSections.sections = [...reorderedSections.sections].reverse();
    expect(fingerprintTemplateProfile(reorderedSections)).not.toBe(
      fingerprintTemplateProfile(profile),
    );
  });
});

describe('strict wiki prompt rendering', () => {
  const spec: PromptSpec = {
    system: 'System',
    user: '{{NAME}} uses {{OPTIONAL}}.',
    requiredVariables: ['NAME'],
    allowedVariables: ['NAME', 'OPTIONAL'],
  };

  it('renders declared variables through the legacy substitution helper', () => {
    expect(renderPrompt(spec, { NAME: 'GitNexus', OPTIONAL: 'profiles' })).toEqual({
      system: 'System',
      user: 'GitNexus uses profiles.',
    });
  });

  it('rejects missing required, unknown, and residual variables before LLM use', () => {
    expect(() => renderPrompt(spec, { OPTIONAL: 'profiles' })).toThrow(
      'Required prompt variable NAME is missing',
    );
    expect(() => renderPrompt(spec, { NAME: 'GitNexus', EXTRA: 'x' })).toThrow(
      'Prompt variable EXTRA is not allowed',
    );
    expect(() => renderPrompt(spec, { NAME: 'GitNexus' })).toThrow(
      'Prompt contains unresolved variables: OPTIONAL',
    );
  });
});

describe('wiki generation identity and legacy meta migration', () => {
  const baseConfig = {
    apiKey: 'test',
    baseUrl: 'https://example.test/v1',
    model: 'test-model',
    maxTokens: 1000,
    temperature: 0,
    provider: 'openai' as const,
  };

  function generator(
    overrides: Partial<typeof baseConfig> = {},
    options: ConstructorParameters<typeof WikiGenerator>[4] = {},
  ) {
    return new WikiGenerator(
      '/repo',
      '/storage',
      '/lbug',
      { ...baseConfig, ...overrides },
      options,
    );
  }

  function legacyMeta(lang = ''): WikiMeta {
    return {
      fromCommit: 'old-commit',
      generatedAt: '2026-01-01T00:00:00.000Z',
      model: 'old-model',
      lang,
      moduleFiles: { Core: ['src/core.ts'] },
      moduleTree: [{ name: 'Core', slug: 'core', files: ['src/core.ts'] }],
    };
  }

  it('keeps legacy meta readable for default and upgrades it on the next successful write', () => {
    const gen = generator();
    expect(() => (gen as any).assertCacheCompatibility(legacyMeta(), 'new-commit')).not.toThrow();

    const upgraded = (gen as any).buildWikiMeta(
      'new-commit',
      legacyMeta().moduleFiles,
      legacyMeta().moduleTree,
      legacyMeta(),
    ) as WikiMeta;
    expect(upgraded).toMatchObject({
      schemaVersion: 2,
      fromCommit: 'new-commit',
      profile: {
        id: 'default',
        revision: 1,
        fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      generation: {
        provider: 'openai',
        model: 'test-model',
        requestedLanguage: '',
        resolvedLocale: 'en',
        localeFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        semanticsKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        artifactKey: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
  });

  it('fails closed when a non-default profile tries to reuse legacy meta', () => {
    const profile = cloneDefault();
    profile.id = 'arc42';
    profile.displayName = { en: 'arc42', 'zh-CN': 'arc42' };
    const registry = new TemplateProfileRegistry();
    const registered = registry.register(profile);
    const language = resolveLanguage(undefined, registered.profile);
    const gen = generator({}, { profile: registered, language });

    expect(() => (gen as any).assertCacheCompatibility(legacyMeta(), 'new-commit')).toThrow(
      'Legacy wiki metadata can only be reused by the default profile; use --force to regenerate with arc42.',
    );
  });

  it('allows incremental reuse only when the generation semantics key matches', () => {
    const original = generator();
    const meta = (original as any).buildWikiMeta(
      'old-commit',
      legacyMeta().moduleFiles,
      legacyMeta().moduleTree,
    ) as WikiMeta;

    expect(() => (original as any).assertCacheCompatibility(meta, 'new-commit')).not.toThrow();

    const changedModel = generator({ model: 'different-model' });
    expect(() => (changedModel as any).assertCacheCompatibility(meta, 'new-commit')).toThrow(
      'Wiki generation settings changed; use --force to regenerate all pages.',
    );

    const corruptedStructuredIdentity = structuredClone(meta);
    corruptedStructuredIdentity.profile!.revision += 1;
    expect(() =>
      (original as any).assertCacheCompatibility(corruptedStructuredIdentity, 'new-commit'),
    ).toThrow('Wiki generation settings changed; use --force to regenerate all pages.');
  });

  it('separates stable semantics identity from commit-specific artifact identity', () => {
    const gen = generator();
    const first = (gen as any).buildWikiMeta('commit-a', {}, []) as WikiMeta;
    const second = (gen as any).buildWikiMeta('commit-b', {}, []) as WikiMeta;

    expect(first.generation?.semanticsKey).toBe(second.generation?.semanticsKey);
    expect(first.generation?.artifactKey).not.toBe(second.generation?.artifactKey);
    expect(first.generation?.generationId).toBe(first.generation?.artifactKey);
  });

  it('records requested language, deterministic fallback, and legacy lang together', () => {
    const profile = resolveTemplateProfile('default');
    const language = resolveLanguage('Japanese', profile.profile);
    const gen = generator({}, { profile, language, lang: 'Japanese' });
    const meta = (gen as any).buildWikiMeta('commit-a', {}, []) as WikiMeta;

    expect(meta).toMatchObject({
      lang: 'Japanese',
      generation: {
        requestedLanguage: 'Japanese',
        resolvedLocale: 'en',
        localeFallback: { from: 'Japanese', to: 'en' },
      },
    });
  });
});
