import * as path from 'node:path';
import type { ThriftLanguagePlugin } from './types.js';
import { JAVA_THRIFT_PLUGIN } from './java.js';

export type { ThriftDetection, ThriftLanguagePlugin, ThriftRole } from './types.js';

const REGISTRY: Record<string, ThriftLanguagePlugin> = {
  '.java': JAVA_THRIFT_PLUGIN,
};

export const THRIFT_SCAN_GLOB = '**/*.java';

export function getPluginForFile(rel: string): ThriftLanguagePlugin | undefined {
  const ext = path.extname(rel).toLowerCase();
  return REGISTRY[ext];
}
