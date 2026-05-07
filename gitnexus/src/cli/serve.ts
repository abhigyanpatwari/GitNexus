import { createServer } from '../server/api.js';
import { logger, flushLoggerSync } from '../core/logger.js';
import { cliError } from './cli-message.js';

// Catch anything that would cause a silent exit. Pino v10's default
// destination is `sync: false` (SonicBoom buffered) — call
// `flushLoggerSync()` between the log and `process.exit(1)` so the crash
// record is not lost to the unflushed buffer. Worker-thread transports
// (pino-pretty under TTY) handle their own flush on process exit in v10,
// so no separate `pino.final` integration is needed (the API was removed
// in v10 because the transport architecture made it unnecessary).
//
// We pass the Error itself in `{ err }` so pino's built-in err serializer
// captures `type`, `message`, and `stack` as structured fields.
process.on('uncaughtException', (err) => {
  logger.error({ err }, '[gitnexus serve] Uncaught exception');
  flushLoggerSync();
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logger.error({ err }, '[gitnexus serve] Unhandled rejection');
  flushLoggerSync();
  process.exit(1);
});

export const serveCommand = async (options?: { port?: string; host?: string }) => {
  const port = Number(options?.port ?? 4747);
  // Default to 'localhost' so the OS decides whether to bind to 127.0.0.1 or
  // ::1 based on system configuration, avoiding spurious CORS errors when the
  // hosted frontend at gitnexus.vercel.app connects to localhost.
  const host = options?.host ?? 'localhost';

  try {
    await createServer(port, host);
  } catch (err: any) {
    if (err.code === 'EADDRINUSE') {
      cliError(
        `\nFailed to start GitNexus server:\n` +
          `  ${err.message || err}\n\n` +
          `  Port ${port} is already in use. Either:\n` +
          `    1. Stop the other process using port ${port}\n` +
          `    2. Use a different port: gitnexus serve --port 4748\n`,
        { code: err.code, port, host },
      );
    } else {
      cliError(`\nFailed to start GitNexus server:\n  ${err.message || err}\n`, {
        code: err.code,
        port,
        host,
      });
    }
    if (err.stack && process.env.DEBUG) {
      logger.debug({ stack: err.stack }, 'serve start error stack');
    }
    flushLoggerSync();
    process.exit(1);
  }
};
