import { defineConfig } from 'vite';

// The world is one page and a handful of modules. three.js is split out so a change to the world
// code does not invalidate a 700 KB chunk in everyone's cache.
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsDir: 'assets',
    rollupOptions: { output: { manualChunks: { three: ['three'] } } }
  },
  server: { host: true, port: 5180 }
});
