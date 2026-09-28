import { runSweep } from './sweep';

// The reporter's shape: a Cloudflare worker's default-export object whose
// `scheduled` handler lets tests inject a replacement sweep.
export default {
  async scheduled(_c: unknown, env: { __sweep?: typeof runSweep }) {
    const sweep = env.__sweep ?? runSweep;
    await sweep(env);
  },
};
