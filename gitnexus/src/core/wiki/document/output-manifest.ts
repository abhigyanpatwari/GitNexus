import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ResolvedLanguage } from '../profiles/types.js';
import type { EvidenceStatus } from './evidence.js';
import type { ProfileIdentity } from './planner.js';

export const OUTPUT_MANIFEST_SCHEMA_VERSION = 1 as const;

export interface ManifestEntryInput {
  slug: string;
  label: string;
  file: string;
  content: string;
}

export interface ManifestPageInput extends ManifestEntryInput {
  id: string;
  parentId?: string;
  order: number;
  status: EvidenceStatus;
}

export interface OutputManifestPage {
  id: string;
  slug: string;
  label: string;
  file: string;
  parentId?: string;
  order: number;
  status: EvidenceStatus;
  contentHash: string;
}

export interface OutputManifestSupportingArtifact {
  role: 'document-plan' | 'module-tree';
  file: string;
  contentHash: string;
}

export interface OutputManifest {
  schemaVersion: typeof OUTPUT_MANIFEST_SCHEMA_VERSION;
  generationId: string;
  profile: ProfileIdentity;
  language: ResolvedLanguage;
  sourceCommit: string;
  generationSemanticsKey: string;
  entry: Omit<ManifestEntryInput, 'content'> & { contentHash: string };
  pages: OutputManifestPage[];
  aggregate?: { file: string; contentHash: string };
  coverage: { file: string; contentHash: string };
  supportingArtifacts?: OutputManifestSupportingArtifact[];
}

export interface CreateOutputManifestInput {
  generationId: string;
  profile: ProfileIdentity;
  language: ResolvedLanguage;
  sourceCommit: string;
  generationSemanticsKey: string;
  entry: ManifestEntryInput;
  pages: ManifestPageInput[];
  aggregate?: { file: string; content: string };
  coverage: { file: string; content: string };
  supportingArtifacts?: Array<{
    role: OutputManifestSupportingArtifact['role'];
    file: string;
    content: string;
  }>;
}

export function hashOutputContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function validateSafeRelativeFile(file: string, label: string): void {
  const windowsStem = file.split('.')[0].toUpperCase();
  if (
    file === '' ||
    path.isAbsolute(file) ||
    file.includes('\\') ||
    file.includes('/') ||
    ['CON', 'PRN', 'AUX', 'NUL'].includes(windowsStem) ||
    /^(?:COM|LPT)[1-9]$/.test(windowsStem) ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(file)
  ) {
    throw new Error(`${label} must be a safe relative file name`);
  }
}

export function createOutputManifest(input: CreateOutputManifestInput): OutputManifest {
  const manifest: OutputManifest = {
    schemaVersion: OUTPUT_MANIFEST_SCHEMA_VERSION,
    generationId: input.generationId,
    profile: input.profile,
    language: input.language,
    sourceCommit: input.sourceCommit,
    generationSemanticsKey: input.generationSemanticsKey,
    entry: {
      slug: input.entry.slug,
      label: input.entry.label,
      file: input.entry.file,
      contentHash: hashOutputContent(input.entry.content),
    },
    pages: input.pages.map((page) => ({
      id: page.id,
      slug: page.slug,
      label: page.label,
      file: page.file,
      ...(page.parentId ? { parentId: page.parentId } : {}),
      order: page.order,
      status: page.status,
      contentHash: hashOutputContent(page.content),
    })),
    ...(input.aggregate
      ? {
          aggregate: {
            file: input.aggregate.file,
            contentHash: hashOutputContent(input.aggregate.content),
          },
        }
      : {}),
    coverage: {
      file: input.coverage.file,
      contentHash: hashOutputContent(input.coverage.content),
    },
    ...(input.supportingArtifacts
      ? {
          supportingArtifacts: input.supportingArtifacts.map((artifact) => ({
            role: artifact.role,
            file: artifact.file,
            contentHash: hashOutputContent(artifact.content),
          })),
        }
      : {}),
  };
  validateOutputManifest(manifest);
  return manifest;
}

