import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  worker: { format: 'es' },
  build: { target: 'safari16', sourcemap: true },
  test: { include: ['tests/**/*.test.ts'], testTimeout: 60_000 },
} as any);
