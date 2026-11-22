import type { ChokidarOptions, FSWatcher as ChokidarWatcher } from 'chokidar';

export type FSWatcher = Pick<ChokidarWatcher, 'on' | 'once' | 'off' | 'close'>;
type Watch = (path: string, options: ChokidarOptions) => FSWatcher;

export async function loadWatch(): Promise<Watch> {
  // A node_modules tree installed on a newer Node can also run on the CLI's 22.18 floor.
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major > 22 || (major === 22 && minor >= 22)) {
    let entry: string | undefined;
    try {
      entry = import.meta.resolve('chokidar-v6');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw error;
    }
    // Load outside the catch so a broken installed backend reports its own error.
    if (entry) return (await import(entry)).watch;
  }
  return (await import('chokidar')).watch;
}
