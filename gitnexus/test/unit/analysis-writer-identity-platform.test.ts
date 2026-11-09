import { expect, it } from 'vitest';
import { readAnalysisWriterBirth } from '../../src/core/analysis-writer-identity.js';

it.skipIf(!['linux', 'darwin', 'win32'].includes(process.platform))(
  'reads a stable birth identity from a real live process',
  async () => {
    // This checks the OS identity format and stability. Cold PowerShell on
    // Windows CI can exceed the production probe's five-second wait budget;
    // timeout/unknown behavior and the production limit have separate unit tests.
    const probeBudget = process.platform === 'win32' ? 15_000 : undefined;
    const birth = await readAnalysisWriterBirth(process.pid, probeBudget);
    expect(birth).toBeDefined();
    expect(birth?.kind).toBe(
      { linux: 'linux-proc', darwin: 'darwin-lstart', win32: 'win32-ticks' }[process.platform],
    );
    expect(await readAnalysisWriterBirth(process.pid, probeBudget)).toEqual(birth);
  },
  35_000,
);
