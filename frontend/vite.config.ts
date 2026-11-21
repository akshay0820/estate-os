/// <reference types="vitest" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { BRAND } from './src/brand';

// index.html's <title> comes from src/brand.ts, so a client rename is one file.
const brandTitle = BRAND.company ? `${BRAND.productName} — ${BRAND.company}` : BRAND.productName;

export default defineConfig({
  plugins: [react(), { name: 'brand-title', transformIndexHtml: (html) => html.replace('%BRAND_TITLE%', brandTitle) }],
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
