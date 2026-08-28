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

/**
 * 检查路径是否为符号链接，如果是则抛出错误。
 * 防止攻击者通过预置 symlink 逃逸 wiki 目录。
 */
async function rejectSymlink(target: string, label: string): Promise<void> {
  let stats: import('node:fs').Stats;
  try {
    stats = await fs.lstat(target);
  } catch {
    return; // 路径不存在，不是 symlink，无需处理
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`Wiki publication ${label} must not be a symbolic link: ${target}`);
  }
}

/** 陈旧锁判定阈值：超过此时间未释放的锁视为陈旧（1 小时） */
const STALE_LOCK_TTL_MS = 3600_000;

/**
 * 检测指定 PID 的进程是否仍在运行。
 * 使用 signal 0（不实际发送信号）检测进程存在性。
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ESRCH: 进程不存在 → false
    // EPERM: 进程存在但无权限（Windows 行为）→ true
    // 其他异常 → 保守处理为存活，不强制接管
    return code !== 'ESRCH';
  }
}

/**
 * 尝试检测并清理陈旧的锁文件。
 * 读取锁文件中的 PID 和创建时间，判断持有进程是否已退出或锁已过期。
 * 返回 true 表示陈旧锁已被清理、可重试获取；false 表示锁仍被活跃进程持有。
 */
async function tryBreakStaleLock(lockPath: string): Promise<boolean> {
  let content: string;
  try {
    content = await fs.readFile(lockPath, 'utf8');
  } catch {
    return false; // 锁文件已被删除
  }

  let parsed: { pid?: unknown; startedAt?: unknown };
  try {
    parsed = JSON.parse(content.trim());
  } catch {
    // 锁文件格式损坏，视为陈旧
    await fs.unlink(lockPath).catch(() => {});
    return true;
  }

  const pid = typeof parsed.pid === 'number' ? parsed.pid : 0;
  const startedAt = typeof parsed.startedAt === 'string' ? Date.parse(parsed.startedAt) : NaN;

  // PID 不存在 → 陈旧
  if (pid > 0 && !isProcessAlive(pid)) {
    await fs.unlink(lockPath).catch(() => {});
    return true;
  }

  // 锁存在时间超过 TTL → 陈旧
  if (!Number.isNaN(startedAt) && Date.now() - startedAt > STALE_LOCK_TTL_MS) {
    await fs.unlink(lockPath).catch(() => {});
    return true;
  }

  return false;
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

    // 规范化 wikiDir，解析所有符号链接得到真实绝对路径
    const canonicalRoot = await fs.realpath(input.wikiDir);

    const stateDir = path.join(canonicalRoot, '.state');
    const stagingRoot = path.join(canonicalRoot, '.staging');
    const generationsRoot = path.join(canonicalRoot, '.generations');
    const stagingDir = path.join(stagingRoot, input.manifest.generationId);
    const generationDir = path.join(generationsRoot, input.manifest.generationId);
    const currentPath = path.join(stateDir, 'current.json');
    const lockPath = path.join(stateDir, 'generation.lock');
    await Promise.all([
      fs.mkdir(stateDir, { recursive: true }),
      fs.mkdir(stagingRoot, { recursive: true }),
      fs.mkdir(generationsRoot, { recursive: true }),
    ]);

    // 拒绝已被替换为符号链接的路径组件（防止 TOCTOU 竞争）
    await rejectSymlink(stateDir, 'state directory');
    await rejectSymlink(stagingRoot, 'staging root');
    await rejectSymlink(generationsRoot, 'generations root');

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
          // 尝试检测并清理陈旧锁（进程崩溃后遗留的锁）
          const broke = await tryBreakStaleLock(lockPath);
          if (!broke) {
            throw new Error('Wiki generation is locked by another publisher');
          }
          // 陈旧锁已清理，重试获取
          lock = await fs.open(lockPath, 'wx', 0o600);
          await lock.writeFile(
            `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
          );
        } else {
          throw error;
        }
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
