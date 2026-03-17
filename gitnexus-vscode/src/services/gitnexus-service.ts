import * as vscode from 'vscode';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { GitNexusMcpClient } from './mcp-client';
import { ensureWorkspaceMcpConfig } from './mcp-config';
import { findRepoForWorkspace, pickDefaultRepo, readRegistryRepos } from './registry';
import { getWorkspaceRoot, toShellArg } from '../utils/workspace';
import type { ModuleSummary, ProcessSummary, RepoRegistryEntry, WorkspaceIndexStatus } from '../types';
import { buildGraphPayload, type GraphPayload } from '../webview/graph-data';

const execFileAsync = promisify(execFile);

export class GitNexusService implements vscode.Disposable {
  private mcpClient: GitNexusMcpClient | undefined;
  private repos: RepoRegistryEntry[] = [];
  private activeRepoName: string | undefined;

  constructor(private readonly output: vscode.OutputChannel) {}

  async initialize(): Promise<void> {
    await this.refreshRepos();
  }

  async refreshRepos(): Promise<void> {
    const registryRepos = await readRegistryRepos();
    this.repos = registryRepos;

    const configuredRepo = this.getConfig().defaultRepo;
    const defaultRepo = pickDefaultRepo(registryRepos, configuredRepo, getWorkspaceRoot());

    if (!this.activeRepoName || !registryRepos.some((repo) => repo.name === this.activeRepoName)) {
      this.activeRepoName = defaultRepo?.name;
    }

    await vscode.commands.executeCommand('setContext', 'gitnexus.isIndexed', Boolean(this.getWorkspaceRepo()));
  }

