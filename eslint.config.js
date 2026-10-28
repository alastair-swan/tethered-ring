import js from '@eslint/js'
import globals from 'globals'

export default [
  { ignores: ['src/launcher/datasets/', 'dist/', 'node_modules/', 'assets/', 'textures/', 'basis/', 'components/', 'tools/'] },
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.browser } },
    rules: {
      // The existing code base has many unused variables and empty blocks; keep the signal on
      // things that are actually broken.
      'no-unused-vars': 'off',
      'no-empty': 'off',
      'no-debugger': 'error',
      'no-prototype-builtins': 'off',
      'no-case-declarations': 'off',
    },
  },
  {
    files: ['scripts/**/*.mjs', 'eslint.config.js', 'vite.config.js'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: { ...globals.node } },
  },
]
