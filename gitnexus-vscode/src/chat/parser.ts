export type GitNexusWorkflow = 'explore' | 'impact' | 'debug' | 'refactor' | 'flow' | 'changes';

const WORKFLOWS: GitNexusWorkflow[] = ['explore', 'impact', 'debug', 'refactor', 'flow', 'changes'];

const IMPACT_HINTS = ['impact', 'blast radius', 'break', 'depend'];
const DEBUG_HINTS = ['debug', 'error', 'exception', 'failing', 'failure', 'stack trace'];
const REFACTOR_HINTS = ['rename', 'refactor', 'extract', 'split'];
const FLOW_HINTS = ['flow', 'execution', 'trace', 'process'];
const CHANGES_HINTS = ['changes', 'diff', 'staged', 'unstaged', 'commit'];

export function resolveWorkflow(command: string | undefined, prompt: string): GitNexusWorkflow {
  if (command && WORKFLOWS.includes(command as GitNexusWorkflow)) {
    return command as GitNexusWorkflow;
  }

  const lowerPrompt = prompt.toLowerCase();

  if (containsAny(lowerPrompt, IMPACT_HINTS)) {
    return 'impact';
  }

  if (containsAny(lowerPrompt, DEBUG_HINTS)) {
    return 'debug';
  }

  if (containsAny(lowerPrompt, REFACTOR_HINTS)) {
    return 'refactor';
  }

  if (containsAny(lowerPrompt, FLOW_HINTS)) {
    return 'flow';
  }

  if (containsAny(lowerPrompt, CHANGES_HINTS)) {
    return 'changes';
  }

  return 'explore';
}

export function parseRenamePrompt(prompt: string): { source: string; target: string } | undefined {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return undefined;
  }

  const renameMatch = trimmed.match(/rename\s+([\w.$-]+)\s+(?:to|as|into)\s+([\w.$-]+)/i);
  if (renameMatch) {
    return {
      source: renameMatch[1],
      target: renameMatch[2],
    };
  }

  const arrowMatch = trimmed.match(/([\w.$-]+)\s*(?:->|=>|→)\s*([\w.$-]+)/);
  if (arrowMatch) {
    return {
      source: arrowMatch[1],
      target: arrowMatch[2],
    };
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length === 2) {
    return {
      source: parts[0],
      target: parts[1],
    };
  }

  return undefined;
}

export function pickPrimarySymbol(prompt: string): string | undefined {
  const cleaned = prompt.replace(/[\n\t]/g, ' ').trim();
  if (!cleaned) {
    return undefined;
  }

  const tokens = cleaned.split(/\s+/).filter(Boolean);
  return tokens[0];
}

function containsAny(text: string, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => text.includes(candidate));
}
