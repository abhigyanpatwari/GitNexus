import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import * as vscode from 'vscode';
import type { RepoRegistryEntry } from '../types';

interface McpClientOptions {
  command: string;
  baseArgs: string[];
  mcpArgs: string[];
  cwd?: string;
  output: vscode.OutputChannel;
}

export class GitNexusMcpClient implements vscode.Disposable {
  private client: Client | undefined;
  private transport: StdioClientTransport | undefined;
  private connectPromise: Promise<void> | undefined;

  constructor(private readonly options: McpClientOptions) {}

  async listRepos(): Promise<RepoRegistryEntry[]> {
    const text = await this.callToolText('list_repos', {});
    const parsed = this.parseJson<RepoRegistryEntry[]>(text);
    return Array.isArray(parsed) ? parsed : [];
  }

  async callToolText(name: string, args: Record<string, unknown>): Promise<string> {
    const client = await this.ensureConnected();

    try {
      const result = await client.callTool({ name, arguments: args });
      return this.flattenContent(result?.content);
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }

  async readResourceText(uri: string): Promise<string> {
    const client = await this.ensureConnected();

    try {
      const result = await client.readResource({ uri });
      return this.flattenResourceContent(result?.contents);
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }

  stripNextStepHint(text: string): string {
    const marker = '\n\n---\n**Next:**';
    const markerIndex = text.indexOf(marker);
    if (markerIndex < 0) {
      return text.trim();
    }

    return text.slice(0, markerIndex).trim();
  }

  isConnected(): boolean {
    return Boolean(this.client && this.transport);
  }

  private async ensureConnected(): Promise<Client> {
    if (this.client) {
      return this.client;
    }

    if (!this.connectPromise) {
      this.connectPromise = this.connectInternal();
    }

    await this.connectPromise;

    if (!this.client) {
      throw new Error('GitNexus MCP client failed to initialize.');
    }

    return this.client;
  }

  private async connectInternal(): Promise<void> {
    const args = [...this.options.baseArgs, ...this.options.mcpArgs];
    this.options.output.appendLine(`[GitNexus] Starting MCP process: ${this.options.command} ${args.join(' ')}`);

    const transport = new StdioClientTransport({
      command: this.options.command,
      args,
      cwd: this.options.cwd,
      stderr: 'pipe',
    });

    const stderrStream = transport.stderr as NodeJS.ReadableStream | null;
    if (stderrStream) {
      stderrStream.on('data', (chunk) => {
        const message = chunk.toString().trim();
        if (message) {
          this.options.output.appendLine(`[GitNexus MCP] ${message}`);
        }
      });
    }

    const client = new Client(
      {
        name: 'gitnexus-vscode',
        version: '0.0.1',
      },
      {
        capabilities: {},
      },
    );

    try {
      await client.connect(transport);
      this.transport = transport;
      this.client = client;
      this.options.output.appendLine('[GitNexus] MCP server started successfully.');
    } finally {
      this.connectPromise = undefined;
    }
  }

  private flattenContent(content: unknown): string {
    if (!Array.isArray(content)) {
      return '';
    }

    const chunks: string[] = [];
    for (const part of content as Array<Record<string, unknown>>) {
      if (part && part.type === 'text' && typeof part.text === 'string') {
        chunks.push(part.text);
      }
    }

    return chunks.join('\n').trim();
  }

  private flattenResourceContent(contents: unknown): string {
    if (!Array.isArray(contents)) {
      return '';
    }

    const chunks: string[] = [];
    for (const entry of contents as Array<Record<string, unknown>>) {
      if (typeof entry.text === 'string') {
        chunks.push(entry.text);
      }
    }

    return chunks.join('\n').trim();
  }

  private parseJson<T>(text: string): T | undefined {
    const payload = this.stripNextStepHint(text);
    try {
      return JSON.parse(payload) as T;
    } catch {
      return undefined;
    }
  }

  async disconnect(): Promise<void> {
    const client = this.client;
    const transport = this.transport;
    this.client = undefined;
    this.transport = undefined;

    if (client) {
      try {
        await client.close();
      } catch {
        // no-op
      }
    }

    if (transport) {
      try {
        await transport.close();
      } catch {
        // no-op
      }
    }
  }

  dispose(): void {
    void this.disconnect();
  }
}