  async listRepos(): Promise<RepoRegistryEntry[]> {
    const mcpClient = this.getMcpClient();

    try {
      const mcpRepos = await mcpClient.listRepos();
      if (mcpRepos.length > 0) {
        this.repos = mcpRepos;
      }
    } catch (error) {
      this.log(`Failed to list repos over MCP: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (this.repos.length === 0) {
      this.repos = await readRegistryRepos();
    }

    return this.repos;
  }

  getActiveRepo(): RepoRegistryEntry | undefined {
    if (this.activeRepoName) {
      const byName = this.repos.find((repo) => repo.name === this.activeRepoName);
      if (byName) {
        return byName;
      }
    }

    return this.getWorkspaceRepo() ?? this.repos[0];
  }

  setActiveRepo(name: string): void {
    this.activeRepoName = name;
  }

  async ensureMcpRegistration(): Promise<boolean> {
    const config = this.getConfig();
    if (!config.autoRegisterMcp) {
      return false;
    }

    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      return false;
    }

    return ensureWorkspaceMcpConfig(workspaceRoot, config.cliCommand, config.baseArgs, config.mcpArgs);
  }

  async getRepoContext(): Promise<string> {
    const repo = this.requireActiveRepo();
    return this.readRepoResource(repo.name, 'context');
  }

  async getProcesses(): Promise<ProcessSummary[]> {
    const repo = this.requireActiveRepo();
    const text = await this.readRepoResource(repo.name, 'processes');
    return this.parseProcessSummary(text);
  }

  async getModules(): Promise<ModuleSummary[]> {
    const repo = this.requireActiveRepo();
    const text = await this.readRepoResource(repo.name, 'clusters');
    return this.parseModuleSummary(text);
  }

  async getProcessDetails(processName: string): Promise<string> {
    const repo = this.requireActiveRepo();
    const encodedName = encodeURIComponent(processName);
    return this.readRepoResource(repo.name, `process/${encodedName}`);
  }

  async exploreSymbol(symbol: string): Promise<string> {
    const args = this.withRepo({ name: symbol });
    return this.getMcpClient().callToolText('context', args);
  }

  async impactSymbol(symbol: string): Promise<string> {
    const args = this.withRepo({ target: symbol, direction: 'upstream' });
    return this.getMcpClient().callToolText('impact', args);
  }

  async queryConcept(query: string): Promise<string> {
    const args = this.withRepo({ query, limit: 8 });
    return this.getMcpClient().callToolText('query', args);
  }

  async detectChanges(scope: 'unstaged' | 'staged' | 'all' | 'compare' = 'all'): Promise<string> {
    const args = this.withRepo({ scope });
    return this.getMcpClient().callToolText('detect_changes', args);
  }

  async previewRename(sourceSymbol: string, targetSymbol: string): Promise<string> {
    const args = this.withRepo({
      symbol_name: sourceSymbol,
      new_name: targetSymbol,
      dry_run: true,
    });

    return this.getMcpClient().callToolText('rename', args);
  }

  async getGraphPayload(focusSymbol?: string): Promise<GraphPayload> {
    const repo = this.requireActiveRepo();
    const [modules, processes] = await Promise.all([this.getModules(), this.getProcesses()]);

    return buildGraphPayload(repo.name, modules, processes, focusSymbol);
  }

  async getWorkspaceStatus(): Promise<WorkspaceIndexStatus> {
    const workspaceRepo = this.getWorkspaceRepo();
    if (!workspaceRepo) {
      return { state: 'not-indexed' };
    }

    const currentCommit = await this.getCurrentCommit(workspaceRepo.path);
    const indexedCommit = workspaceRepo.lastCommit;

    const stale = Boolean(
      currentCommit &&
        indexedCommit &&
        !indexedCommit.startsWith(currentCommit) &&
        !currentCommit.startsWith(indexedCommit),
    );

    return {
      state: stale ? 'stale' : 'fresh',
      repo: workspaceRepo,
      currentCommit,
    };
  }

  runAnalyzeWorkspace(targetUri?: vscode.Uri): void {
    const config = this.getConfig();
    const workspaceRoot = targetUri?.fsPath ?? getWorkspaceRoot();

    if (!workspaceRoot) {
      void vscode.window.showWarningMessage('No workspace folder selected for GitNexus analyze.');
      return;
    }

    const fullArgs = [...config.baseArgs, 'analyze', workspaceRoot];
    const shellCommand = [config.cliCommand, ...fullArgs.map(toShellArg)].join(' ');

    const terminal = vscode.window.createTerminal({
      name: 'GitNexus Analyze',
      cwd: workspaceRoot,
    });

    terminal.show(true);
    terminal.sendText(shellCommand, true);
  }

  private async readRepoResource(repoName: string, suffix: string): Promise<string> {
    const encodedRepo = encodeURIComponent(repoName);
    const uri = `gitnexus://repo/${encodedRepo}/${suffix}`;
    return this.getMcpClient().readResourceText(uri);
  }

  private getWorkspaceRepo(): RepoRegistryEntry | undefined {
    const workspaceRoot = getWorkspaceRoot();
    if (!workspaceRoot) {
      return undefined;
    }

    return findRepoForWorkspace(workspaceRoot, this.repos);
  }

  private requireActiveRepo(): RepoRegistryEntry {
    const repo = this.getActiveRepo();
    if (!repo) {
      throw new Error('No indexed repository available. Run gitnexus analyze first.');
    }

    return repo;
  }

  private withRepo(args: Record<string, unknown>): Record<string, unknown> {
    const repo = this.getActiveRepo();
    if (!repo) {
      return args;
    }

    return {
      ...args,
      repo: repo.name,
    };
  }

  private getMcpClient(): GitNexusMcpClient {
    if (!this.mcpClient) {
      const config = this.getConfig();
      this.mcpClient = new GitNexusMcpClient({
        command: config.cliCommand,
        baseArgs: config.baseArgs,
        mcpArgs: config.mcpArgs,
        cwd: getWorkspaceRoot(),
        output: this.output,
      });
    }

    return this.mcpClient;
  }

  private getConfig(): {
    autoRegisterMcp: boolean;
    defaultRepo: string | undefined;
    cliCommand: string;
    baseArgs: string[];
    mcpArgs: string[];
  } {
    const configuration = vscode.workspace.getConfiguration('gitnexus');

    const baseArgsSetting = configuration.get<string[]>('cli.baseArgs', ['-y', 'gitnexus@latest']);
    const mcpArgsSetting = configuration.get<string[]>('cli.mcpArgs', ['mcp']);

    const baseArgs = Array.isArray(baseArgsSetting) ? baseArgsSetting : ['-y', 'gitnexus@latest'];
    const mcpArgs = Array.isArray(mcpArgsSetting) ? mcpArgsSetting : ['mcp'];

    return {
      autoRegisterMcp: configuration.get<boolean>('mcp.autoRegister', true),
      defaultRepo: configuration.get<string>('defaultRepo')?.trim() || undefined,
      cliCommand: configuration.get<string>('cli.command', 'npx'),
      baseArgs,
      mcpArgs,
    };
  }

  private parseProcessSummary(text: string): ProcessSummary[] {
    const items = this.parseNamedSection(text, 'processes');
    return items.map((item) => ({
      name: item.name,
      type: item.type ?? 'unknown',
      steps: Number.parseInt(item.steps ?? '0', 10) || 0,
    }));
  }

  private parseModuleSummary(text: string): ModuleSummary[] {
    const items = this.parseNamedSection(text, 'modules');
    return items.map((item) => ({
      name: item.name,
      symbols: Number.parseInt(item.symbols ?? '0', 10) || 0,
      cohesion: item.cohesion,
    }));
  }

  private parseNamedSection(text: string, section: string): Array<Record<string, string>> {
    const lines = text.split(/\r?\n/);
    const results: Array<Record<string, string>> = [];

    let inSection = false;
    let current: Record<string, string> | undefined;

    for (const line of lines) {
      if (!inSection) {
        if (line.trim() === `${section}:`) {
          inSection = true;
        }
        continue;
      }

      const sectionBoundary = /^[A-Za-z_\-]+:\s*$/.test(line.trim());
      if (sectionBoundary && !line.startsWith('  ')) {
        break;
      }

      const nameMatch = line.match(/^\s*-\s+name:\s+"?(.+?)"?\s*$/);
      if (nameMatch) {
        if (current) {
          results.push(current);
        }
        current = { name: nameMatch[1] };
        continue;
      }

      if (!current) {
        continue;
      }

      const kvMatch = line.match(/^\s+([A-Za-z_\-]+):\s+(.+)\s*$/);
      if (kvMatch) {
        const key = kvMatch[1];
        const value = kvMatch[2].replace(/^"/, '').replace(/"$/, '').trim();
        current[key] = value;
      }
    }

    if (current) {
      results.push(current);
    }

    return results;
  }

  private async getCurrentCommit(repoPath: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync('git', ['-C', repoPath, 'rev-parse', 'HEAD']);
      return stdout.trim();
    } catch {
      return undefined;
    }
  }

  private log(message: string): void {
    this.output.appendLine(`[GitNexus] ${message}`);
  }

  dispose(): void {
    this.mcpClient?.dispose();
  }
}
