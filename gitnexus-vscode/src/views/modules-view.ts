import * as vscode from 'vscode';
import { GitNexusService } from '../services/gitnexus-service';

export class ModulesViewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
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

    try {
      const modules = await this.service.getModules();
      if (modules.length === 0) {
        return [this.createInfoItem('No modules found', 'Re-run gitnexus analyze if the graph is stale.')];
      }

      return modules.map((module) => {
        const item = new vscode.TreeItem(module.name, vscode.TreeItemCollapsibleState.None);
        item.description = `${module.symbols} symbols`;
        item.tooltip = module.cohesion
          ? `${module.name}\nSymbols: ${module.symbols}\nCohesion: ${module.cohesion}`
          : `${module.name}\nSymbols: ${module.symbols}`;
        item.iconPath = new vscode.ThemeIcon('symbol-namespace');
        item.command = {
          command: 'gitnexus.queryConcept',
          title: 'Query Module',
          arguments: [`module ${module.name}`],
        };
        return item;
      });
    } catch (error) {
      return [this.createInfoItem('Unable to load modules', error instanceof Error ? error.message : String(error))];
    }
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  private createInfoItem(label: string, tooltip: string): vscode.TreeItem {
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.tooltip = tooltip;
    item.iconPath = new vscode.ThemeIcon('info');
    return item;
  }
}
