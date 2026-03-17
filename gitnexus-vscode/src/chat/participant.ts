import * as vscode from 'vscode';
import { GitNexusService } from '../services/gitnexus-service';
import { parseRenamePrompt, pickPrimarySymbol, resolveWorkflow, type GitNexusWorkflow } from './parser';

interface ChatMetadata {
  workflow: GitNexusWorkflow;
  subject?: string;
}

export function registerGitNexusParticipant(
  context: vscode.ExtensionContext,
  service: GitNexusService,
  output: vscode.OutputChannel,
): vscode.Disposable {
  const participant = vscode.chat.createChatParticipant('gitnexus-vscode.gitnexus', async (request, _chatContext, stream, token) => {
    const workflow = resolveWorkflow(request.command, request.prompt);

    stream.progress(`Running GitNexus /${workflow} workflow...`);

    switch (workflow) {
      case 'impact':
        return runImpactWorkflow(request.prompt, service, stream, token);
      case 'debug':
        return runDebugWorkflow(request.prompt, service, stream, token);
      case 'refactor':
        return runRefactorWorkflow(request.prompt, service, stream, token);
      case 'flow':
        return runFlowWorkflow(request.prompt, service, stream, token);
      case 'changes':
        return runChangesWorkflow(service, stream, token);
      case 'explore':
      default:
        return runExploreWorkflow(request.prompt, service, stream, token);
    }
  });

  participant.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'gitnexus.svg');
  participant.followupProvider = {
    provideFollowups(result) {
      const workflow = (result.metadata as ChatMetadata | undefined)?.workflow;

      if (!workflow) {
        return [];
      }

      return suggestFollowups(workflow);
    },
  };

  participant.onDidReceiveFeedback((feedback) => {
    output.appendLine(`[GitNexus Chat] feedback=${feedback.kind}`);
  });

  return participant;
}

