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
import { statSync } from 'node:fs';
import path from 'path';
import { execFileSync } from 'child_process';

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
import { callGrokLLM, resolveGrokConfig } from './grok-client.js';
import {
  callClaudeLLM,
  callCodexLLM,
  callOpenCodeLLM,
  resolveLocalCLIConfig,
} from './local-cli-client.js';

import {
  GROUPING_SYSTEM_PROMPT,
  GROUPING_USER_PROMPT,
  MODULE_SYSTEM_PROMPT,
  MODULE_USER_PROMPT,
  PARENT_SYSTEM_PROMPT,
  PARENT_USER_PROMPT,
  OVERVIEW_SYSTEM_PROMPT,
  OVERVIEW_USER_PROMPT,
  fillTemplate,
  formatFileListForGrouping,
  formatDirectoryTree,
  formatCallEdges,
  formatProcesses,
} from './prompts.js';

import { splitModuleByDirectory } from './module-split.js';

import { shouldIgnorePath } from '../../config/ignore-service.js';

/** A repository being documented must not participate in finding the Git executable. */
function resolveWikiGit(): string | undefined {
  const configured = process.env.GITNEXUS_WIKI_GIT_PATH;
  if (configured) {
    if (
      !path.isAbsolute(configured) ||
      !statSync(configured, { throwIfNoEntry: false })?.isFile()
    ) {
      throw new Error('GITNEXUS_WIKI_GIT_PATH must be the absolute path of a Git executable');
    }
    return configured;
  }
  const candidates =
    process.platform === 'win32'
      ? [
          path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'cmd', 'git.exe'),
          path.join(
            process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
            'Git',
            'cmd',
            'git.exe',
          ),
          path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'cmd', 'git.exe'),
        ]
      : [
          '/usr/bin/git',
          '/bin/git',
          '/run/current-system/sw/bin/git',
          '/opt/homebrew/bin/git',
          '/usr/local/bin/git',
        ];
  return candidates.find(
    (file) => path.isAbsolute(file) && statSync(file, { throwIfNoEntry: false })?.isFile(),
  );
}

// ─── Types ────────────────────────────────────────────────────────────

export interface WikiOptions {
  force?: boolean;
  maxTokensPerModule?: number;
  concurrency?: number;
  /** If true, stop after building module tree for user review */
  reviewOnly?: boolean;
  /**
   * Generate from module_tree.json as it is, even when it matches the last
   * generation's tree. The CLI sets it for the run that follows a review.
   */
  useSavedTree?: boolean;
  /** Output language for generated documentation (e.g. 'english', 'chinese', 'spanish') */
  lang?: string;
}

export interface WikiMeta {
  fromCommit: string;
  generatedAt: string;
  model: string;
  lang: string;
  moduleFiles: Record<string, string[]>;
  moduleTree: ModuleTreeNode[];
  /** Pages that must be retried even when fromCommit is still current. */
  failedModules?: string[];
  /** A regrouping a run started and did not complete. */
  regrouping?: PendingRegrouping;
}

/**
 * A run that groups an existing wiki's files again records this in meta.json
 * before it deletes any page, and the run that completes the regrouping
 * drops it. The rest of meta.json still describes the previous wiki.
 */
export interface PendingRegrouping {
  /** The commit the run documents. */
  commit: string;
  /** The tree the run writes pages for. */
  tree: ModuleTreeNode[];
  /** The pages of the previous wiki the run keeps as they are. */
  keptPages: string[];
  /** Whether the run has deleted the other pages of both trees. */
  staleRemoved: boolean;
}

export interface ModuleTreeNode {
  name: string;
  slug: string;
  files: string[];
  children?: ModuleTreeNode[];
}

export type ProgressCallback = (phase: string, percent: number, detail?: string) => void;

export interface WikiRunResult {
  pagesGenerated: number;
  mode: 'full' | 'incremental' | 'up-to-date';
  failedModules: string[];
  moduleTree?: ModuleTreeNode[];
}

