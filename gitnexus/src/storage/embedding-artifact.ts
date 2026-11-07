/** Directly keyed ownership of one pending artifact per compatible input space.
 * Caller holds the ordinary index lock. No model, native pool or history scan. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  createEmbeddingJobDirectories,
  embeddingJobDirectory,
  readEmbeddingJobRecord,
  writeEmbeddingJobRecord,
  syncEmbeddingJobDirectory,
} from './embedding-job.js';

export interface EmbeddingArtifactSpace {
  vectorIdentity: string;
  inputIdentity: string;
  dimensions: number;
  schema: string;
}

export interface EmbeddingArtifactOwner {
  artifactIdentity: string;
  jobIdentity: string;
  graphGeneration: string;
  sourceIdentity: string;
  manifestDigest: string;
  phase: 'pending' | 'sealed';
  revalidateInputs: boolean;
  /** At most one completed, read-only source for bounded group reuse. */
  fallbackArtifact?: string;
  /** Alternative sole read-only fallback during first legacy migration. */
  fallbackLegacy?: string;
}

export interface EmbeddingArtifactRecord {
  version: 1;
  spaceKey: string;
  space: EmbeddingArtifactSpace;
  owner: EmbeddingArtifactOwner;
}

/** Read every model space before reclamation. An interrupted ownership change
 * retains both sides; malformed/unreadable receipts abort the entire sweep. */
export async function readEmbeddingArtifactOwners(root: string): Promise<EmbeddingArtifactOwner[]> {
  const parent = path.join(root, 'embeddings', 'spaces');
  try {
    await fs.lstat(parent);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  await embeddingJobDirectory(path.dirname(parent));
  await embeddingJobDirectory(parent);
  const owners: EmbeddingArtifactOwner[] = [];
  for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
    if (!DIGEST.test(entry.name))
      throw new Error('Unexpected embedding space entry; artifacts retained');
    const directory = await embeddingJobDirectory(path.join(parent, entry.name));
    const add = (value: unknown) => {
      const raw = value as EmbeddingArtifactRecord;
      const validated = record(raw, raw?.space);
      if (validated.spaceKey !== entry.name) throw new Error('Embedding space directory mismatch');
      owners.push(validated.owner);
    };
    const current = await optionalRecord(directory, 'space.json');
    if (current !== null) add(current);
    const intent = (await optionalRecord(directory, 'rebase.json')) as {
      version: number;
      before: unknown;
      after: unknown;
    } | null;
    if (intent !== null) {
      if (intent.version !== 1 || intent.before === undefined || !intent.after)
        throw new Error('Invalid embedding rebase intent; artifacts retained');
      if (intent.before !== null) add(intent.before);
      add(intent.after);
    }
    if (current === null && intent === null && (await fs.readdir(directory)).length)
      throw new Error('Embedding space has no ownership receipt');
  }
  return owners;
}

type ValidateOwner = (owner: EmbeddingArtifactOwner) => Promise<void>;
const DIGEST = /^[a-f0-9]{64}$/;

export function embeddingArtifactSpaceKey(space: EmbeddingArtifactSpace): string {
  if (
    !DIGEST.test(space.vectorIdentity) ||
    !DIGEST.test(space.inputIdentity) ||
    !Number.isSafeInteger(space.dimensions) ||
    space.dimensions < 1 ||
    typeof space.schema !== 'string' ||
    !space.schema.length ||
    space.schema.length > 256
  )
    throw new Error('Invalid embedding artifact space');
  return createHash('sha256')
    .update(
      JSON.stringify([
        1,
        space.vectorIdentity,
        space.inputIdentity,
        space.dimensions,
        space.schema,
      ]),
    )
    .digest('hex');
}

function ownerRecord(value: unknown): EmbeddingArtifactOwner {
  const owner = value as EmbeddingArtifactOwner;
  if (
    !owner ||
    typeof owner !== 'object' ||
    !DIGEST.test(owner.artifactIdentity) ||
    !DIGEST.test(owner.jobIdentity) ||
    !DIGEST.test(owner.sourceIdentity) ||
    !DIGEST.test(owner.manifestDigest) ||
    !/^[a-f0-9]{32}$/.test(owner.graphGeneration) ||
    !['pending', 'sealed'].includes(owner.phase) ||
    typeof owner.revalidateInputs !== 'boolean' ||
    (owner.fallbackArtifact !== undefined &&
      (!DIGEST.test(owner.fallbackArtifact) ||
        owner.fallbackArtifact === owner.artifactIdentity)) ||
    (owner.fallbackLegacy !== undefined &&
      (!DIGEST.test(owner.fallbackLegacy) || owner.fallbackArtifact !== undefined))
  )
    throw new Error('Invalid embedding artifact ownership; artifacts retained');
  return {
    artifactIdentity: owner.artifactIdentity,
    jobIdentity: owner.jobIdentity,
    graphGeneration: owner.graphGeneration,
    sourceIdentity: owner.sourceIdentity,
    manifestDigest: owner.manifestDigest,
    phase: owner.phase,
    revalidateInputs: owner.revalidateInputs,
    ...(owner.fallbackArtifact === undefined ? {} : { fallbackArtifact: owner.fallbackArtifact }),
    ...(owner.fallbackLegacy === undefined ? {} : { fallbackLegacy: owner.fallbackLegacy }),
  };
}

