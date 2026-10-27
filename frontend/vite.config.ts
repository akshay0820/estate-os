/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // Shared Edge Function code lives outside this package; resolve its deps from here in tests.
      zod: path.resolve(__dirname, 'node_modules/zod'),
    },
  },
  server: { port: 5180 },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
