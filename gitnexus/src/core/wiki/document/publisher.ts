import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { retryRename, writeFileAtomic } from '../../../storage/fs-atomic.js';
import {
  hashOutputContent,
  validateOutputManifest,
  type OutputManifest,
} from './output-manifest.js';

export const WIKI_CURRENT_POINTER_SCHEMA_VERSION = 1 as const;

export interface WikiCurrentPointer {
  schemaVersion: typeof WIKI_CURRENT_POINTER_SCHEMA_VERSION;
  generationId: string;
  manifestFile: 'manifest.json';
  manifestHash: string;
  publishedAt: string;
  previousGenerationId?: string;
}

export interface PublishWikiGenerationInput {
  wikiDir: string;
  manifest: OutputManifest;
  files: Readonly<Record<string, string>>;
  mirrorFiles?: readonly string[];
}

export interface PublishWikiGenerationResult {
  current: WikiCurrentPointer;
  generationDir: string;
  mirrorFailures: readonly string[];
}

export interface PublisherHooks {
  beforeCurrentWrite?: () => Promise<void> | void;
  beforeMirrorWrite?: (file: string) => Promise<void> | void;
}

function validateGenerationId(generationId: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(generationId)) {
    throw new Error('Wiki generationId must be a safe stable identifier');
  }
}

function validateFileName(file: string): void {
  const stem = file.split('.')[0].toUpperCase();
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(file) ||
    ['CON', 'PRN', 'AUX', 'NUL'].includes(stem) ||
    /^(?:COM|LPT)[1-9]$/.test(stem)
  ) {
    throw new Error(`Wiki publication file must be a safe file name: ${file}`);
  }
}

function parseCurrentPointer(value: unknown): WikiCurrentPointer {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Wiki current pointer must be an object');
  }
  const pointer = value as Record<string, unknown>;
  const allowed = new Set([
    'schemaVersion',
    'generationId',
    'manifestFile',
    'manifestHash',
    'publishedAt',
    'previousGenerationId',
  ]);
  const unknown = Object.keys(pointer).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`Wiki current pointer contains unknown fields: ${unknown.join(', ')}`);
  }
  if (
    pointer.schemaVersion !== WIKI_CURRENT_POINTER_SCHEMA_VERSION ||
    pointer.manifestFile !== 'manifest.json' ||
    typeof pointer.generationId !== 'string' ||
    typeof pointer.manifestHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(pointer.manifestHash) ||
    typeof pointer.publishedAt !== 'string'
  ) {
    throw new Error('Wiki current pointer is invalid');
  }
  validateGenerationId(pointer.generationId);
  if (pointer.previousGenerationId !== undefined) {
    if (typeof pointer.previousGenerationId !== 'string') {
      throw new Error('Wiki current pointer previousGenerationId is invalid');
    }
    validateGenerationId(pointer.previousGenerationId);
  }
  return pointer as unknown as WikiCurrentPointer;
}

