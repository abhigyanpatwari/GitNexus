import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  validateReviewedModuleTree,
  validateReviewedModuleTreePaths,
} from '../../src/core/wiki/generator.js';
import { createEvidenceRef, type EvidenceBundle } from '../../src/core/wiki/document/evidence.js';
import { createDocumentPlan } from '../../src/core/wiki/document/planner.js';
import { validateReviewedDocumentPlan } from '../../src/core/wiki/document/validator.js';
import { resolveLanguage } from '../../src/core/wiki/profiles/locale.js';
import { resolveTemplateProfile } from '../../src/core/wiki/profiles/registry.js';

const validTree = [
  {
    name: 'Core',
    slug: 'core',
    files: [],
    children: [
      { name: 'Core API', slug: 'core-api', files: ['src/api.ts'] },
      { name: 'Core Store', slug: 'core-store', files: ['src/store.ts'] },
    ],
  },
];

describe('reviewed wiki module tree validation', () => {
  it('accepts a bounded tree and allows users to omit known repository files', () => {
    expect(
      validateReviewedModuleTree(
        validTree,
        new Set(['src/api.ts', 'src/store.ts', 'src/omitted.ts']),
      ),
    ).toEqual(validTree);
  });

  it.each([
    [
      'traversal file',
      [{ name: 'Core', slug: 'core', files: ['../secret'] }],
      'safe repository-relative',
    ],
    [
      'absolute file',
      [{ name: 'Core', slug: 'core', files: ['/etc/passwd'] }],
      'safe repository-relative',
    ],
    [
      'unknown file',
      [{ name: 'Core', slug: 'core', files: ['src/unknown.ts'] }],
      'unknown repository file',
    ],
    [
      'reserved slug',
      [{ name: 'Core', slug: 'overview', files: ['src/api.ts'] }],
      'unsafe or reserved',
    ],
    [
      'unsafe slug',
      [{ name: 'Core', slug: '../core', files: ['src/api.ts'] }],
      'unsafe or reserved',
    ],
    [
      'duplicate slug',
      [
        { name: 'Core', slug: 'core', files: ['src/api.ts'] },
        { name: 'Core 2', slug: 'core', files: ['src/store.ts'] },
      ],
      'Duplicate module slug',
    ],
    [
      'duplicate assignment',
      [
        { name: 'Core', slug: 'core', files: ['src/api.ts'] },
        { name: 'API', slug: 'api', files: ['src/api.ts'] },
      ],
      'assigned twice',
    ],
    [
      'files and children',
      [
        {
          name: 'Core',
          slug: 'core',
          files: ['src/api.ts'],
          children: [{ name: 'API', slug: 'api', files: ['src/store.ts'] }],
        },
      ],
      'cannot own files and children',
    ],
    [
      'unknown field',
      [{ name: 'Core', slug: 'core', files: [], output: 'x.md' }],
      'unknown fields',
    ],
  ])('rejects %s before any file is generated', (_name, tree, message) => {
    expect(() => validateReviewedModuleTree(tree, new Set(['src/api.ts', 'src/store.ts']))).toThrow(
      message,
    );
  });

  it('rejects a reviewed symlink that resolves outside the repository', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gitnexus-review-path-'));
    try {
      const repoPath = path.join(tempDir, 'repo');
      const outside = path.join(tempDir, 'outside.ts');
      await fs.mkdir(path.join(repoPath, 'src'), { recursive: true });
      await fs.writeFile(outside, 'secret');
      await fs.symlink(outside, path.join(repoPath, 'src/link.ts'));
      const tree = validateReviewedModuleTree(
        [{ name: 'Core', slug: 'core', files: ['src/link.ts'] }],
        new Set(['src/link.ts']),
      );

      await expect(validateReviewedModuleTreePaths(repoPath, tree)).rejects.toThrow(
        'escapes the repository',
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('reviewed standard DocumentPlan validation', () => {
  const evidence = createEvidenceRef({
    kind: 'file',
    status: 'verified',
    filePath: 'src/api.ts',
    summary: 'API source',
  });

  function fixture() {
    const profile = resolveTemplateProfile('arc42');
    const language = resolveLanguage('chinese', profile.profile);
    const bundle: EvidenceBundle = {
      schemaVersion: 1,
      repoPath: '/repo',
      sourceCommit: 'abc123',
      collectedAt: '2026-08-12T00:00:00.000Z',
      repository: [evidence],
      modules: { Core: [evidence] },
      conflicts: [],
      limitations: [],
    };
    const plan = createDocumentPlan({
      profile,
      language,
      sourceCommit: bundle.sourceCommit,
      moduleTree: validTree,
      evidence: bundle,
    });
    return { plan, known: new Set([evidence.id]) };
  }

  it('accepts an unchanged identity and converts the plan to reviewed state', () => {
    const { plan, known } = fixture();
    expect(validateReviewedDocumentPlan(structuredClone(plan), plan, known).status).toBe(
      'reviewed',
    );
  });

  it.each([
    ['Profile', (plan: any) => (plan.profile.fingerprint = 'b'.repeat(64)), 'Profile identity'],
    ['locale', (plan: any) => (plan.language.resolvedLocale = 'en'), 'language identity'],
    ['source commit', (plan: any) => (plan.sourceCommit = 'other'), 'source commit'],
    ['section id', (plan: any) => (plan.sections[0].id = 'invented'), 'unknown section'],
    ['unknown field', (plan: any) => (plan.outputPath = '../escape'), 'unknown fields'],
  ])('rejects %s tampering', (_name, mutate, message) => {
    const { plan, known } = fixture();
    const edited = structuredClone(plan) as any;
    mutate(edited);
    expect(() => validateReviewedDocumentPlan(edited, plan, known)).toThrow(message);
  });

  it('rejects reviewer-authored claims that cite invented Evidence IDs', () => {
    const { plan, known } = fixture();
    const edited = structuredClone(plan);
    edited.sections[0].payload = {
      mode: 'structured',
      blocks: [
        {
          type: 'claim',
          claim: {
            id: 'claim-1',
            text: 'Invented fact',
            status: 'verified',
            evidenceIds: ['ev-invented'],
            origin: 'deterministic',
          },
        },
      ],
    };
    expect(() => validateReviewedDocumentPlan(edited, plan, known)).toThrow(
      'references unknown evidence id',
    );
  });
});
