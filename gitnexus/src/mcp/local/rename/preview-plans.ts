import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  getLanguageFromFilename,
  RenameFailure,
  type GraphNode,
  type RenamePlan,
  type RenameSymbol,
} from 'gitnexus-shared';
import { walkRepositoryPaths } from '../../../core/ingestion/filesystem-walker.js';
import {
  getProviderForFile,
  needsContentLanguageClassification,
} from '../../../core/ingestion/languages/index.js';

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_PLANS = 16;
const LIFETIME_MS = 15 * 60 * 1000;

interface Preview {
  root: string;
  plan: RetainedRenamePlan;
  graph: string;
  sources: string[];
  versions: Map<string, RenameSourceVersion>;
  expires: number;
  bytes: number;
}

export interface RenameSourceVersion {
  real: string;
  hash: string;
}
export interface RetainedRenamePlan extends RenamePlan {
  /** Evidence-only sources retain hashes and targets rather than full source text. */
  evidence: ReadonlyMap<string, RenameSourceVersion>;
}

function symbolIdentity(symbol: RenameSymbol): string {
  return JSON.stringify([
    symbol.uid,
    symbol.name,
    symbol.kind,
    symbol.filePath,
    symbol.startLine,
    symbol.endLine,
  ]);
}

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Hash every byte with bounded memory, including sources above the index size limit. */
export async function readRenameSourceVersion(file: string): Promise<RenameSourceVersion> {
  const real = await fs.realpath(file);
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(file, { highWaterMark: 64 * 1024 }))
    digest.update(chunk);
  return { real, hash: digest.digest('hex') };
}

/** Include untracked and oversized sources; a size filter must not hide new targets. */
export async function renameSourceInventory(root: string): Promise<string[]> {
  let sources: string[] = [];
  await walkRepositoryPaths(root, undefined, {
    quiet: true,
    onPathsDiscovered: async (files) => {
      sources = files
        .filter(
          (file) =>
            getLanguageFromFilename(file) ||
            getProviderForFile(file) ||
            needsContentLanguageClassification(file),
        )
        .sort();
    },
  });
  return sources;
}

function graphVersion(nodes: readonly GraphNode[], references: readonly string[]): string {
  const digest = createHash('sha256');
  for (const node of [...nodes].sort((a, b) => a.id.localeCompare(b.id))) {
    const p = node.properties;
    digest.update(
      JSON.stringify([node.id, node.label, p.name, p.filePath, p.startLine, p.endLine]),
    );
  }
  digest.update(JSON.stringify([...references].sort()));
  return digest.digest('hex');
}

/** Process-local capabilities: no caller-provided edit payload is ever trusted. */
export class RenamePreviewPlans {
  private readonly plans = new Map<string, Preview>();
  private bytes = 0;

  private remove(token: string): void {
    const preview = this.plans.get(token);
    if (preview) this.bytes -= preview.bytes;
    this.plans.delete(token);
  }

  async remember(
    root: string,
    plan: RenamePlan,
    nodes: readonly GraphNode[],
    references: readonly string[],
    sources: string[],
  ): Promise<string> {
    const editedPaths = new Set(plan.edits.map((edit) => path.resolve(root, edit.file_path)));
    const unindexedPaths = sources
      .map((file) => path.resolve(root, file))
      .filter((file) => !plan.snapshots.has(file));
    let bytes = 512 + JSON.stringify([plan.symbol, plan.coverage]).length * 2;
    for (const [file, source] of plan.snapshots)
      bytes += file.length * 4 + 512 + (editedPaths.has(file) ? source.length * 2 : 0);
    for (const edit of plan.edits) bytes += JSON.stringify(edit).length * 2 + 64;
    for (const source of sources) bytes += source.length * 2 + 32;
    for (const file of unindexedPaths) bytes += file.length * 4 + 512;
    if (bytes > MAX_BYTES)
      throw new RenameFailure(
        'plan_too_large',
        'The preview exceeds the retained-plan memory budget. Narrow the indexed repository before retrying.',
      );
    const immutable: RetainedRenamePlan = {
      ...structuredClone({
        ...plan,
        snapshots: new Map([...plan.snapshots].filter(([file]) => editedPaths.has(file))),
      }),
      evidence: new Map(),
    };
    const versions = new Map<string, RenameSourceVersion>();
    const evidence = new Map<string, RenameSourceVersion>();
    for (const [file, source] of plan.snapshots)
      versions.set(file, { real: await fs.realpath(file), hash: hash(source) });
    // An existing unindexed source can gain a reference without changing the
    // inventory paths. Bind its contents and target without replanning its edits.
    for (const file of unindexedPaths) versions.set(file, await readRenameSourceVersion(file));
    for (const [file, version] of versions) if (!editedPaths.has(file)) evidence.set(file, version);
    immutable.evidence = evidence;
    const token = randomBytes(32).toString('hex');
    const canonicalRoot = await fs.realpath(root);
    const graph = graphVersion(nodes, references);
    // Evict immediately before insertion, without yielding: concurrent previews
    // must share the same count and retained-memory budget.
    for (const [existing, preview] of this.plans)
      if (preview.expires <= Date.now()) this.remove(existing);
    while (this.plans.size >= MAX_PLANS || this.bytes + bytes > MAX_BYTES)
      this.remove(this.plans.keys().next().value!);
    this.plans.set(token, {
      root: canonicalRoot,
      plan: immutable,
      graph,
      sources: [...sources],
      versions,
      expires: Date.now() + LIFETIME_MS,
      bytes,
    });
    this.bytes += bytes;
    return token;
  }

  async take(
    token: string,
    root: string,
    symbol: RenameSymbol,
    newName: string,
    nodes: readonly GraphNode[],
    references: readonly string[],
  ): Promise<RetainedRenamePlan> {
    const preview = this.plans.get(token);
    if (!preview || preview.expires <= Date.now()) {
      this.remove(token);
      throw new RenameFailure(
        'invalid_plan',
        'The rename preview expired, was consumed or evicted, or belongs to another server. Request and review a fresh preview.',
      );
    }
    // Reserve synchronously: concurrent apply calls must never share a capability.
    this.remove(token);
    if (
      preview.root !== (await fs.realpath(root)) ||
      symbolIdentity(preview.plan.symbol) !== symbolIdentity(symbol) ||
      preview.plan.new_name !== newName
    )
      throw new RenameFailure(
        'plan_mismatch',
        'The repository, target, and new name must match the reviewed preview.',
      );
    if (preview.graph !== graphVersion(nodes, references))
      throw new RenameFailure(
        'stale_graph',
        'The indexed target set changed after preview. Review a fresh preview.',
      );
    if (JSON.stringify(preview.sources) !== JSON.stringify(await renameSourceInventory(root)))
      throw new RenameFailure(
        'source_set_changed',
        'The repository source-file set changed after preview, including untracked files. Re-analyze and review a fresh preview.',
      );
    for (const [file, version] of preview.versions) {
      try {
        const current = await readRenameSourceVersion(file);
        if (current.real === version.real && current.hash === version.hash) continue;
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
          throw error;
      }
      throw new RenameFailure(
        'source_changed',
        `Source contents or target changed after preview: ${path.relative(root, file)}. Review a fresh preview.`,
      );
    }
    return preview.plan;
  }
}
