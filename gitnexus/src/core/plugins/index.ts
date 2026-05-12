// src/core/plugins/index.ts
/* eslint-disable no-console */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'node:url';
import { pluginManager as _pm } from './plugin-manager.js';
import { loadPluginsFromConfig as _loadPlugins } from './plugin-loader.js';

/**
 * GitNexus 插件系统
 */

export * from './types.js';
export * from './plugin-manager.js';
export * from './plugin-loader.js';
export * from './plugin-hooks.js';

/**
 * 插件系统版本
 */
export const PLUGIN_SYSTEM_VERSION = '1.0.0';

/**
 * 插件系统状态
 */
export interface PluginSystemStatus {
  /** 插件系统版本 */
  version: string;
  /** 已加载的插件数量 */
  loadedPlugins: number;
  /** 启用的插件数量 */
  enabledPlugins: number;
  /** 插件系统状态 */
  status: 'active' | 'inactive' | 'error';
  /** 错误信息 */
  error?: string;
}

/**
 * 获取插件系统状态
 */
export function getPluginSystemStatus(): PluginSystemStatus {
  try {
    const plugins = _pm.getPlugins();
    const statuses = plugins.map((plugin) => _pm.getPluginStatus(plugin.name));
    const enabledPlugins = statuses.filter((status) => status?.enabled).length;

    return {
      version: PLUGIN_SYSTEM_VERSION,
      loadedPlugins: plugins.length,
      enabledPlugins,
      status: 'active',
    };
  } catch (error) {
    return {
      version: PLUGIN_SYSTEM_VERSION,
      loadedPlugins: 0,
      enabledPlugins: 0,
      status: 'error',
      error: (error as Error).message,
    };
  }
}

/**
 * 初始化插件系统
 */
export async function initializePluginSystem() {
  try {
    // 加载配置文件中的插件
    await _loadPlugins();

    // 加载默认插件
    await loadDefaultPlugins();

    console.log(`Plugin system initialized with ${_pm.getPlugins().length} plugins`);
  } catch (error) {
    console.error('Failed to initialize plugin system:', error);
    throw error;
  }
}

/**
 * 加载默认插件
 */
async function loadDefaultPlugins() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  const yamlPluginPath = path.resolve(__dirname, '../../../gitnexus-plugins/yaml-parser');
  if (fs.existsSync(yamlPluginPath)) {
    try {
      await _pm.loadPlugin({ pluginPath: yamlPluginPath, enabled: true });
    } catch (error) {
      console.warn('Failed to load yaml-parser plugin:', (error as Error).message);
    }
  }
}

/**
 * 关闭插件系统
 */
export async function shutdownPluginSystem() {
  try {
    const plugins = _pm.getPlugins();

    for (const plugin of plugins) {
      _pm.unregisterPlugin(plugin.name);
    }

    console.log('Plugin system shutdown');
  } catch (error) {
    console.error('Failed to shutdown plugin system:', error);
  }
}
