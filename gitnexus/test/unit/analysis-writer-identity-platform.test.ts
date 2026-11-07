import { expect, it } from 'vitest';
import { readAnalysisWriterBirth } from '../../src/core/analysis-writer-identity.js';

it.skipIf(!['linux', 'darwin', 'win32'].includes(process.platform))(
  'reads a stable birth identity from a real live process',
  async () => {
    const birth = await readAnalysisWriterBirth(process.pid);
    expect(birth).toBeDefined();
    expect(birth?.kind).toBe(
      { linux: 'linux-proc', darwin: 'darwin-lstart', win32: 'win32-ticks' }[process.platform],
    );
    expect(await readAnalysisWriterBirth(process.pid)).toEqual(birth);
  },
  15000,
);
