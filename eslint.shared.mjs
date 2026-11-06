import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';

export const ignores = globalIgnores([
  '**/node_modules/**',
  '**/.nx/**',
  '**/.next/**',
  '**/.haulpath-workers/**',
  '**/next-env.d.ts',
  '**/dist/**',
  '**/out/**',
  '**/build/**',
  '**/coverage/**',
  '**/playwright-report/**',
  '**/test-results/**',
  '**/data/**',
  '**/backups/**',
  '**/.scratch/**',
  '**/.impeccable/**',
]);

export const javascript = defineConfig({
  files: ['**/*.{js,cjs,mjs,jsx}'],
  extends: [js.configs.recommended],
  languageOptions: { globals: globals.node },
});

export const typescript = defineConfig({
  files: ['**/*.{ts,cts,mts,tsx}'],
  extends: [js.configs.recommended, ts.configs.recommended],
});
