import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

// Mismas reglas que el viejo `.eslintrc.js` (plugin:@typescript-eslint/recommended), en el formato
// que lee ESLint 9. El plugin instalado solo trae las configs viejas, por eso se arman a mano.
//
// El formato no se controla acá: Prettier queda para `pnpm format`. Si el lint también exigiera
// formato, el CI fallaría por miles de diferencias de espacios en archivos que nadie tocó.
export default [
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', '.tmp/**'] },
  {
    files: ['**/*.ts'],
    languageOptions: { parser: tsParser, sourceType: 'module' },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...tsPlugin.configs['eslint-recommended'].overrides[0].rules,
      ...tsPlugin.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true },
      ],
    },
  },
];
