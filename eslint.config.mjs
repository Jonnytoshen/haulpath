import { defineConfig } from 'eslint/config';
import globals from 'globals';
import { ignores, javascript, typescript } from './eslint.shared.mjs';

export default defineConfig(
  ignores,
  javascript,
  typescript,
  { files: ['**/*.{ts,cts,mts,tsx}'], languageOptions: { globals: globals.node } },
);