/** An existing wiki whose files a full generation groups again (see removeStalePages). */
interface Regrouping {
  meta: WikiMeta;
  /** The files changed since `meta.fromCommit`. */
  changedFiles: string[];
}

/** `value` as JSON with every object's keys in name order; arrays keep theirs. */
const keyOrderFreeJson = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : item,
  );

// ─── Constants ────────────────────────────────────────────────────────

const DEFAULT_MAX_TOKENS_PER_MODULE = 30_000;
const GROUPING_TOKEN_BUDGET = 100_000;
const MAX_SLUG_LENGTH = 60;
const WIKI_DIR = 'wiki';

/** One file as a module page prompt quotes it. */
const sourceSection = (filePath: string, content: string): string =>
  `\n--- ${filePath} ---\n${content}`;

/** What a module page prompt quotes for a file it cannot read. */
const UNREADABLE_FILE = '(file not readable)';

// ─── Generator Class ──────────────────────────────────────────────────

export class WikiGenerator {
  private readonly gitExecutable = resolveWikiGit();
  private repoPath: string;
  private storagePath: string;
  private wikiDir: string;
  private lbugPath: string;
  private llmConfig: LLMConfig;
  private maxTokensPerModule: number;
  private concurrency: number;
  private options: WikiOptions;
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
    return `${base}\n\nIMPORTANT: Write ALL documentation content in ${lang}. This includes prose, code comments in examples, and diagram labels. Note: page titles (H1 headings) are generated separately and will remain in English.`;
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
    if (this.llmConfig.provider === 'grok') {
      const grokConfig = resolveGrokConfig({
        model: this.llmConfig.model,
        requestTimeoutMs: this.llmConfig.requestTimeoutMs,
      });
      return callGrokLLM(prompt, grokConfig, systemPrompt, options);
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
    this.failedModules = [];
    await fs.mkdir(this.wikiDir, { recursive: true });

    const existingMeta = await this.loadWikiMeta();
    const currentCommit = this.getCurrentCommit();
    const forceMode = this.options.force;

    // Up-to-date check (skip if --force)
    if (
      !forceMode &&
      currentCommit &&
      existingMeta &&
      existingMeta.fromCommit === currentCommit &&
      !existingMeta.failedModules?.length &&
      !existingMeta.regrouping
    ) {
      const currentLang = this.effectiveLang();
      const metaLang = existingMeta.lang ?? '';
      if (currentLang !== metaLang) {
        const prevDisplay = metaLang || 'english (default)';
        const nextDisplay = currentLang || 'english (default)';
        throw new Error(
          `Wiki was generated in ${prevDisplay}; use --force to regenerate in ${nextDisplay}.`,
        );
      }
      // Still regenerate the HTML viewer in case it's missing
      await this.ensureHTMLViewer();
      return { pagesGenerated: 0, mode: 'up-to-date', failedModules: [] };
    }

    // Force mode: regenerate every page, from a new grouping unless the saved
    // tree was edited since the last generation (see discardSavedGrouping)
    if (forceMode) {
      // A failure must not leave the previous wiki marked complete at this commit.
      await fs.rm(path.join(this.wikiDir, 'meta.json'), { force: true });
      await this.discardSavedGrouping(existingMeta);
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
        const currentLang = this.effectiveLang();
        const metaLang = existingMeta.lang ?? '';
        if (currentLang !== metaLang) {
          const prevDisplay = metaLang || 'english (default)';
          const nextDisplay = currentLang || 'english (default)';
          throw new Error(
            `Wiki was generated in ${prevDisplay}; use --force to regenerate in ${nextDisplay}.`,
          );
        }
        result = await this.incrementalUpdate(existingMeta, currentCommit);
      } else {
        result = await this.fullGeneration(currentCommit);
      }
    } finally {
      releaseWikiDbPin();
      await closeWikiDb();
    }

