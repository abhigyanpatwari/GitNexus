// src/core/plugins/plugin-hooks.ts

import { pluginManager } from './plugin-manager.js';
import { PipelineContext } from '../ingestion/pipeline-phases/types.js';
import { Node, Edge } from './types.js';

/**
 * 插件钩子系统
 * 用于在 GitNexus 处理流程中集成插件
 */

export class PluginHooks {
  /**
   * 在解析文件前调用
   */
  static async beforeParse(filePath: string, content: string): Promise<string> {
    // 可以在这里添加插件处理逻辑
    return content;
  }

  /**
   * 在解析文件后调用
   */
  static async afterParse(
    filePath: string,
    nodes: Node[],
    edges: Edge[],
  ): Promise<{ nodes: Node[]; edges: Edge[] }> {
    // 调用解析器插件
    const parser = pluginManager.parserRegistry.getParser(filePath);
    if (parser && pluginManager.getPluginStatus(parser.name)?.enabled) {
      try {
        const result = await parser.parse(nodes[0]?.properties?.content || '', filePath);
        if (result.nodes && result.edges) {
          return { nodes: result.nodes, edges: result.edges };
        }
      } catch (error) {
        console.error(`Error in parser plugin ${parser.name}:`, error);
      }
    }
    return { nodes, edges };
  }

  /**
   * 在分析代码前调用
   */
  static async beforeAnalyze(filePath: string, language: string, node: any): Promise<any> {
    // 可以在这里添加插件处理逻辑
    return node;
  }

  /**
   * 在分析代码后调用
   */
  static async afterAnalyze(
    filePath: string,
    language: string,
    node: any,
    result: any,
  ): Promise<any> {
    // 调用分析器插件
    const analyzers = pluginManager.analyzerRegistry.getAnalyzers(language);
    for (const analyzer of analyzers) {
      if (pluginManager.getPluginStatus(analyzer.name)?.enabled) {
        try {
          const analysisResult = await analyzer.analyze(node, {
            filePath,
            language,
            semanticModel: {},
            parser: {},
            config: {},
          });
          if (analysisResult.results && analysisResult.results.length > 0) {
            // 合并分析结果
            result.analysisResults = [...(result.analysisResults || []), ...analysisResult.results];
          }
        } catch (error) {
          console.error(`Error in analyzer plugin ${analyzer.name}:`, error);
        }
      }
    }
    return result;
  }

  /**
   * 在处理阶段前调用
   */
  static async beforeProcess(phase: string, data: any, context: PipelineContext): Promise<any> {
    // 调用处理器插件
    const processors = pluginManager.processorRegistry.getProcessors(phase);
    for (const processor of processors) {
      if (pluginManager.getPluginStatus(processor.name)?.enabled) {
        try {
          data = await processor.process(data, {
            phase,
            projectPath: context.repoPath,
            knowledgeGraph: context.graph,
            config: {},
          });
        } catch (error) {
          console.error(`Error in processor plugin ${processor.name}:`, error);
        }
      }
    }
    return data;
  }

  /**
   * 在处理阶段后调用
   */
  static async afterProcess(phase: string, data: any, context: PipelineContext): Promise<any> {
    // 可以在这里添加插件处理逻辑
    return data;
  }

  /**
   * 在管道开始前调用
   */
  static async beforePipeline(repoPath: string): Promise<void> {
    // 初始化插件系统
    const { initializePluginSystem } = await import('./index.js');
    await initializePluginSystem();
  }

  /**
   * 在管道完成后调用
   */
  static async afterPipeline(repoPath: string, result: any): Promise<any> {
    // 可以在这里添加插件处理逻辑
    return result;
  }

  /**
   * 执行集成操作
   */
  static async executeIntegration(target: string, data: any, context: any): Promise<any> {
    // 调用集成插件
    const integration = pluginManager.integrationRegistry.getIntegration(target);
    if (integration && pluginManager.getPluginStatus(integration.name)?.enabled) {
      try {
        const result = await integration.execute(data, {
          target,
          projectPath: context.repoPath || process.cwd(),
          knowledgeGraph: context.graph,
          config: {},
        });
        return result;
      } catch (error) {
        console.error(`Error in integration plugin ${integration.name}:`, error);
        return { success: false, error: (error as Error).message };
      }
    }
    return { success: false, error: `No integration plugin found for target: ${target}` };
  }
}

/**
 * 注册插件钩子到管道阶段
 */
export function registerPluginHooks() {
  // 这里可以注册钩子到具体的管道阶段
  console.log('Plugin hooks registered');
}

/**
 * 插件钩子类型
 */
export type PluginHookType =
  | 'beforeParse'
  | 'afterParse'
  | 'beforeAnalyze'
  | 'afterAnalyze'
  | 'beforeProcess'
  | 'afterProcess'
  | 'beforePipeline'
  | 'afterPipeline'
  | 'executeIntegration';

/**
 * 钩子执行选项
 */
export interface HookOptions {
  /** 插件名称过滤器 */
  pluginFilter?: string[];
  /** 执行超时时间（毫秒） */
  timeout?: number;
  /** 是否忽略错误 */
  ignoreErrors?: boolean;
}
