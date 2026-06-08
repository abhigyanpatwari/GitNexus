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

export interface ImpactForRangesCommandOptions {
  input?: string;
  repo?: string;
}

export async function impactForRangesCommand(
  options: ImpactForRangesCommandOptions,
): Promise<void> {
  if (!options?.input?.trim()) {
    throw new Error('input path is required');
  }

  const raw = await readFile(options.input, 'utf-8');
  const parsed = JSON.parse(raw) as { ranges?: unknown[] } | unknown[];
  const ranges = Array.isArray(parsed) ? parsed : parsed?.ranges;
  if (!Array.isArray(ranges)) {
    throw new Error('Input JSON must be an array of ranges or an object with a ranges array.');
  }

  const backend = await getBackend();
  const result = await backend.callTool('impact_for_ranges', {
    repo: options.repo,
    ranges: ranges.map((range: any) => ({
      filePath: range?.filePath,
      startLine: range?.startLine,
      endLine: range?.endLine,
      side: range?.side,
      change_type: range?.change_type ?? range?.changeType,
    })),
  });
  output(result);
}
