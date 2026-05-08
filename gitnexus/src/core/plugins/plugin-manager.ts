// src/core/plugins/plugin-manager.ts

import * as fs from 'fs';
import * as path from 'path';
import {
  Plugin,
  ParserPlugin,
  AnalyzerPlugin,
  ProcessorPlugin,
  IntegrationPlugin,
  PluginRegistry,
  ParserRegistry,
  AnalyzerRegistry,
  ProcessorRegistry,
  IntegrationRegistry,
  PluginStatus,
  PluginLoadOptions,
  EventEmitter,
  PluginEvent,
} from './types.js';

/**
 * 事件发射器实现
 */
class PluginEventEmitter implements EventEmitter {
  private listeners: Map<string, Set<(event: PluginEvent) => void>> = new Map();

  on(event: string, listener: (event: PluginEvent) => void): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(listener);
  }

  once(event: string, listener: (event: PluginEvent) => void): void {
    const onceListener = (evt: PluginEvent) => {
      listener(evt);
      this.off(event, onceListener);
    };
    this.on(event, onceListener);
  }

  off(event: string, listener: (event: PluginEvent) => void): void {
    if (this.listeners.has(event)) {
      this.listeners.get(event)!.delete(listener);
    }
  }

  emit(event: string, data: any): void {
    if (this.listeners.has(event)) {
      for (const listener of this.listeners.get(event)!) {
        listener({ type: event as any, data });
      }
    }
  }
}

/**
 * 解析器注册表实现
 */
class DefaultParserRegistry implements ParserRegistry {
  private parsers: Map<string, ParserPlugin> = new Map();

  registerParser(parser: ParserPlugin): void {
    this.parsers.set(parser.name, parser);
  }

  getParser(filePath: string): ParserPlugin | undefined {
    for (const parser of this.parsers.values()) {
      if (parser.supports(filePath)) {
        return parser;
      }
    }
    return undefined;
  }

  getParsers(): ParserPlugin[] {
    return Array.from(this.parsers.values());
  }

  unregisterParser(name: string): void {
    this.parsers.delete(name);
  }
}

/**
 * 分析器注册表实现
 */
class DefaultAnalyzerRegistry implements AnalyzerRegistry {
  private analyzers: Map<string, AnalyzerPlugin> = new Map();

  registerAnalyzer(analyzer: AnalyzerPlugin): void {
    this.analyzers.set(analyzer.name, analyzer);
  }

  getAnalyzers(language?: string): AnalyzerPlugin[] {
    if (language) {
      return Array.from(this.analyzers.values()).filter((analyzer) => analyzer.supports(language));
    }
    return Array.from(this.analyzers.values());
  }

  unregisterAnalyzer(name: string): void {
    this.analyzers.delete(name);
  }
}

/**
 * 处理器注册表实现
 */
class DefaultProcessorRegistry implements ProcessorRegistry {
  private processors: Map<string, ProcessorPlugin> = new Map();

  registerProcessor(processor: ProcessorPlugin): void {
    this.processors.set(processor.name, processor);
  }

  getProcessors(phase?: string): ProcessorPlugin[] {
    let processors = Array.from(this.processors.values());
    if (phase) {
      processors = processors
        .filter((processor) => processor.phase === phase)
        .sort((a, b) => (b.priority || 0) - (a.priority || 0));
    }
    return processors;
  }

  unregisterProcessor(name: string): void {
    this.processors.delete(name);
  }
}

/**
 * 集成注册表实现
 */
class DefaultIntegrationRegistry implements IntegrationRegistry {
  private integrations: Map<string, IntegrationPlugin> = new Map();

  registerIntegration(integration: IntegrationPlugin): void {
    this.integrations.set(integration.name, integration);
  }

  getIntegration(target: string): IntegrationPlugin | undefined {
    return Array.from(this.integrations.values()).find(
      (integration) => integration.target === target,
    );
  }

  getIntegrations(): IntegrationPlugin[] {
    return Array.from(this.integrations.values());
  }

  unregisterIntegration(name: string): void {
    this.integrations.delete(name);
  }
}

/**
 * 解析插件入口文件
 */
