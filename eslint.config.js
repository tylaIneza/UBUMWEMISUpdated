import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'server/src/generated/**', 'test-results/**', 'playwright-report/**', 'storage/**', '.test-storage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // API payloads are rendered generically in the web app; server code is strictly typed by tsc.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  { files: ['server/prisma/**', 'scripts/**'], rules: { 'no-console': 'off' } },
  { files: ['scripts/**/*.mjs', 'eslint.config.js'], languageOptions: { globals: { process: 'readonly', console: 'readonly' } } },
  { files: ['web/public/sw.js'], languageOptions: { globals: { self: 'readonly', caches: 'readonly', fetch: 'readonly', URL: 'readonly', Response: 'readonly' } } },
);