function record(value: unknown, space: EmbeddingArtifactSpace): EmbeddingArtifactRecord {
  const input = value as EmbeddingArtifactRecord;
  const spaceKey = embeddingArtifactSpaceKey(space);
  if (
    !input ||
    input.version !== 1 ||
    input.spaceKey !== spaceKey ||
    !input.space ||
    embeddingArtifactSpaceKey(input.space) !== spaceKey
  )
    throw new Error('Embedding artifact space mismatch; artifacts retained');
  return {
    version: 1,
    spaceKey,
    space: {
      vectorIdentity: space.vectorIdentity,
      inputIdentity: space.inputIdentity,
      dimensions: space.dimensions,
      schema: space.schema,
    },
    owner: ownerRecord(input.owner),
  };
}

async function spaceDirectory(
  root: string,
  space: EmbeddingArtifactSpace,
  create = true,
): Promise<string> {
  let directory = await embeddingJobDirectory(root);
  const parts = ['embeddings', 'spaces', embeddingArtifactSpaceKey(space)];
  if (create) return createEmbeddingJobDirectories(directory, parts);
  for (const part of parts) directory = await embeddingJobDirectory(path.join(directory, part));
  return directory;
}

async function optionalRecord(directory: string, name: string): Promise<unknown | null> {
  try {
    return await readEmbeddingJobRecord(directory, name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

const same = (a: EmbeddingArtifactRecord | null, b: EmbeddingArtifactRecord | null): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

function validateTransition(
  before: EmbeddingArtifactRecord | null,
  after: EmbeddingArtifactRecord,
): void {
  if (!before) return;
  const a = before.owner,
    b = after.owner;
  if (a.artifactIdentity !== b.artifactIdentity) {
    if (
      a.phase !== 'sealed' ||
      b.phase !== 'pending' ||
      b.fallbackArtifact !== a.artifactIdentity ||
      b.fallbackLegacy !== undefined ||
      b.artifactIdentity === a.fallbackArtifact
    )
      throw new Error('Pending paid artifacts must be retained until sealed');
    return;
  }
  if (a.jobIdentity !== b.jobIdentity) {
    if (
      a.phase !== 'pending' ||
      b.phase !== 'pending' ||
      !b.revalidateInputs ||
      a.fallbackArtifact !== b.fallbackArtifact ||
      a.fallbackLegacy !== b.fallbackLegacy
    )
      throw new Error(
        'Rebased artifact requires current-input validation and its retained fallback',
      );
    return;
  }
  if (
    a.graphGeneration !== b.graphGeneration ||
    a.sourceIdentity !== b.sourceIdentity ||
    a.manifestDigest !== b.manifestDigest ||
    (a.phase === 'sealed' && b.phase !== 'sealed') ||
    (b.phase === 'pending' && a.fallbackLegacy !== b.fallbackLegacy) ||
    (a.revalidateInputs && !b.revalidateInputs)
  )
    throw new Error('Embedding artifact job identity or sealed state changed');
}

async function finishIntent(directory: string): Promise<void> {
  await fs.unlink(path.join(directory, 'rebase.json'));
  await syncEmbeddingJobDirectory(directory);
}

/** A lagging metadata job pointer is reconciled by the controller BEFORE it
 * opens this artifact for paid work. The owned receipt names the sole writer.
 * Recovery completes only the exact before/after transition, never guessing
 * from an old journal cursor or choosing an artifact by directory enumeration. */
export async function readEmbeddingArtifactSpace(
  root: string,
  space: EmbeddingArtifactSpace,
  validateOwner: ValidateOwner,
): Promise<EmbeddingArtifactRecord | null> {
  let directory: string;
  try {
    directory = await spaceDirectory(root, space, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  const currentRaw = await optionalRecord(directory, 'space.json');
  let current = currentRaw === null ? null : record(currentRaw, space);
  const intent = (await optionalRecord(directory, 'rebase.json')) as {
    version?: unknown;
    before?: unknown;
    after?: unknown;
  } | null;
  if (intent !== null) {
    if (intent.version !== 1 || intent.before === undefined || !intent.after)
      throw new Error('Invalid embedding rebase intent; artifacts retained');
    const before = intent.before === null ? null : record(intent.before, space);
    const after = record(intent.after, space);
    validateTransition(before, after);
    if (!same(current, before) && !same(current, after))
      throw new Error('Embedding artifact owner superseded its rebase intent; artifacts retained');
    await validateOwner(after.owner);
    if (!same(current, after)) await writeEmbeddingJobRecord(directory, 'space.json', after);
    await finishIntent(directory);
    current = after;
  }
  if (current) await validateOwner(current.owner);
  return current;
}

/** Manifest creation precedes this durable intent; journal recovery and native
 * mutation follow it. A crash at either rename can be replayed by read above. */
export async function adoptEmbeddingArtifact(
  root: string,
  space: EmbeddingArtifactSpace,
  previous: EmbeddingArtifactRecord | null,
  owner: EmbeddingArtifactOwner,
  validateOwner: ValidateOwner,
): Promise<EmbeddingArtifactRecord> {
  const directory = await spaceDirectory(root, space);
  const before = previous === null ? null : record(previous, space);
  const after = record(
    { version: 1, spaceKey: embeddingArtifactSpaceKey(space), space, owner },
    space,
  );
  const currentRaw = await optionalRecord(directory, 'space.json');
  const current = currentRaw === null ? null : record(currentRaw, space);
  if (!same(current, before) || (await optionalRecord(directory, 'rebase.json')) !== null)
    throw new Error('Embedding artifact ownership changed; recover before adoption');
  validateTransition(before, after);
  await validateOwner(after.owner);
  if (same(before, after)) return after;
  await writeEmbeddingJobRecord(directory, 'rebase.json', { version: 1, before, after });
  await writeEmbeddingJobRecord(directory, 'space.json', after);
  await finishIntent(directory);
  return after;
}
