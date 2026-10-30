import { defineConfig } from 'vite';
import solidPlugin from 'vite-plugin-solid';
import { reactChat, chatTailwind, solidExcludes, chatDedupe, chatPostcss, chatAliases } from './src/chat/vite';

export default defineConfig({
  plugins: [solidPlugin({ exclude: solidExcludes }), reactChat(), chatTailwind()],
  resolve: { dedupe: chatDedupe, alias: chatAliases },
  css: { postcss: { plugins: [chatPostcss()] } },
  optimizeDeps: { include: ['react', 'react-dom', 'react/jsx-runtime'] },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
        ws: true,
      },
      '/terminal': {
        target: 'ws://localhost:8787',
        ws: true,
      },
    },
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
  },
});
