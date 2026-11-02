import { defineConfig } from 'eslint/config';
import nextVitals from 'eslint-config-next/core-web-vitals';
import globals from 'globals';
import { ignores, javascript, typescript } from '../../eslint.shared.mjs';

export default defineConfig(ignores, javascript, nextVitals, typescript, {
  files: ['**/*.{js,cjs,mjs,jsx,ts,cts,mts,tsx}'],
  languageOptions: { globals: { ...globals.browser, ...globals.node } },
  settings: { next: { rootDir: import.meta.dirname } },
});
