import type { TFunction } from 'i18next';

export function translateAnalyzePhase(
  phase: string,
  message: string | undefined,
  t: TFunction,
): string {
  const key = `common:analyzePhases.${phase}`;
  const translated = t(key, { defaultValue: '' });
  return translated || message || phase;
}

export function translateProgressMessage(message: string | undefined, t: TFunction): string {
  if (!message) return '';
  const key = PROGRESS_MESSAGE_KEYS[message];
  return key ? t(key) : message;
}

const PROGRESS_MESSAGE_KEYS: Record<string, string> = {
  'Connecting...': 'common:progress.connectingShort',
  'Connecting to server...': 'common:progress.connecting',
  'Validating server': 'common:progress.validatingServer',
  'Validating server...': 'common:progress.validatingServerEllipsis',
  'Downloading graph...': 'common:progress.downloadingGraph',
  'Extracting file contents': 'common:progress.extractingFileContents',
  'Processing...': 'common:progress.processing',
  'Processing graph...': 'common:progress.processingGraph',
  'Loading graph...': 'common:progress.loadingGraph',
  Queued: 'common:analyzePhases.queued',
  'Starting...': 'common:progress.starting',
};
