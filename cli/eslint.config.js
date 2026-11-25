import js from '@eslint/js';
import globals from 'globals';
import portableEsmPaths from './eslint-rules/portable-esm-paths.js';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node,
      },
    },
    plugins: { local: { rules: { 'portable-esm-paths': portableEsmPaths } } },
    rules: {
      'local/portable-esm-paths': 'error',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': 'off',
    },
  },
];
