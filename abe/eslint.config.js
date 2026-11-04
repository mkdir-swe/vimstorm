import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const ENUMS = { selector: 'TSEnumDeclaration', message: "Use a union or an 'as const' object." };

/** Core and ui are pure: time, randomness, the process and the world come in as arguments. */
const PURE = [
  ENUMS,
  {
    selector: "MemberExpression[object.name='Date'][property.name='now']",
    message: 'Take `now` as an argument; the clock is a port.',
  },
  {
    selector: "NewExpression[callee.name='Date'][arguments.length=0]",
    message: 'Take `now` as an argument; the clock is a port.',
  },
  {
    selector: "MemberExpression[object.name='Math'][property.name='random']",
    message: 'Randomness is a port.',
  },
  {
    selector:
      'Identifier[name=/^(process|Bun|fetch|console|setTimeout|setInterval|setImmediate|queueMicrotask)$/]',
    message: 'Core and ui are pure; reach the world through a port.',
  },
];

export default tseslint.config(
  { ignores: ['**/node_modules/**', 'dist/**', '**/.scratch/**'] },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  eslintConfigPrettier,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      eqeqeq: 'error',
      'no-nested-ternary': 'error',
      'no-restricted-syntax': ['error', ENUMS],
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { arguments: false } },
      ],
    },
  },
  {
    files: ['packages/core/src/**/*.ts', 'packages/ui/src/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: { 'no-restricted-syntax': ['error', ...PURE] },
  },
  { files: ['**/*.js'], ...tseslint.configs.disableTypeChecked },
);
