import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD__: JSON.stringify(`${(process.env.VERCEL_GIT_COMMIT_SHA ?? 'local').slice(0, 7)} ${new Date().toISOString().slice(0, 16)}`),
  },
  worker: { format: 'es' },
  build: { target: 'safari16', sourcemap: true },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 60_000 },
} as any);