async function readCurrentPointer(currentPath: string): Promise<WikiCurrentPointer | null> {
  try {
    return parseCurrentPointer(JSON.parse(await fs.readFile(currentPath, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Cannot read wiki current pointer: ${(error as Error).message}`);
  }
}

function referencedArtifacts(manifest: OutputManifest): Array<{ file: string; hash: string }> {
  return [
    { file: manifest.entry.file, hash: manifest.entry.contentHash },
    ...manifest.pages.map((page) => ({ file: page.file, hash: page.contentHash })),
    ...(manifest.aggregate
      ? [{ file: manifest.aggregate.file, hash: manifest.aggregate.contentHash }]
      : []),
    { file: manifest.coverage.file, hash: manifest.coverage.contentHash },
    ...(manifest.supportingArtifacts ?? []).map((artifact) => ({
      file: artifact.file,
      hash: artifact.contentHash,
    })),
  ];
}

export class WikiPublisher {
  constructor(private readonly hooks: PublisherHooks = {}) {}

  async publish(input: PublishWikiGenerationInput): Promise<PublishWikiGenerationResult> {
    validateOutputManifest(input.manifest);
    validateGenerationId(input.manifest.generationId);
    for (const file of Object.keys(input.files)) validateFileName(file);
    for (const file of input.mirrorFiles ?? []) validateFileName(file);

    const referenced = referencedArtifacts(input.manifest);
    for (const artifact of referenced) {
      const content = input.files[artifact.file];
      if (content === undefined) throw new Error(`Wiki publication is missing ${artifact.file}`);
      if (hashOutputContent(content) !== artifact.hash) {
        throw new Error(`Wiki publication hash mismatch: ${artifact.file}`);
      }
    }
    for (const file of input.mirrorFiles ?? []) {
      if (input.files[file] === undefined) {
        throw new Error(`Wiki mirror file is missing from publication: ${file}`);
      }
    }

    const stateDir = path.join(input.wikiDir, '.state');
    const stagingRoot = path.join(input.wikiDir, '.staging');
    const generationsRoot = path.join(input.wikiDir, '.generations');
    const stagingDir = path.join(stagingRoot, input.manifest.generationId);
    const generationDir = path.join(generationsRoot, input.manifest.generationId);
    const currentPath = path.join(stateDir, 'current.json');
    const lockPath = path.join(stateDir, 'generation.lock');
    await Promise.all([
      fs.mkdir(stateDir, { recursive: true }),
      fs.mkdir(stagingRoot, { recursive: true }),
      fs.mkdir(generationsRoot, { recursive: true }),
    ]);

    let lock: FileHandle | undefined;
    let promoted = false;
    let committed = false;
    try {
      try {
        lock = await fs.open(lockPath, 'wx', 0o600);
        await lock.writeFile(
          `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new Error('Wiki generation is locked by another publisher');
        }
        throw error;
      }

      const previous = await readCurrentPointer(currentPath);
      await fs.rm(stagingDir, { recursive: true, force: true });
      await fs.mkdir(stagingDir);
      for (const [file, content] of Object.entries(input.files).sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        await writeFileAtomic(path.join(stagingDir, file), content);
      }
      const manifestJson = `${JSON.stringify(input.manifest, null, 2)}\n`;
      await writeFileAtomic(path.join(stagingDir, 'manifest.json'), manifestJson);

      for (const artifact of referenced) {
        const content = await fs.readFile(path.join(stagingDir, artifact.file), 'utf8');
        if (hashOutputContent(content) !== artifact.hash) {
          throw new Error(`Staged wiki artifact hash mismatch: ${artifact.file}`);
        }
      }

      let reuseExisting = false;
      try {
        const existingManifest = await fs.readFile(
          path.join(generationDir, 'manifest.json'),
          'utf8',
        );
        if (existingManifest !== manifestJson) {
          throw new Error(`Wiki generation identity collision: ${input.manifest.generationId}`);
        }
        for (const [file, content] of Object.entries(input.files)) {
          if ((await fs.readFile(path.join(generationDir, file), 'utf8')) !== content) {
            throw new Error(`Wiki generation identity collision: ${input.manifest.generationId}`);
          }
        }
        reuseExisting = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (reuseExisting) {
        await fs.rm(stagingDir, { recursive: true, force: true });
      } else {
        await retryRename(stagingDir, generationDir);
        promoted = true;
      }

      await this.hooks.beforeCurrentWrite?.();
      const current: WikiCurrentPointer = {
        schemaVersion: WIKI_CURRENT_POINTER_SCHEMA_VERSION,
        generationId: input.manifest.generationId,
        manifestFile: 'manifest.json',
        manifestHash: hashOutputContent(manifestJson),
        publishedAt: new Date().toISOString(),
        ...(previous && previous.generationId !== input.manifest.generationId
          ? { previousGenerationId: previous.generationId }
          : previous?.previousGenerationId
            ? { previousGenerationId: previous.previousGenerationId }
            : {}),
      };
      await writeFileAtomic(currentPath, `${JSON.stringify(current, null, 2)}\n`);
      committed = true;

      const mirrorFailures: string[] = [];
      for (const file of input.mirrorFiles ?? []) {
        try {
          await this.hooks.beforeMirrorWrite?.(file);
          await writeFileAtomic(path.join(input.wikiDir, file), input.files[file]);
        } catch {
          mirrorFailures.push(file);
        }
      }
      return { current, generationDir, mirrorFailures };
    } finally {
      if (!committed && promoted) {
        await fs.rm(generationDir, { recursive: true, force: true }).catch(() => {});
      }
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
      if (lock) {
        await lock.close().catch(() => {});
        await fs.unlink(lockPath).catch(() => {});
      }
    }
  }
}
