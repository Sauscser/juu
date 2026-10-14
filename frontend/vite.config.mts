import { defineConfig, loadEnv } from 'vite'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, dirname(fileURLToPath(import.meta.url)), 'VITE_')

  return {
    server: {
      port: 5173,
      strictPort: true,
      proxy: env.VITE_UPPY_API_URL
        ? {
            '/api': {
              target: env.VITE_UPPY_API_URL,
              changeOrigin: true,
              rewrite: (path) => path.replace(/^\/api/, ''),
            },
          }
        : undefined,
    },
    build: {
      outDir: '../dist/web',
      emptyOutDir: true,
    },
  }
})
