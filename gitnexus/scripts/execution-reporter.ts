import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { JsonReporter, type TestRunEndReason } from 'vitest/node';

/** Vitest's stock JSON omits unhandled errors, even when success is true. */
export default class ExecutionReporter extends JsonReporter {
  constructor() {
    super({});
  }

  override async onTestRunEnd(
    modules: Parameters<JsonReporter['onTestRunEnd']>[0],
    errors: readonly unknown[] = [],
    reason: TestRunEndReason = 'interrupted',
  ): Promise<void> {
    const configuredOutput = this.ctx.config.outputFile;
    const outputFile = resolve(
      this.ctx.config.root,
      (typeof configuredOutput === 'string' ? configuredOutput : configuredOutput?.json) ??
        '.vitest/json/output.json',
    );
    // Vitest 5 writes JSON directly instead of calling writeReport. Use an
    // explicit path so this reporter also works for the web suite on Vitest 4.
    this.options.outputFile = outputFile;
    await super.onTestRunEnd(modules);
    const report = JSON.parse(await readFile(outputFile, 'utf8'));
    await writeFile(
      outputFile,
      JSON.stringify({
        ...report,
        success: report.success && errors.length === 0 && reason === 'passed',
        executionErrors: errors.length,
        executionReason: reason,
      }),
      'utf8',
    );
  }
}
