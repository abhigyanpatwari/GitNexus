import * as vscode from 'vscode';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { GitNexusMcpClient } from './mcp-client';
import { ensureWorkspaceMcpConfig } from './mcp-config';
import { findRepoForWorkspace, pickDefaultRepo, readRegistryRepos } from './registry';
import { getWorkspaceRoot, toShellArg } from '../utils/workspace';
import type { ModuleSummary, ProcessSummary, RepoRegistryEntry, WorkspaceIndexStatus } from '../types';
import { buildGraphPayload, type GraphPayload } from '../webview/graph-data';

const execFileAsync = promisify(execFile);

export type GraphNodeKind = 'repo' | 'module' | 'process' | 'symbol';

export interface GraphFocusSymbolHint {
  name: string;
  filePath: string;
  startLine?: number;
  endLine?: number;
}

export interface GraphNodeLocation {
  filePath: string;
  startLine: number;
  endLine: number;
  symbolName?: string;
  symbolUid?: string;
}

export interface GraphNodeCandidate {
  uid: string;
  name: string;
  filePath: string;
  startLine: number;
}

export type GraphNodeResolution =
  | {
      status: 'resolved';
      location: GraphNodeLocation;
    }
  | {
      status: 'ambiguous';
      message: string;
      candidates: GraphNodeCandidate[];
    }
  | {
      status: 'not-found';
      message: string;
    };

interface ContextSymbolPayload {
  uid?: string;
  name?: string;
  filePath?: string;
  startLine?: number;
  endLine?: number;
}

interface ContextCandidatePayload {
  uid?: string;
  name?: string;
  filePath?: string;
  line?: number;
}

interface ContextToolResponse {
  status?: string;
  error?: string;
  symbol?: ContextSymbolPayload;
  candidates?: ContextCandidatePayload[];
}

interface ClusterMemberReference {
  name: string;
  type?: string;
  filePath: string;
}

export type AnalyzeSkillLayout = 'github' | 'claude' | 'dual';

export interface AnalyzeWorkspaceOptions {
  skillLayout?: AnalyzeSkillLayout;
  includeCopilotInstructions?: boolean;
}

const DEFAULT_ANALYZE_SKILL_LAYOUT: AnalyzeSkillLayout = 'github';

export class GitNexusService implements vscode.Disposable {
  private mcpClient: GitNexusMcpClient | undefined;
  private repos: RepoRegistryEntry[] = [];
  private activeRepoName: string | undefined;
  private readonly graphNodeLocationCache = new Map<string, GraphNodeResolution>();
  private focusSymbolHint: GraphFocusSymbolHint | undefined;

  constructor(private readonly output: vscode.OutputChannel) {}

  async initialize(): Promise<void> {
    await this.refreshRepos();
  }

