import * as vscode from 'vscode';
import { GitNexusService } from './services/gitnexus-service';
import { RepositoriesViewProvider } from './views/repositories-view';
import { ModulesViewProvider } from './views/modules-view';
import { ProcessesViewProvider } from './views/processes-view';
import { GitNexusStatusBar } from './ui/status-bar';
import { GraphPanel } from './webview/graph-panel';
import { getSelectionOrWord } from './utils/workspace';
import { registerGitNexusParticipant } from './chat/participant';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('GitNexus');
  const service = new GitNexusService(output);

  await service.initialize();

  const wroteMcpConfig = await service.ensureMcpRegistration();
  if (wroteMcpConfig) {
    vscode.window.setStatusBarMessage('GitNexus: registered MCP server in .vscode/mcp.json', 5000);
  }

  const repositoriesView = new RepositoriesViewProvider(service);
  const modulesView = new ModulesViewProvider(service);
  const processesView = new ProcessesViewProvider(service);

  const statusBar = new GitNexusStatusBar(service);
  await statusBar.refresh();
  statusBar.show();

  context.subscriptions.push(
    output,
    service,
    statusBar,
    registerGitNexusParticipant(context, service, output),
    vscode.window.registerTreeDataProvider('gitnexus.repositoriesView', repositoriesView),
    vscode.window.registerTreeDataProvider('gitnexus.modulesView', modulesView),
    vscode.window.registerTreeDataProvider('gitnexus.processesView', processesView),
    registerCommand(context, 'gitnexus.refresh', async () => {
      await service.refreshRepos();
      repositoriesView.refresh();
      modulesView.refresh();
      processesView.refresh();
      await statusBar.refresh();
    }),
    registerCommand(context, 'gitnexus.analyzeWorkspace', async (resource?: vscode.Uri) => {
      service.runAnalyzeWorkspace(resource);
    }),
    registerCommand(context, 'gitnexus.openRepoContext', async () => {
      await presentOutput('GitNexus Repository Context', await service.getRepoContext(), 'yaml');
    }),
    registerCommand(context, 'gitnexus.exploreSymbol', async () => {
      const symbol = getSelectionOrWord(vscode.window.activeTextEditor);
      if (!symbol) {
        void vscode.window.showWarningMessage('Select a symbol or place the cursor on one first.');
        return;
      }

      await presentOutput(`GitNexus Context: ${symbol}`, await service.exploreSymbol(symbol));
    }),
    registerCommand(context, 'gitnexus.showImpact', async () => {
      const symbol = getSelectionOrWord(vscode.window.activeTextEditor);
      if (!symbol) {
        void vscode.window.showWarningMessage('Select a symbol or place the cursor on one first.');
        return;
      }

      await presentOutput(`GitNexus Impact: ${symbol}`, await service.impactSymbol(symbol));
    }),
    registerCommand(context, 'gitnexus.showInGraph', async () => {
      const symbol = getSelectionOrWord(vscode.window.activeTextEditor);
      await GraphPanel.show(context, service, symbol);
    }),
    registerCommand(context, 'gitnexus.openProcessDetails', async (processName?: string) => {
      if (!processName) {
        void vscode.window.showWarningMessage('Choose a process from the Execution Flows view first.');
        return;
      }

      await presentOutput(`GitNexus Process: ${processName}`, await service.getProcessDetails(processName), 'yaml');
    }),
    registerCommand(context, 'gitnexus.setActiveRepository', async (repoName?: string) => {
      if (!repoName) {
        return;
      }

      service.setActiveRepo(repoName);
      repositoriesView.refresh();
      modulesView.refresh();
      processesView.refresh();
      await statusBar.refresh();
    }),
    registerCommand(context, 'gitnexus.queryConcept', async (query?: string) => {
      if (!query || typeof query !== 'string') {
        return;
      }

      await presentOutput(`GitNexus Query: ${query}`, await service.queryConcept(query));
    }),
    registerCommand(context, 'gitnexus.copySymbolName', async () => {
      const symbol = getSelectionOrWord(vscode.window.activeTextEditor);
      if (!symbol) {
        return;
      }

      await vscode.env.clipboard.writeText(symbol);
      void vscode.window.setStatusBarMessage(`Copied symbol: ${symbol}`, 2000);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(async () => {
      await service.refreshRepos();
      repositoriesView.refresh();
      modulesView.refresh();
      processesView.refresh();
      await statusBar.refresh();
    }),
    vscode.workspace.onDidSaveTextDocument(async () => {
      await statusBar.refresh();
    }),
  );
}

export function deactivate(): void {
  // Extension disposables handle MCP shutdown and cleanup.
}

function registerCommand(
  context: vscode.ExtensionContext,
  command: string,
  handler: (...args: any[]) => unknown | Promise<unknown>,
): vscode.Disposable {
  const wrapped = async (...args: any[]) => {
    try {
      await handler(...args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`GitNexus: ${message}`);
    }
  };

  const disposable = vscode.commands.registerCommand(command, wrapped);
  context.subscriptions.push(disposable);
  return disposable;
}

async function presentOutput(title: string, content: string, language = 'markdown'): Promise<void> {
  const document = await vscode.workspace.openTextDocument({
    content,
    language,
  });

  await vscode.window.showTextDocument(document, {
    preview: false,
    viewColumn: vscode.ViewColumn.Beside,
  });

  void vscode.window.setStatusBarMessage(title, 2500);
}
