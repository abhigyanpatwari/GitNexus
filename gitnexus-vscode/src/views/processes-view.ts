import * as vscode from 'vscode';
import { GitNexusService } from '../services/gitnexus-service';

export class ProcessesViewProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
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
      const processes = await this.service.getProcesses();
      if (processes.length === 0) {
        return [this.createInfoItem('No execution flows found', 'Run gitnexus analyze to generate process traces.')];
      }

      return processes.map((process) => {
        const item = new vscode.TreeItem(process.name, vscode.TreeItemCollapsibleState.None);
        item.description = `${process.steps} steps`;
        item.tooltip = `${process.name}\nType: ${process.type}\nSteps: ${process.steps}`;
        item.iconPath = new vscode.ThemeIcon('debug-alt-small');
        item.command = {
          command: 'gitnexus.openProcessDetails',
          title: 'Open Process Details',
          arguments: [process.name],
        };
        return item;
      });
    } catch (error) {
      return [
        this.createInfoItem(
          'Unable to load execution flows',
          error instanceof Error ? error.message : String(error),
        ),
      ];
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
