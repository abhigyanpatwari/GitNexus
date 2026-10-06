import { JsonReporter, type TestRunEndReason } from 'vitest/node';

/** Vitest's stock JSON omits unhandled errors, even when success is true. */
export default class ExecutionReporter extends JsonReporter {
  private executionErrors = 0;
  private executionReason: TestRunEndReason = 'interrupted';

  constructor() {
    super({});
  }

  override async onTestRunEnd(
    modules: Parameters<JsonReporter['onTestRunEnd']>[0],
    errors: readonly unknown[] = [],
    reason: TestRunEndReason = 'interrupted',
  ): Promise<void> {
    this.executionErrors = errors.length;
    this.executionReason = reason;
    await super.onTestRunEnd(modules);
  }

  override async writeReport(json: string): Promise<void> {
    const report = JSON.parse(json);
    await super.writeReport(
      JSON.stringify({
        ...report,
        success: report.success && this.executionErrors === 0 && this.executionReason === 'passed',
        executionErrors: this.executionErrors,
        executionReason: this.executionReason,
      }),
    );
  }
}
