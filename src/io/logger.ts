
export function log(msg: string) {
  console.log('[LOG]', msg);
}

export function logError(msg: string) {
  console.error('[ERR]', msg);
}

export function createEntry(level: string, msg: string) {
  return { level, msg, ts: Date.now() };
}
