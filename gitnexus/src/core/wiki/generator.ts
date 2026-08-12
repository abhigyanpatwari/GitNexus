/**
 * Wiki Generator
 *
 * Orchestrates the full wiki generation pipeline:
 *   Phase 0: Validate prerequisites + gather graph structure
 *   Phase 1: Build module tree (one LLM call)
 *   Phase 2: Generate module pages (one LLM call per module, bottom-up)
 *   Phase 3: Generate overview page
 *
 * Supports incremental updates via git diff + module-file mapping.
 */

import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'node:crypto';
import { execSync, execFileSync } from 'child_process';

import {
  initWikiDb,
  closeWikiDb,
  touchWikiDb,
  pinWikiDb,
  getFilesWithExports,
  getAllFiles,
  getIntraModuleCallEdges,
  getInterModuleCallEdges,
  getProcessesForFiles,
  getAllProcesses,
  getInterModuleEdgesForOverview,
  type FileWithExports,
} from './graph-queries.js';
import { generateHTMLViewer } from './html-viewer.js';
import { sanitizeMermaidMarkdown } from './mermaid-sanitizer.js';

import {
  callLLM,
  estimateTokens,
  type LLMConfig,
  type CallLLMOptions,
  type LLMResponse,
} from './llm-client.js';

import { callCursorLLM, resolveCursorConfig } from './cursor-client.js';
import {
  callClaudeLLM,
  callCodexLLM,
  callOpenCodeLLM,
  resolveLocalCLIConfig,
} from './local-cli-client.js';

import {
  GROUPING_SYSTEM_PROMPT,
  GROUPING_USER_PROMPT,
  fillTemplate,
  formatFileListForGrouping,
  formatDirectoryTree,
  formatCallEdges,
  formatProcesses,
} from './prompts.js';

import { shouldIgnorePath } from '../../config/ignore-service.js';
import { resolveLanguage } from './profiles/locale.js';
import { resolveTemplateProfile } from './profiles/registry.js';
import type {
  EvidenceKind,
  PromptSpec,
  RegisteredTemplateProfile,
  ResolvedLanguage,
  SectionSpec,
} from './profiles/types.js';
import { EvidenceCollector, EVIDENCE_COLLECTOR_VERSION } from './document/evidence-collector.js';
import type { EvidenceBundle, EvidenceRef } from './document/evidence.js';
import { SectionWriter, SECTION_WRITER_VERSION } from './document/section-writer.js';
import { assembleSectionPage } from './document/assembler.js';
import {
  createOutputManifest,
  hashOutputContent,
  validateOutputManifest,
  type ManifestPageInput,
} from './document/output-manifest.js';
import { WikiPublisher } from './document/publisher.js';
import {
  createDocumentPlan,
  evidenceKindsForRequirement,
  flattenSections,
  type DocumentPlan,
} from './document/planner.js';
import { MARKDOWN_RENDERER_VERSION, renderDocumentPlan } from './document/markdown-renderer.js';
import { validateProfileCoverage, validateReviewedDocumentPlan } from './document/validator.js';

// ─── Types ────────────────────────────────────────────────────────────

export interface WikiOptions {
  force?: boolean;
  maxTokensPerModule?: number;
  concurrency?: number;
  /** If true, stop after building module tree for user review */
  reviewOnly?: boolean;
  /** Output language for generated documentation (e.g. 'english', 'chinese', 'spanish') */
  lang?: string;
  /** 预解析的文档 Profile，CLI 在任何图谱或 LLM 工作前完成解析。 */
  profile?: RegisteredTemplateProfile;
  /** 为所选 Profile 预解析的确定性展示区域设置。 */
  language?: ResolvedLanguage;
}

export interface WikiMeta {
  schemaVersion?: 2;
  fromCommit: string;
  generatedAt: string;
  model: string;
  lang?: string;
  moduleFiles: Record<string, string[]>;
  moduleTree: ModuleTreeNode[];
  profile?: {
    id: string;
    revision: number;
    fingerprint: string;
  };
  generation?: {
    generationId: string;
    provider: string;
    model: string;
    requestedLanguage: string;
    resolvedLocale: 'en' | 'zh-CN';
    localeFallback?: { from: string; to: 'en' };
    localeFingerprint: string;
    localeResolverVersion: number;
    collectorVersion: number;
    writerVersion: number;
    validatorVersion: number;
    rendererVersion: number;
    semanticsKey: string;
    artifactKey: string;
  };
  outputManifest?: unknown;
  evidenceLimitations?: string[];
}

export interface ModuleTreeNode {
  name: string;
  slug: string;
  files: string[];
  children?: ModuleTreeNode[];
}

