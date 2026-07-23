import tsPlugin from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import reactPlugin from 'eslint-plugin-react'

export default [
  {
    ignores: [
      'dist/**',
      'dist-main/**',
      'dist-preload/**',
      'release/**',
      'node_modules/**',
      '**/*.cjs',
      '**/*.mjs',
    ],
  },
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      react: reactPlugin,
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      // ===== 代码质量 =====
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      'prefer-const': 'warn',
      'no-var': 'error',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-unused-expressions': 'off',
      '@typescript-eslint/no-unused-expressions': 'warn',

      // ===== 宽松规则（避免噪音）=====
      'no-console': 'off',
      'no-debugger': 'warn',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',

      // ===== React =====
      'react/jsx-uses-react': 'off',
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'react/display-name': 'off',
      'react/no-unescaped-entities': 'warn',
    },
  },
]
