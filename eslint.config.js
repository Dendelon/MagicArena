import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/logs/**'],
  },

  js.configs.recommended,

  {
    files: ['client/src/**/*.{js,ts}', 'client/test/**/*.{js,ts}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.browser,
    },
  },

  {
    files: ['server/**/*.{js,ts}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
  },

  {
    files: ['shared/**/*.{js,ts}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
      },
    },
  },

  {
    files: [
      'client/src/**/*.ts',
      'client/test/**/*.ts',
      'server/**/*.ts',
      'shared/**/*.ts',
    ],

    extends: [...tseslint.configs.recommended],

    rules: {
      '@typescript-eslint/no-explicit-any': 'error',

      '@typescript-eslint/no-non-null-assertion': 'error',

      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-expect-error': 'allow-with-description',
          minimumDescriptionLength: 10,
        },
      ],

      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'separate-type-imports',
        },
      ],

      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
);
