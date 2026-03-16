export interface LogEntry {
  level: string;
  message: string;
  timestamp: number;
}

export function createLogEntry(level: string, message: string): LogEntry {
  return { level, message, timestamp: Date.now() };
}

export function formatLogEntry(entry: LogEntry): string {
  return `[${entry.level}] ${entry.message}`;
}

export function logMessage(level: string, message: string): string {
  const entry = createLogEntry(level, message);
  return formatLogEntry(entry);
}
