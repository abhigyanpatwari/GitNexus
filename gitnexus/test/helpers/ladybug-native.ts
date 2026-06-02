import fs from 'node:fs';
import path from 'node:path';

export const hasLadybugNative = (): boolean =>
  fs.existsSync(path.join(process.cwd(), 'node_modules', '@ladybugdb', 'core', 'lbugjs.node'));
