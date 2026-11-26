
export function logRequest(msg: string) {
  console.log('[REQ]', msg);
}

export function logError(msg: string) {
  console.error('[ERR]', msg);
}

export function createLogEntry(level: string, msg: string) {
  return { level, msg, ts: Date.now() };
}
