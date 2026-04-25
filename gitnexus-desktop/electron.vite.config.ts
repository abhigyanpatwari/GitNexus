import { resolve } from 'node:path';

export default {
  main: {
    build: {
      outDir: 'dist/main',
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'src/main/main.ts'),
        },
      },
    },
  },
  preload: {
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        input: {
          preload: resolve(__dirname, 'src/main/preload.ts'),
        },
        output: {
          format: 'cjs',
          entryFileNames: 'preload.js',
        },
      },
    },
  },
  renderer: {
    server: {
      host: 'localhost',
      port: 5174,
      strictPort: true,
      watch: {
        ignored: ['**/release/**'],
      },
    },
    build: {
      outDir: 'dist/renderer',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
        },
      },
    },
  },
};
