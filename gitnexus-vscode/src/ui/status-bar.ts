import * as vscode from 'vscode';
import { GitNexusService } from '../services/gitnexus-service';

export class GitNexusStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;

  constructor(private readonly service: GitNexusService) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
    this.item.name = 'GitNexus Status';
    this.item.tooltip = 'GitNexus index status';
  }

  show(): void {
    this.item.show();
  }

  async refresh(): Promise<void> {
    const status = await this.service.getWorkspaceStatus();

    if (status.state === 'not-indexed') {
      this.item.text = '$(warning) GitNexus: Not Indexed';
      this.item.tooltip = 'No GitNexus index found for this workspace.';
      this.item.command = 'gitnexus.analyzeWorkspace';
      return;
    }

    if (status.state === 'stale') {
      this.item.text = '$(alert) GitNexus: Stale';
      this.item.tooltip = [
        `Repo: ${status.repo?.name ?? 'unknown'}`,
        `Indexed commit: ${status.repo?.lastCommit?.slice(0, 7) ?? 'unknown'}`,
        `Current commit: ${status.currentCommit?.slice(0, 7) ?? 'unknown'}`,
        'Run GitNexus analyze to refresh the graph.',
      ].join('\n');
      this.item.command = 'gitnexus.analyzeWorkspace';
      return;
    }

    this.item.text = '$(check) GitNexus: Fresh';
    this.item.tooltip = [
      `Repo: ${status.repo?.name ?? 'unknown'}`,
      `Indexed: ${status.repo?.indexedAt ?? 'unknown'}`,
      `Commit: ${status.currentCommit?.slice(0, 7) ?? status.repo?.lastCommit?.slice(0, 7) ?? 'unknown'}`,
    ].join('\n');
    this.item.command = 'gitnexus.refresh';
  }

  dispose(): void {
    this.item.dispose();
  }
}
