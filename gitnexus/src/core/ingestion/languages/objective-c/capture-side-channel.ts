import type { ParsedFile } from 'gitnexus-shared';

import {
  collectCStaticLinkageSideChannel,
  type CCaptureSideChannel,
} from '../c/capture-side-channel.js';
import { markStaticName } from '../c/static-linkage.js';

export interface ObjectiveCCaptureSideChannel {
  readonly kind: 'objective-c';
  readonly cStatic?: CCaptureSideChannel;
}

export function collectObjectiveCCaptureSideChannel(
  filePath: string,
): ObjectiveCCaptureSideChannel | undefined {
  const cStatic = collectCStaticLinkageSideChannel(filePath);
  return cStatic === undefined ? undefined : { kind: 'objective-c', cStatic };
}

export function applyObjectiveCCaptureSideChannel(parsed: ParsedFile): void {
  const data = parsed.captureSideChannel as ObjectiveCCaptureSideChannel | undefined;
  if (data?.kind !== 'objective-c' || !Array.isArray(data.cStatic?.staticNames)) return;
  for (const name of data.cStatic.staticNames) markStaticName(parsed.filePath, name);
}
