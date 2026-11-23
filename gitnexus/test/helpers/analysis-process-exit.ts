import type { ChildProcess } from 'node:child_process';

/** Observe real child exit in publication fixtures; IPC is not release evidence. */
export function waitForAnalysisProcessExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      if (code === 0 && signal === null) resolve();
      else
        reject(
          new Error(
            `Graph process exited unsuccessfully (${signal ?? code ?? 'unknown'}); prepared artifacts retained`,
          ),
        );
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    if (child.exitCode !== null || child.signalCode !== null) {
      onExit(child.exitCode, child.signalCode);
      return;
    }
    child.once('exit', onExit);
    child.once('error', onError);
  });
}
