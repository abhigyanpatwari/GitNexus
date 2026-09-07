/** Reserved CLI verb: never starts either watch product. */
import { t } from './i18n/index.js';

export async function watchAmbiguousCommand(_action?: string): Promise<void> {
  process.stderr.write(t('error.watch.ambiguous'));
  process.exitCode = 1;
}
