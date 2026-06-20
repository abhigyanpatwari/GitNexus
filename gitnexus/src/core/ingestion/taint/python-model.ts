/**
 * Built-in Python taint model (#2204 first slice).
 *
 * Keep the model intentionally conservative: import-aware sinks for standard
 * library command execution, receiver-conventional database execution calls,
 * and Flask/FastAPI-style request-object member reads. No sanitizers are
 * registered yet because a false sanitizer kill can hide a real finding.
 */

import type { SourceSinkSanitizerSpec } from './source-sink-config.js';

export const PYTHON_TAINT_MODEL: SourceSinkSanitizerSpec = {
  sources: [
    {
      kind: 'remote-input',
      objects: ['request', 'req'],
      properties: [
        'args',
        'form',
        'json',
        'data',
        'headers',
        'cookies',
        'path_params',
        'query_params',
      ],
    },
  ],
  sinks: [
    { name: 'system', kind: 'command-injection', args: [0], module: 'os' },
    { name: 'popen', kind: 'command-injection', args: [0], module: 'os' },
    { name: 'call', kind: 'command-injection', args: [0], module: 'subprocess' },
    { name: 'run', kind: 'command-injection', args: [0], module: 'subprocess' },
    { name: 'Popen', kind: 'command-injection', args: [0], module: 'subprocess' },
    { name: 'check_call', kind: 'command-injection', args: [0], module: 'subprocess' },
    { name: 'check_output', kind: 'command-injection', args: [0], module: 'subprocess' },
    { name: 'eval', kind: 'code-injection', args: [0], global: true },
    { name: 'exec', kind: 'code-injection', args: [0], global: true },
    { name: 'open', kind: 'path-traversal', args: [0], global: true },
    { name: 'query', kind: 'sql-injection', args: [0], anyReceiver: true },
    { name: 'execute', kind: 'sql-injection', args: [0], anyReceiver: true },
    { name: 'executemany', kind: 'sql-injection', args: [0], anyReceiver: true },
    { name: 'executescript', kind: 'sql-injection', args: [0], anyReceiver: true },
  ],
  sanitizers: [],
};