    // Generate the HTML viewer after wiki content changes. A tree waiting for
    // review has no pages yet, so the viewer keeps showing the last wiki.
    if (!(this.options.reviewOnly && result.moduleTree)) await this.ensureHTMLViewer();

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

  private async fullGeneration(
    currentCommit: string,
    regroup?: Regrouping,
  ): Promise<WikiRunResult> {
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

    // Phase 1: Build module tree, or take the one of a regrouping to complete
    const moduleTree =
      regroup?.meta.regrouping?.tree ??
      (await this.buildModuleTree(
        enrichedFiles,
        regroup && !(await this.keepsSavedTree(regroup.meta)),
      ));
    pagesGenerated = 0;

    // If reviewOnly mode, save tree and stop for user to review/edit
    if (this.options.reviewOnly) {
      await this.saveModuleTree(moduleTree);
      this.onProgress('review', 30, 'Module tree ready for review');
      const reviewResult: WikiRunResult = {
        pagesGenerated: 0,
        mode: 'full',
        failedModules: [],
        moduleTree,
      };
      return reviewResult;
    }

    if (regroup) await this.removeStalePages(moduleTree, currentCommit, regroup);

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
      if (node.children?.some((child) => this.failedModules.includes(child.name))) {
        this.failedModules.push(node.name);
        reportProgress(`Failed: ${node.name}`);
        continue;
      }
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
    await this.saveWikiMeta({
      fromCommit: currentCommit,
      generatedAt: new Date().toISOString(),
      model: this.llmConfig.model,
      lang: this.effectiveLang(),
      moduleFiles,
      moduleTree,
      failedModules: [...this.failedModules],
    });

    this.onProgress('done', 100, 'Wiki generation complete');
    return { pagesGenerated, mode: 'full', failedModules: [...this.failedModules] };
  }

  // ─── Phase 1: Build Module Tree ────────────────────────────────────

  /**
   * @param groupAgain Ask the model even when a tree is saved, for a run that
   *   groups an existing wiki's files again (see keepsSavedTree).
   */
  private async buildModuleTree(
    files: FileWithExports[],
    groupAgain = false,
  ): Promise<ModuleTreeNode[]> {
    // First, check for user-edited module_tree.json (from --review workflow)
    const edited = groupAgain ? null : await this.readSavedTree('module_tree.json');
    if (edited) {
      this.onProgress('grouping', 25, 'Using edited module tree');
      return edited;
    }

    // Check for existing immutable snapshot (resumability)
    const snapshotPath = path.join(this.wikiDir, 'first_module_tree.json');
    const snapshot = groupAgain ? null : await this.readSavedTree('first_module_tree.json');
    if (snapshot) {
      this.onProgress('grouping', 25, 'Using existing module tree (resuming)');
      return snapshot;
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
    // Pages of a split module get names whose slugs no other page uses, the
    // overview's included. A page's slug is empty only when its module's is,
    // and the module's slug is in the set.
    const takenSlugs = new Set([
      'overview',
      ...Object.keys(grouping).map((name) => this.slugify(name)),
    ]);
    for (const [moduleName, modulePaths] of Object.entries(grouping)) {
      const slug = this.slugify(moduleName);
      const node: ModuleTreeNode = { name: moduleName, slug, files: modulePaths };

      // Token budget check — split if too large
      const fileTokens = await this.estimateFileTokens(modulePaths);
      let totalTokens = 0;
      for (const tokens of fileTokens.values()) totalTokens += tokens;
      if (totalTokens > this.maxTokensPerModule) {
        const parts = splitModuleByDirectory(
          modulePaths,
          (file) => fileTokens.get(file) ?? 0,
          this.maxTokensPerModule,
        );
        // Only create hierarchy if we actually got multiple children
        // If splitting results in 1 child, keep files flat (avoid redundant nesting)
        if (parts.length > 1) {
          node.children = parts.map((part) => {
            const name = this.uniqueModuleName(moduleName, part.label, takenSlugs);
            return { name, slug: this.slugify(name), files: part.files };
          });
          node.files = []; // Parent doesn't own files directly when split
        }
        // If only 1 child, keep original flat structure (files stay in node.files)
      }

      tree.push(node);
    }

    // Save immutable snapshot for resumability
    await fs.writeFile(snapshotPath, JSON.stringify(tree, null, 2), 'utf-8');
    this.onProgress('grouping', 28, `Created ${tree.length} modules`);

    return tree;
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

    const prompt = fillTemplate(MODULE_USER_PROMPT, {
      MODULE_NAME: node.name,
      SOURCE_CODE: finalSourceCode,
      INTRA_CALLS: formatCallEdges(intraCalls),
      OUTGOING_CALLS: formatCallEdges(interCalls.outgoing),
      INCOMING_CALLS: formatCallEdges(interCalls.incoming),
      PROCESSES: formatProcesses(processes),
    });

    const response = await this.invokeLLM(
      prompt,
      this.buildSystemPrompt(MODULE_SYSTEM_PROMPT),
      this.streamOpts(node.name),
    );

    // H1 uses the English module name (stable slug source); body is LLM-translated.
    const pageContent = sanitizeMermaidMarkdown(`# ${node.name}\n\n${response.content}`);
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
        childDocs.push(`#### ${child.name} (\`${child.slug}.md\`)\n${overview}`);
      } catch {
        childDocs.push(
          `#### ${child.name} (\`${child.slug}.md\`)\n(Documentation not yet generated)`,
        );
      }
    }

