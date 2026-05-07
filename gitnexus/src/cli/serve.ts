import { createServer } from '../server/api.js';
import { logger } from '../core/logger.js';

// Catch anything that would cause a silent exit. Pass the Error itself in
// `{ err }` so pino's built-in err serializer captures `type`, `message`,
// AND `stack` as structured fields — passing `err.message` (a string) loses
// the stack and shape; setting GITNEXUS_LOG_LEVEL=debug bumps verbosity.
process.on('uncaughtException', (err) => {
  logger.error({ err }, '[gitnexus serve] Uncaught exception');
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logger.error({ err }, '[gitnexus serve] Unhandled rejection');
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
    logger.error(`\nFailed to start GitNexus server:\n`);
    logger.error(`  ${err.message || err}\n`);
    if (err.code === 'EADDRINUSE') {
      logger.error(`  Port ${port} is already in use. Either:`);
      logger.error(`    1. Stop the other process using port ${port}`);
      logger.error(`    2. Use a different port: gitnexus serve --port 4748\n`);
    }
    if (err.stack && process.env.DEBUG) {
      logger.error(err.stack);
    }
    process.exit(1);
  }
};