function resolvePluginEntry(pluginPath: string): string {
  // 如果是文件，直接返回
  const stat = fs.statSync(pluginPath);
  if (!stat.isDirectory()) return pluginPath;

  // 检查 package.json 的 main 字段
  const packageJsonPath = path.join(pluginPath, 'package.json');
  let mainEntry: string | undefined;
  if (fs.existsSync(packageJsonPath)) {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    mainEntry = packageJson.main;
  }

  if (mainEntry) {
    const resolvedMain = path.join(pluginPath, mainEntry);
    if (fs.existsSync(resolvedMain)) {
      return resolvedMain;
    }
    // main 指向的文件不存在，回退到源码
  }

  // 尝试 index.mjs, index.js, index.ts
  for (const entry of ['index.mjs', 'index.js', 'src/index.ts', 'src/index.mjs']) {
    const fullPath = path.join(pluginPath, entry);
    if (fs.existsSync(fullPath)) {
      return fullPath;
    }
  }

  throw new Error(
    `Cannot find plugin entry in directory: ${pluginPath}. ` +
      `Add a "main" field to package.json pointing to a built file, or create index.js/index.mjs`,
  );
}

/**
 * 插件管理器
 */
export class PluginManager implements PluginRegistry {
  private plugins: Map<string, Plugin> = new Map();
  private pluginStatuses: Map<string, PluginStatus> = new Map();
  private eventEmitter: EventEmitter = new PluginEventEmitter();

  // 注册表
  public parserRegistry: ParserRegistry = new DefaultParserRegistry();
  public analyzerRegistry: AnalyzerRegistry = new DefaultAnalyzerRegistry();
  public processorRegistry: ProcessorRegistry = new DefaultProcessorRegistry();
  public integrationRegistry: IntegrationRegistry = new DefaultIntegrationRegistry();

  /**
   * 注册插件
   */
  registerPlugin(plugin: Plugin): void {
    this.plugins.set(plugin.name, plugin);

    // 注册到相应的注册表
    if (this.isParserPlugin(plugin)) {
      plugin.register(this.parserRegistry);
    } else if (this.isAnalyzerPlugin(plugin)) {
      plugin.register(this.analyzerRegistry);
    } else if (this.isProcessorPlugin(plugin)) {
      plugin.register(this.processorRegistry);
    } else if (this.isIntegrationPlugin(plugin)) {
      plugin.register(this.integrationRegistry);
    }

    // 设置默认状态
    this.pluginStatuses.set(plugin.name, {
      name: plugin.name,
      version: plugin.version,
      enabled: true,
      type: this.getPluginType(plugin),
    });

    // 触发事件
    this.eventEmitter.emit('plugin.loaded', { pluginName: plugin.name });
  }

  /**
   * 获取插件
   */
  getPlugin(name: string): Plugin | undefined {
    return this.plugins.get(name);
  }

  /**
   * 获取所有插件
   */
  getPlugins(): Plugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * 注销插件
   */
  unregisterPlugin(name: string): void {
    const plugin = this.plugins.get(name);
    if (plugin) {
      // 清理资源
      if (plugin.dispose) {
        plugin.dispose().catch(console.error);
      }

      // 从注册表中移除
      if (this.isParserPlugin(plugin)) {
        this.parserRegistry.unregisterParser(name);
      } else if (this.isAnalyzerPlugin(plugin)) {
        this.analyzerRegistry.unregisterAnalyzer(name);
      } else if (this.isProcessorPlugin(plugin)) {
        this.processorRegistry.unregisterProcessor(name);
      } else if (this.isIntegrationPlugin(plugin)) {
        this.integrationRegistry.unregisterIntegration(name);
      }

      // 从插件列表中移除
      this.plugins.delete(name);
      this.pluginStatuses.delete(name);

      // 触发事件
      this.eventEmitter.emit('plugin.unloaded', { pluginName: name });
    }
  }

  /**
   * 启用插件
   */
  enablePlugin(name: string): void {
    const status = this.pluginStatuses.get(name);
    if (status) {
      status.enabled = true;
      this.eventEmitter.emit('plugin.enabled', { pluginName: name });
    }
  }

  /**
   * 禁用插件
   */
  disablePlugin(name: string): void {
    const status = this.pluginStatuses.get(name);
    if (status) {
      status.enabled = false;
      this.eventEmitter.emit('plugin.disabled', { pluginName: name });
    }
  }

  /**
   * 获取插件状态
   */
  getPluginStatus(name: string): PluginStatus | undefined {
    return this.pluginStatuses.get(name);
  }

