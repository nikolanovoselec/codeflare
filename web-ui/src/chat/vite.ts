import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import prefixSelector from 'postcss-prefix-selector';
import { fileURLToPath } from 'node:url';
import sourceEntries from './source-entries.json';

// Exact, upstream-declared public entries only. No private-file or tooling
// aliases, package installation, plugin registry, or second frontend build.
export const chatAliases = Object.entries(sourceEntries).map(([entry, source]) => ({
  find: new RegExp(`^${entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`),
  replacement: fileURLToPath(new URL(`./upstream/${source}`, import.meta.url)),
}));

// Standard Vite transforms only: one application, a Solid shell and a pinned
// React source subtree. Do not run the Solid transform over React JSX.
export const reactChat = () => react({
  include: [/\/src\/chat\/.*\.[jt]sx?$/, /\/node_modules\/@blackbelt-technology\/.*\.[jt]sx?$/],
});
export const chatTailwind = () => tailwindcss();
export const solidExcludes = ['**/src/chat/**', '**/node_modules/@blackbelt-technology/**'];
export const chatDedupe = ['react', 'react-dom'];

// Upstream's stylesheet supplies its coherent UI/tokens. Scope its output,
// including Tailwind preflight, so it cannot restyle the incumbent Solid shell.
export const chatPostcss = () => prefixSelector({
  prefix: '.codeflare-chat',
  includeFiles: [/\/src\/chat\/.*\.css$/],
  transform(prefix, selector, prefixedSelector) {
    if (selector.includes(prefix)) return selector;
    if (selector.includes(':root') || selector.includes(':host')) {
      return selector.replace(/:root|:host/g, prefix);
    }
    if (/^(html|body)(?=[\s.:[#>+~]|$)/.test(selector)) {
      return selector.replace(/^(html|body)/, prefix);
    }
    return prefixedSelector;
  },
});
