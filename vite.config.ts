import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  base: './',
  root: '.',
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main:     path.resolve(__dirname, 'index.html'),
        wxochat:  path.resolve(__dirname, 'src/renderer/wxo-chat.html'),
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/renderer'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    // Allow Vite to serve files from src/renderer
    fs: {
      allow: ['.'],
    },
    headers: {
      // Relax CSP for the wxo-chat page so IBM scripts load
      'Content-Security-Policy': [
        "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob:",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://au-syd.watson-orchestrate.cloud.ibm.com https://*.watson-orchestrate.cloud.ibm.com https://*.ibm.com",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://au-syd.watson-orchestrate.cloud.ibm.com https://*.ibm.com",
        "font-src 'self' https://fonts.gstatic.com data: https://au-syd.watson-orchestrate.cloud.ibm.com https://*.ibm.com",
        "connect-src 'self' http://localhost:3001 ws://localhost:3001 https://*.supabase.co wss://*.supabase.co https://au-syd.watson-orchestrate.cloud.ibm.com https://*.watson-orchestrate.cloud.ibm.com https://iam.cloud.ibm.com https://*.ibm.com",
        "img-src 'self' data: blob: https://au-syd.watson-orchestrate.cloud.ibm.com https://*.ibm.com",
        "frame-src 'self' http://localhost:5173 https://au-syd.watson-orchestrate.cloud.ibm.com https://*.watson-orchestrate.cloud.ibm.com https://*.ibm.com",
      ].join('; '),
    },
  },
});
