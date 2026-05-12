import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

const commonIgnores = [
  'assets/**',
  'build/**',
  'dist/**',
  'node_modules/**',
  'out/**',
  'vendor/**',
  'package-lock.json',
];

const commonScriptGlobals = {
  ...globals.node,
  ...globals.es2022,
};

export default defineConfig([
  {
    ignores: commonIgnores,
  },
  {
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
  },
  {
    files: ['**/*.js', '**/*.cjs'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: commonScriptGlobals,
    },
    rules: js.configs.recommended.rules,
  },
  {
    files: ['**/*.mjs'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: commonScriptGlobals,
    },
    rules: js.configs.recommended.rules,
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['src/**/*.ts'],
  })),
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    files: ['src/renderer/**/*.ts'],
    languageOptions: {
      globals: globals.browser,
    },
  },
  eslintConfigPrettier,
]);
