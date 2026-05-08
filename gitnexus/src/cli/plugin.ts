#!/usr/bin/env node

import { Command } from 'commander';
import { pluginManager, getPluginSystemStatus } from '../core/plugins/index.js';
import {
  loadPluginsFromConfig,
  addPluginToConfig,
  removePluginFromConfig,
  enablePluginInConfig,
  disablePluginInConfig,
  getPluginPaths,
} from '../core/plugins/plugin-loader.js';

/**
 * 插件管理命令
 */
export const pluginCommand = new Command('plugin')
  .description('Manage GitNexus plugins')
  .helpOption('-h, --help', 'Display help for command');

/**
 * 列出插件
 */
pluginCommand
  .command('list')
  .description('List all installed plugins')
  .action(async () => {
    try {
      await loadPluginsFromConfig();

      const plugins = pluginManager.getPlugins();
      const statuses = plugins.map((plugin) => pluginManager.getPluginStatus(plugin.name));

      console.log('Installed plugins:');
      console.log(
        '┌──────────────────────────────────────────────────────────────────────────────┐',
      );
      console.log(
        '│ Name                │ Version │ Type        │ Status │ Description          │',
      );
      console.log(
        '├──────────────────────────────────────────────────────────────────────────────┤',
      );

      plugins.forEach((plugin, index) => {
        const status = statuses[index];
        const name = plugin.name.padEnd(20);
        const version = (plugin.version || 'unknown').padEnd(8);
        const type = (status?.type || 'unknown').padEnd(12);
        const enabled = (status?.enabled ? 'enabled' : 'disabled').padEnd(8);
        const description = (plugin.description || '').padEnd(24);

        console.log(`│ ${name} │ ${version} │ ${type} │ ${enabled} │ ${description} │`);
      });

      console.log(
        '└──────────────────────────────────────────────────────────────────────────────┘',
      );

      if (plugins.length === 0) {
        console.log('No plugins installed.');
      }
    } catch (error) {
      console.error('Error listing plugins:', error);
    }
  });

/**
 * 加载插件
 */
pluginCommand
  .command('load <pluginPath>')
  .description('Load a plugin from a path or npm package')
  .option('-e, --enabled', 'Enable the plugin after loading', true)
  .option('-c, --config <config>', 'Plugin configuration JSON')
  .action(async (pluginPath, options) => {
    try {
      const config = options.config ? JSON.parse(options.config) : {};

      console.log(`Loading plugin from: ${pluginPath}`);
      const plugin = await pluginManager.loadPlugin({
        pluginPath,
        config,
        enabled: options.enabled,
      });

      // 添加到配置
      addPluginToConfig({
        name: plugin.name,
        enabled: options.enabled,
        config,
        path: pluginPath,
      });

      console.log(`✓ Plugin ${plugin.name} v${plugin.version} loaded successfully`);
    } catch (error) {
      console.error('Error loading plugin:', error);
    }
  });

/**
 * 卸载插件
 */
pluginCommand
  .command('unload <pluginName>')
  .description('Unload a plugin')
  .action(async (pluginName) => {
    try {
      console.log(`Unloading plugin: ${pluginName}`);
      pluginManager.unregisterPlugin(pluginName);

      // 从配置中移除
      removePluginFromConfig(pluginName);

      console.log(`✓ Plugin ${pluginName} unloaded successfully`);
    } catch (error) {
      console.error('Error unloading plugin:', error);
    }
  });

/**
 * 启用插件
 */
pluginCommand
  .command('enable <pluginName>')
  .description('Enable a plugin')
  .action(async (pluginName) => {
    try {
      console.log(`Enabling plugin: ${pluginName}`);
      pluginManager.enablePlugin(pluginName);

      // 更新配置
      enablePluginInConfig(pluginName);

      console.log(`✓ Plugin ${pluginName} enabled successfully`);
    } catch (error) {
      console.error('Error enabling plugin:', error);
    }
  });

/**
 * 禁用插件
 */
pluginCommand
  .command('disable <pluginName>')
  .description('Disable a plugin')
  .action(async (pluginName) => {
    try {
      console.log(`Disabling plugin: ${pluginName}`);
      pluginManager.disablePlugin(pluginName);

      // 更新配置
      disablePluginInConfig(pluginName);

      console.log(`✓ Plugin ${pluginName} disabled successfully`);
    } catch (error) {
      console.error('Error disabling plugin:', error);
    }
  });

/**
 * 插件系统状态
 */
pluginCommand
  .command('status')
  .description('Show plugin system status')
  .action(async () => {
    try {
      await loadPluginsFromConfig();

      const status = getPluginSystemStatus();

      console.log('Plugin system status:');
      console.log('┌──────────────────────────────────────────────────────────────┐');
      console.log(`│ Version:          ${status.version}                      │`);
      console.log(`│ Loaded plugins:   ${status.loadedPlugins}                 │`);
      console.log(`│ Enabled plugins:  ${status.enabledPlugins}                │`);
      console.log(`│ Status:           ${status.status}                       │`);
      if (status.error) {
        console.log(`│ Error:            ${status.error}                       │`);
      }
      console.log('└──────────────────────────────────────────────────────────────┘');
    } catch (error) {
      console.error('Error getting plugin system status:', error);
    }
  });

/**
 * 扫描插件
 */
pluginCommand
  .command('scan [pluginsDir]')
  .description('Scan for plugins in a directory')
  .action(async (pluginsDir = './plugins') => {
    try {
      console.log(`Scanning for plugins in: ${pluginsDir}`);

      // 扫描目录拿到插件路径
      const pluginPaths = getPluginPaths(pluginsDir);

      if (pluginPaths.length === 0) {
        console.log(`No plugins found in ${pluginsDir}`);
        return;
      }

      // 加载每个插件并保存到配置
      const loadedPlugins: any[] = [];
      for (const pluginPath of pluginPaths) {
        try {
          const plugin = await pluginManager.loadPlugin({
            pluginPath,
            config: {},
            enabled: true,
          });

          // 保存到配置
          addPluginToConfig({
            name: plugin.name,
            enabled: true,
            config: {},
            path: pluginPath,
          });

          loadedPlugins.push(plugin);
        } catch (err) {
          console.error(`Failed to load plugin ${pluginPath}:`, err);
        }
      }

      console.log(`✓ Scanned ${pluginsDir} and loaded ${loadedPlugins.length} plugins`);

      loadedPlugins.forEach((plugin) => {
        console.log(`  - ${plugin.name} v${plugin.version}`);
      });
    } catch (error) {
      console.error('Error scanning for plugins:', error);
    }
  });

export default pluginCommand;
