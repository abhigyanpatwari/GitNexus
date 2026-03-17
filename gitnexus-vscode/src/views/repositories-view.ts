import * as vscode from 'vscode';
import type { RepoRegistryEntry } from '../types';
import { GitNexusService } from '../services/gitnexus-service';

export class RepositoriesViewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  constructor(private readonly service: GitNexusService) {}

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element) {
      return [];
    }

    const repos = await this.service.listRepos();
    const serverStatusItem = this.createServerStatusItem();
    const activeRepo = this.service.getActiveRepo()?.name;

    if (repos.length === 0) {
      return [
        serverStatusItem,
        this.createInfoItem('No indexed repositories', 'Run GitNexus: Analyze Workspace to build an index.'),
      ];
    }

    return [
      serverStatusItem,
      ...repos.map((repo) => this.createRepoItem(repo, repo.name === activeRepo)),
    ];
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  private createRepoItem(repo: RepoRegistryEntry, isActive: boolean): vscode.TreeItem {
    const label = isActive ? `${repo.name} (active)` : repo.name;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);

    item.description = repo.path;
    item.tooltip = this.repoTooltip(repo);
    item.iconPath = new vscode.ThemeIcon(isActive ? 'check' : 'repo');
    item.command = {
      command: 'gitnexus.setActiveRepository',
      title: 'Set Active Repository',
      arguments: [repo.name],
    };
    item.contextValue = 'gitnexusRepo';

    return item;
  }

  private repoTooltip(repo: RepoRegistryEntry): string {
    const stats = repo.stats;
    if (!stats) {
      return `${repo.name}\n${repo.path}`;
    }

    return [
      repo.name,
      repo.path,
      `Files: ${stats.files ?? 0}`,
      `Symbols: ${stats.nodes ?? 0}`,
      `Processes: ${stats.processes ?? 0}`,
    ].join('\n');
  }

  private createInfoItem(label: string, tooltip: string): vscode.TreeItem {
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.tooltip = tooltip;
    item.iconPath = new vscode.ThemeIcon('info');
    return item;
  }

  private createServerStatusItem(): vscode.TreeItem {
    const running = this.service.isMcpServerRunning();
    const item = new vscode.TreeItem(
      running ? 'MCP Server: Running' : 'MCP Server: Stopped',
      vscode.TreeItemCollapsibleState.None,
    );

    item.tooltip = running
      ? 'GitNexus MCP server is connected and responding.'
      : 'GitNexus MCP server is not connected yet. Trigger refresh or run a GitNexus command.';
    item.iconPath = new vscode.ThemeIcon(running ? 'radio-tower' : 'debug-disconnect');
    item.contextValue = 'gitnexusServerStatus';
    return item;
  }
}