const RESERVED_WIKI_SLUGS = new Set([
  'overview',
  'coverage',
  'index',
  'meta',
  'manifest',
  'module-tree',
  'first-module-tree',
  'document-plan',
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

function validateModuleFile(file: unknown, label: string): string {
  if (
    typeof file !== 'string' ||
    file.trim() === '' ||
    file.includes('\\') ||
    path.isAbsolute(file) ||
    file.split('/').includes('..') ||
    file !== file.replace(/^\.\//, '') ||
    /[\x00-\x1f\x7f]/.test(file)
  ) {
    throw new Error(`${label} must be a safe repository-relative path`);
  }
  return file;
}

export function validateReviewedModuleTree(
  value: unknown,
  knownFiles?: ReadonlySet<string>,
): ModuleTreeNode[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('Reviewed module tree must be a non-empty array');
  }
  const slugs = new Set<string>();
  const assignedFiles = new Set<string>();
  let nodeCount = 0;

  const validateNodes = (nodes: unknown[], depth: number, label: string): ModuleTreeNode[] => {
    if (depth > 8) throw new Error('Reviewed module tree exceeds the maximum depth');
    return nodes.map((raw, index) => {
      const nodeLabel = `${label}[${index}]`;
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error(`${nodeLabel} must be an object`);
      }
      const object = raw as Record<string, unknown>;
      const unknownKeys = Object.keys(object).filter(
        (key) => !['name', 'slug', 'files', 'children'].includes(key),
      );
      if (unknownKeys.length > 0) {
        throw new Error(`${nodeLabel} contains unknown fields: ${unknownKeys.join(', ')}`);
      }
      nodeCount++;
      if (nodeCount > 10_000) throw new Error('Reviewed module tree contains too many nodes');
      if (
        typeof object.name !== 'string' ||
        object.name.trim() === '' ||
        object.name.length > 200 ||
        /[\x00-\x1f\x7f<>]/.test(object.name)
      ) {
        throw new Error(`${nodeLabel}.name is invalid`);
      }
      if (
        typeof object.slug !== 'string' ||
        !/^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/.test(object.slug) ||
        RESERVED_WIKI_SLUGS.has(object.slug)
      ) {
        throw new Error(`${nodeLabel}.slug is unsafe or reserved`);
      }
      if (slugs.has(object.slug)) throw new Error(`Duplicate module slug: ${object.slug}`);
      slugs.add(object.slug);
      if (!Array.isArray(object.files)) throw new Error(`${nodeLabel}.files must be an array`);
      const files = object.files.map((file, fileIndex) =>
        validateModuleFile(file, `${nodeLabel}.files[${fileIndex}]`),
      );
      for (const file of files) {
        if (knownFiles && !knownFiles.has(file)) {
          throw new Error(`${nodeLabel} references unknown repository file: ${file}`);
        }
        if (assignedFiles.has(file)) throw new Error(`Repository file is assigned twice: ${file}`);
        assignedFiles.add(file);
      }
      let children: ModuleTreeNode[] | undefined;
      if (object.children !== undefined) {
        if (!Array.isArray(object.children) || object.children.length === 0) {
          throw new Error(`${nodeLabel}.children must be a non-empty array when present`);
        }
        if (files.length > 0) {
          throw new Error(`${nodeLabel} cannot own files and children at the same time`);
        }
        children = validateNodes(object.children, depth + 1, `${nodeLabel}.children`);
      }
      return {
        name: object.name,
        slug: object.slug,
        files,
        ...(children ? { children } : {}),
      };
    });
  };

  return validateNodes(value, 1, 'moduleTree');
}

export async function validateReviewedModuleTreePaths(
  repoPath: string,
  tree: readonly ModuleTreeNode[],
): Promise<void> {
  const repositoryRealPath = await fs.realpath(repoPath);
  for (const { node } of (function flatten(nodes: readonly ModuleTreeNode[]): Array<{
    node: ModuleTreeNode;
  }> {
    return nodes.flatMap((node) => [{ node }, ...(node.children ? flatten(node.children) : [])]);
  })(tree)) {
    for (const file of node.files) {
      let fileRealPath: string;
      try {
        fileRealPath = await fs.realpath(path.resolve(repoPath, file));
      } catch (error) {
        throw new Error(
          `Reviewed module tree file cannot be resolved: ${file}: ${(error as Error).message}`,
        );
      }
      const relative = path.relative(repositoryRealPath, fileRealPath);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Reviewed module tree file escapes the repository: ${file}`);
      }
    }
  }
}

export type ProgressCallback = (phase: string, percent: number, detail?: string) => void;

export interface WikiRunResult {
  pagesGenerated: number;
  mode: 'full' | 'incremental' | 'up-to-date';
  failedModules: string[];
  moduleTree?: ModuleTreeNode[];
}

// ─── Constants ────────────────────────────────────────────────────────

const DEFAULT_MAX_TOKENS_PER_MODULE = 30_000;
const GROUPING_TOKEN_BUDGET = 100_000;
const WIKI_DIR = 'wiki';
const COLLECTOR_VERSION = EVIDENCE_COLLECTOR_VERSION;
const WRITER_VERSION = SECTION_WRITER_VERSION;
const VALIDATOR_VERSION = 1;
const RENDERER_VERSION = MARKDOWN_RENDERER_VERSION;

// ─── Generator Class ──────────────────────────────────────────────────

export class WikiGenerator {
  private repoPath: string;
  private storagePath: string;
  private wikiDir: string;
  private lbugPath: string;
  private llmConfig: LLMConfig;
  private maxTokensPerModule: number;
  private concurrency: number;
  private options: WikiOptions;
  private profile: RegisteredTemplateProfile;
  private language: ResolvedLanguage;
  private evidenceBundle: EvidenceBundle | null = null;
  private readonly sectionWriter = new SectionWriter();
  private onProgress: ProgressCallback;
  private failedModules: string[] = [];

  constructor(
    repoPath: string,
    storagePath: string,
    lbugPath: string,
    llmConfig: LLMConfig,
    options: WikiOptions = {},
    onProgress?: ProgressCallback,
  ) {
    this.repoPath = repoPath;
    this.storagePath = storagePath;
    this.wikiDir = path.join(storagePath, WIKI_DIR);
    this.lbugPath = lbugPath;
    this.options = options;
    this.profile = options.profile ?? resolveTemplateProfile('default');
    this.language = options.language ?? resolveLanguage(options.lang, this.profile.profile);
    this.llmConfig = llmConfig;
    this.maxTokensPerModule = options.maxTokensPerModule ?? DEFAULT_MAX_TOKENS_PER_MODULE;
    this.concurrency = options.concurrency ?? 3;
    const progressFn = onProgress || (() => {});
    this.onProgress = (phase, percent, detail) => {
      if (percent > 0) this.lastPercent = percent;
      progressFn(phase, percent, detail);
    };
  }

  private lastPercent = 0;

  /**
   * Create streaming options that report LLM progress to the progress bar.
   *
   * Progress calculation:
   * - If fixedPercent is provided, we show incremental progress within that phase
   *   based on token generation (e.g., grouping at 15% → 15-28%)
   * - If fixedPercent is NOT provided, we only update the label with token count
   *   but keep the current percentage (avoids fluctuation during module generation)
   *
   * Also touches the DB connection periodically to prevent idle timeout.
   */
  private streamOpts(label: string, fixedPercent?: number, percentRange = 10): CallLLMOptions {
    const hasFixedStart = fixedPercent !== undefined;
    const startPercent = fixedPercent ?? this.lastPercent;
    const expectedTokens = 2000;
    let lastTouch = Date.now();

    return {
      onChunk: (chars: number) => {
        const tokens = Math.round(chars / 4);

        if (hasFixedStart) {
          // For fixed phases (like grouping), show incremental progress
          const progress = Math.min(1, tokens / expectedTokens);
          const pct = Math.round(startPercent + progress * percentRange);
          this.onProgress('stream', pct, `${label} (${tokens} tok)`);
        } else {
          // For module generation, only update the label, keep current percent
          this.onProgress('stream', this.lastPercent, `${label} (${tokens} tok)`);
        }

        // Touch DB every 60s to prevent idle timeout during long LLM calls
        const now = Date.now();
        if (now - lastTouch > 60_000) {
          touchWikiDb();
          lastTouch = now;
        }
      },
    };
  }

  /**
   * Return the effective lang string: strip control characters, trim, cap at 50 chars,
   * then validate against a character allowlist. Returns '' if the value is absent or invalid.
   * Used for both prompt construction and meta storage/comparison so they are always in sync.
   */
  private effectiveLang(): string {
    const lang = (this.options.lang ?? '')
      .replace(/[\x00-\x1F\x7F]/g, '')
      .trim()
      .slice(0, 50);
    return /^[a-zA-Z -]+$/.test(lang) ? lang : '';
  }

  /**
   * Append an output-language instruction to a system prompt when --lang is set.
   */
  private buildSystemPrompt(base: string): string {
    const lang = this.effectiveLang();
    if (!lang) return base;
    const titleNote =
      this.profile.profile.id === 'default'
        ? 'Note: page titles (H1 headings) are generated separately and will remain in English.'
        : 'Note: fixed structural titles are resolved separately by the selected Profile and locale.';
    return `${base}\n\nIMPORTANT: Write ALL documentation content in ${lang}. This includes prose, code comments in examples, and diagram labels. ${titleNote}`;
  }

  /**
   * Route LLM call to the appropriate provider.
   */
  private async invokeLLM(
    prompt: string,
    systemPrompt: string,
    options?: CallLLMOptions,
  ): Promise<LLMResponse> {
    if (this.llmConfig.provider === 'cursor') {
      const cursorConfig = resolveCursorConfig({
        model: this.llmConfig.model,
        workingDirectory: this.repoPath,
      });
      return callCursorLLM(prompt, cursorConfig, systemPrompt, options);
    }
    if (
      this.llmConfig.provider === 'claude' ||
      this.llmConfig.provider === 'codex' ||
      this.llmConfig.provider === 'opencode'
    ) {
      const localConfig = resolveLocalCLIConfig({
        model: this.llmConfig.model,
        workingDirectory: this.repoPath,
        requestTimeoutMs: this.llmConfig.requestTimeoutMs,
      });
      if (this.llmConfig.provider === 'claude') {
        return callClaudeLLM(prompt, localConfig, systemPrompt, options);
      }
      if (this.llmConfig.provider === 'codex') {
        return callCodexLLM(prompt, localConfig, systemPrompt, options);
      }
      if (this.llmConfig.provider === 'opencode') {
        return callOpenCodeLLM(prompt, localConfig, systemPrompt, options);
      }
    }
    return callLLM(prompt, this.llmConfig, systemPrompt, options);
  }

  /**
   * Main entry point. Runs the full pipeline or incremental update.
   */
  async run(): Promise<WikiRunResult> {
    await fs.mkdir(this.wikiDir, { recursive: true });

    const existingMeta = await this.loadWikiMeta();
    const currentCommit = this.getCurrentCommit();
    const forceMode = this.options.force;

    if (!forceMode && existingMeta) {
      this.assertCacheCompatibility(existingMeta, currentCommit);
    }

    // 标准文档的 partial generation 需要继续重试失败章节，不能被同 commit 快路径吞掉。
    const retryStandardFailures =
      !forceMode &&
      this.profile.profile.id !== 'default' &&
      existingMeta?.fromCommit === currentCommit &&
      (await this.hasRetryableStandardFailures(existingMeta));

    // Up-to-date check (skip if --force or a standard generation is partial)
    if (!forceMode && existingMeta && existingMeta.fromCommit === currentCommit) {
      if (retryStandardFailures) {
        this.onProgress('retry', 1, 'Retrying failed standard document sections...');
      } else {
        // Still regenerate the HTML viewer in case it's missing
        await this.ensureHTMLViewer();
        return { pagesGenerated: 0, mode: 'up-to-date', failedModules: [] };
      }
    }

    // 强制模式下丢弃所有可编辑或可恢复计划，防止 Profile 或区域设置变更时
    // 静默复用由不同生成语义创建的模块树或文档计划。
    if (forceMode) {
      for (const file of ['first_module_tree.json', 'module_tree.json', 'document_plan.json']) {
        try {
          await fs.unlink(path.join(this.wikiDir, file));
        } catch {}
      }
      // Delete existing module pages so they get regenerated
      const existingFiles = await fs.readdir(this.wikiDir).catch(() => [] as string[]);
      for (const f of existingFiles) {
        if (f.endsWith('.md')) {
          try {
            await fs.unlink(path.join(this.wikiDir, f));
          } catch {}
        }
      }
    }

    // Init graph
    this.onProgress('init', 2, 'Connecting to knowledge graph...');
    const releaseWikiDbPin = pinWikiDb();
    await initWikiDb(this.lbugPath);

    let result: WikiRunResult;
    try {
      if (!forceMode && existingMeta && existingMeta.fromCommit) {
        result = await this.incrementalUpdate(existingMeta, currentCommit);
      } else {
        result = await this.fullGeneration(currentCommit);
      }
    } finally {
      releaseWikiDbPin();
      await closeWikiDb();
    }

    if (this.profile.profile.id === 'default' && !this.options.reviewOnly) {
      await this.publishLegacyGeneration(currentCommit);
    }

    // Always generate the HTML viewer after wiki content changes
    await this.ensureHTMLViewer();

    return result;
  }

  // ─── HTML Viewer ─────────────────────────────────────────────────────

  private async ensureHTMLViewer(): Promise<void> {
    // Only generate if there are markdown pages to bundle
    const dirEntries = await fs.readdir(this.wikiDir).catch(() => [] as string[]);
    const hasMd = dirEntries.some((f) => f.endsWith('.md'));
    if (!hasMd) return;

    this.onProgress('html', 98, 'Building HTML viewer...');
    const repoName = path.basename(this.repoPath);
    await generateHTMLViewer(this.wikiDir, repoName);
  }

  // ─── Full Generation ────────────────────────────────────────────────

  private async fullGeneration(currentCommit: string): Promise<WikiRunResult> {
    let pagesGenerated = 0;

    // Phase 0: Gather structure
    this.onProgress('gather', 5, 'Querying graph for file structure...');
    const filesWithExports = await getFilesWithExports();
    const allFiles = await getAllFiles();

    // Filter to source files only
    const sourceFiles = allFiles.filter((f) => !shouldIgnorePath(f));
    if (sourceFiles.length === 0) {
      throw new Error('No source files found in the knowledge graph. Nothing to document.');
    }

    // Build enriched file list (merge exports into all source files)
    const exportMap = new Map(filesWithExports.map((f) => [f.filePath, f]));
    const enrichedFiles: FileWithExports[] = sourceFiles.map((fp) => {
      return exportMap.get(fp) || { filePath: fp, symbols: [] };
    });

    this.onProgress('gather', 10, `Found ${sourceFiles.length} source files`);

    // Phase 1: Build module tree
    const moduleTree = await this.buildModuleTree(enrichedFiles);
    pagesGenerated = 0;

    // If reviewOnly mode, save tree and stop for user to review/edit
    if (this.options.reviewOnly) {
      await this.saveModuleTree(moduleTree);
      if (this.profile.profile.id !== 'default') {
        await this.collectStructuredEvidence(currentCommit, moduleTree);
        const reviewPlan = createDocumentPlan({
          profile: this.profile,
          language: this.language,
          sourceCommit: currentCommit,
          moduleTree,
          evidence: this.evidenceBundle!,
        });
        await fs.writeFile(
          path.join(this.wikiDir, 'document_plan.json'),
          `${JSON.stringify(reviewPlan, null, 2)}\n`,
          'utf8',
        );
      }
      this.onProgress('review', 30, 'Module tree ready for review');
      const reviewResult: WikiRunResult = {
        pagesGenerated: 0,
        mode: 'full',
        failedModules: [],
        moduleTree,
      };
      return reviewResult;
    }

    await this.collectStructuredEvidence(currentCommit, moduleTree);

    if (this.profile.profile.id !== 'default') {
      return this.generateStandardDocument(currentCommit, moduleTree);
    }

    // Phase 2: Generate module pages (parallel with concurrency limit)
    const totalModules = this.countModules(moduleTree);
    let modulesProcessed = 0;

    const reportProgress = (moduleName?: string) => {
      modulesProcessed++;
      const percent = 30 + Math.round((modulesProcessed / totalModules) * 55);
      const detail = moduleName
        ? `${modulesProcessed}/${totalModules} — ${moduleName}`
        : `${modulesProcessed}/${totalModules} modules`;
      this.onProgress('modules', percent, detail);
    };

    // Flatten tree into layers: leaves first, then parents
    // Leaves can run in parallel; parents must wait for their children
    const { leaves, parents } = this.flattenModuleTree(moduleTree);

    // Process all leaf modules in parallel
    pagesGenerated += await this.runParallel(leaves, async (node) => {
      const pagePath = path.join(this.wikiDir, `${node.slug}.md`);
      if (await this.fileExists(pagePath)) {
        reportProgress(node.name);
        return 0;
      }
      try {
        await this.generateLeafPage(node);
        reportProgress(node.name);
        return 1;
      } catch (err: any) {
        this.failedModules.push(node.name);
        reportProgress(`Failed: ${node.name}`);
        return 0;
      }
    });

    // Process parent modules sequentially (they depend on child docs)
    for (const node of parents) {
      const pagePath = path.join(this.wikiDir, `${node.slug}.md`);
      if (await this.fileExists(pagePath)) {
        reportProgress(node.name);
        continue;
      }
      try {
        await this.generateParentPage(node);
        pagesGenerated++;
        reportProgress(node.name);
      } catch (err: any) {
        this.failedModules.push(node.name);
        reportProgress(`Failed: ${node.name}`);
      }
    }

    // Phase 3: Generate overview
    this.onProgress('overview', 88, 'Generating overview page...');
    await this.generateOverview(moduleTree);
    pagesGenerated++;

    // Save metadata
    this.onProgress('finalize', 95, 'Saving metadata...');
    const moduleFiles = this.extractModuleFiles(moduleTree);
    await this.saveModuleTree(moduleTree);
    await this.saveWikiMeta(this.buildWikiMeta(currentCommit, moduleFiles, moduleTree));

    this.onProgress('done', 100, 'Wiki generation complete');
    return { pagesGenerated, mode: 'full', failedModules: [...this.failedModules] };
  }

  // ─── Phase 1: Build Module Tree ────────────────────────────────────

  private async buildModuleTree(files: FileWithExports[]): Promise<ModuleTreeNode[]> {
    const knownFiles = new Set(files.map((file) => file.filePath));
    // First, check for user-edited module_tree.json (from --review workflow)
    const editablePath = path.join(this.wikiDir, 'module_tree.json');
    try {
      const edited = await fs.readFile(editablePath, 'utf-8');
      const parsed = JSON.parse(edited);
      const validated = validateReviewedModuleTree(parsed, knownFiles);
      await validateReviewedModuleTreePaths(this.repoPath, validated);
      this.onProgress('grouping', 25, 'Using edited module tree');
      return validated;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Invalid reviewed module tree: ${(error as Error).message}`);
      }
      // No edited tree, check for original snapshot
    }

    // Check for existing immutable snapshot (resumability)
    const snapshotPath = path.join(this.wikiDir, 'first_module_tree.json');
    try {
      const existing = await fs.readFile(snapshotPath, 'utf-8');
      const parsed = JSON.parse(existing);
      const validated = validateReviewedModuleTree(parsed, knownFiles);
      await validateReviewedModuleTreePaths(this.repoPath, validated);
      this.onProgress('grouping', 25, 'Using existing module tree (resuming)');
      return validated;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Invalid module tree snapshot: ${(error as Error).message}`);
      }
      // No snapshot, generate new
    }

    this.onProgress('grouping', 15, 'Grouping files into modules (LLM)...');

    const fileList = formatFileListForGrouping(files);
    const dirTree = formatDirectoryTree(files.map((f) => f.filePath));

    const prompt = fillTemplate(GROUPING_USER_PROMPT, {
      FILE_LIST: fileList,
      DIRECTORY_TREE: dirTree,
    });

    const promptTokens = estimateTokens(prompt);
    let grouping: Record<string, string[]>;

    if (promptTokens <= GROUPING_TOKEN_BUDGET) {
      // Grouping is a structured-data phase (JSON output), not documentation.
      // Do NOT apply buildSystemPrompt here — a language instruction would risk
      // translating module-name keys, breaking slug stability and JSON parsing.
      const response = await this.invokeLLM(
        prompt,
        GROUPING_SYSTEM_PROMPT,
        this.streamOpts('Grouping files', 15, 13),
      );
      grouping = this.parseGroupingResponse(response.content, files);
    } else {
      grouping = await this.batchedGrouping(files);
    }

    // Convert to tree nodes
    const tree: ModuleTreeNode[] = [];
    for (const [moduleName, modulePaths] of Object.entries(grouping)) {
      const slug = this.slugify(moduleName);
      const node: ModuleTreeNode = { name: moduleName, slug, files: modulePaths };

      // Token budget check — split if too large
      const totalTokens = await this.estimateModuleTokens(modulePaths);
      if (totalTokens > this.maxTokensPerModule && modulePaths.length > 3) {
        const children = this.splitBySubdirectory(moduleName, modulePaths);
        // Only create hierarchy if we actually got multiple children
        // If splitting results in 1 child, keep files flat (avoid redundant nesting)
        if (children.length > 1) {
          node.children = children;
          node.files = []; // Parent doesn't own files directly when split
        }
        // If only 1 child, keep original flat structure (files stay in node.files)
      }

      tree.push(node);
    }

    const validatedTree = validateReviewedModuleTree(tree, knownFiles);
    // Save immutable snapshot for resumability
    await fs.writeFile(snapshotPath, JSON.stringify(validatedTree, null, 2), 'utf-8');
    this.onProgress('grouping', 28, `Created ${tree.length} modules`);

    return validatedTree;
  }

  /**
   * Run grouping in batches when the full file list exceeds GROUPING_TOKEN_BUDGET.
   */
  private async batchedGrouping(files: FileWithExports[]): Promise<Record<string, string[]>> {
    const batches = this.batchFilesForGrouping(files);
    const partials: Record<string, string[]>[] = [];

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      this.onProgress(
        'grouping',
        15 + Math.round(((i + 1) / batches.length) * 13),
        `Grouping batch ${i + 1}/${batches.length} (LLM)...`,
      );

      const batchFileList = formatFileListForGrouping(batch);
      const batchDirTree = formatDirectoryTree(batch.map((f) => f.filePath));
      const batchPrompt = fillTemplate(GROUPING_USER_PROMPT, {
        FILE_LIST: batchFileList,
        DIRECTORY_TREE: batchDirTree,
      });

      try {
        const batchStart = 15 + Math.round((i / batches.length) * 13);
        const batchRange = Math.max(1, Math.round(13 / batches.length));
        const response = await this.invokeLLM(
          batchPrompt,
          GROUPING_SYSTEM_PROMPT,
          this.streamOpts(`Grouping batch ${i + 1}/${batches.length}`, batchStart, batchRange),
        );
        partials.push(this.parseGroupingResponse(response.content, batch));
      } catch {
        this.onProgress(
          'grouping',
          15,
          `Batch ${i + 1} failed, falling back to directory grouping`,
        );
        return this.fallbackGrouping(files);
      }
    }

    const merged = this.mergeGroupings(partials);

    const assignedFiles = new Set(Object.values(merged).flat());
    const unassigned = files.map((f) => f.filePath).filter((fp) => !assignedFiles.has(fp));
    if (unassigned.length > 0) {
      merged['Other'] = [...(merged['Other'] ?? []), ...unassigned];
    }

    return Object.keys(merged).length > 0 ? merged : this.fallbackGrouping(files);
  }

  /**
   * Partition files into batches that fit within GROUPING_TOKEN_BUDGET.
   * Groups by top-level directory for semantic coherence.
   */
  private batchFilesForGrouping(files: FileWithExports[]): FileWithExports[][] {
    if (files.length === 0) return [];

    const dirGroups = new Map<string, FileWithExports[]>();
    for (const f of files) {
      const parts = f.filePath.replace(/\\/g, '/').split('/');
      const topDir = parts.length > 1 ? parts[0] : 'Root';
      let group = dirGroups.get(topDir);
      if (!group) {
        group = [];
        dirGroups.set(topDir, group);
      }
      group.push(f);
    }

    const batches: FileWithExports[][] = [];
    let currentBatch: FileWithExports[] = [];

    for (const dirFiles of dirGroups.values()) {
      const dirPromptSize = this.estimateGroupingPromptTokens(dirFiles);

      if (dirPromptSize > GROUPING_TOKEN_BUDGET) {
        if (currentBatch.length > 0) {
          batches.push(currentBatch);
          currentBatch = [];
        }
        // Sub-batch this large directory by fixed chunks
        for (let i = 0; i < dirFiles.length; ) {
          const subBatch: FileWithExports[] = [];
          while (i < dirFiles.length) {
            subBatch.push(dirFiles[i]);
            i++;
            if (
              this.estimateGroupingPromptTokens(subBatch) > GROUPING_TOKEN_BUDGET &&
              subBatch.length > 1
            ) {
              subBatch.pop();
              i--;
              break;
            }
          }
          if (
            subBatch.length === 1 &&
            this.estimateGroupingPromptTokens(subBatch) > GROUPING_TOKEN_BUDGET
          ) {
            subBatch[0] = this.trimSymbolsToFit(subBatch[0]);
          }
          batches.push(subBatch);
        }
        continue;
      }

      const candidateBatch = [...currentBatch, ...dirFiles];
      if (this.estimateGroupingPromptTokens(candidateBatch) > GROUPING_TOKEN_BUDGET) {
        if (currentBatch.length > 0) {
          batches.push(currentBatch);
        }
        currentBatch = dirFiles;
      } else {
        currentBatch = candidateBatch;
      }
    }

    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }

    return batches;
  }

  private estimateGroupingPromptTokens(files: FileWithExports[]): number {
    const fileList = formatFileListForGrouping(files);
    const dirTree = formatDirectoryTree(files.map((f) => f.filePath));
    const prompt = fillTemplate(GROUPING_USER_PROMPT, {
      FILE_LIST: fileList,
      DIRECTORY_TREE: dirTree,
    });
    return estimateTokens(prompt);
  }

  private trimSymbolsToFit(file: FileWithExports): FileWithExports {
    const symbols = file.symbols;
    let lo = 0;
    let hi = symbols.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      const candidate: FileWithExports = {
        filePath: file.filePath,
        symbols: [
          ...symbols.slice(0, mid),
          { name: `... and ${symbols.length - mid} more`, type: 'truncated' },
        ],
      };
      if (this.estimateGroupingPromptTokens([candidate]) <= GROUPING_TOKEN_BUDGET) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    if (lo >= symbols.length) return file;
    return {
      filePath: file.filePath,
      symbols:
        lo > 0
          ? [
              ...symbols.slice(0, lo),
              { name: `... and ${symbols.length - lo} more`, type: 'truncated' },
            ]
          : [{ name: 'no exports (truncated)', type: 'truncated' }],
    };
  }

  /**
   * Merge partial groupings from multiple batches. Same module name across
   * batches gets file lists concatenated. Deduplicates (first-seen wins).
   */
  private mergeGroupings(partials: Record<string, string[]>[]): Record<string, string[]> {
    const merged: Record<string, string[]> = {};
    const seen = new Set<string>();
    const slugToCanonical = new Map<string, string>();

    for (const partial of partials) {
      for (const [mod, paths] of Object.entries(partial)) {
        const slug = this.slugify(mod);
        const canonical = slugToCanonical.get(slug) ?? mod;
        if (!slugToCanonical.has(slug)) slugToCanonical.set(slug, mod);

        for (const fp of paths) {
          if (!seen.has(fp)) {
            seen.add(fp);
            if (!merged[canonical]) merged[canonical] = [];
            merged[canonical].push(fp);
          }
        }
      }
    }

    return merged;
  }

  /**
   * Parse LLM grouping response. Validates all files are assigned.
   */
  private parseGroupingResponse(
    content: string,
    files: FileWithExports[],
  ): Record<string, string[]> {
    // Extract JSON from response (handle markdown fences)
    let jsonStr = content.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }

    let parsed: Record<string, string[]>;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      // Fallback: group by top-level directory
      return this.fallbackGrouping(files);
    }

    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      return this.fallbackGrouping(files);
    }

    // Validate — ensure all files are assigned
    const allFilePaths = new Set(files.map((f) => f.filePath));
    const assignedFiles = new Set<string>();
    const validGrouping: Record<string, string[]> = {};

    for (const [mod, paths] of Object.entries(parsed)) {
      if (!Array.isArray(paths)) continue;
      const validPaths = paths.filter((p) => {
        if (allFilePaths.has(p) && !assignedFiles.has(p)) {
          assignedFiles.add(p);
          return true;
        }
        return false;
      });
      if (validPaths.length > 0) {
        validGrouping[mod] = validPaths;
      }
    }

    // Assign unassigned files to a "Miscellaneous" module
    const unassigned = files.map((f) => f.filePath).filter((fp) => !assignedFiles.has(fp));
    if (unassigned.length > 0) {
      validGrouping['Other'] = unassigned;
    }

    return Object.keys(validGrouping).length > 0 ? validGrouping : this.fallbackGrouping(files);
  }

  /**
   * Fallback grouping by top-level directory when LLM parsing fails.
   */
  private fallbackGrouping(files: FileWithExports[]): Record<string, string[]> {
    const groups = new Map<string, string[]>();
    for (const f of files) {
      const parts = f.filePath.replace(/\\/g, '/').split('/');
      const topDir = parts.length > 1 ? parts[0] : 'Root';
      let group = groups.get(topDir);
      if (!group) {
        group = [];
        groups.set(topDir, group);
      }
      group.push(f.filePath);
    }
    return Object.fromEntries(groups);
  }

  /**
   * Split a large module into sub-modules by subdirectory.
   * Uses the full subDir path for naming to avoid slug collisions
   * (e.g., "synapse-screen/src" vs "synapse-core/src").
   */
  private splitBySubdirectory(moduleName: string, files: string[]): ModuleTreeNode[] {
    const subGroups = new Map<string, string[]>();
    for (const fp of files) {
      const parts = fp.replace(/\\/g, '/').split('/');
      const subDir = parts.length > 2 ? parts.slice(0, 2).join('/') : parts[0];
      let group = subGroups.get(subDir);
      if (!group) {
        group = [];
        subGroups.set(subDir, group);
      }
      group.push(fp);
    }

    // Check if basenames are unique; if not, use the full subDir path
    const basenames = Array.from(subGroups.keys()).map((s) => path.basename(s));
    const hasCollisions = new Set(basenames).size < basenames.length;

    return Array.from(subGroups.entries()).map(([subDir, subFiles]) => {
      const label = hasCollisions ? subDir.replace(/\//g, '-') : path.basename(subDir);
      return {
        name: `${moduleName} — ${label}`,
        slug: this.slugify(`${moduleName}-${label}`),
        files: subFiles,
      };
    });
  }

  // ─── Phase 2: Generate Module Pages ─────────────────────────────────

  /**
   * Generate a leaf module page from source code + graph data.
   */
  private async generateLeafPage(node: ModuleTreeNode): Promise<void> {
    const filePaths = node.files;

    // Read source files from disk
    const sourceCode = await this.readSourceFiles(filePaths);

    // Token budget check — if too large, summarize in batches
    const totalTokens = estimateTokens(sourceCode);
    let finalSourceCode = sourceCode;
    if (totalTokens > this.maxTokensPerModule) {
      finalSourceCode = this.truncateSource(sourceCode, this.maxTokensPerModule);
    }

    // Get graph data
    const [intraCalls, interCalls, processes] = await Promise.all([
      getIntraModuleCallEdges(filePaths),
      getInterModuleCallEdges(filePaths),
      getProcessesForFiles(filePaths, 5),
    ]);

    const moduleEvidence = this.evidenceBundle?.modules[node.name];
    const variables = this.variablesForPrompt(this.profile.profile.prompts.module, {
      SECTION_ID: `module-${node.slug}`,
      EVIDENCE_BUNDLE: this.formatEvidenceForPrompt(moduleEvidence),
      MODULE_NAME: node.name,
      SOURCE_CODE: finalSourceCode,
      INTRA_CALLS: formatCallEdges(intraCalls),
      OUTGOING_CALLS: formatCallEdges(interCalls.outgoing),
      INCOMING_CALLS: formatCallEdges(interCalls.incoming),
      PROCESSES: formatProcesses(processes),
    });
    const evidenceIds = moduleEvidence?.map((item) => item.id) ?? [];
    const payload = await this.sectionWriter.write({
      profileId: this.profile.profile.id,
      sectionId: `module-${node.slug}`,
      prompt: this.profile.profile.prompts.module,
      variables,
      evidenceIds,
      invokeLLM: (prompt, systemPrompt, options) => this.invokeLLM(prompt, systemPrompt, options),
      transformSystemPrompt: (systemPrompt) => this.buildSystemPrompt(systemPrompt),
      llmOptions: this.streamOpts(node.name),
    });

    // H1 uses the English module name (stable slug source); body is LLM-translated.
    const pageContent = sanitizeMermaidMarkdown(assembleSectionPage(node.name, payload));
    await fs.writeFile(path.join(this.wikiDir, `${node.slug}.md`), pageContent, 'utf-8');
  }

  /**
   * Generate a parent module page from children's documentation.
   */
  private async generateParentPage(node: ModuleTreeNode): Promise<void> {
    if (!node.children || node.children.length === 0) return;

    // Read children's overview sections
    const childDocs: string[] = [];
    for (const child of node.children) {
      const childPage = path.join(this.wikiDir, `${child.slug}.md`);
      try {
        const content = await fs.readFile(childPage, 'utf-8');
        // Extract overview section (first ~500 chars or up to "### Architecture")
        const overviewEnd = content.indexOf('### Architecture');
        const overview =
          overviewEnd > 0 ? content.slice(0, overviewEnd).trim() : content.slice(0, 800).trim();
        childDocs.push(`#### ${child.name}\n${overview}`);
      } catch {
        childDocs.push(`#### ${child.name}\n(Documentation not yet generated)`);
      }
    }

    // Get cross-child call edges
    const allChildFiles = node.children.flatMap((c) => c.files);
    const crossCalls = await getIntraModuleCallEdges(allChildFiles);
    const processes = await getProcessesForFiles(allChildFiles, 3);

    const moduleEvidence = this.evidenceBundle?.modules[node.name];
    const variables = this.variablesForPrompt(this.profile.profile.prompts.parent, {
      SECTION_ID: `module-${node.slug}`,
      EVIDENCE_BUNDLE: this.formatEvidenceForPrompt(moduleEvidence),
      MODULE_NAME: node.name,
      CHILDREN_DOCS: childDocs.join('\n\n'),
      CROSS_MODULE_CALLS: formatCallEdges(crossCalls),
      CROSS_PROCESSES: formatProcesses(processes),
    });
    const evidenceIds = moduleEvidence?.map((item) => item.id) ?? [];
    const payload = await this.sectionWriter.write({
      profileId: this.profile.profile.id,
      sectionId: `module-${node.slug}`,
      prompt: this.profile.profile.prompts.parent,
      variables,
      evidenceIds,
      invokeLLM: (prompt, systemPrompt, options) => this.invokeLLM(prompt, systemPrompt, options),
      transformSystemPrompt: (systemPrompt) => this.buildSystemPrompt(systemPrompt),
      llmOptions: this.streamOpts(node.name),
    });

    const pageContent = sanitizeMermaidMarkdown(assembleSectionPage(node.name, payload));
    await fs.writeFile(path.join(this.wikiDir, `${node.slug}.md`), pageContent, 'utf-8');
  }

  // ─── Phase 3: Generate Overview ─────────────────────────────────────

  private async generateOverview(moduleTree: ModuleTreeNode[]): Promise<void> {
    // Read module overview sections
    const moduleSummaries: string[] = [];
    for (const node of moduleTree) {
      const pagePath = path.join(this.wikiDir, `${node.slug}.md`);
      try {
        const content = await fs.readFile(pagePath, 'utf-8');
        const overviewEnd = content.indexOf('### Architecture');
        const overview =
          overviewEnd > 0 ? content.slice(0, overviewEnd).trim() : content.slice(0, 600).trim();
        moduleSummaries.push(`#### ${node.name}\n${overview}`);
      } catch {
        moduleSummaries.push(`#### ${node.name}\n(Documentation pending)`);
      }
    }

    // Get inter-module edges for architecture diagram
    const moduleFiles = this.extractModuleFiles(moduleTree);
    const moduleEdges = await getInterModuleEdgesForOverview(moduleFiles);

    // Get top processes for key workflows
    const topProcesses = await getAllProcesses(5);

    // Read project config
    const projectInfo = await this.readProjectInfo();

    const edgesText =
      moduleEdges.length > 0
        ? moduleEdges.map((e) => `${e.from} → ${e.to} (${e.count} calls)`).join('\n')
        : 'No inter-module call edges detected';

    const variables = this.variablesForPrompt(this.profile.profile.prompts.overview, {
      SECTION_ID: 'overview',
      EVIDENCE_BUNDLE: this.formatEvidenceForPrompt(this.evidenceBundle?.repository),
      PROJECT_INFO: projectInfo,
      MODULE_SUMMARIES: moduleSummaries.join('\n\n'),
      MODULE_EDGES: edgesText,
      TOP_PROCESSES: formatProcesses(topProcesses),
    });
    const evidenceIds = this.evidenceBundle?.repository.map((item) => item.id) ?? [];
    const payload = await this.sectionWriter.write({
      profileId: this.profile.profile.id,
      sectionId: 'overview',
      prompt: this.profile.profile.prompts.overview,
      variables,
      evidenceIds,
      invokeLLM: (prompt, systemPrompt, options) => this.invokeLLM(prompt, systemPrompt, options),
      transformSystemPrompt: (systemPrompt) => this.buildSystemPrompt(systemPrompt),
      llmOptions: this.streamOpts('Generating overview', 88),
    });

    const pageContent = sanitizeMermaidMarkdown(
      assembleSectionPage(`${path.basename(this.repoPath)} — Wiki`, payload),
    );
    await fs.writeFile(path.join(this.wikiDir, 'overview.md'), pageContent, 'utf-8');
  }

  // ─── Incremental Updates ────────────────────────────────────────────

  private async incrementalUpdate(
    existingMeta: WikiMeta,
    currentCommit: string,
  ): Promise<WikiRunResult> {
    if (this.profile.profile.id !== 'default') {
      return this.incrementalStandardDocument(existingMeta, currentCommit);
    }
    this.onProgress('incremental', 5, 'Detecting changes...');

    // Get changed files since last generation
    const changedFiles = this.getChangedFiles(existingMeta.fromCommit, currentCommit);

    // If null, commits are on divergent branches (e.g., wiki generated on feature branch,
    // now running on main). Fall back to full generation.
    if (changedFiles === null) {
      this.onProgress('incremental', 10, 'Branch diverged, running full generation...');
      const fullResult = await this.fullGeneration(currentCommit);
      return { ...fullResult, mode: 'incremental' };
    }

    if (changedFiles.length === 0) {
      // No file changes but commit differs (e.g. merge commit)
      await this.saveWikiMeta(
        this.buildWikiMeta(
          currentCommit,
          existingMeta.moduleFiles,
          existingMeta.moduleTree,
          existingMeta,
        ),
      );
      return { pagesGenerated: 0, mode: 'incremental', failedModules: [] };
    }

    this.onProgress('incremental', 10, `${changedFiles.length} files changed`);

    const deletedFiles = new Set<string>();
    for (const file of changedFiles) {
      if (!(await this.fileExists(path.join(this.repoPath, file)))) deletedFiles.add(file);
    }

    // Determine affected modules
    const affectedModules = new Set<string>();
    const newFiles: string[] = [];

    for (const fp of changedFiles) {
      let found = false;
      for (const [mod, files] of Object.entries(existingMeta.moduleFiles)) {
        if (files.includes(fp)) {
          affectedModules.add(mod);
          found = true;
        }
      }
      if (!found && !deletedFiles.has(fp) && !shouldIgnorePath(fp)) {
        newFiles.push(fp);
      }
    }

    const removedSlugs = this.removeDeletedFilesFromTree(existingMeta.moduleTree, deletedFiles);
    for (const slug of removedSlugs) {
      await fs.unlink(path.join(this.wikiDir, `${slug}.md`)).catch(() => {});
    }
    if (existingMeta.moduleTree.length === 0) {
      for (const file of ['first_module_tree.json', 'module_tree.json', 'document_plan.json']) {
        await fs.unlink(path.join(this.wikiDir, file)).catch(() => {});
      }
      const fullResult = await this.fullGeneration(currentCommit);
      return { ...fullResult, mode: 'incremental' };
    }
    existingMeta.moduleFiles = this.extractModuleFiles(existingMeta.moduleTree);

    // If significant new files exist, re-run full grouping
    if (newFiles.length > 5) {
      this.onProgress(
        'incremental',
        15,
        'Significant new files detected, running full generation...',
      );
      // Delete old snapshot to force re-grouping
      try {
        await fs.unlink(path.join(this.wikiDir, 'first_module_tree.json'));
      } catch {}
      const fullResult = await this.fullGeneration(currentCommit);
      return { ...fullResult, mode: 'incremental' };
    }

    // Add new files to nearest module or "Other"
    if (newFiles.length > 0) {
      let otherNode = this.findNodeBySlug(existingMeta.moduleTree, 'other');
      if (!otherNode) {
        otherNode = { name: 'Other', slug: 'other', files: [] };
        existingMeta.moduleTree.push(otherNode);
      }
      otherNode.files = Array.from(new Set([...otherNode.files, ...newFiles])).sort();
      existingMeta.moduleFiles['Other'] = [...otherNode.files];
      affectedModules.add('Other');
    }

    // Regenerate affected module pages (parallel)
    let pagesGenerated = 0;
    const moduleTree = existingMeta.moduleTree;
    const affectedArray = Array.from(affectedModules);

    this.onProgress('incremental', 20, `Regenerating ${affectedArray.length} module(s)...`);

    const affectedNodes: ModuleTreeNode[] = [];
    for (const mod of affectedArray) {
      const modSlug = this.slugify(mod);
      const node = this.findNodeBySlug(moduleTree, modSlug);
      if (node) {
        try {
          await fs.unlink(path.join(this.wikiDir, `${node.slug}.md`));
        } catch {}
        affectedNodes.push(node);
      }
    }

    await this.collectStructuredEvidence(currentCommit, moduleTree);

    let incProcessed = 0;
    const affectedLeaves = affectedNodes.filter(
      (node) => !node.children || node.children.length === 0,
    );
    const affectedParents = affectedNodes.filter(
      (node) => node.children && node.children.length > 0,
    );
    pagesGenerated += await this.runParallel(affectedLeaves, async (node) => {
      try {
        await this.generateLeafPage(node);
        incProcessed++;
        const percent = 20 + Math.round((incProcessed / affectedNodes.length) * 60);
        this.onProgress(
          'incremental',
          percent,
          `${incProcessed}/${affectedNodes.length} — ${node.name}`,
        );
        return 1;
      } catch (err: any) {
        this.failedModules.push(node.name);
        incProcessed++;
        return 0;
      }
    });
    for (const node of affectedParents) {
      try {
        await this.generateParentPage(node);
        pagesGenerated++;
      } catch {
        this.failedModules.push(node.name);
      }
      incProcessed++;
    }

    // Regenerate overview if any pages changed
    if (pagesGenerated > 0 || deletedFiles.size > 0) {
      this.onProgress('incremental', 85, 'Updating overview...');
      await this.generateOverview(moduleTree);
      pagesGenerated++;
    }

    // Save updated metadata
    this.onProgress('incremental', 95, 'Saving metadata...');
    await this.saveModuleTree(moduleTree);
    await this.saveWikiMeta(
      this.buildWikiMeta(
        currentCommit,
        existingMeta.moduleFiles,
        existingMeta.moduleTree,
        existingMeta,
      ),
    );

    this.onProgress('done', 100, 'Incremental update complete');
    return { pagesGenerated, mode: 'incremental', failedModules: [...this.failedModules] };
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  private variablesForPrompt(
    prompt: PromptSpec,
    variables: Record<string, string>,
  ): Record<string, string> {
    return Object.fromEntries(
      Object.entries(variables).filter(([name]) => prompt.allowedVariables.includes(name)),
    );
  }

  private async collectStructuredEvidence(
    sourceCommit: string,
    moduleTree: ModuleTreeNode[],
  ): Promise<void> {
    if (this.profile.profile.id === 'default') {
      this.evidenceBundle = null;
      return;
    }
    const collector = new EvidenceCollector(this.repoPath);
    this.evidenceBundle = await collector.collect({
      sourceCommit,
      moduleFiles: this.extractModuleFiles(moduleTree),
      limitations: [
        'Runtime evidence uses public file, call, and process graph queries; PDG evidence is not collected.',
      ],
    });
  }

  private flattenProfileSections(sections: readonly SectionSpec[]): SectionSpec[] {
    return sections.flatMap((section) => [
      section,
      ...(section.children ? this.flattenProfileSections(section.children) : []),
    ]);
  }

  private allStructuredEvidence(): EvidenceBundle['repository'] {
    if (!this.evidenceBundle) return [];
    const byId = new Map(
      [...this.evidenceBundle.repository, ...Object.values(this.evidenceBundle.modules).flat()].map(
        (item) => [item.id, item],
      ),
    );
    return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
  }

  private evidenceRecordForPrompt(item: EvidenceRef): Record<string, unknown> {
    return {
      id: item.id,
      kind: item.kind,
      status: item.status,
      summary: item.summary,
      ...(item.filePath ? { filePath: item.filePath } : {}),
      ...(item.symbol ? { symbol: item.symbol } : {}),
      ...(item.relation ? { relation: item.relation } : {}),
      ...(item.processId ? { processId: item.processId } : {}),
      ...(item.excerpt ? { excerpt: item.excerpt } : {}),
    };
  }

  private selectEvidenceForSection(
    spec: SectionSpec,
    allEvidence: EvidenceBundle['repository'],
  ): { evidence: EvidenceRef[]; relevantCount: number; truncated: boolean } {
    const requirementKinds = Array.from(
      new Set(spec.evidenceRequirements.map((requirement) => requirement.kind)),
    );
    const buckets =
      requirementKinds.length === 0
        ? [[...allEvidence]]
        : requirementKinds.map((requirementKind) => {
            const acceptedKinds = evidenceKindsForRequirement(requirementKind);
            return allEvidence.filter((item) => acceptedKinds.includes(item.kind));
          });
    const ordered: EvidenceRef[] = [];
    const seen = new Set<string>();
    for (let index = 0; buckets.some((bucket) => index < bucket.length); index++) {
      for (const bucket of buckets) {
        const item = bucket[index];
        if (item && !seen.has(item.id)) {
          seen.add(item.id);
          ordered.push(item);
        }
      }
    }

    // 与旧模块源码预算共用同一配置，按 estimateTokens 的 chars/4 规则保留完整证据项。
    const maxChars = Math.max(2, Math.floor(this.maxTokensPerModule) * 4);
    const selected: EvidenceRef[] = [];
    let usedChars = 2;
    for (const item of ordered) {
      const serializedLength = JSON.stringify(this.evidenceRecordForPrompt(item)).length;
      const separatorLength = selected.length > 0 ? 1 : 0;
      if (usedChars + separatorLength + serializedLength > maxChars) continue;
      selected.push(item);
      usedChars += separatorLength + serializedLength;
    }
    return {
      evidence: selected,
      relevantCount: ordered.length,
      truncated: selected.length < ordered.length,
    };
  }

  private async createOrLoadReviewedPlan(
    currentCommit: string,
    moduleTree: ModuleTreeNode[],
  ): Promise<DocumentPlan> {
    const freshPlan = createDocumentPlan({
      profile: this.profile,
      language: this.language,
      sourceCommit: currentCommit,
      moduleTree,
      evidence: this.evidenceBundle!,
    });
    const reviewPath = path.join(this.wikiDir, 'document_plan.json');
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(reviewPath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return freshPlan;
      throw new Error(`Invalid reviewed DocumentPlan: ${(error as Error).message}`);
    }
    if (
      raw !== null &&
      typeof raw === 'object' &&
      ['generated', 'partial', 'failed'].includes(String((raw as Record<string, unknown>).status))
    ) {
      return freshPlan;
    }
    const knownEvidenceIds = new Set(this.allStructuredEvidence().map((item) => item.id));
    return validateReviewedDocumentPlan(raw, freshPlan, knownEvidenceIds);
  }

  private async writeStandardSections(plan: DocumentPlan): Promise<number> {
    const sections = new Map(
      flattenSections(plan.sections).map((section) => [section.id, section]),
    );
    const specs = new Map(
      this.flattenProfileSections(this.profile.profile.sections).map((section) => [
        section.id,
        section,
      ]),
    );
    const allEvidence = this.allStructuredEvidence();
    let completed = 0;
    let generated = 0;

    for (const sectionId of plan.dependencyOrder) {
      const section = sections.get(sectionId)!;
      if (section.payload.mode === 'structured' && section.payload.blocks.length > 0) {
        completed++;
        continue;
      }
      const spec = specs.get(sectionId)!;
      const prompt = spec.prompt ?? this.profile.profile.prompts.overview;
      const selection = this.selectEvidenceForSection(spec, allEvidence);
      const evidenceIds = selection.evidence.map((item) => item.id);
      if (selection.truncated) {
        section.diagnostics.push({
          code: 'evidence-prompt-truncated',
          message: `Prompt evidence was bounded to ${selection.evidence.length} of ${selection.relevantCount} relevant items.`,
          severity: 'info',
        });
      }
      try {
        section.payload = await this.sectionWriter.write({
          profileId: this.profile.profile.id,
          sectionId,
          prompt,
          variables: this.variablesForPrompt(prompt, {
            SECTION_ID: sectionId,
            EVIDENCE_BUNDLE: this.formatEvidenceForPrompt(selection.evidence),
          }),
          evidenceIds,
          invokeLLM: (userPrompt, systemPrompt, options) =>
            this.invokeLLM(userPrompt, systemPrompt, options),
          transformSystemPrompt: (systemPrompt) => this.buildSystemPrompt(systemPrompt),
          llmOptions: this.streamOpts(section.title),
        });
        generated++;
      } catch (error) {
        section.status = 'needs-human';
        section.payload = {
          mode: 'structured',
          blocks: [
            {
              type: 'unknown',
              status: 'needs-human',
              reason:
                this.language.resolvedLocale === 'zh-CN'
                  ? '章节生成失败，需要人工确认。'
                  : 'Section generation failed and requires human review.',
              evidenceIds: [],
            },
          ],
        };
        section.diagnostics.push({
          code: 'section-writer-failed',
          message: (error as Error).message,
          severity: 'error',
        });
        this.failedModules.push(sectionId);
      }
      completed++;
      this.onProgress(
        'sections',
        30 + Math.round((completed / plan.dependencyOrder.length) * 55),
        `${completed}/${plan.dependencyOrder.length} — ${section.title}`,
      );
    }
    return generated;
  }

  private generationIdForPlan(sourceCommit: string, plan: DocumentPlan): string {
    const identity = this.generationIdentity(sourceCommit);
    return createHash('sha256')
      .update(JSON.stringify([identity.artifactKey, plan]))
      .digest('hex');
  }

  private async publishStandardPlan(
    currentCommit: string,
    moduleTree: ModuleTreeNode[],
    plan: DocumentPlan,
  ): Promise<void> {
    const coverage = validateProfileCoverage(this.profile, plan, this.evidenceBundle!);
    const generationId = this.generationIdForPlan(currentCommit, plan);
    const identity = this.generationIdentity(currentCommit);
    const rendered = renderDocumentPlan(
      this.profile,
      plan,
      coverage,
      generationId,
      identity.semanticsKey,
      this.evidenceBundle!,
    );
    const documentPlanJson = `${JSON.stringify(plan, null, 2)}\n`;
    const moduleTreeJson = `${JSON.stringify(moduleTree, null, 2)}\n`;
    rendered.manifest.supportingArtifacts = [
      {
        role: 'document-plan',
        file: 'document_plan.json',
        contentHash: hashOutputContent(documentPlanJson),
      },
      {
        role: 'module-tree',
        file: 'module_tree.json',
        contentHash: hashOutputContent(moduleTreeJson),
      },
    ];
    validateOutputManifest(rendered.manifest);
    const meta = this.buildWikiMeta(currentCommit, this.extractModuleFiles(moduleTree), moduleTree);
    meta.generation!.generationId = generationId;
    meta.outputManifest = rendered.manifest;
    meta.evidenceLimitations = [...this.evidenceBundle!.limitations];
    const files: Record<string, string> = {
      ...rendered.files,
      'document_plan.json': documentPlanJson,
      'module_tree.json': moduleTreeJson,
      'meta.json': `${JSON.stringify(meta, null, 2)}\n`,
    };
    const publication = await new WikiPublisher().publish({
      wikiDir: this.wikiDir,
      manifest: rendered.manifest,
      files,
      mirrorFiles: Object.keys(files),
    });
    if (publication.mirrorFailures.length > 0) {
      this.failedModules.push(...publication.mirrorFailures.map((file) => `legacy-mirror:${file}`));
    }
  }

  private async generateStandardDocument(
    currentCommit: string,
    moduleTree: ModuleTreeNode[],
  ): Promise<WikiRunResult> {
    const plan = await this.createOrLoadReviewedPlan(currentCommit, moduleTree);
    await this.writeStandardSections(plan);
    plan.status = this.failedModules.length > 0 ? 'partial' : 'generated';
    await this.publishStandardPlan(currentCommit, moduleTree, plan);
    this.onProgress('done', 100, 'Standard document generation complete');
    return {
      pagesGenerated: flattenSections(plan.sections).length,
      mode: 'full',
      failedModules: [...this.failedModules],
    };
  }

  private changedEvidenceKinds(changedFiles: readonly string[]): Set<EvidenceKind> {
    const result = new Set<EvidenceKind>();
    for (const file of changedFiles) {
      const normalized = file.toLowerCase();
      if (
        /(^|\/)(__tests__|test|tests|spec|specs)(\/|$)/.test(normalized) ||
        /\.(test|spec)\.[^.]+$/.test(normalized)
      ) {
        result.add('test');
      } else if (
        /(^|\/)(docs?|wiki)(\/|$)/.test(normalized) ||
        /(^|\/)(readme|changelog|contributing|architecture)(\.|$)/.test(normalized) ||
        /\.(md|mdx|adoc|rst)$/.test(normalized)
      ) {
        result.add('documentation');
      } else if (
        /(^|\/)(config|configs)(\/|$)/.test(normalized) ||
        /\.(json|ya?ml|toml|ini|properties)$/.test(normalized) ||
        /(^|\/)(dockerfile|compose.*\.ya?ml)$/.test(normalized)
      ) {
        result.add('config');
      } else {
        result.add('source');
        result.add('call-graph');
        result.add('process');
      }
    }
    return result;
  }

  private removeDeletedFilesFromTree(
    tree: ModuleTreeNode[],
    deletedFiles: ReadonlySet<string>,
  ): string[] {
    if (deletedFiles.size === 0) return [];
    const removedSlugs: string[] = [];
    const prune = (nodes: ModuleTreeNode[]): ModuleTreeNode[] =>
      nodes.filter((node) => {
        if (node.children && node.children.length > 0) {
          node.children = prune(node.children);
          if (node.children.length === 0) {
            removedSlugs.push(node.slug);
            return false;
          }
          return true;
        }
        const before = node.files.length;
        node.files = node.files.filter((file) => !deletedFiles.has(file));
        if (before > 0 && node.files.length === 0) {
          removedSlugs.push(node.slug);
          return false;
        }
        return true;
      });
    tree.splice(0, tree.length, ...prune(tree));
    return removedSlugs;
  }

  private copyUnaffectedSectionPayloads(
    nextPlan: DocumentPlan,
    previousPlan: DocumentPlan,
    affectedKinds: ReadonlySet<EvidenceKind>,
    knownEvidenceIds: ReadonlySet<string>,
  ): void {
    const specs = new Map(
      this.flattenProfileSections(this.profile.profile.sections).map((section) => [
        section.id,
        section,
      ]),
    );
    const previous = new Map(
      flattenSections(previousPlan.sections).map((section) => [section.id, section]),
    );
    for (const section of flattenSections(nextPlan.sections)) {
      const spec = specs.get(section.id)!;
      const affected = spec.evidenceRequirements.some((requirement) =>
        affectedKinds.has(requirement.kind),
      );
      const oldSection = previous.get(section.id);
      const writerFailed = oldSection?.diagnostics.some(
        (diagnostic) => diagnostic.code === 'section-writer-failed',
      );
      if (
        affected ||
        !oldSection ||
        oldSection.payload.mode !== 'structured' ||
        oldSection.payload.blocks.length === 0 ||
        writerFailed
      )
        continue;
      const evidenceIds = oldSection.payload.blocks.flatMap((block) => {
        if (block.type === 'claim') return block.claim.evidenceIds;
        if (block.type === 'table') return block.rows.flatMap((row) => row.evidenceIds);
        return block.evidenceIds;
      });
      if (evidenceIds.some((id) => !knownEvidenceIds.has(id))) continue;
      section.payload = structuredClone(oldSection.payload);
      section.status = oldSection.status;
      section.diagnostics = [...oldSection.diagnostics];
    }
  }

  private async loadPreviousStandardPlan(
    existingMeta: WikiMeta,
    expected: DocumentPlan,
    knownEvidenceIds: ReadonlySet<string>,
  ): Promise<DocumentPlan | null> {
    const generationId = existingMeta.generation?.generationId;
    if (!generationId || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(generationId)) return null;
    try {
      const generationDir = path.join(this.wikiDir, '.generations', generationId);
      const manifest = JSON.parse(
        await fs.readFile(path.join(generationDir, 'manifest.json'), 'utf8'),
      );
      validateOutputManifest(manifest);
      if (manifest.generationId !== generationId) return null;
      const documentPlanArtifact = manifest.supportingArtifacts?.find(
        (artifact: { role: string }) => artifact.role === 'document-plan',
      );
      if (!documentPlanArtifact) return null;
      const rawPlan = await fs.readFile(path.join(generationDir, 'document_plan.json'), 'utf8');
      if (hashOutputContent(rawPlan) !== documentPlanArtifact.contentHash) return null;
      const raw = JSON.parse(rawPlan) as Record<string, unknown>;
      const oldExpected: DocumentPlan = {
        ...expected,
        sourceCommit: existingMeta.fromCommit,
      };
      return validateReviewedDocumentPlan(
        { ...raw, status: 'reviewed' },
        oldExpected,
        knownEvidenceIds,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      return null;
    }
  }

  private async hasRetryableStandardFailures(existingMeta: WikiMeta): Promise<boolean> {
    const generationId = existingMeta.generation?.generationId;
    if (!generationId || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(generationId)) return false;
    try {
      const raw = JSON.parse(
        await fs.readFile(
          path.join(this.wikiDir, '.generations', generationId, 'document_plan.json'),
          'utf8',
        ),
      ) as DocumentPlan;
      return flattenSections(raw.sections).some((section) =>
        section.diagnostics.some((diagnostic) => diagnostic.code === 'section-writer-failed'),
      );
    } catch {
      return false;
    }
  }

  private async incrementalStandardDocument(
    existingMeta: WikiMeta,
    currentCommit: string,
  ): Promise<WikiRunResult> {
    this.onProgress('incremental', 5, 'Detecting standard document changes...');
    const changedFiles = this.getChangedFiles(existingMeta.fromCommit, currentCommit);
    if (changedFiles === null || changedFiles.length > 5) {
      for (const file of ['first_module_tree.json', 'module_tree.json', 'document_plan.json']) {
        await fs.unlink(path.join(this.wikiDir, file)).catch(() => {});
      }
      const result = await this.fullGeneration(currentCommit);
      return { ...result, mode: 'incremental' };
    }

    const moduleTree = structuredClone(existingMeta.moduleTree);
    const moduleFiles = this.extractModuleFiles(moduleTree);
    const deletedFiles = new Set<string>();
    for (const file of changedFiles) {
      if (!(await this.fileExists(path.join(this.repoPath, file)))) deletedFiles.add(file);
    }
    this.removeDeletedFilesFromTree(moduleTree, deletedFiles);
    if (moduleTree.length === 0) {
      for (const file of ['first_module_tree.json', 'module_tree.json', 'document_plan.json']) {
        await fs.unlink(path.join(this.wikiDir, file)).catch(() => {});
      }
      const result = await this.fullGeneration(currentCommit);
      return { ...result, mode: 'incremental' };
    }
    const newFiles = changedFiles.filter(
      (file) =>
        !deletedFiles.has(file) &&
        !Object.values(moduleFiles).some((files) => files.includes(file)) &&
        !shouldIgnorePath(file),
    );
    if (newFiles.length > 0) {
      let other = this.findNodeBySlug(moduleTree, 'other');
      if (!other) {
        other = { name: 'Other', slug: 'other', files: [] };
        moduleTree.push(other);
      }
      other.files = Array.from(new Set([...other.files, ...newFiles])).sort();
    }
    validateReviewedModuleTree(moduleTree);
    await this.collectStructuredEvidence(currentCommit, moduleTree);
    const nextPlan = createDocumentPlan({
      profile: this.profile,
      language: this.language,
      sourceCommit: currentCommit,
      moduleTree,
      evidence: this.evidenceBundle!,
    });
    const knownEvidenceIds = new Set(this.allStructuredEvidence().map((item) => item.id));
    const previousPlan = await this.loadPreviousStandardPlan(
      existingMeta,
      nextPlan,
      knownEvidenceIds,
    );
    if (previousPlan) {
      this.copyUnaffectedSectionPayloads(
        nextPlan,
        previousPlan,
        this.changedEvidenceKinds(changedFiles),
        knownEvidenceIds,
      );
    }
    const generated = await this.writeStandardSections(nextPlan);
    nextPlan.status = this.failedModules.length > 0 ? 'partial' : 'generated';
    await this.publishStandardPlan(currentCommit, moduleTree, nextPlan);
    return {
      pagesGenerated: generated,
      mode: 'incremental',
      failedModules: [...this.failedModules],
    };
  }

  private flattenLegacyPages(
    tree: readonly ModuleTreeNode[],
    parentId?: string,
  ): Array<{ node: ModuleTreeNode; parentId?: string }> {
    return tree.flatMap((node) => [
      { node, ...(parentId ? { parentId } : {}) },
      ...(node.children ? this.flattenLegacyPages(node.children, `module-${node.slug}`) : []),
    ]);
  }

  private async publishLegacyGeneration(currentCommit: string): Promise<void> {
    const existingMeta = await this.loadWikiMeta();
    if (!existingMeta) throw new Error('Legacy wiki metadata is missing before publication');
    const overview = await fs.readFile(path.join(this.wikiDir, 'overview.md'), 'utf8');
    const candidates = this.flattenLegacyPages(existingMeta.moduleTree);
    const available = new Set<string>();
    const contents = new Map<string, string>();
    for (const { node } of candidates) {
      try {
        contents.set(
          node.slug,
          await fs.readFile(path.join(this.wikiDir, `${node.slug}.md`), 'utf8'),
        );
        available.add(`module-${node.slug}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const pages: ManifestPageInput[] = [];
    for (const { node, parentId } of candidates) {
      const content = contents.get(node.slug);
      if (content === undefined) continue;
      pages.push({
        id: `module-${node.slug}`,
        slug: node.slug,
        label: node.name,
        file: `${node.slug}.md`,
        ...(parentId && available.has(parentId) ? { parentId } : {}),
        order: pages.length,
        status: 'verified',
        content,
      });
    }
    const coverage = `${JSON.stringify(
      {
        schemaVersion: 1,
        profile: {
          id: this.profile.profile.id,
          revision: this.profile.profile.revision,
          fingerprint: this.profile.fingerprint,
        },
        language: this.language,
        status: 'legacy',
        conclusion:
          this.language.resolvedLocale === 'zh-CN'
            ? 'default Profile 仅提供章节级追踪；未进行标准符合性评估。'
            : 'The default Profile provides section-level traceability only; standards conformance not assessed.',
        standardsConformanceAssessed: false,
      },
      null,
      2,
    )}\n`;
    const identity = this.generationIdentity(currentCommit);
    const generationId = hashOutputContent(
      JSON.stringify([
        identity.artifactKey,
        overview,
        pages.map((page) => [page.file, page.content]),
        coverage,
      ]),
    );
    const manifest = createOutputManifest({
      generationId,
      profile: {
        id: this.profile.profile.id,
        revision: this.profile.profile.revision,
        fingerprint: this.profile.fingerprint,
      },
      language: this.language,
      sourceCommit: currentCommit,
      generationSemanticsKey: identity.semanticsKey,
      entry: {
        slug: 'overview',
        label: 'Overview',
        file: 'overview.md',
        content: overview,
      },
      pages,
      coverage: { file: 'coverage.json', content: coverage },
      supportingArtifacts: [
        {
          role: 'module-tree',
          file: 'module_tree.json',
          content: `${JSON.stringify(existingMeta.moduleTree, null, 2)}\n`,
        },
      ],
    });
    const meta = this.buildWikiMeta(
      currentCommit,
      existingMeta.moduleFiles,
      existingMeta.moduleTree,
      existingMeta,
    );
    meta.generation!.generationId = generationId;
    meta.outputManifest = manifest;
    const files: Record<string, string> = {
      'overview.md': overview,
      ...Object.fromEntries(pages.map((page) => [page.file, page.content])),
      'coverage.json': coverage,
      'module_tree.json': `${JSON.stringify(existingMeta.moduleTree, null, 2)}\n`,
      'meta.json': `${JSON.stringify(meta, null, 2)}\n`,
    };
    const publication = await new WikiPublisher().publish({
      wikiDir: this.wikiDir,
      manifest,
      files,
      mirrorFiles: Object.keys(files).filter((file) => file !== 'coverage.json'),
    });
    if (publication.mirrorFailures.length > 0) {
      this.failedModules.push(...publication.mirrorFailures.map((file) => `legacy-mirror:${file}`));
    }
  }

  private formatEvidenceForPrompt(evidence: EvidenceBundle['repository'] | undefined): string {
    if (!evidence || evidence.length === 0) return '[]';
    return JSON.stringify(evidence.map((item) => this.evidenceRecordForPrompt(item)));
  }

  private generationIdentity(sourceCommit: string): {
    semanticsKey: string;
    artifactKey: string;
  } {
    const semanticsKey = createHash('sha256')
      .update(
        JSON.stringify([
          this.profile.fingerprint,
          this.language.requestedLanguage,
          this.language.resolvedLocale,
          this.language.localeFingerprint,
          this.language.localeResolverVersion,
          this.llmConfig.provider,
          this.llmConfig.model,
          COLLECTOR_VERSION,
          WRITER_VERSION,
          VALIDATOR_VERSION,
          RENDERER_VERSION,
        ]),
      )
      .digest('hex');
    const artifactKey = createHash('sha256')
      .update(JSON.stringify([sourceCommit, semanticsKey]))
      .digest('hex');
    return { semanticsKey, artifactKey };
  }

  private assertCacheCompatibility(existingMeta: WikiMeta, currentCommit: string): void {
    const currentLang = this.effectiveLang();
    const metaLang = existingMeta.lang ?? '';
    if (currentLang !== metaLang) {
      const prevDisplay = metaLang || 'english (default)';
      const nextDisplay = currentLang || 'english (default)';
      throw new Error(
        `Wiki was generated in ${prevDisplay}; use --force to regenerate in ${nextDisplay}.`,
      );
    }

    const isLegacy = existingMeta.schemaVersion !== 2 || !existingMeta.generation;
    if (isLegacy) {
      if (this.profile.profile.id !== 'default') {
        throw new Error(
          `Legacy wiki metadata can only be reused by the default profile; use --force to regenerate with ${this.profile.profile.id}.`,
        );
      }
      return;
    }

    const structuredIdentityMatches =
      existingMeta.profile?.id === this.profile.profile.id &&
      existingMeta.profile.revision === this.profile.profile.revision &&
      existingMeta.profile.fingerprint === this.profile.fingerprint &&
      existingMeta.generation.provider === this.llmConfig.provider &&
      existingMeta.generation.model === this.llmConfig.model &&
      existingMeta.generation.requestedLanguage === this.language.requestedLanguage &&
      existingMeta.generation.resolvedLocale === this.language.resolvedLocale &&
      existingMeta.generation.localeFingerprint === this.language.localeFingerprint &&
      existingMeta.generation.localeResolverVersion === this.language.localeResolverVersion &&
      existingMeta.generation.collectorVersion === COLLECTOR_VERSION &&
      existingMeta.generation.writerVersion === WRITER_VERSION &&
      existingMeta.generation.validatorVersion === VALIDATOR_VERSION &&
      existingMeta.generation.rendererVersion === RENDERER_VERSION;
    if (!structuredIdentityMatches) {
      throw new Error('Wiki generation settings changed; use --force to regenerate all pages.');
    }

    const identity = this.generationIdentity(currentCommit);
    if (existingMeta.generation.semanticsKey !== identity.semanticsKey) {
      throw new Error('Wiki generation settings changed; use --force to regenerate all pages.');
    }
    if (
      existingMeta.fromCommit === currentCommit &&
      existingMeta.generation.artifactKey !== identity.artifactKey
    ) {
      throw new Error(
        'Wiki artifact identity is inconsistent; use --force to regenerate all pages.',
      );
    }
  }

  private buildWikiMeta(
    sourceCommit: string,
    moduleFiles: Record<string, string[]>,
    moduleTree: ModuleTreeNode[],
    previous?: WikiMeta,
  ): WikiMeta {
    const identity = this.generationIdentity(sourceCommit);
    return {
      schemaVersion: 2,
      fromCommit: sourceCommit,
      generatedAt: new Date().toISOString(),
      model: this.llmConfig.model,
      lang: this.effectiveLang(),
      moduleFiles,
      moduleTree,
      profile: {
        id: this.profile.profile.id,
        revision: this.profile.profile.revision,
        fingerprint: this.profile.fingerprint,
      },
      generation: {
        generationId: identity.artifactKey,
        provider: this.llmConfig.provider,
        model: this.llmConfig.model,
        requestedLanguage: this.language.requestedLanguage,
        resolvedLocale: this.language.resolvedLocale,
        ...(this.language.fallbackFrom
          ? { localeFallback: { from: this.language.fallbackFrom, to: 'en' as const } }
          : {}),
        localeFingerprint: this.language.localeFingerprint,
        localeResolverVersion: this.language.localeResolverVersion,
        collectorVersion: COLLECTOR_VERSION,
        writerVersion: WRITER_VERSION,
        validatorVersion: VALIDATOR_VERSION,
        rendererVersion: RENDERER_VERSION,
        semanticsKey: identity.semanticsKey,
        artifactKey: identity.artifactKey,
      },
      ...(previous?.outputManifest !== undefined
        ? { outputManifest: previous.outputManifest }
        : {}),
      evidenceLimitations: previous?.evidenceLimitations ?? [],
    };
  }

  private getCurrentCommit(): string {
    try {
      return execSync('git rev-parse HEAD', {
        cwd: this.repoPath,
        windowsHide: true,
      })
        .toString()
        .trim();
    } catch {
      return '';
    }
  }

  /**
   * Check if fromCommit is an ancestor of toCommit (reachable in git history).
   * Returns false if commits are on divergent branches or fromCommit doesn't exist.
   */
  private isCommitReachable(fromCommit: string, toCommit: string): boolean {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', fromCommit, toCommit], {
        cwd: this.repoPath,
        stdio: 'ignore',
        windowsHide: true,
      });
      return true;
    } catch {
      return false;
    }
  }

  private getChangedFiles(fromCommit: string, toCommit: string): string[] | null {
    // First check if fromCommit is reachable from toCommit
    // This handles the case where wiki was generated on a different branch
    if (!this.isCommitReachable(fromCommit, toCommit)) {
      return null; // Signal that we can't compute diff (divergent branches)
    }

    try {
      const output = execFileSync('git', ['diff', `${fromCommit}..${toCommit}`, '--name-only'], {
        cwd: this.repoPath,
        windowsHide: true,
      })
        .toString()
        .trim();
      return output ? output.split('\n').filter(Boolean) : [];
    } catch {
      return null; // Treat git errors as needing full regen
    }
  }

  private async readSourceFiles(filePaths: string[]): Promise<string> {
    const parts: string[] = [];
    for (const fp of filePaths) {
      const fullPath = path.join(this.repoPath, fp);
      try {
        const content = await fs.readFile(fullPath, 'utf-8');
        parts.push(`\n--- ${fp} ---\n${content}`);
      } catch {
        parts.push(`\n--- ${fp} ---\n(file not readable)`);
      }
    }
    return parts.join('\n');
  }

  private truncateSource(source: string, maxTokens: number): string {
    // Rough truncation: keep first maxTokens*4 chars and add notice
    const maxChars = maxTokens * 4;
    if (source.length <= maxChars) return source;
    return source.slice(0, maxChars) + '\n\n... (source truncated for context window limits)';
  }

  private async estimateModuleTokens(filePaths: string[]): Promise<number> {
    let total = 0;
    for (const fp of filePaths) {
      try {
        const content = await fs.readFile(path.join(this.repoPath, fp), 'utf-8');
        total += estimateTokens(content);
      } catch {
        // File not readable, skip
      }
    }
    return total;
  }

  private async readProjectInfo(): Promise<string> {
    const candidates = [
      'package.json',
      'Cargo.toml',
      'pyproject.toml',
      'go.mod',
      'pom.xml',
      'build.gradle',
    ];
    const lines: string[] = [`Project: ${path.basename(this.repoPath)}`];

    for (const file of candidates) {
      const fullPath = path.join(this.repoPath, file);
      try {
        const content = await fs.readFile(fullPath, 'utf-8');
        if (file === 'package.json') {
          const pkg = JSON.parse(content);
          if (pkg.name) lines.push(`Name: ${pkg.name}`);
          if (pkg.description) lines.push(`Description: ${pkg.description}`);
          if (pkg.scripts) lines.push(`Scripts: ${Object.keys(pkg.scripts).join(', ')}`);
        } else {
          // Include first 500 chars of other config files
          lines.push(`\n${file}:\n${content.slice(0, 500)}`);
        }
        break; // Use first config found
      } catch {
        continue;
      }
    }

    // Read README excerpt
    for (const readme of ['README.md', 'readme.md', 'README.txt']) {
      try {
        const content = await fs.readFile(path.join(this.repoPath, readme), 'utf-8');
        lines.push(`\nREADME excerpt:\n${content.slice(0, 1000)}`);
        break;
      } catch {
        continue;
      }
    }

    return lines.join('\n');
  }

  private extractModuleFiles(tree: ModuleTreeNode[]): Record<string, string[]> {
    const result: Record<string, string[]> = {};
    for (const node of tree) {
      if (node.children && node.children.length > 0) {
        result[node.name] = node.children.flatMap((c) => c.files);
        for (const child of node.children) {
          result[child.name] = child.files;
        }
      } else {
        result[node.name] = node.files;
      }
    }
    return result;
  }

  private countModules(tree: ModuleTreeNode[]): number {
    let count = 0;
    for (const node of tree) {
      count++;
      if (node.children) {
        count += node.children.length;
      }
    }
    return count;
  }

  /**
   * Flatten the module tree into leaf nodes and parent nodes.
   * Leaves can be processed in parallel; parents must wait for children.
   */
  private flattenModuleTree(tree: ModuleTreeNode[]): {
    leaves: ModuleTreeNode[];
    parents: ModuleTreeNode[];
  } {
    const leaves: ModuleTreeNode[] = [];
    const parents: ModuleTreeNode[] = [];

    for (const node of tree) {
      if (node.children && node.children.length > 0) {
        for (const child of node.children) {
          leaves.push(child);
        }
        parents.push(node);
      } else {
        leaves.push(node);
      }
    }

    return { leaves, parents };
  }

  /**
   * Run async tasks in parallel with a concurrency limit and adaptive rate limiting.
   * If a 429 rate limit is hit, concurrency is temporarily reduced.
   */
  private async runParallel<T>(items: T[], fn: (item: T) => Promise<number>): Promise<number> {
    let total = 0;
    let activeConcurrency = this.concurrency;
    let running = 0;
    let idx = 0;

    return new Promise((resolve, reject) => {
      const next = () => {
        while (running < activeConcurrency && idx < items.length) {
          const item = items[idx++];
          running++;

          fn(item)
            .then((count) => {
              total += count;
              running--;
              if (idx >= items.length && running === 0) {
                resolve(total);
              } else {
                next();
              }
            })
            .catch((err) => {
              running--;
              // On rate limit, reduce concurrency temporarily
              if (err.message?.includes('429')) {
                activeConcurrency = Math.max(1, activeConcurrency - 1);
                this.onProgress(
                  'modules',
                  this.lastPercent,
                  `Rate limited — concurrency → ${activeConcurrency}`,
                );
                // Re-queue the item
                idx--;
                setTimeout(next, 5000);
              } else {
                if (idx >= items.length && running === 0) {
                  resolve(total);
                } else {
                  next();
                }
              }
            });
        }
      };

      if (items.length === 0) {
        resolve(0);
      } else {
        next();
      }
    });
  }

  private findNodeBySlug(tree: ModuleTreeNode[], slug: string): ModuleTreeNode | null {
    for (const node of tree) {
      if (node.slug === slug) return node;
      if (node.children) {
        const found = this.findNodeBySlug(node.children, slug);
        if (found) return found;
      }
    }
    return null;
  }

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60);
  }

  private async fileExists(fp: string): Promise<boolean> {
    try {
      await fs.access(fp);
      return true;
    } catch {
      return false;
    }
  }

  private async loadWikiMeta(): Promise<WikiMeta | null> {
    try {
      const raw = await fs.readFile(path.join(this.wikiDir, 'meta.json'), 'utf-8');
      return JSON.parse(raw) as WikiMeta;
    } catch {
      return null;
    }
  }

  private async saveWikiMeta(meta: WikiMeta): Promise<void> {
    await fs.writeFile(
      path.join(this.wikiDir, 'meta.json'),
      JSON.stringify(meta, null, 2),
      'utf-8',
    );
  }

  private async saveModuleTree(tree: ModuleTreeNode[]): Promise<void> {
    const validated = validateReviewedModuleTree(tree);
    await fs.writeFile(
      path.join(this.wikiDir, 'module_tree.json'),
      JSON.stringify(validated, null, 2),
      'utf-8',
    );
  }
}