  async refreshRepos(): Promise<void> {
    const registryRepos = await readRegistryRepos();
    this.repos = registryRepos;
    this.reconcileActiveRepo();
    this.graphNodeLocationCache.clear();
    await this.updateIndexedContext();
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

    this.reconcileActiveRepo();
    await this.updateIndexedContext();

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

  isMcpServerRunning(): boolean {
    return this.mcpClient?.isConnected() ?? false;
  }

  setActiveRepo(name: string): void {
    this.activeRepoName = name;
    this.graphNodeLocationCache.clear();
  }

  async ensureMcpRegistration(): Promise<boolean> {
    const config = this.getConfig();
    if (!config.autoRegisterMcp) {
      return false;
    }

    if (!vscode.workspace.isTrusted) {
      this.log('Skipping MCP registration because workspace is untrusted.');
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

  async getGraphPayload(focusSymbol?: string, focusHint?: GraphFocusSymbolHint): Promise<GraphPayload> {
    const repo = this.requireActiveRepo();
    this.focusSymbolHint =
      focusSymbol && focusHint && focusHint.name === focusSymbol
        ? {
            ...focusHint,
            filePath: this.normalizeFilePath(focusHint.filePath),
          }
        : undefined;

    if (focusSymbol && this.focusSymbolHint?.filePath) {
      const cacheKey = this.getGraphNodeCacheKey('symbol', focusSymbol);
      this.graphNodeLocationCache.set(cacheKey, {
        status: 'resolved',
        location: {
          filePath: this.focusSymbolHint.filePath,
          startLine: this.normalizeLine(this.focusSymbolHint.startLine),
          endLine: this.normalizeLine(this.focusSymbolHint.endLine ?? this.focusSymbolHint.startLine),
          symbolName: focusSymbol,
        },
      });
    }

    const [modules, processes] = await Promise.all([this.getModules(), this.getProcesses()]);

    return buildGraphPayload(repo.name, modules, processes, focusSymbol);
  }

  async getWorkspaceStatus(): Promise<WorkspaceIndexStatus> {
    const workspaceRepo = this.getWorkspaceRepo() ?? this.getActiveRepo();
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

  async resolveGraphNodeLocation(kind: GraphNodeKind, label: string): Promise<GraphNodeResolution> {
    const cacheKey = this.getGraphNodeCacheKey(kind, label);
    const cached = this.graphNodeLocationCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    if (kind === 'repo') {
      return {
        status: 'not-found',
        message: 'Repository nodes do not map to a single symbol location.',
      };
    }

    if (kind === 'symbol' && this.focusSymbolHint?.name === label && this.focusSymbolHint.filePath) {
      return {
        status: 'resolved',
        location: {
          filePath: this.focusSymbolHint.filePath,
          startLine: this.normalizeLine(this.focusSymbolHint.startLine),
          endLine: this.normalizeLine(this.focusSymbolHint.endLine ?? this.focusSymbolHint.startLine),
          symbolName: label,
        },
      };
    }

    let resolution: GraphNodeResolution;
    if (kind === 'symbol') {
      resolution = await this.resolveSymbolByName(label);
    } else if (kind === 'module') {
      resolution = await this.resolveModuleLocation(label);
    } else {
      resolution = await this.resolveProcessLocation(label);
    }

    if (resolution.status !== 'ambiguous') {
      this.graphNodeLocationCache.set(cacheKey, resolution);
    }

    return resolution;
  }

  async resolveGraphNodeCandidate(uid: string): Promise<GraphNodeResolution> {
    const resolution = await this.resolveSymbolByUid(uid);
    if (resolution.status === 'resolved') {
      const cacheKey = this.getGraphNodeCacheKey('symbol', resolution.location.symbolName ?? uid);
      this.graphNodeLocationCache.set(cacheKey, resolution);
    }
    return resolution;
  }

  resolveAbsoluteRepoPath(filePath: string): string {
    if (!filePath.trim()) {
      throw new Error('Cannot resolve an empty file path.');
    }

    const normalizedInput = filePath.replace(/\\/g, path.sep);
    if (path.isAbsolute(normalizedInput)) {
      return path.normalize(normalizedInput);
    }

    const repo = this.requireActiveRepo();
    const repoRoot = path.resolve(repo.path);
    const resolved = path.resolve(repoRoot, normalizedInput);

    if (!resolved.startsWith(repoRoot + path.sep) && resolved !== repoRoot) {
      throw new Error(`Resolved path escapes repository root: ${filePath}`);
    }

    return resolved;
  }

  runAnalyzeWorkspace(targetUri?: vscode.Uri, options?: AnalyzeWorkspaceOptions): boolean {
    const config = this.getConfig();
    const workspaceRoot = targetUri?.fsPath ?? getWorkspaceRoot();

    if (!workspaceRoot) {
      void vscode.window.showWarningMessage('No workspace folder selected for GitNexus analyze.');
      return false;
    }

    const skillLayout = options?.skillLayout ?? DEFAULT_ANALYZE_SKILL_LAYOUT;
    const includeCopilotInstructions = options?.includeCopilotInstructions ?? true;

    const fullArgs = [...config.baseArgs, 'analyze', workspaceRoot, '--skill-layout', skillLayout];
    if (includeCopilotInstructions) {
      fullArgs.push('--copilot-instructions');
    }

    const shellCommand = [config.cliCommand, ...fullArgs.map(toShellArg)].join(' ');

    const terminal = vscode.window.createTerminal({
      name: 'GitNexus Analyze',
      cwd: workspaceRoot,
    });

    terminal.show(true);
    terminal.sendText(shellCommand, true);
    return true;
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

  private reconcileActiveRepo(): void {
    const configuredRepo = this.getConfig().defaultRepo;
    const defaultRepo = pickDefaultRepo(this.repos, configuredRepo, getWorkspaceRoot());

    if (!this.activeRepoName || !this.repos.some((repo) => repo.name === this.activeRepoName)) {
      this.activeRepoName = defaultRepo?.name;
    }
  }

  private async updateIndexedContext(): Promise<void> {
    const hasIndexedRepo = Boolean(this.getWorkspaceRepo() ?? this.getActiveRepo());
    await vscode.commands.executeCommand('setContext', 'gitnexus.isIndexed', hasIndexedRepo);
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

  private async resolveSymbolByName(name: string, fileHint?: string): Promise<GraphNodeResolution> {
    const args = this.withRepo({
      name,
      ...(fileHint ? { file_path: fileHint } : {}),
    });

    const response = await this.callToolJson<ContextToolResponse>('context', args);
    return this.mapContextResponse(response, name, fileHint);
  }

  private async resolveSymbolByUid(uid: string): Promise<GraphNodeResolution> {
    const args = this.withRepo({ uid });
    const response = await this.callToolJson<ContextToolResponse>('context', args);
    const mapped = await this.mapContextResponse(response, uid);

    if (mapped.status === 'resolved' && !mapped.location.symbolUid) {
      return {
        status: 'resolved',
        location: {
          ...mapped.location,
          symbolUid: uid,
        },
      };
    }

    return mapped;
  }

  private async resolveModuleLocation(moduleName: string): Promise<GraphNodeResolution> {
    const repo = this.requireActiveRepo();
    const resource = await this.readRepoResource(repo.name, `cluster/${encodeURIComponent(moduleName)}`);
    const members = this.parseClusterMembers(resource);
    const anchor = members.find((member) => member.type?.toLowerCase() !== 'file') ?? members[0];

    if (!anchor) {
      return {
        status: 'not-found',
        message: `No members found for module '${moduleName}'.`,
      };
    }

    return this.resolveSymbolByName(anchor.name, anchor.filePath);
  }

  private async resolveProcessLocation(processName: string): Promise<GraphNodeResolution> {
    const repo = this.requireActiveRepo();
    const resource = await this.readRepoResource(repo.name, `process/${encodeURIComponent(processName)}`);
    const step = this.parseProcessFirstStep(resource);

    if (!step) {
      return {
        status: 'not-found',
        message: `No steps found for process '${processName}'.`,
      };
    }

    return this.resolveSymbolByName(step.name, step.filePath);
  }

  private async mapContextResponse(
    response: ContextToolResponse | undefined,
    requestedSymbol: string,
    fileHint?: string,
  ): Promise<GraphNodeResolution> {
    if (!response) {
      return {
        status: 'not-found',
        message: `Context lookup returned no payload for '${requestedSymbol}'.`,
      };
    }

    if (response.status === 'found' && response.symbol) {
      const location = this.toGraphLocation(response.symbol, requestedSymbol);
      if (location) {
        return {
          status: 'resolved',
          location,
        };
      }
    }

    if (response.status === 'ambiguous') {
      const candidates = this.toCandidateArray(response.candidates);
      if (fileHint) {
        const matched = this.pickCandidateForFile(candidates, fileHint);
        if (matched) {
          return this.resolveSymbolByUid(matched.uid);
        }
      }

      if (candidates.length > 0) {
        return {
          status: 'ambiguous',
          message: `Multiple symbols matched '${requestedSymbol}'. Choose one to open.`,
          candidates,
        };
      }
    }

    if (response.error) {
      return {
        status: 'not-found',
        message: response.error,
      };
    }

    return {
      status: 'not-found',
      message: `No source location found for '${requestedSymbol}'.`,
    };
  }

  private toCandidateArray(candidates: ContextCandidatePayload[] | undefined): GraphNodeCandidate[] {
    if (!Array.isArray(candidates)) {
      return [];
    }

    const results: GraphNodeCandidate[] = [];
    for (const candidate of candidates) {
      if (!candidate.uid || !candidate.name || !candidate.filePath) {
        continue;
      }

      results.push({
        uid: candidate.uid,
        name: candidate.name,
        filePath: this.normalizeFilePath(candidate.filePath),
        startLine: this.normalizeLine(candidate.line),
      });
    }

    return results;
  }

  private toGraphLocation(
    value: {
      uid?: string;
      name?: string;
      filePath?: string;
      startLine?: number;
      endLine?: number;
    },
    fallbackName: string,
  ): GraphNodeLocation | undefined {
    if (!value.filePath) {
      return undefined;
    }

    const startLine = this.normalizeLine(value.startLine);
    const endLine = Math.max(startLine, this.normalizeLine(value.endLine ?? value.startLine));

    return {
      filePath: this.normalizeFilePath(value.filePath),
      startLine,
      endLine,
      symbolName: value.name ?? fallbackName,
      symbolUid: value.uid,
    };
  }

  private pickCandidateForFile(candidates: GraphNodeCandidate[], fileHint: string): GraphNodeCandidate | undefined {
    if (candidates.length === 0) {
      return undefined;
    }

    const normalizedHint = this.normalizeFilePath(fileHint).toLowerCase();
    const exactMatch = candidates.find((candidate) => {
      const candidatePath = this.normalizeFilePath(candidate.filePath).toLowerCase();
      return candidatePath === normalizedHint || candidatePath.endsWith(`/${normalizedHint}`);
    });

    if (exactMatch) {
      return exactMatch;
    }

    return candidates.find((candidate) => {
      const candidatePath = this.normalizeFilePath(candidate.filePath).toLowerCase();
      return normalizedHint.endsWith(candidatePath);
    });
  }

  private parseClusterMembers(text: string): ClusterMemberReference[] {
    const lines = text.split(/\r?\n/);
    const members: ClusterMemberReference[] = [];
    let current: Partial<ClusterMemberReference> | undefined;

    for (const line of lines) {
      const nameMatch = line.match(/^\s*-\s+name:\s+(.+)\s*$/);
      if (nameMatch) {
        if (current?.name && current.filePath) {
          members.push({
            name: current.name,
            type: current.type,
            filePath: current.filePath,
          });
        }

        current = {
          name: this.parseQuotedValue(nameMatch[1]),
        };
        continue;
      }

      if (!current) {
        continue;
      }

      const typeMatch = line.match(/^\s+type:\s+(.+)\s*$/);
      if (typeMatch) {
        current.type = this.parseQuotedValue(typeMatch[1]);
        continue;
      }

      const fileMatch = line.match(/^\s+(?:file|filePath):\s+(.+)\s*$/);
      if (fileMatch) {
        current.filePath = this.normalizeFilePath(this.parseQuotedValue(fileMatch[1]));
      }
    }

    if (current?.name && current.filePath) {
      members.push({
        name: current.name,
        type: current.type,
        filePath: current.filePath,
      });
    }

    return members;
  }

  private parseProcessFirstStep(text: string): ClusterMemberReference | undefined {
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^\s*\d+:\s+(.+?)\s+\((.+)\)\s*$/);
      if (!match) {
        continue;
      }

      return {
        name: this.parseQuotedValue(match[1]),
        filePath: this.normalizeFilePath(this.parseQuotedValue(match[2])),
      };
    }

    return undefined;
  }

  private parseQuotedValue(raw: string): string {
    const trimmed = raw.trim();
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
      return trimmed.slice(1, -1);
    }

    return trimmed;
  }

  private async callToolJson<T>(name: string, args: Record<string, unknown>): Promise<T | undefined> {
    const raw = await this.getMcpClient().callToolText(name, args);
    const payload = this.getMcpClient().stripNextStepHint(raw);

    try {
      return JSON.parse(payload) as T;
    } catch {
      this.log(`Unable to parse JSON response from tool '${name}'.`);
      return undefined;
    }
  }

  private normalizeLine(value: unknown): number {
    const parsed =
      typeof value === 'number'
        ? value
        : Number.parseInt(typeof value === 'string' ? value : String(value ?? ''), 10);

    if (!Number.isFinite(parsed)) {
      return 0;
    }

    return Math.max(0, Math.trunc(parsed));
  }

  private normalizeFilePath(value: string): string {
    return value.replace(/\\/g, '/').trim();
  }

  private getGraphNodeCacheKey(kind: GraphNodeKind, label: string): string {
    const repoName = this.getActiveRepo()?.name ?? 'default';
    return `${repoName}:${kind}:${label}`;
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
