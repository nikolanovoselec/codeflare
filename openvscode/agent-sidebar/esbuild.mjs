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
    external: ['vscode'],
    sourcemap: !production,
    minify: production,
    logLevel: 'info',
  }),
  build({
    entryPoints: ['src/welcome-extension.ts'],
    outfile: 'dist/welcome-extension.cjs',
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    external: ['vscode'],
    sourcemap: !production,
    minify: production,
    logLevel: 'info',
  }),
  build({
    entryPoints: ['src/package-extension.ts'],
    outfile: 'dist/package-extension.mjs',
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    sourcemap: !production,
    minify: production,
    logLevel: 'info',
  }),
]);
