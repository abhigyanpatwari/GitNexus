import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  worker: {
    format: 'es'
  },
  assetsInclude: ['**/*.wasm'],
  build: {
    target: 'esnext',
    assetsInlineLimit: 0 // Don't inline WASM files
  }
})