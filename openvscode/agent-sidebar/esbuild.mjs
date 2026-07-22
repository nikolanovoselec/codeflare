import { build } from 'esbuild';

const production = process.env.NODE_ENV === 'production';

await Promise.all([
  build({
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.cjs',
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    external: ['vscode', 'node-pty'],
    sourcemap: !production,
    minify: production,
    logLevel: 'info',
  }),
  build({
    entryPoints: {
      chat: 'webview/chat.ts',
      terminal: 'webview/terminal.ts',
      styles: 'webview/styles.css',
    },
    outdir: 'dist/webview',
    bundle: true,
    platform: 'browser',
    target: 'es2022',
    format: 'iife',
    entryNames: '[name]',
    sourcemap: !production,
    minify: production,
    logLevel: 'info',
  }),
]);
