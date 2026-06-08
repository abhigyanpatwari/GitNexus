/**
 * Fixture consumer — calls mapGoldenNodeId from mapper.ts.
 * This file is the call-site so a rename of mapGoldenNodeId
 * produces edits in two files (mapper.ts + consumer.ts).
 */
import { mapGoldenNodeId } from './mapper.js';

export function processUri(uri: string): string {
  return mapGoldenNodeId(uri, 0);
}