  /**
   * 加载插件
   */
  async loadPlugin(options: PluginLoadOptions): Promise<Plugin> {
    try {
      const { pluginPath, config = {}, enabled = true } = options;

      // 加载插件模块
      let pluginModule;
      if (pluginPath.startsWith('.')) {
        // 相对路径
        const resolvedPath = path.resolve(process.cwd(), pluginPath);
        const entryPath = resolvePluginEntry(resolvedPath);
        pluginModule = await import(`file://${entryPath}`);
      } else if (pluginPath.startsWith('gitnexus-')) {
        // npm 包
        pluginModule = await import(pluginPath);
      } else {
        // 绝对路径
        const entryPath = resolvePluginEntry(pluginPath);
        pluginModule = await import(`file://${entryPath}`);
      }

      // 获取插件实例
      const plugin = pluginModule.default || pluginModule;

      if (!plugin || typeof plugin !== 'object') {
        throw new Error('Invalid plugin: must export a plugin instance');
      }

      // 初始化插件
      if (plugin.init) {
        await plugin.init(config);
      }

      // 注册插件
      this.registerPlugin(plugin);

      // 设置启用状态
      if (!enabled) {
        this.disablePlugin(plugin.name);
      }

      return plugin;
    } catch (error) {
      const errorMessage = (error as Error).message;
      console.error(`Failed to load plugin: ${errorMessage}`);
      throw error;
    }
  }

  /**
   * 加载多个插件
   */
  async loadPlugins(pluginPaths: string[]): Promise<Plugin[]> {
    const plugins: Plugin[] = [];

    for (const pluginPath of pluginPaths) {
      try {
        const plugin = await this.loadPlugin({ pluginPath });
        plugins.push(plugin);
      } catch (error) {
        console.error(`Failed to load plugin ${pluginPath}:`, error);
        this.eventEmitter.emit('plugin.error', {
          pluginName: pluginPath,
          error: (error as Error).message,
        });
      }
    }

    return plugins;
  }

  /**
   * 扫描并加载插件
   */
  async scanAndLoadPlugins(pluginsDir: string): Promise<Plugin[]> {
    if (!fs.existsSync(pluginsDir)) {
      return [];
    }

    const pluginPaths: string[] = [];
    const files = fs.readdirSync(pluginsDir);

    for (const file of files) {
      const filePath = path.join(pluginsDir, file);
      const stat = fs.statSync(filePath);

      if (stat.isDirectory()) {
        // 检查是否是插件目录
        const packageJsonPath = path.join(filePath, 'package.json');
        if (fs.existsSync(packageJsonPath)) {
          const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
          if (packageJson.gitnexus?.plugin) {
            pluginPaths.push(filePath);
          }
        }
      } else if (file.endsWith('.js') || file.endsWith('.ts')) {
        // 直接加载 JS/TS 文件
        pluginPaths.push(filePath);
      }
    }

    return this.loadPlugins(pluginPaths);
  }

  /**
   * 监听事件
   */
  on(event: string, listener: (event: PluginEvent) => void): void {
    this.eventEmitter.on(event, listener);
  }

  /**
   * 监听事件（仅一次）
   */
  once(event: string, listener: (event: PluginEvent) => void): void {
    this.eventEmitter.once(event, listener);
  }

  /**
   * 移除事件监听
   */
  off(event: string, listener: (event: PluginEvent) => void): void {
    this.eventEmitter.off(event, listener);
  }

  /**
   * 检查是否为解析器插件
   */
  private isParserPlugin(plugin: any): plugin is ParserPlugin {
    return typeof plugin.parse === 'function' && Array.isArray(plugin.extensions);
  }

  /**
   * 检查是否为分析器插件
   */
  private isAnalyzerPlugin(plugin: any): plugin is AnalyzerPlugin {
    return typeof plugin.analyze === 'function' && Array.isArray(plugin.languages);
  }

  /**
   * 检查是否为处理器插件
   */
  private isProcessorPlugin(plugin: any): plugin is ProcessorPlugin {
    return typeof plugin.process === 'function' && typeof plugin.phase === 'string';
  }

  /**
   * 检查是否为集成插件
   */
  private isIntegrationPlugin(plugin: any): plugin is IntegrationPlugin {
    return typeof plugin.execute === 'function' && typeof plugin.target === 'string';
  }

  /**
   * 获取插件类型
   */
  private getPluginType(plugin: Plugin): 'parser' | 'analyzer' | 'processor' | 'integration' {
    if (this.isParserPlugin(plugin)) return 'parser';
    if (this.isAnalyzerPlugin(plugin)) return 'analyzer';
    if (this.isProcessorPlugin(plugin)) return 'processor';
    if (this.isIntegrationPlugin(plugin)) return 'integration';
    return 'parser';
  }
}

/**
 * 全局插件管理器实例
 */
export const pluginManager = new PluginManager();

/**
 * 导出插件管理器
 */
export default pluginManager;