    // Get cross-child call edges
    const allChildFiles = node.children.flatMap((c) => c.files);
    const crossCalls = await getIntraModuleCallEdges(allChildFiles);
    const processes = await getProcessesForFiles(allChildFiles, 3);

    const prompt = fillTemplate(PARENT_USER_PROMPT, {
      MODULE_NAME: node.name,
      CHILDREN_DOCS: childDocs.join('\n\n'),
      CROSS_MODULE_CALLS: formatCallEdges(crossCalls),
      CROSS_PROCESSES: formatProcesses(processes),
    });

    const response = await this.invokeLLM(
      prompt,
      this.buildSystemPrompt(PARENT_SYSTEM_PROMPT),
      this.streamOpts(node.name),
    );

    const pageContent = sanitizeMermaidMarkdown(`# ${node.name}\n\n${response.content}`);
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
        moduleSummaries.push(`#### ${node.name} (\`${node.slug}.md\`)\n${overview}`);
      } catch {
        moduleSummaries.push(`#### ${node.name} (\`${node.slug}.md\`)\n(Documentation pending)`);
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

    const prompt = fillTemplate(OVERVIEW_USER_PROMPT, {
      PROJECT_INFO: projectInfo,
      MODULE_SUMMARIES: moduleSummaries.join('\n\n'),
      MODULE_EDGES: edgesText,
      TOP_PROCESSES: formatProcesses(topProcesses),
    });

    const response = await this.invokeLLM(
      prompt,
      this.buildSystemPrompt(OVERVIEW_SYSTEM_PROMPT),
      this.streamOpts('Generating overview', 88),
    );

    const pageContent = sanitizeMermaidMarkdown(
      `# ${path.basename(this.repoPath)} — Wiki\n\n${response.content}`,
    );
    await fs.writeFile(path.join(this.wikiDir, 'overview.md'), pageContent, 'utf-8');
  }

  // ─── Incremental Updates ────────────────────────────────────────────

  private async incrementalUpdate(
    existingMeta: WikiMeta,
    currentCommit: string,
  ): Promise<WikiRunResult> {
    this.onProgress('incremental', 5, 'Detecting changes...');

    // A regrouping an earlier run did not complete is completed at the commit
    // it documents. Anywhere else, or after a review, its pages are taken back.
    const pending = existingMeta.regrouping;
    if (pending?.commit === currentCommit && !this.options.useSavedTree) {
      this.onProgress('incremental', 10, 'Completing the regrouping of an interrupted run...');
      // The recorded regrouping already lists the pages it keeps.
      const fullResult = await this.fullGeneration(currentCommit, {
        meta: existingMeta,
        changedFiles: [],
      });
      return { ...fullResult, mode: 'incremental' };
    }
    if (pending) existingMeta = await this.abandonRegrouping(existingMeta, pending);

    // Get changed files since last generation
    const changedFiles = this.getChangedFiles(existingMeta.fromCommit, currentCommit);

    // If null, commits are on divergent branches (e.g., wiki generated on feature branch,
    // now running on main). Fall back to full generation.
    if (changedFiles === null) {
      this.onProgress('incremental', 10, 'Branch diverged, running full generation...');
      await this.removeFailedPages(existingMeta);
      const fullResult = await this.fullGeneration(currentCommit);
      return { ...fullResult, mode: 'incremental' };
    }

    if (changedFiles.length === 0 && !existingMeta.failedModules?.length) {
      // No file changes but commit differs (e.g. merge commit)
      await this.saveWikiMeta({
        ...existingMeta,
        fromCommit: currentCommit,
        generatedAt: new Date().toISOString(),
        lang: this.effectiveLang(),
      });
      return { pagesGenerated: 0, mode: 'incremental', failedModules: [] };
    }

    this.onProgress('incremental', 10, `${changedFiles.length} files changed`);

    // Determine affected modules
    const affectedModules = new Set(existingMeta.failedModules ?? []);
    const newFiles: string[] = [];
    // A file no module lists is new when the graph indexes it and its path did
    // not exist at the last generation. An edit to a file a reviewed tree left
    // out, or a path the graph skips, is neither grouped nor added to a module.
    const added = new Set(this.getAddedFiles(existingMeta.fromCommit, currentCommit));
    const indexed = new Set(added.size > 0 ? await getAllFiles() : []);

    for (const fp of changedFiles) {
      let found = false;
      // Every module that lists the file, not only the first: a sub-module's
      // files are also listed under its parent, parent first (extractModuleFiles).
      // The sub-module page documents the file, and the parent page is written
      // from the sub-module pages, so both are regenerated, leaves first.
      for (const [mod, files] of Object.entries(existingMeta.moduleFiles)) {
        if (files.includes(fp)) {
          affectedModules.add(mod);
          found = true;
        }
      }
      if (!found && added.has(fp) && indexed.has(fp) && !shouldIgnorePath(fp)) {
        newFiles.push(fp);
      }
    }

    // If significant new files exist, re-run full grouping
    if (newFiles.length > 5) {
      await this.removeFailedPages(existingMeta);
      this.onProgress(
        'incremental',
        15,
        'Significant new files detected, running full generation...',
      );
      const fullResult = await this.fullGeneration(currentCommit, {
        meta: existingMeta,
        changedFiles,
      });
      return { ...fullResult, mode: 'incremental' };
    }

    // Add new files to nearest module or "Other"
    if (newFiles.length > 0) {
      if (!existingMeta.moduleFiles['Other']) {
        existingMeta.moduleFiles['Other'] = [];
      }
      existingMeta.moduleFiles['Other'].push(...newFiles);
      affectedModules.add('Other');
    }

    // Regenerate affected module pages (parallel)
    let pagesGenerated = 0;
    const moduleTree = existingMeta.moduleTree;
    const affectedArray = Array.from(affectedModules);

    this.onProgress('incremental', 20, `Regenerating ${affectedArray.length} module(s)...`);

    const removePage = (node: ModuleTreeNode): Promise<void> =>
      fs.rm(path.join(this.wikiDir, `${node.slug}.md`), { force: true });
    const affectedNodes: ModuleTreeNode[] = [];
    for (const mod of affectedArray) {
      const node = this.findModule(moduleTree, mod);
      if (node) {
        // A parent page is removed just before it is regenerated, below, so a
        // parent held back by a failed sub-module keeps its last page.
        if (!node.children?.length) await removePage(node);
        affectedNodes.push(node);
      }
    }

    let incProcessed = 0;
    const regenerateNode = async (node: ModuleTreeNode): Promise<number> => {
      try {
        if (node.children && node.children.length > 0) {
          await this.generateParentPage(node);
        } else {
          await this.generateLeafPage(node);
        }
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
    };

    const leaves = affectedNodes.filter((node) => !node.children?.length);
    const parents = affectedNodes.filter((node) => node.children?.length);
    pagesGenerated += await this.runParallel(leaves, regenerateNode);
    for (const node of parents) {
      if (node.children?.some((child) => this.failedModules.includes(child.name))) {
        this.failedModules.push(node.name);
        continue;
      }
      await removePage(node);
      pagesGenerated += await regenerateNode(node);
    }

    // Regenerate overview if any pages changed
    if (pagesGenerated > 0) {
      this.onProgress('incremental', 85, 'Updating overview...');
      await this.generateOverview(moduleTree);
      pagesGenerated++;
    }

    // Save updated metadata
    this.onProgress('incremental', 95, 'Saving metadata...');
    await this.saveWikiMeta({
      ...existingMeta,
      fromCommit: currentCommit,
      generatedAt: new Date().toISOString(),
      model: this.llmConfig.model,
      lang: this.effectiveLang(),
      failedModules: [...this.failedModules],
    });

    this.onProgress('done', 100, 'Incremental update complete');
    return { pagesGenerated, mode: 'incremental', failedModules: [...this.failedModules] };
  }

  /**
   * Before a full generation, which keeps the pages it finds, remove the pages
   * of the modules the last run could not write. A parent held back by a
   * failed sub-module still has its previous page, and a full generation
   * would leave that page as it is and drop the retry.
   */
  private async removeFailedPages(meta: WikiMeta): Promise<void> {
    for (const name of meta.failedModules ?? []) {
      const node = this.findModule(meta.moduleTree, name);
      if (node) await fs.rm(path.join(this.wikiDir, `${node.slug}.md`), { force: true });
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  private runGit(args: string[]): string {
    if (!this.gitExecutable) throw new Error('Git unavailable for wiki generation');
    return execFileSync(this.gitExecutable, args, {
      cwd: this.repoPath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  }

  private getCurrentCommit(): string {
    try {
      return this.runGit(['rev-parse', 'HEAD']).trim();
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
      this.runGit(['merge-base', '--is-ancestor', fromCommit, toCommit]);
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
      return this.diffPaths(fromCommit, toCommit);
    } catch {
      return null; // Treat git errors as needing full regen
    }
  }

  /** The changed paths that did not exist at `fromCommit`, a moved file's new path included. */
  private getAddedFiles(fromCommit: string, toCommit: string): string[] {
    try {
      return this.diffPaths(fromCommit, toCommit, ['--no-renames', '--diff-filter=A']);
    } catch {
      return [];
    }
  }

  /** The paths `git diff` lists between two commits, unquoted, as the graph stores them. */
  private diffPaths(fromCommit: string, toCommit: string, options: string[] = []): string[] {
    return this.runGit(['diff', '-z', '--name-only', ...options, `${fromCommit}..${toCommit}`])
      .split('\0')
      .filter(Boolean);
  }

  private async readSourceFiles(filePaths: string[]): Promise<string> {
    const parts: string[] = [];
    for (const fp of filePaths) {
      const fullPath = path.join(this.repoPath, fp);
      try {
        const content = await fs.readFile(fullPath, 'utf-8');
        parts.push(sourceSection(fp, content));
      } catch {
        parts.push(sourceSection(fp, UNREADABLE_FILE));
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

  /**
   * Estimated tokens each file takes in a module page prompt: its section
   * from readSourceFiles, the placeholder for a file it cannot read, and the
   * newline joining it to the next one.
   */
  private async estimateFileTokens(filePaths: string[]): Promise<Map<string, number>> {
    const tokens = new Map<string, number>();
    for (const fp of filePaths) {
      let content: string;
      try {
        content = await fs.readFile(path.join(this.repoPath, fp), 'utf-8');
      } catch {
        content = UNREADABLE_FILE;
      }
      tokens.set(fp, estimateTokens(`${sourceSection(fp, content)}\n`));
    }
    return tokens;
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

  /**
   * The node of a module that meta.json names: the node of that name, else the
   * node whose page the name gives. A tree edited on --review can give a
   * module a page name that does not come from its name.
   */
  private findModule(tree: ModuleTreeNode[], name: string): ModuleTreeNode | null {
    const byName = (nodes: ModuleTreeNode[]): ModuleTreeNode | null => {
      for (const node of nodes) {
        if (node.name === name) return node;
        const found = byName(node.children ?? []);
        if (found) return found;
      }
      return null;
    };
    return byName(tree) ?? this.findNodeBySlug(tree, this.slugify(name));
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
      .slice(0, MAX_SLUG_LENGTH);
  }

  /**
   * `${moduleName} — ${label}`, followed by a number when its slug is taken:
   * slugs fold case and punctuation and keep MAX_SLUG_LENGTH characters, so
   * two pages can meet on one page file. The number must survive that cut,
   * so the module name loses words first and the label keeps the directory
   * it names. The slug used is added to `taken`.
   */
  private uniqueModuleName(moduleName: string, label: string, taken: Set<string>): string {
    let name = `${moduleName} — ${label}`;
    for (let n = 2; taken.has(this.slugify(name)); n++) {
      name = this.numberedPageName(moduleName, label, n);
    }
    taken.add(this.slugify(name));
    return name;
  }

  private numberedPageName(moduleName: string, label: string, n: number): string {
    const fits = (name: string): boolean => this.slugify(name).length < MAX_SLUG_LENGTH;
    const words = moduleName.split(/\s+/).filter(Boolean);
    for (let count = words.length; count > 0; count--) {
      const head = words
        .slice(0, count)
        .join(' ')
        .replace(/[\s,;:.—–-]+$/, '');
      if (head && fits(`${head} — ${label} ${n}`)) return `${head} — ${label} ${n}`;
    }
    if (fits(`${label} ${n}`)) return `${label} ${n}`;
    // The label alone is too long: keep its end, where the directory it names is.
    let tail = label;
    while (tail.length > 1 && !fits(`…${tail} ${n}`)) tail = tail.slice(1);
    return `…${tail} ${n}`;
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
    await fs.writeFile(
      path.join(this.wikiDir, 'module_tree.json'),
      JSON.stringify(tree, null, 2),
      'utf-8',
    );
  }

  /**
   * Drop the saved grouping before a forced run, so that buildModuleTree asks
   * the model to group the files again, unless module_tree.json holds a tree
   * to keep (see keepsSavedTree).
   */
  private async discardSavedGrouping(meta: WikiMeta | null): Promise<void> {
    await fs.rm(path.join(this.wikiDir, 'first_module_tree.json'), { force: true });
    if (meta && !(await this.keepsSavedTree(meta))) {
      await fs.rm(path.join(this.wikiDir, 'module_tree.json'), { force: true });
    }
  }

  /**
   * Whether a run that groups the files again should still use module_tree.json.
   * buildModuleTree reads that file first, as a tree the user edited, but every
   * completed generation also writes it for the HTML viewer. While it holds the
   * tree meta.json records, it is that generation's copy rather than an edit,
   * unless the user has just approved it on --review.
   */
  private async keepsSavedTree(meta: WikiMeta): Promise<boolean> {
    if (this.options.useSavedTree) return true;
    const saved = await this.readSavedTree('module_tree.json');
    // A tool that only reorders keys or reindents the file has not edited it.
    return saved !== null && keyOrderFreeJson(saved) !== keyOrderFreeJson(meta.moduleTree);
  }

  /** The tree saved in a file of the wiki folder; null when it is missing, empty or not JSON. */
  private async readSavedTree(file: string): Promise<ModuleTreeNode[] | null> {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(this.wikiDir, file), 'utf-8'));
      return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * Before a full generation that groups an existing wiki's files again,
   * delete the pages the new tree makes stale: the generation writes the pages
   * that are missing and keeps the others. meta.json records the regrouping
   * first, so a run that stops before the end does not leave the previous wiki
   * marked complete, and the next run takes it up (see incrementalUpdate).
   */
  private async removeStalePages(
    tree: ModuleTreeNode[],
    currentCommit: string,
    { meta, changedFiles }: Regrouping,
  ): Promise<void> {
    let pending = meta.regrouping;
    if (!pending) {
      pending = {
        commit: currentCommit,
        tree,
        keptPages: this.keptPages(tree, meta.moduleTree, changedFiles),
        staleRemoved: false,
      };
      await this.saveWikiMeta({ ...meta, regrouping: pending });
    }
    if (pending.staleRemoved) return;
    await this.removePagesExcept(pending.keptPages, meta.moduleTree, pending.tree);
    await this.saveWikiMeta({ ...meta, regrouping: { ...pending, staleRemoved: true } });
  }

  /**
   * The pages of the previous wiki that a new tree keeps as they are. A page
   * is kept when the previous tree has a module with its slug, name, files and
   * sub-modules, and none of the files changed; a parent page also needs each
   * of its sub-module pages kept.
   */
  private keptPages(
    tree: ModuleTreeNode[],
    previous: ModuleTreeNode[],
    changedFiles: string[],
  ): string[] {
    const changed = new Set(changedFiles);
    const { leaves, parents } = this.flattenModuleTree(previous);
    const before = new Map([...leaves, ...parents].map((node) => [node.slug, node]));
    const sameSet = (a: string[] = [], b: string[] = []): boolean => {
      const set = new Set(a);
      return set.size === new Set(b).size && b.every((item) => set.has(item));
    };
    const childSlugs = (node: ModuleTreeNode) => (node.children ?? []).map((child) => child.slug);
    const unchanged = (node: ModuleTreeNode): boolean => {
      const old = before.get(node.slug);
      return (
        old !== undefined &&
        old.name === node.name &&
        sameSet(old.files, node.files) &&
        sameSet(childSlugs(old), childSlugs(node)) &&
        !(node.files ?? []).some((file) => changed.has(file))
      );
    };
    const kept: string[] = [];
    for (const node of tree) {
      const children = node.children ?? [];
      const keptChildren = children.filter(unchanged);
      kept.push(...keptChildren.map((child) => child.slug));
      if (keptChildren.length === children.length && unchanged(node)) kept.push(node.slug);
    }
    return kept;
  }

  /** Delete the pages of the modules of the trees, apart from the `kept` ones. */
  private async removePagesExcept(kept: string[], ...trees: ModuleTreeNode[][]): Promise<void> {
    const keep = new Set(kept);
    for (const tree of trees) {
      const { leaves, parents } = this.flattenModuleTree(tree);
      for (const { slug } of [...leaves, ...parents]) {
        if (!keep.has(slug)) await fs.rm(path.join(this.wikiDir, `${slug}.md`), { force: true });
      }
    }
  }

  /**
   * Take back a regrouping that an earlier run started and did not complete:
   * delete the pages it may have written, and list the modules of this wiki
   * whose pages are gone as failed, which makes this run write them again.
   */
  private async abandonRegrouping(meta: WikiMeta, pending: PendingRegrouping): Promise<WikiMeta> {
    await this.removePagesExcept(pending.keptPages, meta.moduleTree, pending.tree);
    const kept = new Set(pending.keptPages);
    const { leaves, parents } = this.flattenModuleTree(meta.moduleTree);
    const gone = [...leaves, ...parents].filter((node) => !kept.has(node.slug));
    const previous: WikiMeta = {
      ...meta,
      failedModules: [
        ...new Set([...(meta.failedModules ?? []), ...gone.map((node) => node.name)]),
      ],
    };
    delete previous.regrouping;
    return previous;
  }
}
