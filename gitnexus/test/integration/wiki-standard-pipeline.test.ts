/**
 * 标准化文档生成路径端到端集成测试
 *
 * 使用真实 LadybugDB 驱动完整链路:
 *   证据收集 → 文档计划 → manifest 创建 → 发布
 *
 * 不测试 LLM 实际调用——直接构造已生成的输出 payload,验证管线装配、
 * 证据流转、manifest 校验和发布原子性。
 */
import { afterAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { withTestLbugDB } from '../helpers/test-indexed-db.js';
import { closeWikiDb, initWikiDb } from '../../src/core/wiki/graph-queries.js';
import { EvidenceCollector } from '../../src/core/wiki/document/evidence-collector.js';
import { createDocumentPlan } from '../../src/core/wiki/document/planner.js';
import { WikiPublisher } from '../../src/core/wiki/document/publisher.js';
import { resolveTemplateProfile } from '../../src/core/wiki/profiles/registry.js';
import { resolveLanguage } from '../../src/core/wiki/profiles/locale.js';
import { createOutputManifest } from '../../src/core/wiki/document/output-manifest.js';

// ─── 测试文件路径常量 ────────────────────────────────────────────────────

const CORE = 'src/core.ts';
const UTILS = 'src/utils.ts';
const INDEX = 'src/index.ts';

// ─── 种子数据辅助函数 ────────────────────────────────────────────────────

/** 构造 Function 节点属性字符串,与 LadybugDB schema 兼容 */
const fn = (file: string, name: string, isExported: boolean, line: number): string =>
  `{id: 'Function:${file}:${name}', name: '${name}', filePath: '${file}',
     startLine: ${line}, endLine: ${line}, isExported: ${isExported}, content: '', description: ''}`;

/** 构造 CodeRelation 边属性字符串 */
const rel = (type: string, step = 0): string =>
  `[:CodeRelation {type: '${type}', confidence: 1.0, reason: 'seed', step: ${step}}]`;

// ─── 种子数据 ──────────────────────────────────────────────────────────────
//
// 覆盖 EvidenceCollector 所需的全部图查询路径:
//   - getAllFiles: 3 个 File 节点
//   - getFilesWithExports: 3 个导出的 Function 节点
//   - getAllProcesses: 1 个 Process 节点 + 2 条 STEP_IN_PROCESS 边
//   - getIntraModuleCallEdges / getInterModuleCallEdges: 3 条 CALLS 边
//     (1 条跨文件模块内, 1 条同文件, 1 条跨模块)

const SEED: string[] = [
  // File 节点
  `CREATE (f:File {id: 'File:${CORE}', name: 'core.ts', filePath: '${CORE}', content: ''})`,
  `CREATE (f:File {id: 'File:${UTILS}', name: 'utils.ts', filePath: '${UTILS}', content: ''})`,
  `CREATE (f:File {id: 'File:${INDEX}', name: 'index.ts', filePath: '${INDEX}', content: ''})`,

  // 导出的顶层 Function 符号
  `CREATE (n:Function ${fn(CORE, 'runCore', true, 10)})`,
  `CREATE (n:Function ${fn(UTILS, 'formatOutput', true, 5)})`,
  `CREATE (n:Function ${fn(INDEX, 'main', true, 1)})`,

  // 未导出的内部辅助函数(不出现在 getFilesWithExports 结果中)
  `CREATE (n:Function ${fn(CORE, 'helper', false, 20)})`,

  // File → DEFINES 关系
  `MATCH (f:File), (n:Function) WHERE f.id = 'File:${CORE}' AND n.id = 'Function:${CORE}:runCore'
   CREATE (f)-${rel('DEFINES')}->(n)`,
  `MATCH (f:File), (n:Function) WHERE f.id = 'File:${UTILS}' AND n.id = 'Function:${UTILS}:formatOutput'
   CREATE (f)-${rel('DEFINES')}->(n)`,
  `MATCH (f:File), (n:Function) WHERE f.id = 'File:${INDEX}' AND n.id = 'Function:${INDEX}:main'
   CREATE (f)-${rel('DEFINES')}->(n)`,
  `MATCH (f:File), (n:Function) WHERE f.id = 'File:${CORE}' AND n.id = 'Function:${CORE}:helper'
   CREATE (f)-${rel('DEFINES')}->(n)`,

  // 调用边:跨文件模块内(core → utils)
  `MATCH (a:Function), (b:Function) WHERE a.id = 'Function:${CORE}:runCore' AND b.id = 'Function:${UTILS}:formatOutput'
   CREATE (a)-${rel('CALLS')}->(b)`,
  // 同文件调用(core → core)
  `MATCH (a:Function), (b:Function) WHERE a.id = 'Function:${CORE}:runCore' AND b.id = 'Function:${CORE}:helper'
   CREATE (a)-${rel('CALLS')}->(b)`,
  // 跨模块调用(index → core),用于测试 inter-module incoming 边
  `MATCH (a:Function), (b:Function) WHERE a.id = 'Function:${INDEX}:main' AND b.id = 'Function:${CORE}:runCore'
   CREATE (a)-${rel('CALLS')}->(b)`,

  // Process 节点
  `CREATE (p:Process {id: 'proc-main', label: 'Lproc-main', heuristicLabel: 'Main Flow',
     processType: 'intra_community', stepCount: 2, communities: [], entryPointId: '', terminalId: ''})`,

  // Process 步骤边(step 1: main, step 2: runCore,按升序验证排序)
  `MATCH (s:Function), (p:Process) WHERE s.id = 'Function:${INDEX}:main' AND p.id = 'proc-main'
   CREATE (s)-${rel('STEP_IN_PROCESS', 1)}->(p)`,
  `MATCH (s:Function), (p:Process) WHERE s.id = 'Function:${CORE}:runCore' AND p.id = 'proc-main'
   CREATE (s)-${rel('STEP_IN_PROCESS', 2)}->(p)`,
];

// ─── 端到端测试套件 ────────────────────────────────────────────────────────

withTestLbugDB(
  'wiki-standard-pipeline',
  (handle) => {
    // 临时 wiki 发布目录,在 afterAll 中清理
    let wikiDir: string | undefined;

    describe('e2e: 标准化文档生成路径全链路', () => {
      // 嵌套 afterAll:确保 wiki DB 在 withTestLbugDB 自身的 afterAll
      // 关闭底层 Database 之前被正确清理
      afterAll(async () => {
        await closeWikiDb();
        if (wikiDir) {
          await fs.rm(wikiDir, { recursive: true, force: true });
        }
      });

      it('证据收集 → 文档计划 → manifest → 发布', async () => {
        // ── 1. 证据收集 (EvidenceCollector 使用真实图查询) ──
        // repoPath 指向临时目录;文件不在磁盘上,collectFile 标记为 'missing',
        // 但 symbol/process/relation 证据来自图查询,状态为 'verified'
        const repoPath = handle.tmpHandle.dbPath;
        const collector = new EvidenceCollector(repoPath);
        const bundle = await collector.collect({
          sourceCommit: 'test-commit-001',
          moduleFiles: { Core: [CORE, UTILS] },
        });

        // 验证证据收集成功
        expect(bundle.repository.length).toBeGreaterThan(0);
        expect(bundle.sourceCommit).toBe('test-commit-001');
        expect(bundle.schemaVersion).toBe(1);

        // 验证模块级证据包含调用关系证据
        expect(bundle.modules['Core']).toBeDefined();
        expect(bundle.modules['Core']!.length).toBeGreaterThan(0);

        // ── 2. 文档计划创建 (使用 engineering-wiki profile) ──
        const profile = resolveTemplateProfile('engineering-wiki');
        const language = resolveLanguage('english', profile.profile);
        const plan = createDocumentPlan({
          profile,
          language,
          sourceCommit: 'test-commit-001',
          moduleTree: [],
          evidence: bundle,
        });

        // 验证计划创建成功
        expect(plan.sections.length).toBeGreaterThan(0);
        expect(plan.status).toBe('planned');
        expect(plan.dependencyOrder.length).toBeGreaterThan(0);
        expect(plan.profile.id).toBe('engineering-wiki');
        expect(plan.profile.fingerprint).toBe(profile.fingerprint);

        // ── 3. 构造输出文件和 manifest ──
        // 跳过 LLM 调用,直接构造已生成的 section payload 作为输出
        const entryContent = '# Engineering Wiki\n\nGenerated from test evidence.\n';
        const architectureContent = '# Architecture Design\n\nSystem architecture overview.\n';
        const coverageContent = JSON.stringify({ status: 'verified', sections: {} }) + '\n';
        const planContent =
          JSON.stringify({ schemaVersion: 1, status: 'planned', sections: [] }) + '\n';

        const files: Record<string, string> = {
          'engineering-wiki.md': entryContent,
          'architecture-design.md': architectureContent,
          'coverage.json': coverageContent,
          'document_plan.json': planContent,
        };

        const manifest = createOutputManifest({
          generationId: 'test-gen-001',
          profile: {
            id: profile.profile.id,
            revision: profile.profile.revision,
            fingerprint: profile.fingerprint,
          },
          language,
          sourceCommit: 'test-commit-001',
          generationSemanticsKey: 'a'.repeat(64),
          entry: {
            slug: 'overview',
            label: 'Engineering Wiki',
            file: 'engineering-wiki.md',
            content: entryContent,
          },
          pages: [
            {
              id: 'architecture-design',
              slug: 'architecture-design',
              label: 'Architecture Design',
              file: 'architecture-design.md',
              order: 0,
              status: 'verified',
              content: architectureContent,
            },
          ],
          coverage: { file: 'coverage.json', content: coverageContent },
          supportingArtifacts: [
            {
              role: 'document-plan',
              file: 'document_plan.json',
              content: planContent,
            },
          ],
        });

        // ── 4. 发布 ──
        wikiDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wiki-e2e-'));
        const publisher = new WikiPublisher();
        const result = await publisher.publish({
          wikiDir,
          manifest,
          files,
        });

        // 验证发布成功
        expect(result.current.generationId).toBe(manifest.generationId);
        expect(result.generationDir).toContain(manifest.generationId);

        // ── 5. 验证 current.json 指针 ──
        const currentPath = path.join(wikiDir, '.state', 'current.json');
        const currentContent = JSON.parse(await fs.readFile(currentPath, 'utf8'));
        expect(currentContent.generationId).toBe(manifest.generationId);
        expect(currentContent.manifestFile).toBe('manifest.json');

        // ── 6. 验证发布的文件内容 ──
        const entryFile = path.join(result.generationDir, 'engineering-wiki.md');
        const entryResult = await fs.readFile(entryFile, 'utf8');
        expect(entryResult).toContain('Engineering Wiki');

        const pageFile = path.join(result.generationDir, 'architecture-design.md');
        const pageResult = await fs.readFile(pageFile, 'utf8');
        expect(pageResult).toContain('Architecture Design');

        // 验证 manifest.json 被正确写入 generation 目录
        const manifestFile = path.join(result.generationDir, 'manifest.json');
        const manifestResult = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
        expect(manifestResult.generationId).toBe(manifest.generationId);
        expect(manifestResult.profile.id).toBe('engineering-wiki');
      });
    });
  },
  {
    seed: SEED,
    poolAdapter: true,
    // graph-queries.ts 内部使用固定 REPO_ID = '__wiki__'。
    // poolAdapter 将核心适配器的 Database 注入 pool 的 dbCache,
    // initWikiDb 调用 initLbug('__wiki__', dbPath) 时复用同一 Database
    // 而不是打开第二个文件锁。
    afterSetup: async (handle) => {
      await initWikiDb(handle.dbPath);
    },
  },
);
