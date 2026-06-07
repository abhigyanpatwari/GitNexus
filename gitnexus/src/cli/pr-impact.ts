import { writeSync } from 'node:fs';
import { LocalBackend } from '../mcp/local/local-backend.js';
import { renderPrImpactMarkdown } from '../core/pr-impact/report.js';
import { buildPrImpactPipelineReport } from '../core/pr-impact/pipeline.js';
import { cliErrorKey } from './cli-message.js';

let _backend: LocalBackend | null = null;

async function getBackend(): Promise<LocalBackend> {
  if (_backend) return _backend;
  _backend = new LocalBackend();
  const ok = await _backend.init();
  if (!ok) {
    cliErrorKey('tool.noIndexed');
    process.exit(1);
  }
  return _backend;
}

function output(data: string): void {
  try {
    writeSync(1, data + '\n');
  } catch (err: any) {
    if (err?.code === 'EPIPE') process.exit(0);
    process.stderr.write(data + '\n');
  }
}

export interface PrImpactCommandOptions {
  scope?: string;
  baseRef?: string;
  repo?: string;
  format?: string;
}

export async function prImpactCommand(options?: PrImpactCommandOptions): Promise<void> {
  const backend = await getBackend();
  const format = (options?.format || 'markdown').toLowerCase();
  const report = await buildPrImpactPipelineReport(backend, options);
  if (format === 'json') {
    output(JSON.stringify(report, null, 2));
    return;
  }
  output(renderPrImpactMarkdown(report));
}