export function validateOutputManifest(manifest: OutputManifest): void {
  if (manifest.schemaVersion !== OUTPUT_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`Unsupported OutputManifest schemaVersion: ${manifest.schemaVersion}`);
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.generationSemanticsKey)) {
    throw new Error('OutputManifest generationSemanticsKey must be a SHA-256 digest');
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.language.localeFingerprint)) {
    throw new Error('OutputManifest language localeFingerprint must be a SHA-256 digest');
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(manifest.generationId)) {
    throw new Error('OutputManifest generationId must be a safe stable identifier');
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.profile.fingerprint)) {
    throw new Error('OutputManifest profile fingerprint must be a SHA-256 digest');
  }
  validateSafeRelativeFile(manifest.entry.file, 'entry.file');
  validateSafeRelativeFile(manifest.coverage.file, 'coverage.file');
  if (manifest.aggregate) validateSafeRelativeFile(manifest.aggregate.file, 'aggregate.file');
  for (const artifact of manifest.supportingArtifacts ?? []) {
    if (!['document-plan', 'module-tree'].includes(artifact.role)) {
      throw new Error(`OutputManifest supporting artifact role is invalid: ${artifact.role}`);
    }
    validateSafeRelativeFile(artifact.file, `supporting artifact ${artifact.role}.file`);
  }

  const initialFiles = [manifest.entry.file, manifest.coverage.file];
  if (manifest.aggregate) initialFiles.push(manifest.aggregate.file);
  initialFiles.push(...(manifest.supportingArtifacts ?? []).map((artifact) => artifact.file));
  if (new Set(initialFiles).size !== initialFiles.length) {
    throw new Error('Entry, aggregate, and coverage files must be unique');
  }

  const hashes = [
    manifest.entry.contentHash,
    manifest.coverage.contentHash,
    ...(manifest.aggregate ? [manifest.aggregate.contentHash] : []),
    ...(manifest.supportingArtifacts ?? []).map((artifact) => artifact.contentHash),
    ...manifest.pages.map((page) => page.contentHash),
  ];
  if (hashes.some((hash) => !/^[a-f0-9]{64}$/.test(hash))) {
    throw new Error('OutputManifest content hashes must be SHA-256 digests');
  }

  const ids = new Set<string>();
  const slugs = new Set<string>([manifest.entry.slug]);
  const files = new Set<string>([manifest.entry.file, manifest.coverage.file]);
  if (manifest.aggregate) files.add(manifest.aggregate.file);
  const supportingRoles = new Set<string>();
  for (const artifact of manifest.supportingArtifacts ?? []) {
    if (supportingRoles.has(artifact.role)) {
      throw new Error(`Duplicate supporting artifact role: ${artifact.role}`);
    }
    supportingRoles.add(artifact.role);
    files.add(artifact.file);
  }

  for (const page of manifest.pages) {
    validateSafeRelativeFile(page.file, `page ${page.id}.file`);
    if (ids.has(page.id)) throw new Error(`Duplicate manifest page id: ${page.id}`);
    if (slugs.has(page.slug)) throw new Error(`Duplicate manifest slug: ${page.slug}`);
    if (files.has(page.file)) throw new Error(`Duplicate manifest file: ${page.file}`);
    if (!Number.isInteger(page.order) || page.order < 0) {
      throw new Error(`Manifest page ${page.id} has an invalid order`);
    }
    ids.add(page.id);
    slugs.add(page.slug);
    files.add(page.file);
  }
  for (const page of manifest.pages) {
    if (page.parentId && !ids.has(page.parentId)) {
      throw new Error(`Manifest page ${page.id} has unknown parent ${page.parentId}`);
    }
  }
  if (new Set(manifest.pages.map((page) => page.order)).size !== manifest.pages.length) {
    throw new Error('Manifest page order values must be unique');
  }
}
