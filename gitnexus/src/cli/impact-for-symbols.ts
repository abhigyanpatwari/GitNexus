import { readFile } from 'node:fs/promises';
import { writeSync } from 'node:fs';
import { LocalBackend } from '../mcp/local/local-backend.js';

let _backend: LocalBackend | null = null;

async function getBackend(): Promise<LocalBackend> {
  if (_backend) return _backend;
  _backend = new LocalBackend();
  const ok = await _backend.init();
  if (!ok) {
    throw new Error('No indexed repositories. Run: gitnexus analyze');
  }
  return _backend;
}

function output(data: unknown): void {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  try {
    writeSync(1, text + '\n');
  } catch (err: any) {
    if (err?.code === 'EPIPE') process.exit(0);
    process.stderr.write(text + '\n');
  }
}

export interface ImpactForSymbolsCommandOptions {
  input?: string;
  repo?: string;
}

export async function impactForSymbolsCommand(
  options: ImpactForSymbolsCommandOptions,
): Promise<void> {
  if (!options?.input?.trim()) {
    throw new Error('input path is required');
  }

  const raw = await readFile(options.input, 'utf-8');
  const parsed = JSON.parse(raw) as { symbols?: unknown[] } | unknown[];
  const symbols = Array.isArray(parsed) ? parsed : parsed?.symbols;
  if (!Array.isArray(symbols)) {
    throw new Error('Input JSON must be an array of symbols or an object with a symbols array.');
  }

  const backend = await getBackend();
  const result = await backend.callTool('impact_for_symbols', {
    repo: options.repo,
    symbols: symbols.map((symbol: any) => ({
      id: symbol?.id,
      name: symbol?.name,
      type: symbol?.type ?? symbol?.kind,
      filePath: symbol?.filePath,
      startLine: symbol?.startLine,
      endLine: symbol?.endLine,
    })),
  });
  output(result);
}
