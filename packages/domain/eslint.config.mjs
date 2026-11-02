import { defineConfig } from 'eslint/config';
import { ignores, javascript, typescript } from '../../eslint.shared.mjs';

// Domain TypeScript deliberately has no browser or Node globals.
export default defineConfig(ignores, javascript, typescript);
