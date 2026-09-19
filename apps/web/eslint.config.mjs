import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['dist/', 'docs/', 'coverage/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.flat.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      // The model indexes fixed-size matrices it just built; a non-null assertion is the honest read.
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
