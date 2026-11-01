/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Relative asset paths let the static build run from a GitHub Pages project subpath.
export default defineConfig({ plugins: [react()], base: './', test: { setupFiles: ['src/test-setup.ts'] } });