async function runExploreWorkflow(
  prompt: string,
  service: GitNexusService,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<vscode.ChatResult> {
  throwIfCancelled(token);

  const query = prompt.trim() || 'architecture';
  const response = await service.queryConcept(query);

  stream.markdown(`### Explore\n`);
  stream.markdown(`Query: **${escapeMarkdown(query)}**\n\n`);
  stream.markdown('```json\n');
  stream.markdown(response);
  stream.markdown('\n```\n');
  stream.button({
    command: 'gitnexus.showInGraph',
    title: 'Open Graph View',
  });

  return { metadata: { workflow: 'explore', subject: query } };
}

async function runImpactWorkflow(
  prompt: string,
  service: GitNexusService,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<vscode.ChatResult> {
  throwIfCancelled(token);

  const symbol = pickPrimarySymbol(prompt);
  if (!symbol) {
    stream.markdown('Use `/impact <symbol>` to analyze blast radius. Example: `/impact activate`');
    return { metadata: { workflow: 'impact' } };
  }

  const response = await service.impactSymbol(symbol);

  stream.markdown(`### Impact\n`);
  stream.markdown(`Symbol: **${escapeMarkdown(symbol)}**\n\n`);
  stream.markdown('```json\n');
  stream.markdown(response);
  stream.markdown('\n```\n');

  return { metadata: { workflow: 'impact', subject: symbol } };
}

async function runDebugWorkflow(
  prompt: string,
  service: GitNexusService,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<vscode.ChatResult> {
  throwIfCancelled(token);

  const query = prompt.trim() || 'failing behavior';
  const [search, changes] = await Promise.all([
    service.queryConcept(query),
    service.detectChanges('all'),
  ]);

  stream.markdown('### Debug\n');
  stream.markdown(`Focus: **${escapeMarkdown(query)}**\n\n`);
  stream.markdown('#### Related execution flows\n');
  stream.markdown('```json\n');
  stream.markdown(search);
  stream.markdown('\n```\n');

  stream.markdown('#### Current workspace changes impact\n');
  stream.markdown('```json\n');
  stream.markdown(changes);
  stream.markdown('\n```\n');

  return { metadata: { workflow: 'debug', subject: query } };
}

async function runRefactorWorkflow(
  prompt: string,
  service: GitNexusService,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<vscode.ChatResult> {
  throwIfCancelled(token);

  const rename = parseRenamePrompt(prompt);
  if (!rename) {
    stream.markdown('Use `/refactor rename oldName to newName` or `/refactor oldName -> newName` to preview a safe rename.');
    return { metadata: { workflow: 'refactor' } };
  }

  const preview = await service.previewRename(rename.source, rename.target);

  stream.markdown('### Refactor Preview\n');
  stream.markdown(`Rename **${escapeMarkdown(rename.source)}** to **${escapeMarkdown(rename.target)}**\n\n`);
  stream.markdown('```json\n');
  stream.markdown(preview);
  stream.markdown('\n```\n');
  stream.markdown('Review low-confidence text_search edits before applying any rename.');

  return {
    metadata: {
      workflow: 'refactor',
      subject: `${rename.source} -> ${rename.target}`,
    },
  };
}

async function runFlowWorkflow(
  prompt: string,
  service: GitNexusService,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<vscode.ChatResult> {
  throwIfCancelled(token);

  const processName = prompt.trim();
  if (!processName) {
    const processes = await service.getProcesses();

    stream.markdown('### Execution Flows\n');
    if (processes.length === 0) {
      stream.markdown('No process flows found. Run `gitnexus analyze` to refresh the index.');
      return { metadata: { workflow: 'flow' } };
    }

    const list = processes
      .slice(0, 12)
      .map((entry) => `- ${escapeMarkdown(entry.name)} (${entry.steps} steps)`)
      .join('\n');
    stream.markdown(`${list}\n\nUse "/flow <process name>" for full trace details.`);

    return { metadata: { workflow: 'flow' } };
  }

  const details = await service.getProcessDetails(processName);

  stream.markdown('### Flow Trace\n');
  stream.markdown(`Process: **${escapeMarkdown(processName)}**\n\n`);
  stream.markdown('```yaml\n');
  stream.markdown(details);
  stream.markdown('\n```\n');

  return { metadata: { workflow: 'flow', subject: processName } };
}

async function runChangesWorkflow(
  service: GitNexusService,
  stream: vscode.ChatResponseStream,
  token: vscode.CancellationToken,
): Promise<vscode.ChatResult> {
  throwIfCancelled(token);

  const changes = await service.detectChanges('all');

  stream.markdown('### Changes Impact\n');
  stream.markdown('```json\n');
  stream.markdown(changes);
  stream.markdown('\n```\n');

  return { metadata: { workflow: 'changes' } };
}

function suggestFollowups(workflow: GitNexusWorkflow): vscode.ChatFollowup[] {
  switch (workflow) {
    case 'explore':
      return [
        { prompt: '/impact activate', label: 'Analyze impact for a symbol' },
        { prompt: '/flow', label: 'List execution flows' },
      ];
    case 'impact':
      return [
        { prompt: '/changes', label: 'Check changed-symbol risk now' },
        { prompt: '/flow', label: 'Inspect affected process flows' },
      ];
    case 'debug':
      return [
        { prompt: '/flow', label: 'Trace a process in detail' },
        { prompt: '/explore authentication', label: 'Explore related code paths' },
      ];
    case 'refactor':
      return [
        { prompt: '/changes', label: 'Verify scope after rename preview' },
        { prompt: '/impact', label: 'Run blast radius on a related symbol' },
      ];
    case 'flow':
      return [
        { prompt: '/debug', label: 'Use flow context for debugging' },
        { prompt: '/impact', label: 'Check risky symbols in this flow' },
      ];
    case 'changes':
      return [
        { prompt: '/impact', label: 'Deep-dive on one changed symbol' },
        { prompt: '/flow', label: 'Open a process trace' },
      ];
    default:
      return [];
  }
}

function escapeMarkdown(value: string): string {
  return value.replaceAll('|', '\\|');
}

function throwIfCancelled(token: vscode.CancellationToken): void {
  if (token.isCancellationRequested) {
    throw new Error('GitNexus chat request was cancelled.');
  }
}
