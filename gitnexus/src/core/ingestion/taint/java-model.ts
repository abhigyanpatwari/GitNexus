/**
 * Built-in Java taint model (#2261 first slice).
 *
 * This deliberately starts small. Servlet request input is modeled only when a
 * conventional request receiver's call result is assigned to a binding. Sinks
 * are limited to static-import-proven JDK filesystem operations that current
 * harvested call-site/import data can identify without broad same-name matching.
 * No sanitizers are registered in this slice.
 */

import type { SourceSinkSanitizerSpec } from './source-sink-config.js';

export const JAVA_TAINT_MODEL: SourceSinkSanitizerSpec = {
  sources: [
    {
      type: 'call-result',
      kind: 'remote-input',
      receivers: ['request', 'req'],
      methods: ['getParameter', 'getHeader'],
    },
  ],
  sinks: [{ name: 'readString', kind: 'path-traversal', args: [0], module: 'java.nio.file.Files' }],
  sanitizers: [],
};
