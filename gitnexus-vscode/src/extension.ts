import * as vscode from 'vscode';
import {
  GitNexusService,
  type AnalyzeSkillLayout,
  type GraphFocusSymbolHint,
} from './services/gitnexus-service';
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
  } else if (!vscode.workspace.isTrusted) {
    output.appendLine('[GitNexus] Workspace is untrusted; MCP auto-registration is deferred until trust is granted.');
  }

  const autoStartMcp = vscode.workspace.getConfiguration('gitnexus').get<boolean>('mcp.autoStart', true);
  if (autoStartMcp) {
    try {
      await service.listRepos();
      if (service.isMcpServerRunning()) {
        output.appendLine('[GitNexus] MCP auto-start completed successfully.');
        vscode.window.setStatusBarMessage('GitNexus MCP server started successfully', 3000);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`[GitNexus] MCP auto-start failed: ${message}`);
    }
  }

  const repositoriesView = new RepositoriesViewProvider(service);
  const modulesView = new ModulesViewProvider(service);
  const processesView = new ProcessesViewProvider(service);

  const statusBar = new GitNexusStatusBar(service);
  await statusBar.refresh();
  statusBar.show();

  const refreshAll = async () => {
    await service.refreshRepos();
    repositoriesView.refresh();
    modulesView.refresh();
    processesView.refresh();
    await statusBar.refresh();
  };

  let analyzeRefreshTimer: NodeJS.Timeout | undefined;
  const startAnalyzeRefreshLoop = () => {
    if (analyzeRefreshTimer) {
      clearInterval(analyzeRefreshTimer);
      analyzeRefreshTimer = undefined;
    }

    let attempts = 0;
    const maxAttempts = 40;
    const intervalMs = 3000;

    const runTick = async () => {
      attempts += 1;

      try {
        await refreshAll();
        const status = await service.getWorkspaceStatus();
        if (status.state === 'fresh' || attempts >= maxAttempts) {
          if (analyzeRefreshTimer) {
            clearInterval(analyzeRefreshTimer);
            analyzeRefreshTimer = undefined;
          }
        }
      } catch {
        if (attempts >= maxAttempts && analyzeRefreshTimer) {
          clearInterval(analyzeRefreshTimer);
          analyzeRefreshTimer = undefined;
        }
      }
    };

    void runTick();
    analyzeRefreshTimer = setInterval(() => {
      void runTick();
    }, intervalMs);
  };

  context.subscriptions.push(
    output,
    service,
    statusBar,
    registerGitNexusParticipant(context, service, output),
    vscode.window.registerTreeDataProvider('gitnexus.repositoriesView', repositoriesView),
    vscode.window.registerTreeDataProvider('gitnexus.modulesView', modulesView),
    vscode.window.registerTreeDataProvider('gitnexus.processesView', processesView),
    registerCommand(context, 'gitnexus.refresh', refreshAll),
    registerCommand(context, 'gitnexus.analyzeWorkspace', async (resource?: vscode.Uri) => {
      const selectedLayout = getConfiguredAnalyzeSkillLayout();

      const started = service.runAnalyzeWorkspace(resource, {
        skillLayout: selectedLayout,
        includeCopilotInstructions: true,
      });
      if (started) {
        startAnalyzeRefreshLoop();
      }
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
      const editor = vscode.window.activeTextEditor;
      const symbol = getSelectionOrWord(editor);
      const focusHint = getGraphFocusSymbolHint(editor, symbol);
      await GraphPanel.show(context, service, symbol, focusHint);
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
      await refreshAll();
    }),
    vscode.workspace.onDidSaveTextDocument(async () => {
      await statusBar.refresh();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(async () => {
      try {
        const wroteConfig = await service.ensureMcpRegistration();
        if (wroteConfig) {
          vscode.window.setStatusBarMessage('GitNexus: registered MCP server in .vscode/mcp.json', 5000);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`[GitNexus] Failed to register MCP config after trust grant: ${message}`);
      }
    }),
  );

  // Kick off a startup refresh immediately and once more shortly after activation.
  // This covers slower MCP startup without requiring a manual refresh click.
  void refreshAll();

  const startupRetry = setTimeout(() => {
    void refreshAll();
  }, 2500);

  context.subscriptions.push({
    dispose() {
      clearTimeout(startupRetry);
      if (analyzeRefreshTimer) {
        clearInterval(analyzeRefreshTimer);
      }
    },
  });
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

function getGraphFocusSymbolHint(
  editor: vscode.TextEditor | undefined,
  symbol: string | undefined,
): GraphFocusSymbolHint | undefined {
  if (!editor || !symbol) {
    return undefined;
  }

  const relativePath = vscode.workspace.asRelativePath(editor.document.uri, false);
  if (!relativePath || relativePath.startsWith('..')) {
    return undefined;
  }

  const position = editor.selection.active;
  const wordRange = editor.document.getWordRangeAtPosition(position);
  const startLine = editor.selection.isEmpty ? (wordRange?.start.line ?? position.line) : editor.selection.start.line;
  const endLine = editor.selection.isEmpty ? (wordRange?.end.line ?? position.line) : editor.selection.end.line;

  return {
    name: symbol,
    filePath: relativePath.replace(/\\/g, '/'),
    startLine,
    endLine,
  };
}

function getConfiguredAnalyzeSkillLayout(): AnalyzeSkillLayout {
  const configured = vscode.workspace
    .getConfiguration('gitnexus')
    .get<string>('analyze.skillLayout', 'github')
    .trim()
    .toLowerCase();

  if (configured === 'github' || configured === 'claude' || configured === 'dual') {
    return configured;
  }

  return 'github';
}
