import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['data/**', 'node_modules/**'] },
  js.configs.recommended,
  { languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node } },
  { files: ['public/**/*.js'], languageOptions: { globals: globals.browser } },
];
